import type { Server as HttpServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Server, type Socket } from 'socket.io';
import {
  EVENTS,
  eventRoutingKey,
  parseEventPayload,
  type EventEnvelope,
  type administration,
} from '@aegis/contracts';
import type { Logger } from '@aegis/observability';
import {
  ACCESS_COOKIE,
  AppError,
  parseCookies,
  type AccessTokenVerifier,
  type MessageBroker,
} from '@aegis/service-kit';

export const REALTIME_PATH = '/realtime/socket.io';

/** Lease validation through administration-service (fail closed). */
export interface LeaseValidator {
  validate(
    input: { sessionId: string; userId: string; touch: boolean },
    correlationId: string,
  ): Promise<administration.ValidatedLease>;
}

/** Session introspection through identity-service (fail closed). */
export interface SessionChecker {
  isActive(sessionId: string, userId: string, correlationId: string): Promise<boolean>;
}

interface SocketData {
  userId: string;
  sessionId: string;
  lease: {
    grantId: string;
    workspaceType: string;
    workspaceId: string;
    fencingToken: number;
  } | null;
}

/** Default (untyped) event maps; payloads are built from validated server data only. */
type HubSocket = Socket & { data: SocketData };

export interface RealtimeHubOptions {
  allowedOrigins: readonly string[];
  revalidateIntervalMs: number;
}

/**
 * Authenticated realtime fan-out. In Phase 1 it carries the privileged administration channel:
 *  - connections require a valid access token and an active session;
 *  - `privileged:subscribe` joins only after administration-service validates the lease;
 *  - lease changes and session revocations from the broker drop subscriptions immediately;
 *  - every subscription is also revalidated periodically, so a missed event cannot leave access open.
 * School and trip rooms are added in Phase 4 with the same reauthorization pattern.
 */
export class RealtimeHub {
  readonly io: Server;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    httpServer: HttpServer,
    private readonly tokens: AccessTokenVerifier,
    private readonly sessions: SessionChecker,
    private readonly leases: LeaseValidator,
    private readonly logger: Pick<Logger, 'info' | 'warn' | 'error'>,
    private readonly options: RealtimeHubOptions,
  ) {
    this.io = new Server(httpServer, {
      path: REALTIME_PATH,
      serveClient: false,
      maxHttpBufferSize: 16 * 1024,
      cors: { origin: [...options.allowedOrigins], credentials: true },
      allowRequest: (request, callback) => {
        // Browsers always send Origin; reject cross-site websocket hijacking. Native clients may omit it.
        const origin = request.headers.origin;
        callback(null, origin === undefined || options.allowedOrigins.includes(origin));
      },
    });
    this.io.use((socket, next) => {
      void this.authenticate(socket as HubSocket)
        .then(() => next())
        .catch(() => next(new Error('UNAUTHENTICATED')));
    });
    this.io.on('connection', (socket) => this.onConnection(socket as HubSocket));
  }

  async attachBroker(broker: MessageBroker): Promise<void> {
    await broker.subscribe(
      {
        queue: 'realtime-gateway.fanout',
        routingKeys: [eventRoutingKey('leaseChanged'), eventRoutingKey('sessionRevoked')],
        // Each instance needs every event for its own sockets; correctness is backed by revalidation.
        durable: false,
      },
      (envelope) => this.onEvent(envelope),
    );
  }

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => void this.revalidateAll(), this.options.revalidateIntervalMs);
  }

  async close(): Promise<void> {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    await this.io.close();
  }

  async onEvent(envelope: EventEnvelope): Promise<void> {
    if (envelope.type === EVENTS.leaseChanged.type) {
      const change = parseEventPayload('leaseChanged', envelope);
      for (const socket of await this.sockets()) {
        const lease = socket.data.lease;
        if (lease === null || lease.workspaceId !== change.workspaceId) continue;
        if (change.status !== 'ACTIVE' || change.grantId !== lease.grantId) {
          this.dropLease(
            socket,
            change.status === 'ACTIVE' ? 'TAKEOVER' : (change.reason ?? change.status),
          );
        }
      }
    } else if (envelope.type === EVENTS.sessionRevoked.type) {
      const revoked = parseEventPayload('sessionRevoked', envelope);
      for (const socket of await this.sockets()) {
        if (socket.data.sessionId === revoked.sessionId) {
          socket.emit('session:revoked', { reason: revoked.reason });
          socket.disconnect(true);
        }
      }
    }
  }

  /** Re-checks every privileged subscription; any failure (including an outage) drops it. */
  async revalidateAll(): Promise<void> {
    for (const socket of await this.sockets()) {
      const lease = socket.data.lease;
      if (lease === null) continue;
      try {
        const current = await this.leases.validate(
          { sessionId: socket.data.sessionId, userId: socket.data.userId, touch: false },
          randomUUID(),
        );
        if (current.grantId !== lease.grantId) this.dropLease(socket, 'TAKEOVER');
      } catch (error) {
        this.dropLease(socket, error instanceof AppError ? error.code : 'VALIDATION_UNAVAILABLE');
      }
    }
  }

  private async authenticate(socket: HubSocket): Promise<void> {
    const handshake = socket.handshake;
    const authToken = typeof handshake.auth?.token === 'string' ? handshake.auth.token : undefined;
    const header = handshake.headers.authorization;
    const bearer =
      typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : undefined;
    const cookie = parseCookies(handshake.headers.cookie)[ACCESS_COOKIE];
    const token = authToken ?? bearer ?? cookie;
    if (token === undefined) throw new AppError('UNAUTHENTICATED');
    const auth = await this.tokens.verify(token);
    if (!(await this.sessions.isActive(auth.sessionId, auth.userId, randomUUID())))
      throw new AppError('UNAUTHENTICATED');
    socket.data = { userId: auth.userId, sessionId: auth.sessionId, lease: null };
  }

  private onConnection(socket: HubSocket): void {
    socket.on('privileged:subscribe', (ack: unknown) => {
      const reply =
        typeof ack === 'function' ? (ack as (result: unknown) => void) : () => undefined;
      void this.subscribePrivileged(socket).then(reply);
    });
  }

  private async subscribePrivileged(
    socket: HubSocket,
  ): Promise<{ ok: true; grantId: string } | { ok: false; code: string }> {
    try {
      const lease = await this.leases.validate(
        { sessionId: socket.data.sessionId, userId: socket.data.userId, touch: false },
        randomUUID(),
      );
      if (socket.data.lease !== null) await socket.leave(`lease:${socket.data.lease.grantId}`);
      socket.data.lease = {
        grantId: lease.grantId,
        workspaceType: lease.workspaceType,
        workspaceId: lease.workspaceId,
        fencingToken: lease.fencingToken,
      };
      await socket.join(`lease:${lease.grantId}`);
      return { ok: true, grantId: lease.grantId };
    } catch (error) {
      return {
        ok: false,
        code: error instanceof AppError ? error.code : 'PRIVILEGED_LEASE_REQUIRED',
      };
    }
  }

  private dropLease(socket: HubSocket, reason: string): void {
    const lease = socket.data.lease;
    if (lease === null) return;
    socket.data.lease = null;
    void socket.leave(`lease:${lease.grantId}`);
    socket.emit('privileged:lease_lost', { grantId: lease.grantId, reason });
    this.logger.info(
      { grantId: lease.grantId, reason },
      'privileged realtime subscription dropped',
    );
  }

  /** Sockets connected to this instance; every instance receives every fan-out event. */
  private async sockets(): Promise<HubSocket[]> {
    return [...this.io.sockets.sockets.values()] as HubSocket[];
  }
}

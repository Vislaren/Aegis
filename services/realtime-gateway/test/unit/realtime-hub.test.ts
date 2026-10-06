import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { io as connect, type Socket } from 'socket.io-client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { administration } from '@aegis/contracts';
import {
  AccessTokenSigner,
  AppError,
  InMemoryBroker,
  createAccessTokenVerifier,
  createEnvelope,
  eventRoutingKeyFor,
  generateSigningJwk,
  publicJwk,
} from './support';
import {
  REALTIME_PATH,
  RealtimeHub,
  type LeaseValidator,
  type SessionChecker,
} from '../../src/realtime-hub';

const ISSUER = 'https://identity.aegis.test';
const WORKSPACE = randomUUID();

let http: HttpServer;
let hub: RealtimeHub;
let broker: InMemoryBroker;
let signer: AccessTokenSigner;
let url: string;
const leases = new Map<string, administration.ValidatedLease>();
const activeSessions = new Set<string>();
let validationAvailable = true;
const sockets: Socket[] = [];

const leaseValidator: LeaseValidator = {
  async validate(input) {
    if (!validationAvailable) throw new AppError('DEPENDENCY_UNAVAILABLE');
    const lease = leases.get(input.sessionId);
    if (lease === undefined) throw new AppError('PRIVILEGED_LEASE_REQUIRED');
    return lease;
  },
};
const sessionChecker: SessionChecker = {
  isActive: async (sessionId) => activeSessions.has(sessionId),
};

async function client(
  withLease: boolean,
): Promise<{ socket: Socket; sessionId: string; grantId: string }> {
  const sessionId = randomUUID();
  const userId = randomUUID();
  const grantId = randomUUID();
  activeSessions.add(sessionId);
  if (withLease) {
    leases.set(sessionId, {
      grantId,
      fencingToken: 1,
      workspaceType: 'SCHOOL',
      workspaceId: WORKSPACE,
      schoolId: randomUUID(),
      operatorProfileId: randomUUID(),
      operatorDisplayName: 'Operator Fictional',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
  }
  const { token } = await signer.sign({ userId, sessionId, aal: 2 }, 300);
  const socket = connect(url, {
    path: REALTIME_PATH,
    auth: { token },
    transports: ['websocket'],
    reconnection: false,
  });
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('connect_error', reject);
  });
  return { socket, sessionId, grantId };
}

function next<T>(socket: Socket, event: string): Promise<T> {
  return new Promise((resolve) => socket.once(event, (payload: T) => resolve(payload)));
}

beforeEach(async () => {
  const key = await generateSigningJwk('test');
  signer = await AccessTokenSigner.fromJwk(key, ISSUER);
  http = createServer();
  broker = new InMemoryBroker();
  hub = new RealtimeHub(
    http,
    createAccessTokenVerifier({ issuer: ISSUER, jwks: { keys: [publicJwk(key)] } }),
    sessionChecker,
    leaseValidator,
    { info: () => undefined, warn: () => undefined, error: () => undefined },
    { allowedOrigins: ['http://localhost:8081'], revalidateIntervalMs: 60_000 },
  );
  await hub.attachBroker(broker);
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  validationAvailable = true;
});

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  await hub.close();
  http.close();
});

describe('realtime privileged channel', () => {
  it('rejects connections without a valid token or with a revoked session', async () => {
    const bad = connect(url, {
      path: REALTIME_PATH,
      auth: { token: 'not-a-token' },
      transports: ['websocket'],
      reconnection: false,
    });
    sockets.push(bad);
    await expect(new Promise((_, reject) => bad.once('connect_error', reject))).rejects.toThrow(
      /UNAUTHENTICATED/,
    );
  });

  it('subscribes only with a live lease', async () => {
    const holder = await client(true);
    const outsider = await client(false);
    await expect(holder.socket.emitWithAck('privileged:subscribe')).resolves.toEqual({
      ok: true,
      grantId: holder.grantId,
    });
    await expect(outsider.socket.emitWithAck('privileged:subscribe')).resolves.toEqual({
      ok: false,
      code: 'PRIVILEGED_LEASE_REQUIRED',
    });
  });

  it('drops the subscription when the lease is taken over, and disconnects revoked sessions', async () => {
    const holder = await client(true);
    await holder.socket.emitWithAck('privileged:subscribe');
    const lost = next<{ reason: string }>(holder.socket, 'privileged:lease_lost');
    await broker.publish(
      createEnvelope(
        'leaseChanged',
        {
          workspaceType: 'SCHOOL',
          workspaceId: WORKSPACE,
          grantId: randomUUID(),
          sessionId: randomUUID(),
          fencingToken: 2,
          status: 'ACTIVE',
          reason: 'TAKEOVER',
        },
        { producer: 'administration-service', schoolId: null, correlationId: 'c' },
      ),
      eventRoutingKeyFor('leaseChanged'),
    );
    await expect(lost).resolves.toMatchObject({ reason: 'TAKEOVER' });

    const disconnected = next<string>(holder.socket, 'disconnect');
    await broker.publish(
      createEnvelope(
        'sessionRevoked',
        { sessionId: holder.sessionId, userId: randomUUID(), reason: 'LOGOUT' },
        { producer: 'identity-service', schoolId: null, correlationId: 'c' },
      ),
      eventRoutingKeyFor('sessionRevoked'),
    );
    await expect(disconnected).resolves.toBeDefined();
  });

  it('fails closed: revalidation drops subscriptions when administration-service is unreachable', async () => {
    const holder = await client(true);
    await holder.socket.emitWithAck('privileged:subscribe');
    const lost = next<{ reason: string }>(holder.socket, 'privileged:lease_lost');
    validationAvailable = false;
    await hub.revalidateAll();
    await expect(lost).resolves.toMatchObject({ reason: 'DEPENDENCY_UNAVAILABLE' });
  });
});

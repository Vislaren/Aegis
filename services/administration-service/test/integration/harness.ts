import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import request from 'supertest';
import type { identity, EventEnvelope } from '@aegis/contracts';
import { maskContact, parseContactIdentifier } from '@aegis/domain';
import {
  AccessTokenSigner,
  ServiceTokenSigner,
  ServiceTokenVerifier,
  correlationIdFor,
  createAccessTokenVerifier,
  createEnvelope,
  generateSigningJwk,
  publicJwk,
} from '@aegis/service-kit';
import {
  createTestDatabase,
  dropTestDatabase,
  withClient,
  type TestDatabase,
} from '@aegis/service-kit/dist/testing';
import { AdministrationModule } from '../../src/app.module';
import { AdministrationEventHandlers } from '../../src/application/event-handlers';
import { loadAdministrationConfig } from '../../src/config';
import type { IdentityPort } from '../../src/infrastructure/identity.client';

export interface FakeSession {
  sessionId: string;
  userId: string;
  active: boolean;
  aal: 1 | 2;
  mfaVerifiedAt: Date | null;
  userStatus: identity.SessionIntrospection['userStatus'];
}

/** In-memory identity-service: provisioned users by contact, and introspectable sessions. */
export class FakeIdentity implements IdentityPort {
  readonly usersByContact = new Map<string, string>();
  readonly sessions = new Map<string, FakeSession>();
  available = true;

  async provisionUser(input: {
    displayName: string;
    contact: string;
  }): Promise<identity.ProvisionUserResponse> {
    const contact = parseContactIdentifier(input.contact);
    if (contact === null) throw new Error('invalid contact');
    const existing = this.usersByContact.get(contact.value);
    const userId = existing ?? randomUUID();
    this.usersByContact.set(contact.value, userId);
    return {
      userId,
      created: existing === undefined,
      status: 'INVITED',
      contactMasked: maskContact(contact.value),
    };
  }

  async introspectSession(sessionId: string): Promise<identity.SessionIntrospection | null> {
    if (!this.available) {
      const { AppError } = await import('@aegis/service-kit');
      throw new AppError('DEPENDENCY_UNAVAILABLE');
    }
    const s = this.sessions.get(sessionId);
    if (s === undefined) return null;
    return {
      sessionId: s.sessionId,
      userId: s.userId,
      active: s.active,
      userStatus: s.userStatus,
      aal: s.aal,
      mfaVerifiedAt: s.mfaVerifiedAt?.toISOString() ?? null,
    };
  }
}

export interface Harness {
  app: NestFastifyApplication;
  db: TestDatabase;
  identity: FakeIdentity;
  handlers: AdministrationEventHandlers;
  http: () => ReturnType<typeof request>;
  /** Test isolation: ends any platform lease left by a previous test. */
  resetPlatformLease(): Promise<void>;
  /** Creates an MFA-verified session for a user and returns its bearer token. */
  login(
    userId: string,
    options?: { aal?: 1 | 2; mfaVerifiedAt?: Date | null },
  ): Promise<{ token: string; sessionId: string }>;
  serviceToken(caller: string): Promise<string>;
  platformWorkspaceId(): Promise<string>;
  /** Inserts an ACTIVE platform operator directly (bootstrap path). */
  createPlatformOperator(name: string): Promise<{ userId: string; profileId: string }>;
  /** Delivers an event to the service's consumers as the broker would. */
  deliver(envelope: EventEnvelope): Promise<void>;
  outbox(
    type?: string,
  ): Promise<Array<{ type: string; schoolId: string | null; payload: Record<string, unknown> }>>;
  close(): Promise<void>;
}

export async function createHarness(): Promise<Harness> {
  const db = await createTestDatabase({
    service: 'administration',
    migrationsDir: join(__dirname, '../../prisma/migrations'),
  });
  const accessKey = await generateSigningJwk('test-access');
  const auditKey = await generateSigningJwk('audit-service');
  const realtimeKey = await generateSigningJwk('realtime-gateway');
  const ownKey = await generateSigningJwk('administration-service');
  const issuer = 'https://identity.aegis.test';

  const config = loadAdministrationConfig({
    NODE_ENV: 'test',
    PORT: '3002',
    LOG_LEVEL: 'silent',
    SERVICE_NAME: 'administration-service',
    SERVICE_PRIVATE_KEY: JSON.stringify(ownKey),
    TRUSTED_SERVICE_KEYS: JSON.stringify({
      'audit-service': publicJwk(auditKey),
      'realtime-gateway': publicJwk(realtimeKey),
    }),
    ACCESS_TOKEN_ISSUER: issuer,
    IDENTITY_JWKS_URL: 'http://identity.test/internal/v1/.well-known/jwks.json',
    IDENTITY_INTERNAL_URL: 'http://identity.test',
    BROKER: 'memory',
    DATABASE_URL: db.appUrl,
  });

  const identityFake = new FakeIdentity();
  const signer = await AccessTokenSigner.fromJwk(accessKey, issuer);
  const signers: Record<string, ServiceTokenSigner> = {
    'audit-service': await ServiceTokenSigner.fromJwk('audit-service', auditKey),
    'realtime-gateway': await ServiceTokenSigner.fromJwk('realtime-gateway', realtimeKey),
  };

  const app = await NestFactory.create<NestFastifyApplication>(
    AdministrationModule.register({
      config,
      identity: identityFake,
      accessTokenVerifier: createAccessTokenVerifier({
        issuer,
        jwks: { keys: [publicJwk(accessKey)] },
      }),
      serviceTokenVerifier: await ServiceTokenVerifier.create(
        'administration-service',
        config.TRUSTED_SERVICE_KEYS,
      ),
    }),
    new FastifyAdapter({ genReqId: correlationIdFor }),
    { logger: false },
  );
  // Listen once on an ephemeral port: concurrent supertest calls against an unstarted server race.
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address();
  const baseUrl =
    typeof address === 'object' && address !== null ? `http://127.0.0.1:${address.port}` : '';
  const handlers = app.get(AdministrationEventHandlers);

  return {
    app,
    db,
    identity: identityFake,
    handlers,
    http: () => request(baseUrl),
    async resetPlatformLease() {
      await withClient(db.ownerUrl, (c) =>
        c.query(
          `UPDATE privileged_access_leases SET status = 'RELEASED' WHERE workspace_type = 'PLATFORM' AND status = 'ACTIVE'`,
        ),
      );
    },
    async login(userId, options = {}) {
      const sessionId = randomUUID();
      const aal = options.aal ?? 2;
      identityFake.sessions.set(sessionId, {
        sessionId,
        userId,
        active: true,
        aal,
        mfaVerifiedAt:
          options.mfaVerifiedAt === undefined
            ? aal === 2
              ? new Date()
              : null
            : options.mfaVerifiedAt,
        userStatus: 'ACTIVE',
      });
      const { token } = await signer.sign({ userId, sessionId, aal }, 300);
      return { token, sessionId };
    },
    async serviceToken(caller) {
      const callerSigner = signers[caller];
      if (callerSigner === undefined) throw new Error(`no signer for ${caller}`);
      return callerSigner.tokenFor('administration-service');
    },
    async platformWorkspaceId() {
      return withClient(
        db.ownerUrl,
        async (c) =>
          (await c.query<{ id: string }>('SELECT id FROM platform_administration_workspaces'))
            .rows[0]?.id ?? '',
      );
    },
    async createPlatformOperator(name) {
      const userId = randomUUID();
      const profileId = randomUUID();
      await withClient(db.ownerUrl, async (c) => {
        await c.query(
          `INSERT INTO platform_admin_operator_profiles (id, workspace_id, user_id, display_name, contact_masked, status, activated_at)
           SELECT $1, id, $2, $3, 'o***@example.org', 'ACTIVE', now() FROM platform_administration_workspaces`,
          [profileId, userId, name],
        );
        await c.query(
          `INSERT INTO role_assignments (user_id, role_key, role_scope, status) VALUES ($1, 'PLATFORM_ADMIN', 'PLATFORM', 'ACTIVE')`,
          [userId],
        );
      });
      return { userId, profileId };
    },
    async deliver(envelope) {
      if (envelope.type === 'identity.invitation.accepted')
        await handlers.onInvitationAccepted(envelope);
      else if (envelope.type === 'identity.session.revoked')
        await handlers.onSessionRevoked(envelope);
      else throw new Error(`unexpected event ${envelope.type}`);
    },
    async outbox(type) {
      return withClient(db.ownerUrl, async (c) => {
        const rows = await c.query<{ envelope: EventEnvelope }>(
          'SELECT envelope FROM outbox_messages ORDER BY created_at, id',
        );
        return rows.rows
          .map((r) => ({
            type: r.envelope.type,
            schoolId: r.envelope.schoolId,
            payload: r.envelope.payload as Record<string, unknown>,
          }))
          .filter((e) => type === undefined || e.type === type);
      });
    },
    async close() {
      await app.close();
      await dropTestDatabase(db);
    },
  };
}

/** Simulates identity-service publishing `invitation.accepted` for a pending invitation request. */
export function invitationAccepted(input: {
  invitationRequestId: string;
  userId: string;
  schoolId: string | null;
}): EventEnvelope {
  return createEnvelope(
    'invitationAccepted',
    {
      invitationRequestId: input.invitationRequestId,
      userId: input.userId,
      sessionId: randomUUID(),
      acceptedAt: new Date().toISOString(),
    },
    { producer: 'identity-service', schoolId: input.schoolId, correlationId: randomUUID() },
  );
}

export function sessionRevoked(input: {
  sessionId: string;
  userId: string;
  reason: 'LOGOUT' | 'USER_REVOKED';
}): EventEnvelope {
  return createEnvelope('sessionRevoked', input, {
    producer: 'identity-service',
    schoolId: null,
    correlationId: randomUUID(),
  });
}

export function idempotencyKey(): string {
  return `it-${randomUUID()}`;
}

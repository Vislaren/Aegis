/**
 * Composed end-to-end test of the Phase 1 journey across services, driven through the public
 * api-gateway. Real: HTTP between services, ES256 service tokens, JWKS fetched from identity,
 * per-service PostgreSQL databases with RLS, transactional outboxes and relays, event consumers,
 * and the gateway's routing and internal-route blocking. Substituted: RabbitMQ (InMemoryBroker)
 * and message delivery (in-memory), because neither can run on the build host.
 */
import { createHmac, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EVENTS, eventRoutingKey, type EventEnvelope } from '@aegis/contracts';
import {
  InMemoryBroker,
  OutboxRelay,
  PLATFORM_CONTEXT,
  correlationIdFor,
  generateSigningJwk,
  publicJwk,
} from '@aegis/service-kit';
import {
  createTestDatabase,
  dropTestDatabase,
  type TestDatabase,
} from '@aegis/service-kit/dist/testing';
import { AdministrationModule } from '../../src/app.module';
import { AdministrationEventHandlers } from '../../src/application/event-handlers';
import { requestInvitation } from '../../src/application/invitations';
import { loadAdministrationConfig } from '../../src/config';
import { PrismaService as AdminPrisma } from '../../src/infrastructure/prisma.service';
import { buildDependencies as buildAdminDeps } from '../../src/runtime';
import { IdentityModule } from '../../../identity-service/src/app.module';
import { ProvisioningService } from '../../../identity-service/src/application/provisioning.service';
import { loadIdentityConfig } from '../../../identity-service/src/config';
import {
  DeliveryDispatcher,
  InMemoryDelivery,
} from '../../../identity-service/src/infrastructure/delivery';
import { buildDependencies as buildIdentityDeps } from '../../../identity-service/src/runtime';
import {
  AuditModule,
  buildDependencies as buildAuditDeps,
} from '../../../audit-service/src/app.module';
import { AuditService } from '../../../audit-service/src/audit.service';
import { loadAuditConfig } from '../../../audit-service/src/config';
import { buildGateway } from '../../../api-gateway/src/gateway';

const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };
const ISSUER = 'https://identity.aegis.test';

/** RFC 6238 TOTP (SHA-1, 30 s, 6 digits) for the test's simulated authenticator app. */
function totp(base32Secret: string, at = Date.now()): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const char of base32Secret.replace(/=+$/, '').toUpperCase())
    bits += alphabet.indexOf(char).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g)?.map((b) => parseInt(b, 2)) ?? []);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)));
  const hmac = createHmac('sha1', key).update(counter).digest();
  const offset = (hmac[hmac.length - 1] ?? 0) & 0x0f;
  const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return code.toString().padStart(6, '0');
}

let dbs: TestDatabase[] = [];
const apps: Array<{ close(): Promise<unknown> }> = [];
const pools: Pool[] = [];
let gateway = '';
let pump: () => Promise<void>;
let delivery: InMemoryDelivery;
let bootstrapOperator: (name: string, contact: string) => Promise<void>;

async function listen(app: NestFastifyApplication): Promise<string> {
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address();
  if (typeof address !== 'object' || address === null) throw new Error('no address');
  return `http://127.0.0.1:${address.port}`;
}

async function call(
  method: string,
  path: string,
  options: { token?: string; body?: unknown; idempotent?: boolean } = {},
) {
  const headers: Record<string, string> =
    options.body === undefined ? {} : { 'content-type': 'application/json' };
  if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`;
  if (options.idempotent === true) headers['idempotency-key'] = `e2e-${randomUUID()}`;
  const response = await fetch(`${gateway}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: (text.length > 0 ? JSON.parse(text) : undefined) as JsonObject,
  };
}

/** Loosely typed JSON for test assertions; values are checked by the assertions themselves. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonObject = Record<string, any>;

const client = () => ({ type: 'NATIVE', deviceId: randomUUID(), platform: 'android' });

/** Redeems the latest invitation sent to `contact`, signs in, and completes MFA enrollment. */
async function acceptInvitationWithMfa(contact: string): Promise<string> {
  await pump();
  const link = delivery.lastTo(contact)?.text.match(/#token=([A-Za-z0-9_-]+)/)?.[1];
  expect(link, `invitation delivered to ${contact}`).toBeDefined();
  const redeem = await call('POST', '/api/v1/auth/invitations/redeem', { body: { token: link } });
  expect(redeem.status).toBe(202);
  await pump();
  const code = delivery.lastTo(contact)?.text.match(/\b(\d{6})\b/)?.[1];
  const verified = await call('POST', '/api/v1/auth/otp/verify', {
    body: { challengeId: redeem.body.challengeId, code, client: client() },
  });
  expect(verified.status).toBe(200);
  expect(verified.body.session.mfaRequiredForPrivilegedUse).toBe(true);
  await pump(); // invitation.accepted -> administration-service activates the profile
  const token = verified.body.tokens.accessToken as string;
  const enroll = await call('POST', '/api/v1/auth/mfa/totp/enroll', { token, body: {} });
  expect(enroll.status).toBe(200);
  const activated = await call('POST', '/api/v1/auth/mfa/totp/activate', {
    token,
    body: { code: totp(enroll.body.secret) },
  });
  expect(activated.status).toBe(200);
  expect(activated.body.session.aal).toBe(2);
  return activated.body.tokens.accessToken as string;
}

/** Signs in an already-active, MFA-enrolled operator on a new device (second independent session). */
async function signInAgain(contact: string, secret: string): Promise<string> {
  const start = await call('POST', '/api/v1/auth/otp/start', { body: { identifier: contact } });
  await pump();
  const code = delivery.lastTo(contact)?.text.match(/\b(\d{6})\b/)?.[1];
  const verified = await call('POST', '/api/v1/auth/otp/verify', {
    body: { challengeId: start.body.challengeId, code, client: client() },
  });
  // A code for the next 30 s step avoids replay rejection of the enrollment code.
  const mfa = await call('POST', '/api/v1/auth/mfa/verify', {
    token: verified.body.tokens.accessToken,
    body: { code: totp(secret, Date.now() + 30_000) },
  });
  expect(mfa.status).toBe(200);
  return mfa.body.tokens.accessToken as string;
}

beforeAll(async () => {
  const migrations = (service: string) => join(__dirname, `../../../${service}/prisma/migrations`);
  const [identityDb, adminDb, auditDb] = await Promise.all([
    createTestDatabase({ service: 'identity', migrationsDir: migrations('identity-service') }),
    createTestDatabase({
      service: 'administration',
      migrationsDir: migrations('administration-service'),
    }),
    createTestDatabase({ service: 'audit', migrationsDir: migrations('audit-service') }),
  ]);
  if (identityDb === undefined || adminDb === undefined || auditDb === undefined)
    throw new Error('databases');
  dbs = [identityDb, adminDb, auditDb];

  const keys = {
    identity: await generateSigningJwk('identity-service'),
    administration: await generateSigningJwk('administration-service'),
    audit: await generateSigningJwk('audit-service'),
    access: await generateSigningJwk('access-e2e'),
  };
  const common = {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    ACCESS_TOKEN_ISSUER: ISSUER,
    BROKER: 'memory',
  };

  // identity-service: started first so the others can fetch its JWKS.
  const identityConfig = loadIdentityConfig({
    ...common,
    PORT: '65000', // nominal: the test listens on ephemeral ports
    SERVICE_NAME: 'identity-service',
    SERVICE_PRIVATE_KEY: JSON.stringify(keys.identity),
    TRUSTED_SERVICE_KEYS: JSON.stringify({
      'administration-service': publicJwk(keys.administration),
      'audit-service': publicJwk(keys.audit),
    }),
    ACCESS_TOKEN_SIGNING_KEY: JSON.stringify(keys.access),
    OTP_PEPPER: 'e2e-pepper-not-secret-0123456789abcdef',
    MFA_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString('base64'),
    DELIVERY: 'memory',
    DATABASE_URL: identityDb.appUrl,
  });
  delivery = new InMemoryDelivery();
  const dispatcher = new DeliveryDispatcher(delivery, silent);
  const identityApp = await NestFactory.create<NestFastifyApplication>(
    IdentityModule.register({ ...(await buildIdentityDeps(identityConfig, silent)), dispatcher }),
    new FastifyAdapter({ genReqId: correlationIdFor }),
    { logger: false },
  );
  const identityUrl = await listen(identityApp);
  apps.push(identityApp);
  const jwksUrl = `${identityUrl}/internal/v1/.well-known/jwks.json`;

  const adminConfig = loadAdministrationConfig({
    ...common,
    PORT: '65000', // nominal: the test listens on ephemeral ports
    SERVICE_NAME: 'administration-service',
    SERVICE_PRIVATE_KEY: JSON.stringify(keys.administration),
    TRUSTED_SERVICE_KEYS: JSON.stringify({ 'audit-service': publicJwk(keys.audit) }),
    IDENTITY_JWKS_URL: jwksUrl,
    IDENTITY_INTERNAL_URL: identityUrl,
    DATABASE_URL: adminDb.appUrl,
  });
  const adminApp = await NestFactory.create<NestFastifyApplication>(
    AdministrationModule.register(await buildAdminDeps(adminConfig)),
    new FastifyAdapter({ genReqId: correlationIdFor }),
    { logger: false },
  );
  const adminUrl = await listen(adminApp);
  apps.push(adminApp);

  const auditConfig = loadAuditConfig({
    ...common,
    PORT: '65000', // nominal: the test listens on ephemeral ports
    SERVICE_NAME: 'audit-service',
    SERVICE_PRIVATE_KEY: JSON.stringify(keys.audit),
    IDENTITY_JWKS_URL: jwksUrl,
    ADMINISTRATION_INTERNAL_URL: adminUrl,
    DATABASE_URL: auditDb.appUrl,
  });
  const auditApp = await NestFactory.create<NestFastifyApplication>(
    AuditModule.register(await buildAuditDeps(auditConfig)),
    new FastifyAdapter({ genReqId: correlationIdFor }),
    { logger: false },
  );
  const auditUrl = await listen(auditApp);
  apps.push(auditApp);

  const gw = await buildGateway({
    serviceName: 'api-gateway',
    environment: 'test',
    logLevel: 'silent',
    upstreams: {
      identity: identityUrl,
      administration: adminUrl,
      audit: auditUrl,
      realtime: 'http://127.0.0.1:9',
    },
    allowedOrigins: ['http://localhost:8081'],
    rateLimitPerMinute: 10_000,
    authRateLimitPerMinute: 10_000,
    openApiDocument: null,
  });
  await gw.listen({ port: 0, host: '127.0.0.1' });
  const gwAddress = gw.server.address();
  gateway =
    typeof gwAddress === 'object' && gwAddress !== null ? `http://127.0.0.1:${gwAddress.port}` : '';
  apps.push(gw);

  // Broker wiring exactly as the workers subscribe.
  const broker = new InMemoryBroker();
  const provisioning = identityApp.get(ProvisioningService);
  const handlers = adminApp.get(AdministrationEventHandlers);
  const auditService = auditApp.get(AuditService);
  await broker.subscribe(
    {
      queue: 'identity-service.events',
      routingKeys: [eventRoutingKey('invitationRequested'), eventRoutingKey('invitationCancelled')],
      durable: true,
    },
    async (e: EventEnvelope) => {
      if (e.type === EVENTS.invitationRequested.type) await provisioning.onInvitationRequested(e);
      else await provisioning.onInvitationCancelled(e);
    },
  );
  await broker.subscribe(
    {
      queue: 'administration-service.events',
      routingKeys: [eventRoutingKey('invitationAccepted'), eventRoutingKey('sessionRevoked')],
      durable: true,
    },
    async (e: EventEnvelope) => {
      if (e.type === EVENTS.invitationAccepted.type) await handlers.onInvitationAccepted(e);
      else await handlers.onSessionRevoked(e);
    },
  );
  await broker.subscribe(
    {
      queue: 'audit-service.events',
      routingKeys: [eventRoutingKey('journalEntry'), eventRoutingKey('securityEvent')],
      durable: true,
      maxAttempts: 3,
    },
    async (e: EventEnvelope) => {
      if (e.type === EVENTS.journalEntry.type) await auditService.onJournalEntry(e);
      else await auditService.onSecurityEvent(e);
    },
  );

  const relays = [identityDb, adminDb].map((db) => {
    const pool = new Pool({ connectionString: db.appUrl, max: 2 });
    pools.push(pool);
    return new OutboxRelay(pool, broker, silent);
  });
  pump = async () => {
    for (let round = 0; round < 10; round += 1) {
      await dispatcher.idle();
      let published = 0;
      for (const relay of relays) published += await relay.drain();
      await dispatcher.idle();
      if (published === 0) return;
    }
  };
  expect(broker.deadLetters).toEqual([]);

  // One-time bootstrap of the first platform operator (same steps as the bootstrap script).
  const adminPrisma = adminApp.get(AdminPrisma);
  const adminDeps = await buildAdminDeps(adminConfig);
  bootstrapOperator = async (name, contact) => {
    const user = await adminDeps.identity.provisionUser(
      { displayName: name, contact },
      { correlationId: randomUUID() },
    );
    await adminPrisma.withContext(PLATFORM_CONTEXT(null), async (tx) => {
      const workspace = await tx.platformAdministrationWorkspace.findFirstOrThrow();
      const invitationRequestId = await requestInvitation(
        tx,
        {
          userId: user.userId,
          schoolId: null,
          schoolName: null,
          kind: 'PLATFORM_OPERATOR',
          role: 'PLATFORM_ADMIN',
        },
        { correlationId: randomUUID(), traceparent: null },
      );
      await tx.platformAdminOperatorProfile.create({
        data: {
          workspaceId: workspace.id,
          userId: user.userId,
          displayName: name,
          contactMasked: user.contactMasked,
          status: 'INVITED',
          invitationRequestId,
        },
      });
      await tx.roleAssignment.create({
        data: {
          userId: user.userId,
          roleKey: 'PLATFORM_ADMIN',
          roleScope: 'PLATFORM',
          status: 'ACTIVE',
        },
      });
    });
  };
}, 180_000);

afterAll(async () => {
  for (const app of apps.reverse()) await app.close().catch(() => undefined);
  for (const pool of pools) await pool.end().catch(() => undefined);
  for (const db of dbs) await dropTestDatabase(db).catch(() => undefined);
});

describe('Phase 1 journey through the gateway', () => {
  it('provisions a school, onboards its administrator, and enforces one operator per workspace', async () => {
    // Internal APIs are never reachable through the public edge.
    expect((await call('POST', '/internal/v1/users/provision', { body: {} })).status).toBe(404);
    expect((await call('GET', '/api/v1/me')).status).toBe(401);

    await bootstrapOperator('Platform Operator Ama Fictional', 'ama.platform@example.org');
    const platformToken = await acceptInvitationWithMfa('ama.platform@example.org');

    const contexts = await call('GET', '/api/v1/access/contexts', { token: platformToken });
    expect(contexts.status).toBe(200);
    expect(contexts.body.platformOperator).toMatchObject({
      displayName: 'Platform Operator Ama Fictional',
      status: 'ACTIVE',
    });

    const lease = await call('POST', '/api/v1/privileged-access/acquire', {
      token: platformToken,
      body: { workspace: { type: 'PLATFORM' } },
    });
    expect(lease.status).toBe(200);
    expect(lease.body.operator.displayName).toBe('Platform Operator Ama Fictional');

    const provisioned = await call('POST', '/api/v1/platform/schools', {
      token: platformToken,
      idempotent: true,
      body: {
        name: 'Fictional Lakeside Academy',
        slug: 'lakeside',
        timezone: 'Africa/Douala',
        countryCode: 'CM',
        defaultLanguage: 'fr',
        firstAdministrator: {
          displayName: 'Head Admin Bello Fictional',
          contact: 'bello.head@example.org',
        },
      },
    });
    expect(provisioned.status).toBe(201);
    const schoolId = provisioned.body.school.schoolId as string;

    // The school's first administrator accepts, enrolls MFA, and opens the school workspace.
    const schoolToken = await acceptInvitationWithMfa('bello.head@example.org');
    const schoolLease = await call('POST', '/api/v1/privileged-access/acquire', {
      token: schoolToken,
      body: { workspace: { type: 'SCHOOL', schoolId } },
    });
    expect(schoolLease.status).toBe(200);
    expect(schoolLease.body.workspace.schoolName).toBe('Fictional Lakeside Academy');

    const driver = await call('POST', `/api/v1/schools/${schoolId}/user-invitations`, {
      token: schoolToken,
      idempotent: true,
      body: { displayName: 'Driver Kofi Fictional', contact: '+237600009001', role: 'DRIVER' },
    });
    expect(driver.status).toBe(201);
    const guardian = await call('POST', `/api/v1/schools/${schoolId}/user-invitations`, {
      token: schoolToken,
      idempotent: true,
      body: {
        displayName: 'Guardian Abena Fictional',
        contact: 'abena@example.org',
        role: 'GUARDIAN',
      },
    });
    expect(guardian.status).toBe(201);

    // The driver accepts their invitation (no MFA required for drivers) and sees only a driver context.
    await pump();
    const driverLink = delivery.lastTo('+237600009001')?.text.match(/#token=([A-Za-z0-9_-]+)/)?.[1];
    const driverRedeem = await call('POST', '/api/v1/auth/invitations/redeem', {
      body: { token: driverLink },
    });
    await pump();
    const driverCode = delivery.lastTo('+237600009001')?.text.match(/\b(\d{6})\b/)?.[1];
    const driverSession = await call('POST', '/api/v1/auth/otp/verify', {
      body: { challengeId: driverRedeem.body.challengeId, code: driverCode, client: client() },
    });
    expect(driverSession.body.session.mfaRequiredForPrivilegedUse).toBe(false);
    await pump();
    const driverToken = driverSession.body.tokens.accessToken as string;
    const driverContexts = await call('GET', '/api/v1/access/contexts', { token: driverToken });
    expect(driverContexts.body.schools).toEqual([
      expect.objectContaining({
        schoolId,
        roles: ['DRIVER'],
        membershipStatus: 'ACTIVE',
        operatorProfile: null,
      }),
    ]);
    expect(driverContexts.body.platformOperator).toBeNull();
    // A driver can neither administer the school nor acquire its workspace.
    expect(
      (await call('GET', `/api/v1/schools/${schoolId}/memberships`, { token: driverToken })).status,
    ).toBe(404);
    expect(
      (
        await call('POST', '/api/v1/privileged-access/acquire', {
          token: driverToken,
          body: { workspace: { type: 'SCHOOL', schoolId } },
        })
      ).status,
    ).toBe(404);

    // Journals: platform sees provisioning; school sees its own invitations, never the reverse.
    await pump();
    const platformJournal = await call('GET', '/api/v1/administration/activity-journal?limit=50', {
      token: platformToken,
    });
    expect(platformJournal.status).toBe(200);
    expect(platformJournal.body.chainVerified).toBe(true);
    const platformActions = platformJournal.body.items.map((i: { action: string }) => i.action);
    expect(platformActions).toEqual(
      expect.arrayContaining([
        'PRIVILEGED_LEASE_ACQUIRED',
        'SCHOOL_PROVISIONED',
        'SCHOOL_OPERATOR_CREATED',
        'INVITATION_ACCEPTED',
      ]),
    );
    expect(platformActions).not.toContain('SCHOOL_USER_INVITED');

    const schoolJournal = await call('GET', '/api/v1/administration/activity-journal?limit=50', {
      token: schoolToken,
    });
    expect(schoolJournal.status).toBe(200);
    expect(schoolJournal.body.chainVerified).toBe(true);
    const schoolEntries = schoolJournal.body.items as Array<{
      action: string;
      actorUserId: string | null;
      schoolId: string;
    }>;
    expect(schoolEntries.map((e) => e.action)).toEqual(
      expect.arrayContaining(['SCHOOL_USER_INVITED', 'PRIVILEGED_LEASE_ACQUIRED']),
    );
    expect(schoolEntries.every((e) => e.schoolId === schoolId)).toBe(true);
    expect(schoolEntries.map((e) => e.action)).not.toContain('SCHOOL_PROVISIONED');

    // Logout releases the platform lease through identity -> broker -> administration.
    expect((await call('POST', '/api/v1/auth/logout', { token: platformToken })).status).toBe(204);
    await pump();
    expect((await call('GET', '/api/v1/platform/schools', { token: platformToken })).status).toBe(
      401,
    );
    const security = await call('GET', '/api/v1/me/security-events', { token: schoolToken });
    expect(security.status).toBe(200);
    expect(security.body.items.map((e: { eventType: string }) => e.eventType)).toEqual(
      expect.arrayContaining(['INVITATION_ACCEPTED', 'MFA_ENROLLED']),
    );
  });

  it('denies a second independent platform session while the workspace is held, then grants it after release', async () => {
    await bootstrapOperator('Platform Operator Two Fictional', 'two.platform@example.org').catch(
      () => undefined,
    );
    // Use the stored TOTP secret path: enroll during invitation acceptance, then sign in on a second device.
    await pump();
    const link = delivery
      .lastTo('two.platform@example.org')
      ?.text.match(/#token=([A-Za-z0-9_-]+)/)?.[1];
    const redeem = await call('POST', '/api/v1/auth/invitations/redeem', { body: { token: link } });
    await pump();
    const code = delivery.lastTo('two.platform@example.org')?.text.match(/\b(\d{6})\b/)?.[1];
    const verified = await call('POST', '/api/v1/auth/otp/verify', {
      body: { challengeId: redeem.body.challengeId, code, client: client() },
    });
    await pump();
    const enroll = await call('POST', '/api/v1/auth/mfa/totp/enroll', {
      token: verified.body.tokens.accessToken,
      body: {},
    });
    const secret = enroll.body.secret as string;
    const first = await call('POST', '/api/v1/auth/mfa/totp/activate', {
      token: verified.body.tokens.accessToken,
      body: { code: totp(secret) },
    });
    const deviceA = first.body.tokens.accessToken as string;
    const deviceB = await signInAgain('two.platform@example.org', secret);

    const held = await call('POST', '/api/v1/privileged-access/acquire', {
      token: deviceA,
      body: { workspace: { type: 'PLATFORM' } },
    });
    expect(held.status).toBe(200);
    const denied = await call('POST', '/api/v1/privileged-access/acquire', {
      token: deviceB,
      body: { workspace: { type: 'PLATFORM' } },
    });
    expect(denied.status).toBe(409);
    expect(denied.body.code).toBe('ADMIN_WORKSPACE_IN_USE');
    expect(denied.body.occupancy.operatorDisplayName).toBe('Platform Operator Two Fictional');

    expect(
      (
        await call('POST', '/api/v1/privileged-access/release', {
          token: deviceA,
          body: { grantId: held.body.grantId },
        })
      ).status,
    ).toBe(204);
    expect(
      (
        await call('POST', '/api/v1/privileged-access/acquire', {
          token: deviceB,
          body: { workspace: { type: 'PLATFORM' } },
        })
      ).status,
    ).toBe(200);
  });
});

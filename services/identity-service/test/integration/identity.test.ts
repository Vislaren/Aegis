import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { generateSync } from 'otplib';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EventEnvelope } from '@aegis/contracts';
import {
  ServiceTokenSigner,
  ServiceTokenVerifier,
  correlationIdFor,
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
import { IdentityModule } from '../../src/app.module';
import { ProvisioningService } from '../../src/application/provisioning.service';
import { loadIdentityConfig } from '../../src/config';
import { DeliveryDispatcher, InMemoryDelivery } from '../../src/infrastructure/delivery';
import { buildDependencies } from '../../src/runtime';

let db: TestDatabase;
let app: NestFastifyApplication;
let provisioning: ProvisioningService;
let adminSigner: ServiceTokenSigner;
const delivery = new InMemoryDelivery();
let dispatcher: DeliveryDispatcher;

const http = () => request(app.getHttpServer());
const nativeClient = (deviceId = randomUUID()) => ({
  type: 'NATIVE' as const,
  deviceId,
  platform: 'android' as const,
});

async function lastCode(destination: string): Promise<string> {
  await dispatcher.idle();
  const message = delivery.lastTo(destination);
  const code = message?.text.match(/\b(\d{6})\b/)?.[1];
  if (code === undefined) throw new Error(`no code delivered to ${destination}`);
  return code;
}

async function outbox(type: string): Promise<EventEnvelope[]> {
  return withClient(db.ownerUrl, async (c) =>
    (
      await c.query<{ envelope: EventEnvelope }>(
        'SELECT envelope FROM outbox_messages ORDER BY created_at',
      )
    ).rows
      .map((r) => r.envelope)
      .filter((e) => e.type === type),
  );
}

/** Provisions a user through the internal API and redeems an invitation, returning a native session. */
async function invitedAndActivated(
  contact: string,
  kind: 'SCHOOL_MEMBER' | 'SCHOOL_OPERATOR' = 'SCHOOL_MEMBER',
) {
  const provisioned = await http()
    .post('/internal/v1/users/provision')
    .set('x-service-token', await adminSigner.tokenFor('identity-service'))
    .send({ displayName: 'Invitee Fictional', contact });
  expect(provisioned.status).toBe(200);
  const userId: string = provisioned.body.userId;
  const invitationRequestId = randomUUID();
  const schoolId = randomUUID();
  await provisioning.onInvitationRequested(
    createEnvelope(
      'invitationRequested',
      {
        invitationRequestId,
        userId,
        schoolId,
        schoolName: 'Fictional Academy',
        kind,
        role: kind === 'SCHOOL_MEMBER' ? 'GUARDIAN' : 'SCHOOL_ADMIN',
      },
      { producer: 'administration-service', schoolId, correlationId: randomUUID() },
    ),
  );
  await dispatcher.idle();
  const token = delivery.lastTo(contact)?.text.match(/#token=([A-Za-z0-9_-]+)/)?.[1];
  if (token === undefined) throw new Error('no invitation link delivered');
  const redeem = await http().post('/api/v1/auth/invitations/redeem').send({ token });
  expect(redeem.status).toBe(202);
  const verify = await http()
    .post('/api/v1/auth/otp/verify')
    .send({
      challengeId: redeem.body.challengeId,
      code: await lastCode(contact),
      client: nativeClient(),
    });
  expect(verify.status).toBe(200);
  return { userId, schoolId, invitationRequestId, token, session: verify.body };
}

beforeAll(async () => {
  db = await createTestDatabase({
    service: 'identity',
    migrationsDir: join(__dirname, '../../prisma/migrations'),
  });
  const adminKey = await generateSigningJwk('administration-service');
  adminSigner = await ServiceTokenSigner.fromJwk('administration-service', adminKey);
  const config = loadIdentityConfig({
    NODE_ENV: 'test',
    PORT: '3001',
    LOG_LEVEL: 'silent',
    SERVICE_NAME: 'identity-service',
    SERVICE_PRIVATE_KEY: JSON.stringify(await generateSigningJwk('identity-service')),
    TRUSTED_SERVICE_KEYS: JSON.stringify({ 'administration-service': publicJwk(adminKey) }),
    ACCESS_TOKEN_ISSUER: 'https://identity.aegis.test',
    ACCESS_TOKEN_SIGNING_KEY: JSON.stringify(await generateSigningJwk('access-1')),
    OTP_PEPPER: 'test-pepper-not-secret-0123456789abcdef',
    MFA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    DELIVERY: 'memory',
    BROKER: 'memory',
    DATABASE_URL: db.appUrl,
  });
  const deps = await buildDependencies(config, { warn: () => undefined, error: () => undefined });
  dispatcher = new DeliveryDispatcher(delivery, { error: () => undefined });
  app = await NestFactory.create<NestFastifyApplication>(
    IdentityModule.register({
      ...deps,
      dispatcher,
      serviceTokenVerifier: await ServiceTokenVerifier.create(
        'identity-service',
        config.TRUSTED_SERVICE_KEYS,
      ),
    }),
    new FastifyAdapter({ genReqId: correlationIdFor }),
    { logger: false },
  );
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  provisioning = app.get(ProvisioningService);
}, 120_000);

afterAll(async () => {
  await app?.close();
  if (db !== undefined) await dropTestDatabase(db);
});

describe('one-time-code sign-in', () => {
  it('responds identically for unknown identifiers and delivers nothing', async () => {
    const unknown = await http()
      .post('/api/v1/auth/otp/start')
      .send({ identifier: 'nobody@example.org' });
    expect(unknown.status).toBe(202);
    expect(Object.keys(unknown.body).sort()).toEqual(['challengeId', 'expiresAt']);
    await dispatcher.idle();
    expect(delivery.lastTo('nobody@example.org')).toBeUndefined();
    // No code can ever verify an undeliverable challenge.
    const guess = await http()
      .post('/api/v1/auth/otp/verify')
      .send({ challengeId: unknown.body.challengeId, code: '000000', client: nativeClient() });
    expect(guess.status).toBe(400);
    expect(guess.body.code).toBe('OTP_INVALID');
  });

  it('does not let an invited-but-unredeemed identity sign in with a plain code', async () => {
    await http()
      .post('/internal/v1/users/provision')
      .set('x-service-token', await adminSigner.tokenFor('identity-service'))
      .send({ displayName: 'Pending Fictional', contact: 'pending@example.org' });
    await http().post('/api/v1/auth/otp/start').send({ identifier: 'pending@example.org' });
    await dispatcher.idle();
    expect(delivery.lastTo('pending@example.org')).toBeUndefined();
  });

  it('throttles challenges per destination', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 6; i += 1)
      statuses.push(
        (await http().post('/api/v1/auth/otp/start').send({ identifier: '+237699000001' })).status,
      );
    expect(statuses.slice(0, 5).every((s) => s === 202)).toBe(true);
    expect(statuses[5]).toBe(429);
  });

  it('signs in an active user once per code and exhausts a challenge after repeated failures', async () => {
    const { userId } = await invitedAndActivated('kofi.driver@example.org');
    const start = await http()
      .post('/api/v1/auth/otp/start')
      .send({ identifier: 'Kofi.Driver@example.org' });
    const code = await lastCode('kofi.driver@example.org');
    const ok = await http()
      .post('/api/v1/auth/otp/verify')
      .send({ challengeId: start.body.challengeId, code, client: nativeClient() });
    expect(ok.status).toBe(200);
    expect(ok.body.session).toMatchObject({ userId, aal: 1 });
    expect(ok.body.tokens.accessToken).toBeTruthy();
    const replay = await http()
      .post('/api/v1/auth/otp/verify')
      .send({ challengeId: start.body.challengeId, code, client: nativeClient() });
    expect(replay.status).toBe(400);

    const second = await http()
      .post('/api/v1/auth/otp/start')
      .send({ identifier: 'kofi.driver@example.org' });
    const realCode = await lastCode('kofi.driver@example.org');
    const wrong = realCode === '111111' ? '222222' : '111111';
    for (let i = 0; i < 5; i += 1) {
      await http()
        .post('/api/v1/auth/otp/verify')
        .send({ challengeId: second.body.challengeId, code: wrong, client: nativeClient() });
    }
    const late = await http()
      .post('/api/v1/auth/otp/verify')
      .send({ challengeId: second.body.challengeId, code: realCode, client: nativeClient() });
    expect(late.status).toBe(400);
  });

  it('sets HttpOnly cookies and returns no tokens for web clients', async () => {
    await invitedAndActivated('web.guardian@example.org');
    const start = await http()
      .post('/api/v1/auth/otp/start')
      .send({ identifier: 'web.guardian@example.org' });
    const res = await http()
      .post('/api/v1/auth/otp/verify')
      .send({
        challengeId: start.body.challengeId,
        code: await lastCode('web.guardian@example.org'),
        client: { type: 'WEB', deviceId: randomUUID(), platform: 'web' },
      });
    expect(res.status).toBe(200);
    expect(res.body.tokens).toBeNull();
    const cookies: string[] = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
    expect(cookies.find((c) => c.startsWith('aegis_at='))).toMatch(/HttpOnly/);
    expect(cookies.find((c) => c.startsWith('aegis_rt='))).toMatch(
      /HttpOnly.*|Path=\/api\/v1\/auth/,
    );
    expect(cookies.find((c) => c.startsWith('aegis_csrf='))).not.toMatch(/HttpOnly/);
  });
});

describe('invitations', () => {
  it('activates the identity, verifies the contact, and publishes invitation.accepted with the school', async () => {
    const result = await invitedAndActivated('+237699000777');
    const accepted = (await outbox('identity.invitation.accepted')).find(
      (e) => (e.payload as { userId: string }).userId === result.userId,
    );
    expect(accepted?.schoolId).toBe(result.schoolId);
    expect(accepted?.payload).toMatchObject({ invitationRequestId: result.invitationRequestId });
    const user = await withClient(db.ownerUrl, (c) =>
      c.query('SELECT status, phone_verified_at FROM users WHERE id = $1', [result.userId]),
    );
    expect(user.rows[0].status).toBe('ACTIVE');
    expect(user.rows[0].phone_verified_at).not.toBeNull();

    // Single use.
    const again = await http()
      .post('/api/v1/auth/invitations/redeem')
      .send({ token: result.token });
    expect(again.status).toBe(400);
    expect(again.body.code).toBe('INVITATION_INVALID');
  });

  it('rejects expired invitations', async () => {
    const provisioned = await http()
      .post('/internal/v1/users/provision')
      .set('x-service-token', await adminSigner.tokenFor('identity-service'))
      .send({ displayName: 'Late Fictional', contact: 'late@example.org' });
    await provisioning.onInvitationRequested(
      createEnvelope(
        'invitationRequested',
        {
          invitationRequestId: randomUUID(),
          userId: provisioned.body.userId,
          schoolId: null,
          schoolName: null,
          kind: 'PLATFORM_OPERATOR',
          role: 'PLATFORM_ADMIN',
        },
        { producer: 'administration-service', schoolId: null, correlationId: randomUUID() },
      ),
    );
    await dispatcher.idle();
    const token = delivery.lastTo('late@example.org')?.text.match(/#token=([A-Za-z0-9_-]+)/)?.[1];
    await withClient(db.ownerUrl, (c) =>
      c.query(
        `UPDATE invitations SET expires_at = now() - interval '1 minute' WHERE user_id = $1`,
        [provisioned.body.userId],
      ),
    );
    const res = await http().post('/api/v1/auth/invitations/redeem').send({ token });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVITATION_INVALID');
  });

  it('provisions idempotently by contact and only for the administration service', async () => {
    const body = { displayName: 'Same Person Fictional', contact: 'same.person@example.org' };
    const first = await http()
      .post('/internal/v1/users/provision')
      .set('x-service-token', await adminSigner.tokenFor('identity-service'))
      .send(body);
    const second = await http()
      .post('/internal/v1/users/provision')
      .set('x-service-token', await adminSigner.tokenFor('identity-service'))
      .send(body);
    expect(second.body.userId).toBe(first.body.userId);
    expect(second.body.created).toBe(false);
    expect((await http().post('/internal/v1/users/provision').send(body)).status).toBe(401);
  });
});

describe('multi-factor authentication', () => {
  it('enrolls, raises the session to AAL2, rejects code replay, and revokes after repeated failures', async () => {
    const { session } = await invitedAndActivated('operator.mfa@example.org', 'SCHOOL_OPERATOR');
    expect(session.session.mfaRequiredForPrivilegedUse).toBe(true);
    const auth = { authorization: `Bearer ${session.tokens.accessToken}` };

    const enroll = await http().post('/api/v1/auth/mfa/totp/enroll').set(auth).send({});
    expect(enroll.status).toBe(200);
    const secret: string = enroll.body.secret;
    const code = generateSync({ secret });
    const activated = await http().post('/api/v1/auth/mfa/totp/activate').set(auth).send({ code });
    expect(activated.status).toBe(200);
    expect(activated.body.session.aal).toBe(2);

    const upgraded = { authorization: `Bearer ${activated.body.tokens.accessToken}` };
    const replay = await http().post('/api/v1/auth/mfa/verify').set(upgraded).send({ code });
    expect(replay.status).toBe(400);
    for (let i = 0; i < 4; i += 1)
      await http().post('/api/v1/auth/mfa/verify').set(upgraded).send({ code: '000000' });
    expect((await http().get('/api/v1/me').set(upgraded)).status).toBe(401);
    expect(
      (await outbox('identity.session.revoked')).some(
        (e) => (e.payload as { sessionId: string }).sessionId === session.session.sessionId,
      ),
    ).toBe(true);
  });
});

describe('sessions', () => {
  it('rotates refresh tokens and revokes the session when a rotated token is reused', async () => {
    const { session } = await invitedAndActivated('rotation@example.org');
    const first = session.tokens.refreshToken as string;
    const rotated = await http().post('/api/v1/auth/refresh').send({ refreshToken: first });
    expect(rotated.status).toBe(200);
    const reuse = await http().post('/api/v1/auth/refresh').send({ refreshToken: first });
    expect(reuse.status).toBe(401);
    // The legitimate holder's newer token is dead too: the whole session ended.
    const newer = await http()
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: rotated.body.tokens.refreshToken });
    expect(newer.status).toBe(401);
    const revoked = (await outbox('identity.session.revoked')).find(
      (e) => (e.payload as { sessionId: string }).sessionId === session.session.sessionId,
    );
    expect(revoked?.payload).toMatchObject({ reason: 'REFRESH_REUSE' });
  });

  it('logout ends access immediately and lets users revoke only their own sessions', async () => {
    const a = await invitedAndActivated('logout.a@example.org');
    const b = await invitedAndActivated('logout.b@example.org');
    const authA = { authorization: `Bearer ${a.session.tokens.accessToken}` };
    const foreign = await http()
      .post(`/api/v1/me/sessions/${b.session.session.sessionId}/revoke`)
      .set(authA);
    expect(foreign.status).toBe(404);
    expect((await http().get('/api/v1/me').set(authA)).status).toBe(200);
    expect((await http().post('/api/v1/auth/logout').set(authA)).status).toBe(204);
    // The access token is still cryptographically valid, but the session is gone.
    expect((await http().get('/api/v1/me').set(authA)).status).toBe(401);
  });

  it('introspects sessions for allowlisted services only', async () => {
    const a = await invitedAndActivated('introspect@example.org');
    const path = `/internal/v1/sessions/${a.session.session.sessionId}`;
    expect((await http().get(path)).status).toBe(401);
    const res = await http()
      .get(path)
      .set('x-service-token', await adminSigner.tokenFor('identity-service'));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ active: true, aal: 1, userStatus: 'ACTIVE' });
  });

  it('records consent only for the current policy version', async () => {
    const a = await invitedAndActivated('consent@example.org');
    const auth = { authorization: `Bearer ${a.session.tokens.accessToken}` };
    const policies = await http().get('/api/v1/policies/current');
    const privacy = policies.body.documents.find(
      (d: { type: string }) => d.type === 'PRIVACY_NOTICE',
    );
    expect(
      (
        await http()
          .post('/api/v1/me/consents')
          .set(auth)
          .send({ documentType: 'PRIVACY_NOTICE', documentVersion: privacy.version })
      ).status,
    ).toBe(201);
    expect(
      (
        await http()
          .post('/api/v1/me/consents')
          .set(auth)
          .send({ documentType: 'PRIVACY_NOTICE', documentVersion: '2020-01-01' })
      ).status,
    ).toBe(400);
    await withClient(db.ownerUrl, async (c) => {
      await expect(c.query('DELETE FROM consent_records')).rejects.toThrow(/append-only/);
    });
  });
});

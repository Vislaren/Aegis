import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { administration, EventEnvelope } from '@aegis/contracts';
import {
  AccessTokenSigner,
  AppError,
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
import { AuditModule } from '../../src/app.module';
import { AuditService } from '../../src/audit.service';
import { loadAuditConfig } from '../../src/config';
import type { LeaseValidationPort } from '../../src/infrastructure';

const SCHOOL_A = randomUUID();
const SCHOOL_B = randomUUID();
const WORKSPACE_A = randomUUID();
const WORKSPACE_B = randomUUID();
const PLATFORM_WS = randomUUID();

/** Lease validation fake: sessions map to the lease administration-service would report. */
class FakeLeases implements LeaseValidationPort {
  readonly leases = new Map<string, administration.ValidatedLease>();
  async validate(input: { sessionId: string }): Promise<administration.ValidatedLease> {
    const lease = this.leases.get(input.sessionId);
    if (lease === undefined) throw new AppError('PRIVILEGED_LEASE_REQUIRED');
    return lease;
  }
}

let db: TestDatabase;
let app: NestFastifyApplication;
let service: AuditService;
let signer: AccessTokenSigner;
const leases = new FakeLeases();

function journalEvent(input: {
  workspaceType: 'PLATFORM' | 'SCHOOL';
  workspaceId: string;
  schoolId: string | null;
  action: string;
  actor: string;
}): EventEnvelope {
  return createEnvelope(
    'journalEntry',
    {
      workspaceType: input.workspaceType,
      workspaceId: input.workspaceId,
      actorUserId: input.actor,
      operatorProfileId: randomUUID(),
      sessionId: randomUUID(),
      grantId: randomUUID(),
      fencingToken: 3,
      originService: 'administration-service',
      action: input.action,
      targetType: 'MEMBERSHIP',
      targetId: randomUUID(),
      outcome: 'SUCCESS',
      sourceIp: '203.0.113.10',
      userAgent: 'integration-test',
      changes: { before: null, after: { status: 'INVITED' } },
    },
    { producer: 'administration-service', schoolId: input.schoolId, correlationId: randomUUID() },
  );
}

async function sessionWithLease(
  lease: Omit<
    administration.ValidatedLease,
    'grantId' | 'fencingToken' | 'operatorProfileId' | 'operatorDisplayName' | 'expiresAt'
  >,
) {
  const userId = randomUUID();
  const sessionId = randomUUID();
  leases.leases.set(sessionId, {
    ...lease,
    grantId: randomUUID(),
    fencingToken: 1,
    operatorProfileId: randomUUID(),
    operatorDisplayName: 'Operator Fictional',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  const { token } = await signer.sign({ userId, sessionId, aal: 2 }, 300);
  return { token, userId, sessionId };
}

beforeAll(async () => {
  db = await createTestDatabase({
    service: 'audit',
    migrationsDir: join(__dirname, '../../prisma/migrations'),
  });
  const key = await generateSigningJwk('test');
  const issuer = 'https://identity.aegis.test';
  signer = await AccessTokenSigner.fromJwk(key, issuer);
  const config = loadAuditConfig({
    NODE_ENV: 'test',
    PORT: '3003',
    LOG_LEVEL: 'silent',
    SERVICE_NAME: 'audit-service',
    SERVICE_PRIVATE_KEY: JSON.stringify(await generateSigningJwk('audit-service')),
    ACCESS_TOKEN_ISSUER: issuer,
    IDENTITY_JWKS_URL: 'http://identity.test/jwks',
    ADMINISTRATION_INTERNAL_URL: 'http://administration.test',
    BROKER: 'memory',
    DATABASE_URL: db.appUrl,
  });
  app = await NestFactory.create<NestFastifyApplication>(
    AuditModule.register({
      config,
      leaseValidation: leases,
      accessTokenVerifier: createAccessTokenVerifier({ issuer, jwks: { keys: [publicJwk(key)] } }),
      serviceTokenVerifier: null,
    }),
    new FastifyAdapter({ genReqId: correlationIdFor }),
    { logger: false },
  );
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  service = app.get(AuditService);
}, 120_000);

afterAll(async () => {
  await app?.close();
  if (db !== undefined) await dropTestDatabase(db);
});

describe('journal ingestion', () => {
  it('chains entries per workspace, verifies, and ignores redelivery', async () => {
    const events = [
      journalEvent({
        workspaceType: 'SCHOOL',
        workspaceId: WORKSPACE_A,
        schoolId: SCHOOL_A,
        action: 'SCHOOL_USER_INVITED',
        actor: randomUUID(),
      }),
      journalEvent({
        workspaceType: 'SCHOOL',
        workspaceId: WORKSPACE_A,
        schoolId: SCHOOL_A,
        action: 'MEMBERSHIP_SUSPENDED',
        actor: randomUUID(),
      }),
      journalEvent({
        workspaceType: 'SCHOOL',
        workspaceId: WORKSPACE_B,
        schoolId: SCHOOL_B,
        action: 'SCHOOL_USER_INVITED',
        actor: randomUUID(),
      }),
      journalEvent({
        workspaceType: 'PLATFORM',
        workspaceId: PLATFORM_WS,
        schoolId: SCHOOL_A,
        action: 'SCHOOL_PROVISIONED',
        actor: randomUUID(),
      }),
    ];
    // Concurrent ingestion into the same chain must not fork it.
    await Promise.all(events.map((e) => service.onJournalEntry(e)));
    const first = events[0];
    if (first === undefined) throw new Error('no event');
    await service.onJournalEntry(first);

    const rows = await withClient(db.ownerUrl, (c) =>
      c.query<{ chain_key: string; chain_position: string }>(
        'SELECT chain_key, chain_position FROM activity_journal ORDER BY chain_key, chain_position',
      ),
    );
    expect(rows.rowCount).toBe(4);
    expect(
      rows.rows
        .filter((r) => r.chain_key === `SCHOOL:${WORKSPACE_A}`)
        .map((r) => Number(r.chain_position)),
    ).toEqual([1, 2]);
    expect(await service.verifyChain(`SCHOOL:${WORKSPACE_A}`)).toBeNull();
  });

  it('cannot be altered or deleted by any role, and tampering is detectable', async () => {
    await withClient(db.appUrl, async (c) => {
      await expect(
        c.query(`UPDATE activity_journal SET action = 'NOTHING_HAPPENED'`),
      ).rejects.toThrow(/permission denied/);
      await expect(c.query('DELETE FROM activity_journal')).rejects.toThrow(/permission denied/);
    });
    await withClient(db.ownerUrl, async (c) => {
      await expect(
        c.query(`UPDATE activity_journal SET action = 'NOTHING_HAPPENED'`),
      ).rejects.toThrow(/append-only/);
      await expect(c.query('DELETE FROM activity_journal')).rejects.toThrow(/append-only/);
      await expect(c.query('TRUNCATE activity_journal')).rejects.toThrow(/append-only/);
      // Simulate a privileged attacker who disables the guard: the hash chain exposes the edit.
      await c.query('BEGIN');
      await c.query('ALTER TABLE activity_journal DISABLE TRIGGER activity_journal_append_only');
      await c.query(
        `UPDATE activity_journal SET action = 'NOTHING_HAPPENED' WHERE chain_key = $1 AND chain_position = 1`,
        [`SCHOOL:${WORKSPACE_A}`],
      );
      const broken = await c.query<{ broken: string | null }>(
        'SELECT aegis_verify_journal_chain($1) AS broken',
        [`SCHOOL:${WORKSPACE_A}`],
      );
      expect(broken.rows[0]?.broken).toBe('1');
      await c.query('ROLLBACK');
    });
  });

  it('records security events idempotently', async () => {
    const userId = randomUUID();
    const event = createEnvelope(
      'securityEvent',
      {
        userId,
        sessionId: null,
        eventType: 'LOGIN_SUCCEEDED',
        outcome: 'SUCCESS',
        sourceIp: null,
        userAgent: null,
        details: {},
      },
      { producer: 'identity-service', schoolId: null, correlationId: randomUUID() },
    );
    await service.onSecurityEvent(event);
    await service.onSecurityEvent(event);
    const { token } = await signer.sign({ userId, sessionId: randomUUID(), aal: 1 }, 300);
    const res = await request(app.getHttpServer())
      .get('/api/v1/me/security-events')
      .set('authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].eventType).toBe('LOGIN_SUCCEEDED');
  });
});

describe('journal search', () => {
  it('returns only the leased workspace, with a verified chain', async () => {
    const operatorA = await sessionWithLease({
      workspaceType: 'SCHOOL',
      workspaceId: WORKSPACE_A,
      schoolId: SCHOOL_A,
    });
    const res = await request(app.getHttpServer())
      .get('/api/v1/administration/activity-journal')
      .set('authorization', `Bearer ${operatorA.token}`);
    expect(res.status).toBe(200);
    expect(res.body.chainVerified).toBe(true);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.items.every((i: { schoolId: string }) => i.schoolId === SCHOOL_A)).toBe(true);

    // The platform sees its own chain only, never school operators' journals.
    const platform = await sessionWithLease({
      workspaceType: 'PLATFORM',
      workspaceId: PLATFORM_WS,
      schoolId: null,
    });
    const platformRes = await request(app.getHttpServer())
      .get('/api/v1/administration/activity-journal')
      .set('authorization', `Bearer ${platform.token}`);
    expect(platformRes.status).toBe(200);
    expect(platformRes.body.items.map((i: { action: string }) => i.action)).toEqual([
      'SCHOOL_PROVISIONED',
    ]);
  });

  it('is denied without a live privileged lease', async () => {
    const { token } = await signer.sign(
      { userId: randomUUID(), sessionId: randomUUID(), aal: 2 },
      300,
    );
    const res = await request(app.getHttpServer())
      .get('/api/v1/administration/activity-journal')
      .set('authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PRIVILEGED_LEASE_REQUIRED');
  });

  it('never reads another school even if the database context were wrong', async () => {
    await withClient(db.appUrl, async (c) => {
      await c.query('BEGIN');
      await c.query(
        `SELECT set_config('aegis.context', 'school', true), set_config('aegis.school_id', $1, true)`,
        [SCHOOL_B],
      );
      const visible = await c.query<{ school_id: string }>(
        'SELECT school_id FROM activity_journal',
      );
      expect(visible.rows.every((r) => r.school_id === SCHOOL_B)).toBe(true);
      await c.query('ROLLBACK');
    });
  });
});

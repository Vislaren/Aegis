import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withClient } from '@aegis/service-kit/dist/testing';
import {
  createHarness,
  idempotencyKey,
  invitationAccepted,
  sessionRevoked,
  type Harness,
} from './harness';

let h: Harness;

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

async function acquirePlatform(token: string) {
  return h
    .http()
    .post('/api/v1/privileged-access/acquire')
    .set(bearer(token))
    .send({ workspace: { type: 'PLATFORM' } });
}

async function provisionSchool(token: string, slug: string, adminContact: string) {
  return h
    .http()
    .post('/api/v1/platform/schools')
    .set({ ...bearer(token), 'idempotency-key': idempotencyKey() })
    .send({
      name: `Fictional ${slug} Academy`,
      slug,
      timezone: 'Africa/Douala',
      countryCode: 'CM',
      defaultLanguage: 'fr',
      firstAdministrator: { displayName: `Admin ${slug} Fictional`, contact: adminContact },
    });
}

/** Provisions a school and activates its first administrator through the invitation event. */
async function schoolWithActiveAdmin(platformToken: string, slug: string) {
  const contact = `admin.${slug}@example.org`;
  const res = await provisionSchool(platformToken, slug, contact);
  expect(res.status).toBe(201);
  const schoolId: string = res.body.school.schoolId;
  const adminUserId: string = res.body.firstAdministrator.userId;
  const requested = (await h.outbox('administration.invitation.requested')).find(
    (e) => e.payload.userId === adminUserId,
  );
  if (requested === undefined) throw new Error('invitation request missing');
  await h.deliver(
    invitationAccepted({
      invitationRequestId: String(requested.payload.invitationRequestId),
      userId: adminUserId,
      schoolId,
    }),
  );
  return { schoolId, adminUserId };
}

beforeAll(async () => {
  h = await createHarness();
}, 120_000);

afterAll(async () => {
  await h?.close();
});

describe('platform workspace exclusivity', () => {
  it('lets exactly one of many concurrent independent sessions acquire the platform lease', async () => {
    const operators = await Promise.all(
      ['Ama', 'Bello', 'Chidi', 'Dina'].map((n) =>
        h.createPlatformOperator(`Operator ${n} Fictional`),
      ),
    );
    const sessions = await Promise.all(
      operators.flatMap((o) => [h.login(o.userId), h.login(o.userId)]),
    );

    const results = await Promise.all(sessions.map((s) => acquirePlatform(s.token)));
    const granted = results.filter((r) => r.status === 200);
    const denied = results.filter((r) => r.status === 409);
    expect(granted).toHaveLength(1);
    expect(denied).toHaveLength(sessions.length - 1);
    // Regression: database time must be real UTC time (a timezone-offset bug once shifted it by hours).
    expect(Math.abs(Date.parse(granted[0]?.body.acquiredAt) - Date.now())).toBeLessThan(10_000);
    for (const d of denied) {
      expect(d.body.code).toBe('ADMIN_WORKSPACE_IN_USE');
      // Only policy-approved holder fields are disclosed.
      expect(Object.keys(d.body.occupancy).sort()).toEqual([
        'acquiredAt',
        'lastActivityAt',
        'operatorDisplayName',
      ]);
    }

    // The winner's session may reconnect (same grant); every denial is in session history.
    const winnerIndex = results.findIndex((r) => r.status === 200);
    const winner = sessions[winnerIndex];
    if (winner === undefined) throw new Error('no winner');
    const again = await acquirePlatform(winner.token);
    expect(again.status).toBe(200);
    expect(again.body.grantId).toBe(granted[0]?.body.grantId);

    const history = await h
      .http()
      .get('/api/v1/administration/session-history?limit=50')
      .set(bearer(winner.token));
    expect(history.status).toBe(200);
    const outcomes = history.body.items.map((i: { outcome: string }) => i.outcome);
    expect(outcomes.filter((o: string) => o === 'GRANTED')).toHaveLength(1);
    expect(outcomes.filter((o: string) => o === 'DENIED_IN_USE')).toHaveLength(sessions.length - 1);

    // Release, then a different operator succeeds.
    await h
      .http()
      .post('/api/v1/privileged-access/release')
      .set(bearer(winner.token))
      .send({ grantId: again.body.grantId });
    const other = sessions[(winnerIndex + 2) % sessions.length];
    if (other === undefined) throw new Error('no other session');
    expect((await acquirePlatform(other.token)).status).toBe(200);
    await h
      .http()
      .post('/api/v1/privileged-access/release')
      .set(bearer(other.token))
      .send({
        grantId: (await h.http().get('/api/v1/privileged-access/current').set(bearer(other.token)))
          .body.lease.grantId,
      });
  });

  it('requires MFA to acquire, and refuses non-operators without revealing anything', async () => {
    const op = await h.createPlatformOperator('Operator Efua Fictional');
    const noMfa = await h.login(op.userId, { aal: 1 });
    const res = await acquirePlatform(noMfa.token);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('MFA_REQUIRED');

    const stranger = await h.login('00000000-0000-4000-8000-0000000000ff');
    const strangerRes = await acquirePlatform(stranger.token);
    expect(strangerRes.status).toBe(403);
    expect(strangerRes.body.code).toBe('FORBIDDEN');
  });
});

describe('provisioning, journaling, and school-scoped user creation', () => {
  let platform: { token: string; sessionId: string; userId: string };

  beforeAll(async () => {
    const op = await h.createPlatformOperator('Operator Provisioner Fictional');
    const session = await h.login(op.userId);
    platform = { ...session, userId: op.userId };
    await h.resetPlatformLease();
    expect((await acquirePlatform(platform.token)).status).toBe(200);
  });

  it('provisions a school, its workspace, lease row, and first administrator, attributed to the named operator', async () => {
    const res = await provisionSchool(platform.token, 'riverside', 'head.riverside@example.org');
    expect(res.status).toBe(201);
    expect(res.body.firstAdministrator.status).toBe('INVITED');
    expect(res.body.firstAdministrator.contactMasked).toBe('h***@example.org');
    const schoolId: string = res.body.school.schoolId;

    const journal = (await h.outbox('audit.journal.entry')).filter((e) => e.schoolId === schoolId);
    const actions = journal.map((e) => e.payload.action);
    expect(actions).toEqual(
      expect.arrayContaining(['SCHOOL_PROVISIONED', 'SCHOOL_OPERATOR_CREATED']),
    );
    for (const entry of journal) {
      expect(entry.payload).toMatchObject({
        actorUserId: platform.userId,
        sessionId: platform.sessionId,
        workspaceType: 'PLATFORM',
        outcome: 'SUCCESS',
      });
      expect(entry.payload.grantId).toBeTruthy();
      expect(entry.payload.fencingToken).toBeGreaterThan(0);
      // Contacts never reach the journal in clear text.
      expect(JSON.stringify(entry.payload)).not.toContain('head.riverside@example.org');
    }
    const leaseRow = await withClient(h.db.ownerUrl, (c) =>
      c.query('SELECT status FROM privileged_access_leases WHERE school_id = $1', [schoolId]),
    );
    expect(leaseRow.rows[0]?.status).toBe('VACANT');
  });

  it('is idempotent per Idempotency-Key and rejects key reuse with a different body', async () => {
    const key = idempotencyKey();
    const body = {
      name: 'Fictional Hillside Academy',
      slug: 'hillside',
      timezone: 'Africa/Douala',
      countryCode: 'CM',
      defaultLanguage: 'fr',
      firstAdministrator: { displayName: 'Admin Hillside Fictional', contact: '+237600000101' },
    };
    const first = await h
      .http()
      .post('/api/v1/platform/schools')
      .set({ ...bearer(platform.token), 'idempotency-key': key })
      .send(body);
    const replay = await h
      .http()
      .post('/api/v1/platform/schools')
      .set({ ...bearer(platform.token), 'idempotency-key': key })
      .send(body);
    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body.school.schoolId).toBe(first.body.school.schoolId);

    const reused = await h
      .http()
      .post('/api/v1/platform/schools')
      .set({ ...bearer(platform.token), 'idempotency-key': key })
      .send({ ...body, slug: 'hillside-two' });
    expect(reused.status).toBe(422);
    expect(reused.body.code).toBe('IDEMPOTENCY_KEY_REUSED');

    const missing = await h
      .http()
      .post('/api/v1/platform/schools')
      .set(bearer(platform.token))
      .send({ ...body, slug: 'hillside-three' });
    expect(missing.status).toBe(400);
    expect(missing.body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('lets a school administrator invite drivers and guardians only into their own school', async () => {
    const a = await schoolWithActiveAdmin(platform.token, 'alpha');
    const b = await schoolWithActiveAdmin(platform.token, 'bravo');
    const adminA = await h.login(a.adminUserId);
    const adminB = await h.login(b.adminUserId);

    // Different schools' administrators work concurrently.
    const [leaseA, leaseB] = await Promise.all([
      h
        .http()
        .post('/api/v1/privileged-access/acquire')
        .set(bearer(adminA.token))
        .send({ workspace: { type: 'SCHOOL', schoolId: a.schoolId } }),
      h
        .http()
        .post('/api/v1/privileged-access/acquire')
        .set(bearer(adminB.token))
        .send({ workspace: { type: 'SCHOOL', schoolId: b.schoolId } }),
    ]);
    expect(leaseA.status).toBe(200);
    expect(leaseB.status).toBe(200);
    expect(leaseA.body.operator.displayName).toBe('Admin alpha Fictional');

    const invite = (schoolId: string, token: string, body: Record<string, unknown>) =>
      h
        .http()
        .post(`/api/v1/schools/${schoolId}/user-invitations`)
        .set({ ...bearer(token), 'idempotency-key': idempotencyKey() })
        .send(body);

    const driver = await invite(a.schoolId, adminA.token, {
      displayName: 'Driver Kofi Fictional',
      contact: '+237600000201',
      role: 'DRIVER',
    });
    expect(driver.status).toBe(201);
    expect(driver.body).toMatchObject({ status: 'INVITED', roles: ['DRIVER'] });
    const guardian = await invite(a.schoolId, adminA.token, {
      displayName: 'Guardian Abena Fictional',
      contact: 'abena.guardian@example.org',
      role: 'GUARDIAN',
    });
    expect(guardian.status).toBe(201);

    // Cross-tenant: School B's path with School A's lease is indistinguishable from a missing school.
    const cross = await invite(b.schoolId, adminA.token, {
      displayName: 'Intruder Fictional',
      contact: '+237600000202',
      role: 'DRIVER',
    });
    expect(cross.status).toBe(404);
    // Client-supplied tenant and platform-role injection are rejected by the strict contract.
    const smuggled = await invite(a.schoolId, adminA.token, {
      displayName: 'X Fictional',
      contact: '+237600000203',
      role: 'DRIVER',
      schoolId: b.schoolId,
    });
    expect(smuggled.status).toBe(400);
    for (const role of ['PLATFORM_ADMIN', 'SCHOOL_ADMIN', 'SUPERUSER']) {
      const res = await invite(a.schoolId, adminA.token, {
        displayName: 'Role Fictional',
        contact: '+237600000204',
        role,
      });
      expect(res.status).toBe(400);
    }
    // Deferred roles stay disabled without the school feature flag.
    const attendant = await invite(a.schoolId, adminA.token, {
      displayName: 'Attendant Fictional',
      contact: '+237600000205',
      role: 'BUS_ATTENDANT',
    });
    expect(attendant.status).toBe(403);

    // A school administrator cannot reach platform administration.
    const platformCall = await h.http().get('/api/v1/platform/schools').set(bearer(adminA.token));
    expect(platformCall.status).toBe(403);

    const members = await h
      .http()
      .get(`/api/v1/schools/${a.schoolId}/memberships?role=DRIVER`)
      .set(bearer(adminA.token));
    expect(members.status).toBe(200);
    expect(members.body.items.map((m: { displayName: string }) => m.displayName)).toEqual([
      'Driver Kofi Fictional',
    ]);

    const journal = (await h.outbox('audit.journal.entry')).filter(
      (e) => e.payload.action === 'SCHOOL_USER_INVITED',
    );
    expect(
      journal.every(
        (e) =>
          e.schoolId === a.schoolId &&
          e.payload.actorUserId === a.adminUserId &&
          e.payload.workspaceType === 'SCHOOL',
      ),
    ).toBe(true);

    // A second, independent session of School A's administrator is denied while the first holds the lease.
    const adminA2 = await h.login(a.adminUserId);
    const second = await h
      .http()
      .post('/api/v1/privileged-access/acquire')
      .set(bearer(adminA2.token))
      .send({ workspace: { type: 'SCHOOL', schoolId: a.schoolId } });
    expect(second.status).toBe(409);
  });
});

describe('lease loss, takeover, fencing, and revocation', () => {
  it('blocks privileged commands as soon as the lease expires, even with a valid access token', async () => {
    const op = await h.createPlatformOperator('Operator Expiry Fictional');
    const s = await h.login(op.userId);
    // Other tests may hold the platform lease; start from a known state.
    await withClient(h.db.ownerUrl, (c) =>
      c.query(
        `UPDATE privileged_access_leases SET status = 'RELEASED' WHERE workspace_type = 'PLATFORM'`,
      ),
    );
    const lease = await acquirePlatform(s.token);
    expect(lease.status).toBe(200);
    expect((await h.http().get('/api/v1/platform/schools').set(bearer(s.token))).status).toBe(200);

    await withClient(h.db.ownerUrl, (c) =>
      c.query(
        `UPDATE privileged_access_leases SET expires_at = now() - interval '1 second' WHERE grant_id = $1`,
        [lease.body.grantId],
      ),
    );
    const after = await h.http().get('/api/v1/platform/schools').set(bearer(s.token));
    expect(after.status).toBe(409);
    expect(after.body.code).toBe('PRIVILEGED_LEASE_LOST');

    const heartbeat = await h
      .http()
      .post('/api/v1/privileged-access/heartbeat')
      .set(bearer(s.token))
      .send({ grantId: lease.body.grantId, userActive: true });
    expect(heartbeat.status).toBe(409);
    const status = await withClient(h.db.ownerUrl, (c) =>
      c.query(
        'SELECT status, release_reason FROM privileged_access_leases WHERE workspace_type = $1',
        ['PLATFORM'],
      ),
    );
    expect(status.rows[0]).toMatchObject({
      status: 'EXPIRED',
      release_reason: 'HEARTBEAT_EXPIRED',
    });
  });

  it('takeover needs fresh MFA and a reason; the displaced holder is fenced out and fencing tokens increase', async () => {
    const holder = await h.createPlatformOperator('Operator Holder Fictional');
    const rescuer = await h.createPlatformOperator('Operator Rescuer Fictional');
    await withClient(h.db.ownerUrl, (c) =>
      c.query(
        `UPDATE privileged_access_leases SET status = 'RELEASED' WHERE workspace_type = 'PLATFORM'`,
      ),
    );
    const holderSession = await h.login(holder.userId);
    const first = await acquirePlatform(holderSession.token);
    expect(first.status).toBe(200);

    const staleMfa = await h.login(rescuer.userId, {
      mfaVerifiedAt: new Date(Date.now() - 3_600_000),
    });
    const refused = await h
      .http()
      .post('/api/v1/privileged-access/takeover')
      .set(bearer(staleMfa.token))
      .send({ workspace: { type: 'PLATFORM' }, reason: 'Holder unreachable during an outage' });
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('REAUTHENTICATION_REQUIRED');

    const fresh = await h.login(rescuer.userId);
    const noReason = await h
      .http()
      .post('/api/v1/privileged-access/takeover')
      .set(bearer(fresh.token))
      .send({ workspace: { type: 'PLATFORM' }, reason: 'short' });
    expect(noReason.status).toBe(400);

    const taken = await h
      .http()
      .post('/api/v1/privileged-access/takeover')
      .set(bearer(fresh.token))
      .send({ workspace: { type: 'PLATFORM' }, reason: 'Holder unreachable during an outage' });
    expect(taken.status, JSON.stringify(taken.body)).toBe(200);
    expect(taken.body.fencingToken).toBeGreaterThan(first.body.fencingToken);

    const displaced = await h
      .http()
      .get('/api/v1/platform/schools')
      .set(bearer(holderSession.token));
    expect(displaced.status).toBe(403);
    expect(displaced.body.code).toBe('PRIVILEGED_LEASE_REQUIRED');
    const takeoverEntries = (await h.outbox('audit.journal.entry')).filter(
      (e) => e.payload.action === 'PRIVILEGED_LEASE_TAKEOVER',
    );
    expect(takeoverEntries.at(-1)?.payload).toMatchObject({
      actorUserId: rescuer.userId,
      sessionId: fresh.sessionId,
    });

    // Logout (session revoked event from identity-service) releases the lease.
    await h.deliver(
      sessionRevoked({ sessionId: fresh.sessionId, userId: rescuer.userId, reason: 'LOGOUT' }),
    );
    const row = await withClient(h.db.ownerUrl, (c) =>
      c.query(
        'SELECT status, release_reason FROM privileged_access_leases WHERE workspace_type = $1',
        ['PLATFORM'],
      ),
    );
    expect(row.rows[0]).toMatchObject({ status: 'RELEASED', release_reason: 'LOGOUT' });
    // Redelivery of the same event is a no-op.
    const before = (await h.outbox()).length;
    const replay = sessionRevoked({
      sessionId: fresh.sessionId,
      userId: rescuer.userId,
      reason: 'LOGOUT',
    });
    await h.deliver(replay);
    await h.deliver(replay);
    expect((await h.outbox()).length).toBe(before);
  });

  it('fails closed when identity-service cannot confirm the session', async () => {
    const op = await h.createPlatformOperator('Operator Outage Fictional');
    const s = await h.login(op.userId);
    h.identity.available = false;
    try {
      const res = await acquirePlatform(s.token);
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('DEPENDENCY_UNAVAILABLE');
    } finally {
      h.identity.available = true;
    }
  });
});

describe('internal lease validation API', () => {
  it('requires an allowlisted service token and returns the grant and fencing token', async () => {
    const op = await h.createPlatformOperator('Operator Internal Fictional');
    await withClient(h.db.ownerUrl, (c) =>
      c.query(
        `UPDATE privileged_access_leases SET status = 'RELEASED' WHERE workspace_type = 'PLATFORM'`,
      ),
    );
    const s = await h.login(op.userId);
    const lease = await acquirePlatform(s.token);
    const body = { sessionId: s.sessionId, userId: op.userId, touch: false };

    expect((await h.http().post('/internal/v1/privileged-access/validate').send(body)).status).toBe(
      401,
    );
    // An end-user token is not a service credential.
    expect(
      (
        await h
          .http()
          .post('/internal/v1/privileged-access/validate')
          .set(bearer(s.token))
          .send(body)
      ).status,
    ).toBe(401);
    const ok = await h
      .http()
      .post('/internal/v1/privileged-access/validate')
      .set('x-service-token', await h.serviceToken('audit-service'))
      .send(body);
    expect(ok.status).toBe(200);
    expect(ok.body.lease).toMatchObject({
      grantId: lease.body.grantId,
      fencingToken: lease.body.fencingToken,
      workspaceType: 'PLATFORM',
    });

    const other = await h.login(op.userId);
    const notHolder = await h
      .http()
      .post('/internal/v1/privileged-access/validate')
      .set('x-service-token', await h.serviceToken('audit-service'))
      .send({ ...body, sessionId: other.sessionId });
    expect(notHolder.status).toBe(403);
    expect(notHolder.body.code).toBe('PRIVILEGED_LEASE_REQUIRED');
  });
});

describe('database-level guarantees (row-level security, constraints, append-only)', () => {
  it('isolates tenants for the runtime role and keeps the platform role out of schools', async () => {
    const schools = await withClient(h.db.ownerUrl, (c) =>
      c.query<{ id: string }>('SELECT id FROM schools ORDER BY created_at LIMIT 2'),
    );
    const [first, second] = schools.rows;
    if (first === undefined || second === undefined)
      throw new Error('expected two schools from earlier tests');

    await withClient(h.db.appUrl, async (c) => {
      await c.query('BEGIN');
      await c.query(
        `SELECT set_config('aegis.context', 'school', true), set_config('aegis.school_id', $1, true), set_config('aegis.user_id', '', true)`,
        [first.id],
      );
      const own = await c.query(
        'SELECT count(*)::int AS n FROM school_memberships WHERE school_id = $1',
        [first.id],
      );
      const foreign = await c.query(
        'SELECT count(*)::int AS n FROM school_memberships WHERE school_id = $1',
        [second.id],
      );
      expect(own.rows[0].n).toBeGreaterThan(0);
      expect(foreign.rows[0].n).toBe(0);
      await expect(
        c.query(
          `INSERT INTO role_assignments (user_id, role_key, role_scope, status) VALUES (gen_random_uuid(), 'PLATFORM_ADMIN', 'PLATFORM', 'ACTIVE')`,
        ),
      ).rejects.toThrow(/row-level security/);
      await c.query('ROLLBACK');

      // Without any context the runtime role sees nothing (deny by default).
      const none = await c.query('SELECT count(*)::int AS n FROM school_memberships');
      expect(none.rows[0].n).toBe(0);
    });

    // Even the owner cannot bind the platform role to a school (shape constraint).
    await withClient(h.db.ownerUrl, async (c) => {
      const membership = await c.query<{ id: string; user_id: string }>(
        'SELECT id, user_id FROM school_memberships WHERE school_id = $1 LIMIT 1',
        [first.id],
      );
      const m = membership.rows[0];
      if (m === undefined) throw new Error('membership expected');
      await expect(
        c.query(
          `INSERT INTO role_assignments (user_id, school_id, membership_id, role_key, role_scope, status) VALUES ($1, $2, $3, 'PLATFORM_ADMIN', 'SCHOOL', 'ACTIVE')`,
          [m.user_id, first.id, m.id],
        ),
      ).rejects.toThrow();
    });
  });

  it('keeps privileged session history append-only and fencing tokens monotonic', async () => {
    await withClient(h.db.appUrl, async (c) => {
      await c.query(`SELECT set_config('aegis.context', 'platform', false)`);
      await expect(c.query('DELETE FROM privileged_session_history')).rejects.toThrow(
        /permission denied/,
      );
      await expect(
        c.query(
          `UPDATE privileged_session_history SET outcome = 'GRANTED' WHERE ended_at IS NOT NULL`,
        ),
      ).rejects.toThrow(/cannot change|lifecycle/);
      await expect(
        c.query(
          `UPDATE privileged_access_leases SET fencing_token = 0 WHERE workspace_type = 'PLATFORM'`,
        ),
      ).rejects.toThrow(/fencing token/);
      await expect(c.query('DELETE FROM privileged_access_leases')).rejects.toThrow(
        /permission denied/,
      );
    });
  });
});

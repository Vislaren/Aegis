import { describe, expect, it, vi } from 'vitest';
import type { administration } from '@aegis/contracts';
import { ApiClient, ApiError, messageFor, type CredentialStrategy } from './api-client';
import { driverCapability } from './capability';
import { LeaseKeeper } from './lease-keeper';
import { availableContexts, gateAfterSignIn } from './navigation';

const S1 = '00000000-0000-4000-8000-000000000001';
const S2 = '00000000-0000-4000-8000-000000000002';

function contexts(
  partial: Partial<administration.AccessContextsResponse> = {},
): administration.AccessContextsResponse {
  return { userId: S1, platformOperator: null, schools: [], activeLease: null, ...partial };
}

const school = (
  schoolId: string,
  roles: administration.AccessContextsResponse['schools'][number]['roles'],
  operator = false,
) => ({
  schoolId,
  schoolName: `School ${schoolId.slice(-1)} Fictional`,
  schoolStatus: 'ACTIVE' as const,
  membershipStatus: 'ACTIVE' as const,
  roles,
  operatorProfile: operator
    ? { profileId: S2, displayName: 'Operator Fictional', status: 'ACTIVE' as const }
    : null,
});

describe('role navigation', () => {
  it('requires MFA for operators before offering any context', () => {
    const session = { aal: 1, mfaEnrolled: false, mfaRequiredForPrivilegedUse: true };
    expect(gateAfterSignIn({ session, contexts: contexts() })).toEqual({ next: 'mfa-enroll' });
    expect(
      gateAfterSignIn({ session: { ...session, mfaEnrolled: true }, contexts: contexts() }),
    ).toEqual({ next: 'mfa-verify' });
  });

  it('routes a single-role guardian straight home and offers a choice for several roles', () => {
    const session = { aal: 1, mfaEnrolled: false, mfaRequiredForPrivilegedUse: false };
    expect(
      gateAfterSignIn({ session, contexts: contexts({ schools: [school(S1, ['GUARDIAN'])] }) }),
    ).toEqual({
      next: 'home',
      route: `/guardian/${S1}`,
    });
    const multi = gateAfterSignIn({
      session,
      contexts: contexts({ schools: [school(S1, ['DRIVER']), school(S2, ['GUARDIAN'])] }),
    });
    expect(multi.next).toBe('choose');
  });

  it('never offers contexts from suspended schools, inactive memberships, or unactivated operators', () => {
    const suspended = { ...school(S1, ['SCHOOL_ADMIN'], true), schoolStatus: 'SUSPENDED' as const };
    const invited = { ...school(S2, ['DRIVER']), membershipStatus: 'INVITED' as const };
    const adminWithoutProfile = school(S1, ['SCHOOL_ADMIN'], false);
    expect(
      availableContexts(contexts({ schools: [suspended, invited, adminWithoutProfile] })),
    ).toEqual([]);
  });

  it('sends people without any active context to the no-access screen', () => {
    expect(
      gateAfterSignIn({
        session: { aal: 1, mfaEnrolled: false, mfaRequiredForPrivilegedUse: false },
        contexts: contexts(),
      }),
    ).toEqual({
      next: 'no-access',
    });
  });
});

describe('driver capability', () => {
  it('refuses trips on web and in Expo Go', () => {
    expect(driverCapability({ os: 'web', executionEnvironment: null }).canOperateTrips).toBe(false);
    expect(
      driverCapability({ os: 'android', executionEnvironment: 'storeClient' }).canOperateTrips,
    ).toBe(false);
    expect(
      driverCapability({ os: 'android', executionEnvironment: 'standalone' }).canOperateTrips,
    ).toBe(true);
  });
});

describe('lease keeper', () => {
  const lease = (overrides: Partial<administration.LeaseView> = {}): administration.LeaseView => ({
    grantId: S1,
    fencingToken: 1,
    workspace: { type: 'PLATFORM', workspaceId: S2, schoolId: null, schoolName: null },
    operator: { profileId: S2, displayName: 'Operator Fictional' },
    acquiredAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
    idleExpiresAt: new Date(Date.now() + 900_000).toISOString(),
    heartbeatIntervalSeconds: 60,
    ...overrides,
  });
  const timers = { setInterval: vi.fn(() => 1), clearInterval: vi.fn() };

  it('reports operator interaction once per heartbeat', async () => {
    const heartbeat = vi.fn(async () => lease());
    const keeper = new LeaseKeeper(lease(), { heartbeat, release: vi.fn() }, timers, vi.fn());
    keeper.noteInteraction();
    await keeper.beat();
    await keeper.beat();
    expect(heartbeat.mock.calls.map((c) => (c as unknown[])[1])).toEqual([true, false]);
  });

  it('declares loss immediately when the server rejects the heartbeat', async () => {
    const onLost = vi.fn();
    const keeper = new LeaseKeeper(
      lease(),
      { heartbeat: vi.fn(async () => Promise.reject(new ApiError(409, null))), release: vi.fn() },
      timers,
      onLost,
    );
    keeper.start();
    await keeper.beat();
    expect(onLost).toHaveBeenCalledWith('expired');
    expect(timers.clearInterval).toHaveBeenCalled();
  });

  it('tolerates brief network loss but declares loss once the lease must have expired', async () => {
    const onLost = vi.fn();
    const keeper = new LeaseKeeper(
      lease({ expiresAt: new Date(Date.now() - 1).toISOString() }),
      { heartbeat: vi.fn(async () => Promise.reject(new ApiError(0, null))), release: vi.fn() },
      timers,
      onLost,
    );
    await keeper.beat();
    expect(onLost).toHaveBeenCalledWith('network');
  });
});

describe('api client', () => {
  const bearer = (
    token: string | null,
    refresh: () => Promise<boolean> = async () => false,
  ): CredentialStrategy => ({
    kind: 'bearer',
    accessToken: () => token,
    csrfToken: () => null,
    refresh,
  });

  it('retries once after a successful refresh, and surfaces problem codes', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return new Response('', { status: 401 });
      return new Response(
        JSON.stringify({
          type: 't',
          title: 'In use',
          status: 409,
          code: 'ADMIN_WORKSPACE_IN_USE',
          correlationId: 'c',
        }),
        { status: 409 },
      );
    });
    const client = new ApiClient({
      baseUrl: 'http://api',
      credentials: bearer('t', async () => true),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const error = await client
      .request('/api/v1/privileged-access/acquire', { method: 'POST', body: {} })
      .catch((e: unknown) => e);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(error).toBeInstanceOf(ApiError);
    expect(messageFor(error)).toBe('Another operator is using this administration workspace.');
  });

  it('sends the CSRF header for cookie sessions on unsafe methods only', async () => {
    const seen: Array<Record<string, string>> = [];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      seen.push(init?.headers as Record<string, string>);
      return new Response(null, { status: 204 });
    });
    const cookie: CredentialStrategy = {
      kind: 'cookie',
      accessToken: () => null,
      csrfToken: () => 'csrf-value-1234567890',
      refresh: async () => false,
    };
    const client = new ApiClient({
      baseUrl: '',
      credentials: cookie,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await client.request('/api/v1/me');
    await client.request('/api/v1/auth/logout', { method: 'POST' });
    expect(seen[0]?.['x-csrf-token']).toBeUndefined();
    expect(seen[1]?.['x-csrf-token']).toBe('csrf-value-1234567890');
    expect(seen.every((h) => h.authorization === undefined)).toBe(true);
  });
});

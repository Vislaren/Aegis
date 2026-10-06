import { describe, expect, it } from 'vitest';
import { authorize, PLATFORM_ACTIONS, SCHOOL_ADMIN_ACTIONS, type ActorContext } from './policy';

const SCHOOL_A = '00000000-0000-4000-8000-00000000000a';
const SCHOOL_B = '00000000-0000-4000-8000-00000000000b';

function baseActor(overrides: Partial<ActorContext> = {}): ActorContext {
  return {
    userId: 'u1',
    sessionId: 's1',
    userStatus: 'ACTIVE',
    sessionAal: 2,
    platformOperator: null,
    schoolOperators: [],
    memberships: [],
    activeLease: null,
    ...overrides,
  };
}

function schoolAdminOf(schoolId: string, overrides: Partial<ActorContext> = {}): ActorContext {
  return baseActor({
    schoolOperators: [{ profileId: 'p1', schoolId, status: 'ACTIVE' }],
    memberships: [{ schoolId, schoolStatus: 'ACTIVE', status: 'ACTIVE', roles: ['SCHOOL_ADMIN'] }],
    activeLease: { workspaceType: 'SCHOOL', schoolId },
    ...overrides,
  });
}

function platformOperator(overrides: Partial<ActorContext> = {}): ActorContext {
  return baseActor({
    platformOperator: { profileId: 'pp1', status: 'ACTIVE' },
    activeLease: { workspaceType: 'PLATFORM' },
    ...overrides,
  });
}

describe('platform actions', () => {
  it.each(PLATFORM_ACTIONS)(
    '%s is allowed for an MFA-verified platform operator holding the lease',
    (action) => {
      expect(authorize(platformOperator(), action)).toEqual({ allowed: true });
    },
  );

  it('is denied without the platform lease even with a valid session', () => {
    expect(authorize(platformOperator({ activeLease: null }), 'platform.school.provision')).toEqual(
      {
        allowed: false,
        reason: 'NO_PRIVILEGED_LEASE',
      },
    );
  });

  it('is denied when the session holds a school lease instead', () => {
    const actor = platformOperator({
      activeLease: { workspaceType: 'SCHOOL', schoolId: SCHOOL_A },
    });
    expect(authorize(actor, 'platform.school.provision')).toEqual({
      allowed: false,
      reason: 'NO_PRIVILEGED_LEASE',
    });
  });

  it('is denied without MFA', () => {
    expect(authorize(platformOperator({ sessionAal: 1 }), 'platform.school.provision')).toEqual({
      allowed: false,
      reason: 'MFA_REQUIRED',
    });
  });

  it('is denied for a suspended operator profile', () => {
    const actor = platformOperator({ platformOperator: { profileId: 'pp1', status: 'SUSPENDED' } });
    expect(authorize(actor, 'platform.school.list')).toEqual({
      allowed: false,
      reason: 'OPERATOR_NOT_ACTIVE',
    });
  });

  it('is denied for a school administrator, whatever lease they hold', () => {
    expect(authorize(schoolAdminOf(SCHOOL_A), 'platform.school.provision')).toEqual({
      allowed: false,
      reason: 'FORBIDDEN',
    });
  });
});

describe('school administration actions', () => {
  it.each(SCHOOL_ADMIN_ACTIONS)(
    '%s is allowed in the operator’s own school with that school’s lease',
    (action) => {
      expect(authorize(schoolAdminOf(SCHOOL_A), action, { schoolId: SCHOOL_A })).toEqual({
        allowed: true,
      });
    },
  );

  it.each(SCHOOL_ADMIN_ACTIONS)(
    '%s in another school is indistinguishable from a missing school',
    (action) => {
      expect(authorize(schoolAdminOf(SCHOOL_A), action, { schoolId: SCHOOL_B })).toEqual({
        allowed: false,
        reason: 'NOT_FOUND',
      });
    },
  );

  it('does not let a lease on School A authorize School B for someone who administers both', () => {
    const actor = baseActor({
      schoolOperators: [
        { profileId: 'p1', schoolId: SCHOOL_A, status: 'ACTIVE' },
        { profileId: 'p2', schoolId: SCHOOL_B, status: 'ACTIVE' },
      ],
      memberships: [
        { schoolId: SCHOOL_A, schoolStatus: 'ACTIVE', status: 'ACTIVE', roles: ['SCHOOL_ADMIN'] },
        { schoolId: SCHOOL_B, schoolStatus: 'ACTIVE', status: 'ACTIVE', roles: ['SCHOOL_ADMIN'] },
      ],
      activeLease: { workspaceType: 'SCHOOL', schoolId: SCHOOL_A },
    });
    expect(authorize(actor, 'school.user.invite', { schoolId: SCHOOL_B })).toEqual({
      allowed: false,
      reason: 'NOT_FOUND',
    });
  });

  it('denies drivers and guardians', () => {
    const driver = baseActor({
      memberships: [
        { schoolId: SCHOOL_A, schoolStatus: 'ACTIVE', status: 'ACTIVE', roles: ['DRIVER'] },
      ],
    });
    expect(authorize(driver, 'school.user.invite', { schoolId: SCHOOL_A })).toEqual({
      allowed: false,
      reason: 'NOT_FOUND',
    });
  });

  it('denies a platform operator routine access to school administration', () => {
    expect(authorize(platformOperator(), 'school.membership.list', { schoolId: SCHOOL_A })).toEqual(
      {
        allowed: false,
        reason: 'NOT_FOUND',
      },
    );
  });

  it('denies when the school is suspended', () => {
    const actor = schoolAdminOf(SCHOOL_A, {
      memberships: [
        {
          schoolId: SCHOOL_A,
          schoolStatus: 'SUSPENDED',
          status: 'ACTIVE',
          roles: ['SCHOOL_ADMIN'],
        },
      ],
    });
    expect(authorize(actor, 'school.user.invite', { schoolId: SCHOOL_A })).toEqual({
      allowed: false,
      reason: 'SCHOOL_NOT_ACTIVE',
    });
  });

  it('denies a suspended user regardless of profiles', () => {
    expect(
      authorize(schoolAdminOf(SCHOOL_A, { userStatus: 'SUSPENDED' }), 'school.user.invite', {
        schoolId: SCHOOL_A,
      }),
    ).toEqual({ allowed: false, reason: 'USER_NOT_ACTIVE' });
  });
});

describe('lease acquisition', () => {
  it('requires MFA for platform and school workspaces', () => {
    expect(
      authorize(
        platformOperator({ sessionAal: 1, activeLease: null }),
        'privileged.acquire.platform',
      ),
    ).toEqual({
      allowed: false,
      reason: 'MFA_REQUIRED',
    });
    const schoolActor = schoolAdminOf(SCHOOL_A, { sessionAal: 1, activeLease: null });
    expect(authorize(schoolActor, 'privileged.acquire.school', { schoolId: SCHOOL_A })).toEqual({
      allowed: false,
      reason: 'MFA_REQUIRED',
    });
  });

  it('allows an operator to acquire only their own school workspace', () => {
    const actor = schoolAdminOf(SCHOOL_A, { activeLease: null });
    expect(authorize(actor, 'privileged.acquire.school', { schoolId: SCHOOL_A })).toEqual({
      allowed: true,
    });
    expect(authorize(actor, 'privileged.acquire.school', { schoolId: SCHOOL_B })).toEqual({
      allowed: false,
      reason: 'NOT_FOUND',
    });
  });

  it('denies platform acquisition for non-operators', () => {
    expect(authorize(baseActor(), 'privileged.acquire.platform')).toEqual({
      allowed: false,
      reason: 'FORBIDDEN',
    });
  });
});

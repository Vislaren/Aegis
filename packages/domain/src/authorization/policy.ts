import { ALLOW, deny, type Decision } from '../common/decision';
import type { RoleKey } from '../roles';

export type UserStatus = 'INVITED' | 'ACTIVE' | 'SUSPENDED' | 'DISABLED';
export type OperatorStatus = 'INVITED' | 'ACTIVE' | 'SUSPENDED';
export type MembershipStatus = 'INVITED' | 'ACTIVE' | 'SUSPENDED' | 'REVOKED';
export type SchoolStatus = 'ACTIVE' | 'SUSPENDED';

/**
 * Everything the policy needs is loaded server-side from PostgreSQL for the current request.
 * Nothing here comes from the client: no role, school, or workspace is trusted from input.
 */
export interface ActorContext {
  userId: string;
  sessionId: string;
  userStatus: UserStatus;
  /** Authentication assurance level of this session: 1 = OTP only, 2 = OTP + MFA. */
  sessionAal: 1 | 2;
  platformOperator: { profileId: string; status: OperatorStatus } | null;
  schoolOperators: ReadonlyArray<{ profileId: string; schoolId: string; status: OperatorStatus }>;
  memberships: ReadonlyArray<{
    schoolId: string;
    schoolStatus: SchoolStatus;
    status: MembershipStatus;
    roles: readonly RoleKey[];
  }>;
  /** Set only after the lease has been validated against PostgreSQL for this request. */
  activeLease: { workspaceType: 'PLATFORM' } | { workspaceType: 'SCHOOL'; schoolId: string } | null;
}

export const PLATFORM_ACTIONS = [
  'platform.school.provision',
  'platform.school.list',
  'platform.school.suspend',
  'platform.school.reactivate',
  'platform.school_lease.revoke',
  'platform.operator.create',
  'platform.operator.list',
  'platform.operator.suspend',
  'platform.operator.reactivate',
  'platform.journal.read',
  'platform.session_history.read',
] as const;

export const SCHOOL_ADMIN_ACTIONS = [
  'school.operator.create',
  'school.operator.list',
  'school.operator.suspend',
  'school.operator.reactivate',
  'school.user.invite',
  'school.membership.list',
  'school.membership.suspend',
  'school.membership.reactivate',
  'school.journal.read',
  'school.session_history.read',
] as const;

export type PlatformAction = (typeof PLATFORM_ACTIONS)[number];
export type SchoolAdminAction = (typeof SCHOOL_ADMIN_ACTIONS)[number];
export type AcquireAction = 'privileged.acquire.platform' | 'privileged.acquire.school';
export type Action = PlatformAction | SchoolAdminAction | AcquireAction;

export interface ResourceContext {
  /** The tenant named by the request path; it is checked, never trusted to grant authority. */
  schoolId?: string;
}

function isPlatformAction(action: Action): action is PlatformAction {
  return (PLATFORM_ACTIONS as readonly string[]).includes(action);
}

function isSchoolAdminAction(action: Action): action is SchoolAdminAction {
  return (SCHOOL_ADMIN_ACTIONS as readonly string[]).includes(action);
}

/** Active, unsuspended school-operator standing in the given school (without the lease). */
export function schoolOperatorStanding(actor: ActorContext, schoolId: string): Decision {
  const operator = actor.schoolOperators.find((o) => o.schoolId === schoolId);
  const membership = actor.memberships.find((m) => m.schoolId === schoolId);
  // No relationship with the school: indistinguishable from a school that does not exist.
  if (operator === undefined || membership === undefined) return deny('NOT_FOUND');
  if (!membership.roles.includes('SCHOOL_ADMIN')) return deny('NOT_FOUND');
  if (membership.schoolStatus !== 'ACTIVE') return deny('SCHOOL_NOT_ACTIVE');
  if (operator.status !== 'ACTIVE' || membership.status !== 'ACTIVE') {
    return deny('OPERATOR_NOT_ACTIVE');
  }
  return ALLOW;
}

export function platformOperatorStanding(actor: ActorContext): Decision {
  if (actor.platformOperator === null) return deny('FORBIDDEN');
  if (actor.platformOperator.status !== 'ACTIVE') return deny('OPERATOR_NOT_ACTIVE');
  return ALLOW;
}

/**
 * Central, deny-by-default authorization for Phase 1 administrative actions.
 * Every privileged action needs: an active user, an MFA-verified session, an active operator
 * profile in the right workspace, and a validated lease on exactly that workspace.
 */
export function authorize(
  actor: ActorContext,
  action: Action,
  resource: ResourceContext = {},
): Decision {
  if (actor.userStatus !== 'ACTIVE') return deny('USER_NOT_ACTIVE');

  if (action === 'privileged.acquire.platform') {
    const standing = platformOperatorStanding(actor);
    if (!standing.allowed) return standing;
    return actor.sessionAal === 2 ? ALLOW : deny('MFA_REQUIRED');
  }

  if (action === 'privileged.acquire.school') {
    if (resource.schoolId === undefined) return deny('NOT_FOUND');
    const standing = schoolOperatorStanding(actor, resource.schoolId);
    if (!standing.allowed) return standing;
    return actor.sessionAal === 2 ? ALLOW : deny('MFA_REQUIRED');
  }

  if (isPlatformAction(action)) {
    const standing = platformOperatorStanding(actor);
    if (!standing.allowed) return standing;
    if (actor.sessionAal !== 2) return deny('MFA_REQUIRED');
    if (actor.activeLease?.workspaceType !== 'PLATFORM') return deny('NO_PRIVILEGED_LEASE');
    return ALLOW;
  }

  if (isSchoolAdminAction(action)) {
    if (resource.schoolId === undefined) return deny('NOT_FOUND');
    const standing = schoolOperatorStanding(actor, resource.schoolId);
    if (!standing.allowed) return standing;
    if (actor.sessionAal !== 2) return deny('MFA_REQUIRED');
    const lease = actor.activeLease;
    if (lease === null || lease.workspaceType !== 'SCHOOL') return deny('NO_PRIVILEGED_LEASE');
    // A lease on School A never authorizes School B, even for a person who administers both.
    if (lease.schoolId !== resource.schoolId) return deny('NOT_FOUND');
    return ALLOW;
  }

  return deny('FORBIDDEN');
}

/** Roles the person currently holds in a school, for building navigation. Not an authorization grant. */
export function activeRolesInSchool(actor: ActorContext, schoolId: string): RoleKey[] {
  const membership = actor.memberships.find((m) => m.schoolId === schoolId);
  if (
    membership === undefined ||
    membership.status !== 'ACTIVE' ||
    membership.schoolStatus !== 'ACTIVE'
  ) {
    return [];
  }
  return [...membership.roles];
}

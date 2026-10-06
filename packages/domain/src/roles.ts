import { ALLOW, deny, type Decision } from './common/decision';

export const ROLE_KEYS = [
  'PLATFORM_ADMIN',
  'SCHOOL_ADMIN',
  'DRIVER',
  'GUARDIAN',
  'TRANSPORT_MANAGER',
  'DISPATCHER',
  'BUS_ATTENDANT',
] as const;

export type RoleKey = (typeof ROLE_KEYS)[number];
export type RoleScope = 'PLATFORM' | 'SCHOOL';

export interface RoleDefinition {
  key: RoleKey;
  scope: RoleScope;
  /** Administrative roles act through a workspace and need the single-operator lease. */
  privileged: boolean;
  /** Deferred roles are only assignable when this school feature flag is enabled. */
  featureFlag: string | null;
}

export const ROLE_DEFINITIONS: Readonly<Record<RoleKey, RoleDefinition>> = Object.freeze({
  PLATFORM_ADMIN: { key: 'PLATFORM_ADMIN', scope: 'PLATFORM', privileged: true, featureFlag: null },
  SCHOOL_ADMIN: { key: 'SCHOOL_ADMIN', scope: 'SCHOOL', privileged: true, featureFlag: null },
  DRIVER: { key: 'DRIVER', scope: 'SCHOOL', privileged: false, featureFlag: null },
  GUARDIAN: { key: 'GUARDIAN', scope: 'SCHOOL', privileged: false, featureFlag: null },
  TRANSPORT_MANAGER: {
    key: 'TRANSPORT_MANAGER',
    scope: 'SCHOOL',
    privileged: false,
    featureFlag: 'role.transport_manager',
  },
  DISPATCHER: {
    key: 'DISPATCHER',
    scope: 'SCHOOL',
    privileged: false,
    featureFlag: 'role.dispatcher',
  },
  BUS_ATTENDANT: {
    key: 'BUS_ATTENDANT',
    scope: 'SCHOOL',
    privileged: false,
    featureFlag: 'role.bus_attendant',
  },
});

/** Roles a school operator may grant through a school user invitation. */
export const SCHOOL_INVITABLE_ROLES = [
  'DRIVER',
  'GUARDIAN',
  'TRANSPORT_MANAGER',
  'DISPATCHER',
  'BUS_ATTENDANT',
] as const satisfies readonly RoleKey[];

export type SchoolInvitableRole = (typeof SCHOOL_INVITABLE_ROLES)[number];

export function isRoleKey(value: string): value is RoleKey {
  return (ROLE_KEYS as readonly string[]).includes(value);
}

/**
 * A school operator may only grant school-scoped, non-privileged roles, and deferred roles only
 * when the school's feature flag is on. SCHOOL_ADMIN is granted through the dedicated operator
 * workflow, and PLATFORM_ADMIN can never be granted by a school.
 */
export function canSchoolOperatorAssignRole(
  role: string,
  enabledSchoolFlags: ReadonlySet<string>,
): Decision {
  if (!isRoleKey(role)) return deny('ROLE_NOT_ASSIGNABLE');
  const definition = ROLE_DEFINITIONS[role];
  if (definition.scope !== 'SCHOOL' || definition.privileged) return deny('ROLE_NOT_ASSIGNABLE');
  if (!(SCHOOL_INVITABLE_ROLES as readonly string[]).includes(role)) {
    return deny('ROLE_NOT_ASSIGNABLE');
  }
  if (definition.featureFlag !== null && !enabledSchoolFlags.has(definition.featureFlag)) {
    return deny('FEATURE_DISABLED');
  }
  return ALLOW;
}

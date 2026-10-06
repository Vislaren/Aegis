import type { administration } from '@aegis/contracts';

/**
 * Role contexts the signed-in person may enter, derived from the server's access contexts.
 * This only shapes navigation: the server authorizes every request again.
 */
export type RoleContext =
  | { kind: 'platform'; label: string; operatorName: string }
  | {
      kind: 'school-admin';
      label: string;
      schoolId: string;
      schoolName: string;
      operatorName: string;
    }
  | { kind: 'driver'; label: string; schoolId: string; schoolName: string }
  | { kind: 'guardian'; label: string; schoolId: string; schoolName: string };

export function availableContexts(contexts: administration.AccessContextsResponse): RoleContext[] {
  const result: RoleContext[] = [];
  if (contexts.platformOperator?.status === 'ACTIVE') {
    result.push({
      kind: 'platform',
      label: 'Aegis platform administration',
      operatorName: contexts.platformOperator.displayName,
    });
  }
  for (const school of contexts.schools) {
    if (school.schoolStatus !== 'ACTIVE' || school.membershipStatus !== 'ACTIVE') continue;
    if (school.roles.includes('SCHOOL_ADMIN') && school.operatorProfile?.status === 'ACTIVE') {
      result.push({
        kind: 'school-admin',
        label: `${school.schoolName}: administration`,
        schoolId: school.schoolId,
        schoolName: school.schoolName,
        operatorName: school.operatorProfile.displayName,
      });
    }
    if (school.roles.includes('DRIVER')) {
      result.push({
        kind: 'driver',
        label: `${school.schoolName}: driver`,
        schoolId: school.schoolId,
        schoolName: school.schoolName,
      });
    }
    if (school.roles.includes('GUARDIAN')) {
      result.push({
        kind: 'guardian',
        label: `${school.schoolName}: guardian`,
        schoolId: school.schoolId,
        schoolName: school.schoolName,
      });
    }
  }
  return result;
}

export function routeFor(context: RoleContext): string {
  switch (context.kind) {
    case 'platform':
      return '/platform';
    case 'school-admin':
      return `/school/${context.schoolId}`;
    case 'driver':
      return `/driver/${context.schoolId}`;
    case 'guardian':
      return `/guardian/${context.schoolId}`;
  }
}

export type SessionGate =
  | { next: 'sign-in' }
  | { next: 'mfa-enroll' }
  | { next: 'mfa-verify' }
  | { next: 'no-access' }
  | { next: 'choose'; contexts: RoleContext[] }
  | { next: 'home'; route: string };

/**
 * Where to go after authentication. Operators must complete MFA before any administration
 * context is offered; other roles go straight to their only context.
 */
export function gateAfterSignIn(input: {
  session: { aal: number; mfaEnrolled: boolean; mfaRequiredForPrivilegedUse: boolean } | null;
  contexts: administration.AccessContextsResponse | null;
}): SessionGate {
  if (input.session === null) return { next: 'sign-in' };
  if (input.session.mfaRequiredForPrivilegedUse && input.session.aal < 2) {
    return { next: input.session.mfaEnrolled ? 'mfa-verify' : 'mfa-enroll' };
  }
  if (input.contexts === null) return { next: 'no-access' };
  const contexts = availableContexts(input.contexts);
  if (contexts.length === 0) return { next: 'no-access' };
  const only = contexts[0];
  if (contexts.length === 1 && only !== undefined) return { next: 'home', route: routeFor(only) };
  return { next: 'choose', contexts };
}

import { Inject, Injectable } from '@nestjs/common';
import type {
  ActorContext,
  MembershipStatus,
  OperatorStatus,
  RoleKey,
  SchoolStatus,
} from '@aegis/domain';
import type { identity } from '@aegis/contracts';
import { AppError, USER_CONTEXT, type AuthContext, type RequestMeta } from '@aegis/service-kit';
import { PrismaService } from '../infrastructure/prisma.service';
import { IDENTITY_CLIENT, type IdentityPort } from '../infrastructure/identity.client';

export interface LoadedActor {
  actor: ActorContext;
  session: identity.SessionIntrospection;
  platformOperator: {
    profileId: string;
    displayName: string;
    status: OperatorStatus;
    workspaceId: string;
  } | null;
  schoolOperators: Array<{
    profileId: string;
    schoolId: string;
    workspaceId: string;
    displayName: string;
    status: OperatorStatus;
  }>;
  schools: Array<{
    schoolId: string;
    schoolName: string;
    schoolStatus: SchoolStatus;
    membershipStatus: MembershipStatus;
    roles: RoleKey[];
  }>;
}

/**
 * Builds the authorization context for a request from authoritative sources: the session from
 * identity-service (synchronously, fail closed) and profiles, memberships, and roles from this
 * service's database. Nothing is taken from the client except the verified token.
 */
@Injectable()
export class ActorService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(IDENTITY_CLIENT) private readonly identity: IdentityPort,
  ) {}

  async load(
    auth: AuthContext,
    meta: Pick<RequestMeta, 'correlationId' | 'traceparent'>,
  ): Promise<LoadedActor> {
    const session = await this.identity.introspectSession(auth.sessionId, meta);
    if (session === null || !session.active || session.userId !== auth.userId) {
      throw new AppError('UNAUTHENTICATED', { internalReason: 'session not active' });
    }

    return this.prisma.withContext(USER_CONTEXT(auth.userId), async (tx) => {
      const [platformProfile, schoolProfiles, memberships] = await Promise.all([
        tx.platformAdminOperatorProfile.findFirst({ where: { userId: auth.userId } }),
        tx.schoolAdminOperatorProfile.findMany({ where: { userId: auth.userId } }),
        tx.schoolMembership.findMany({
          where: { userId: auth.userId },
          include: { school: true, roleAssignments: { where: { status: 'ACTIVE' } } },
          orderBy: { createdAt: 'asc' },
        }),
      ]);

      const schools = memberships.map((m) => ({
        schoolId: m.schoolId,
        schoolName: m.school.name,
        schoolStatus: m.school.status as SchoolStatus,
        membershipStatus: m.status as MembershipStatus,
        roles: m.roleAssignments.map((r) => r.roleKey as RoleKey),
      }));

      const actor: ActorContext = {
        userId: auth.userId,
        sessionId: auth.sessionId,
        userStatus: session.userStatus,
        // The session's assurance level comes from identity-service, not from the token.
        sessionAal: session.aal,
        platformOperator:
          platformProfile === null
            ? null
            : { profileId: platformProfile.id, status: platformProfile.status as OperatorStatus },
        schoolOperators: schoolProfiles.map((p) => ({
          profileId: p.id,
          schoolId: p.schoolId,
          status: p.status as OperatorStatus,
        })),
        memberships: schools.map((s) => ({
          schoolId: s.schoolId,
          schoolStatus: s.schoolStatus,
          status: s.membershipStatus,
          roles: s.roles,
        })),
        activeLease: null,
      };

      return {
        actor,
        session,
        platformOperator:
          platformProfile === null
            ? null
            : {
                profileId: platformProfile.id,
                displayName: platformProfile.displayName,
                status: platformProfile.status as OperatorStatus,
                workspaceId: platformProfile.workspaceId,
              },
        schoolOperators: schoolProfiles.map((p) => ({
          profileId: p.id,
          schoolId: p.schoolId,
          workspaceId: p.workspaceId,
          displayName: p.displayName,
          status: p.status as OperatorStatus,
        })),
        schools,
      };
    });
  }
}

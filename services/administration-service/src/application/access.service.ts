import { Inject, Injectable } from '@nestjs/common';
import { decodeCursor, encodeCursor, type administration } from '@aegis/contracts';
import { AppError, type AuthContext, type RequestMeta } from '@aegis/service-kit';
import { ActorService } from './actor.service';
import { PrivilegedAccessService } from './privileged-access.service';

type Meta = Pick<RequestMeta, 'correlationId' | 'sourceIp' | 'userAgent' | 'traceparent'>;

/** Read models for the signed-in user: role contexts (navigation) and privileged history. */
@Injectable()
export class AccessService {
  constructor(
    @Inject(ActorService) private readonly actors: ActorService,
    @Inject(PrivilegedAccessService) private readonly privileged: PrivilegedAccessService,
  ) {}

  /**
   * The contexts the client may offer. This drives navigation only; every action is still
   * authorized server-side when it is performed.
   */
  async contexts(auth: AuthContext, meta: Meta): Promise<administration.AccessContextsResponse> {
    const loaded = await this.actors.load(auth, meta);
    const activeLease = await this.privileged.currentFor(loaded, auth);
    return {
      userId: auth.userId,
      platformOperator:
        loaded.platformOperator === null
          ? null
          : {
              profileId: loaded.platformOperator.profileId,
              displayName: loaded.platformOperator.displayName,
              status: loaded.platformOperator.status,
            },
      schools: loaded.schools.map((school) => {
        const operator = loaded.schoolOperators.find((o) => o.schoolId === school.schoolId);
        return {
          schoolId: school.schoolId,
          schoolName: school.schoolName,
          schoolStatus: school.schoolStatus,
          membershipStatus: school.membershipStatus,
          // Roles are only effective in an active membership of an active school.
          roles:
            school.membershipStatus === 'ACTIVE' && school.schoolStatus === 'ACTIVE'
              ? school.roles
              : [],
          operatorProfile:
            operator === undefined
              ? null
              : {
                  profileId: operator.profileId,
                  displayName: operator.displayName,
                  status: operator.status,
                },
        };
      }),
      activeLease,
    };
  }

  /** Privileged session history of the workspace whose lease this session currently holds. */
  async sessionHistory(
    auth: AuthContext,
    meta: Meta,
    query: { cursor?: string; limit: number },
  ): Promise<{ items: Array<administration.SessionHistoryItem>; nextCursor: string | null }> {
    const current = await this.privileged.current(auth, meta);
    if (current === null) throw new AppError('PRIVILEGED_LEASE_REQUIRED');
    const action =
      current.workspace.type === 'PLATFORM'
        ? 'platform.session_history.read'
        : 'school.session_history.read';
    const schoolId = current.workspace.schoolId ?? undefined;

    return this.privileged.runPrivileged(auth, meta, action, schoolId, async (tx, ctx) => {
      const cursor = decodeCursor(query.cursor);
      const rows = await tx.privilegedSessionHistory.findMany({
        where: {
          workspaceType: ctx.workspace.type,
          workspaceId: ctx.workspace.workspaceId,
          ...(cursor === null
            ? {}
            : {
                OR: [
                  { attemptedAt: { lt: cursor.at } },
                  { attemptedAt: cursor.at, id: { lt: cursor.id } },
                ],
              }),
        },
        orderBy: [{ attemptedAt: 'desc' }, { id: 'desc' }],
        take: query.limit + 1,
      });
      const page = rows.slice(0, query.limit);
      const last = page.at(-1);
      return {
        items: page.map((row) => ({
          id: row.id,
          workspaceType: row.workspaceType as 'PLATFORM' | 'SCHOOL',
          operatorProfileId: row.operatorProfileId,
          operatorDisplayName: row.operatorDisplayName,
          userId: row.userId,
          sessionId: row.sessionId,
          grantId: row.grantId,
          outcome: row.outcome,
          attemptedAt: row.attemptedAt.toISOString(),
          acquiredAt: row.acquiredAt?.toISOString() ?? null,
          lastActiveAt: row.lastActiveAt?.toISOString() ?? null,
          endedAt: row.endedAt?.toISOString() ?? null,
          endReason: row.endReason,
          sourceIp: row.sourceIp,
          userAgent: row.userAgent,
        })),
        nextCursor:
          rows.length > query.limit && last !== undefined
            ? encodeCursor({ at: last.attemptedAt, id: last.id })
            : null,
      };
    });
  }
}

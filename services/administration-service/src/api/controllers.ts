import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { PageQuery, Uuid, administration } from '@aegis/contracts';
import {
  Auth,
  Meta,
  ResponseSchema,
  ZodPipe,
  type AuthContext,
  type RequestMeta,
} from '@aegis/service-kit';
import { AccessService } from '../application/access.service';
import { PlatformService } from '../application/platform.service';
import { PrivilegedAccessService } from '../application/privileged-access.service';
import { SchoolAdminService } from '../application/school-admin.service';

const UuidParam = new ZodPipe(Uuid);

@Controller('api/v1/access')
export class AccessController {
  constructor(@Inject(AccessService) private readonly access: AccessService) {}

  @Get('contexts')
  @ResponseSchema(administration.AccessContextsResponse)
  contexts(@Auth() auth: AuthContext, @Meta() meta: RequestMeta) {
    return this.access.contexts(auth, meta);
  }
}

@Controller('api/v1/privileged-access')
export class PrivilegedAccessController {
  constructor(
    @Inject(PrivilegedAccessService) private readonly privileged: PrivilegedAccessService,
  ) {}

  @Post('acquire')
  @HttpCode(200)
  @ResponseSchema(administration.LeaseView)
  acquire(
    @Auth() auth: AuthContext,
    @Meta() meta: RequestMeta,
    @Body(new ZodPipe(administration.AcquireLeaseRequest))
    body: z.infer<typeof administration.AcquireLeaseRequest>,
  ) {
    return this.privileged.acquire(auth, meta, body.workspace);
  }

  @Post('heartbeat')
  @HttpCode(200)
  @ResponseSchema(administration.LeaseView)
  heartbeat(
    @Auth() auth: AuthContext,
    @Meta() meta: RequestMeta,
    @Body(new ZodPipe(administration.HeartbeatRequest))
    body: z.infer<typeof administration.HeartbeatRequest>,
  ) {
    return this.privileged.heartbeat(auth, meta, body);
  }

  @Post('release')
  @HttpCode(204)
  async release(
    @Auth() auth: AuthContext,
    @Meta() meta: RequestMeta,
    @Body(new ZodPipe(administration.ReleaseRequest))
    body: z.infer<typeof administration.ReleaseRequest>,
  ): Promise<void> {
    await this.privileged.release(auth, meta, body.grantId);
  }

  @Post('takeover')
  @HttpCode(200)
  @ResponseSchema(administration.LeaseView)
  takeover(
    @Auth() auth: AuthContext,
    @Meta() meta: RequestMeta,
    @Body(new ZodPipe(administration.TakeoverRequest))
    body: z.infer<typeof administration.TakeoverRequest>,
  ) {
    return this.privileged.takeover(auth, meta, body);
  }

  @Get('current')
  @ResponseSchema(administration.CurrentLeaseResponse)
  async current(@Auth() auth: AuthContext, @Meta() meta: RequestMeta) {
    return { lease: await this.privileged.current(auth, meta) };
  }
}

@Controller('api/v1/administration')
export class SessionHistoryController {
  constructor(@Inject(AccessService) private readonly access: AccessService) {}

  @Get('session-history')
  @ResponseSchema(administration.SessionHistoryResponse)
  history(
    @Auth() auth: AuthContext,
    @Meta() meta: RequestMeta,
    @Query(new ZodPipe(PageQuery)) query: PageQuery,
  ) {
    return this.access.sessionHistory(auth, meta, query);
  }
}

@Controller('api/v1/platform')
export class PlatformController {
  constructor(@Inject(PlatformService) private readonly platform: PlatformService) {}

  @Post('schools')
  @ResponseSchema(administration.ProvisionSchoolResponse)
  async provision(
    @Auth() auth: AuthContext,
    @Meta() meta: RequestMeta,
    @Body(new ZodPipe(administration.ProvisionSchoolRequest))
    body: z.infer<typeof administration.ProvisionSchoolRequest>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const result = await this.platform.provisionSchool(auth, meta, body);
    void reply.status(result.status).header('idempotent-replayed', String(result.replayed));
    return result.body;
  }

  @Get('schools')
  @ResponseSchema(administration.SchoolListResponse)
  schools(
    @Auth() auth: AuthContext,
    @Meta() meta: RequestMeta,
    @Query(new ZodPipe(PageQuery)) query: PageQuery,
  ) {
    return this.platform.listSchools(auth, meta, query);
  }

  @Post('schools/:schoolId/suspend')
  @HttpCode(200)
  @ResponseSchema(administration.SchoolView)
  suspend(
    @Auth() auth: AuthContext,
    @Meta() meta: RequestMeta,
    @Param('schoolId', UuidParam) schoolId: string,
    @Body(new ZodPipe(administration.StatusChangeRequest)) body: { reason: string },
  ) {
    return this.platform.setSchoolStatus(auth, meta, schoolId, 'SUSPENDED', body.reason);
  }

  @Post('schools/:schoolId/reactivate')
  @HttpCode(200)
  @ResponseSchema(administration.SchoolView)
  reactivate(
    @Auth() auth: AuthContext,
    @Meta() meta: RequestMeta,
    @Param('schoolId', UuidParam) schoolId: string,
    @Body(new ZodPipe(administration.StatusChangeRequest)) body: { reason: string },
  ) {
    return this.platform.setSchoolStatus(auth, meta, schoolId, 'ACTIVE', body.reason);
  }

  @Post('schools/:schoolId/privileged-access/revoke')
  @HttpCode(200)
  @ResponseSchema(administration.RevokeSchoolLeaseResponse)
  revokeLease(
    @Auth() auth: AuthContext,
    @Meta() meta: RequestMeta,
    @Param('schoolId', UuidParam) schoolId: string,
    @Body(new ZodPipe(administration.StatusChangeRequest)) body: { reason: string },
  ) {
    return this.platform.revokeSchoolLease(auth, meta, schoolId, body.reason);
  }

  @Post('admin-operators')
  @ResponseSchema(administration.OperatorView)
  createOperator(
    @Auth() auth: AuthContext,
    @Meta() meta: RequestMeta,
    @Body(new ZodPipe(administration.CreateOperatorRequest))
    body: z.infer<typeof administration.CreateOperatorRequest>,
  ) {
    return this.platform.createOperator(auth, meta, body);
  }

  @Get('admin-operators')
  @ResponseSchema(administration.OperatorListResponse)
  operators(
    @Auth() auth: AuthContext,
    @Meta() meta: RequestMeta,
    @Query(new ZodPipe(PageQuery)) query: PageQuery,
  ) {
    return this.platform.listOperators(auth, meta, query);
  }

  @Post('admin-operators/:profileId/suspend')
  @HttpCode(200)
  @ResponseSchema(administration.OperatorView)
  suspendOperator(
    @Auth() auth: AuthContext,
    @Meta() meta: RequestMeta,
    @Param('profileId', UuidParam) profileId: string,
    @Body(new ZodPipe(administration.StatusChangeRequest)) body: { reason: string },
  ) {
    return this.platform.setOperatorStatus(auth, meta, profileId, 'SUSPENDED', body.reason);
  }

  @Post('admin-operators/:profileId/reactivate')
  @HttpCode(200)
  @ResponseSchema(administration.OperatorView)
  reactivateOperator(
    @Auth() auth: AuthContext,
    @Meta() meta: RequestMeta,
    @Param('profileId', UuidParam) profileId: string,
    @Body(new ZodPipe(administration.StatusChangeRequest)) body: { reason: string },
  ) {
    return this.platform.setOperatorStatus(auth, meta, profileId, 'ACTIVE', body.reason);
  }
}

@Controller('api/v1/schools/:schoolId')
export class SchoolAdminController {
  constructor(@Inject(SchoolAdminService) private readonly schools: SchoolAdminService) {}

  @Post('user-invitations')
  @ResponseSchema(administration.MembershipView)
  async invite(
    @Auth() auth: AuthContext,
    @Meta() meta: RequestMeta,
    @Param('schoolId', UuidParam) schoolId: string,
    @Body(new ZodPipe(administration.InviteSchoolUserRequest))
    body: z.infer<typeof administration.InviteSchoolUserRequest>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const result = await this.schools.inviteUser(auth, meta, schoolId, body);
    void reply.status(result.status).header('idempotent-replayed', String(result.replayed));
    return result.body;
  }

  @Get('memberships')
  @ResponseSchema(administration.MembershipListResponse)
  memberships(
    @Auth() auth: AuthContext,
    @Meta() meta: RequestMeta,
    @Param('schoolId', UuidParam) schoolId: string,
    @Query(new ZodPipe(administration.MembershipListQuery))
    query: z.infer<typeof administration.MembershipListQuery>,
  ) {
    return this.schools.listMemberships(auth, meta, schoolId, query);
  }

  @Post('memberships/:membershipId/suspend')
  @HttpCode(200)
  @ResponseSchema(administration.MembershipView)
  suspendMembership(
    @Auth() auth: AuthContext,
    @Meta() meta: RequestMeta,
    @Param('schoolId', UuidParam) schoolId: string,
    @Param('membershipId', UuidParam) membershipId: string,
    @Body(new ZodPipe(administration.StatusChangeRequest)) body: { reason: string },
  ) {
    return this.schools.setMembershipStatus(
      auth,
      meta,
      schoolId,
      membershipId,
      'SUSPENDED',
      body.reason,
    );
  }

  @Post('memberships/:membershipId/reactivate')
  @HttpCode(200)
  @ResponseSchema(administration.MembershipView)
  reactivateMembership(
    @Auth() auth: AuthContext,
    @Meta() meta: RequestMeta,
    @Param('schoolId', UuidParam) schoolId: string,
    @Param('membershipId', UuidParam) membershipId: string,
    @Body(new ZodPipe(administration.StatusChangeRequest)) body: { reason: string },
  ) {
    return this.schools.setMembershipStatus(
      auth,
      meta,
      schoolId,
      membershipId,
      'ACTIVE',
      body.reason,
    );
  }

  @Post('admin-operators')
  @ResponseSchema(administration.OperatorView)
  createOperator(
    @Auth() auth: AuthContext,
    @Meta() meta: RequestMeta,
    @Param('schoolId', UuidParam) schoolId: string,
    @Body(new ZodPipe(administration.CreateOperatorRequest))
    body: z.infer<typeof administration.CreateOperatorRequest>,
  ) {
    return this.schools.createOperator(auth, meta, schoolId, body);
  }

  @Get('admin-operators')
  @ResponseSchema(administration.OperatorListResponse)
  operators(
    @Auth() auth: AuthContext,
    @Meta() meta: RequestMeta,
    @Param('schoolId', UuidParam) schoolId: string,
    @Query(new ZodPipe(PageQuery)) query: PageQuery,
  ) {
    return this.schools.listOperators(auth, meta, schoolId, query);
  }

  @Post('admin-operators/:profileId/suspend')
  @HttpCode(200)
  @ResponseSchema(administration.OperatorView)
  suspendOperator(
    @Auth() auth: AuthContext,
    @Meta() meta: RequestMeta,
    @Param('schoolId', UuidParam) schoolId: string,
    @Param('profileId', UuidParam) profileId: string,
    @Body(new ZodPipe(administration.StatusChangeRequest)) body: { reason: string },
  ) {
    return this.schools.setOperatorStatus(
      auth,
      meta,
      schoolId,
      profileId,
      'SUSPENDED',
      body.reason,
    );
  }

  @Post('admin-operators/:profileId/reactivate')
  @HttpCode(200)
  @ResponseSchema(administration.OperatorView)
  reactivateOperator(
    @Auth() auth: AuthContext,
    @Meta() meta: RequestMeta,
    @Param('schoolId', UuidParam) schoolId: string,
    @Param('profileId', UuidParam) profileId: string,
    @Body(new ZodPipe(administration.StatusChangeRequest)) body: { reason: string },
  ) {
    return this.schools.setOperatorStatus(auth, meta, schoolId, profileId, 'ACTIVE', body.reason);
  }
}

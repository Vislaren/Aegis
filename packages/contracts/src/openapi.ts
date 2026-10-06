import { OpenAPIRegistry, OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import * as administration from './administration';
import * as audit from './audit';
import { PageQuery, ProblemDetails, Uuid } from './common';
import * as identity from './identity';

/**
 * Public API description generated from the same zod contracts the services validate with.
 * Internal `/internal/v1` operations are deliberately absent. Kept out of the package root so the
 * client bundle never includes the generator.
 */
export function buildOpenApiDocument(): object {
  const registry = new OpenAPIRegistry();
  const bearer = registry.registerComponent('securitySchemes', 'bearer', {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'JWT',
  });
  const problem = {
    description: 'Problem details',
    content: { 'application/problem+json': { schema: ProblemDetails } },
  };
  const errors = {
    400: problem,
    401: problem,
    403: problem,
    404: problem,
    409: problem,
    429: problem,
    503: problem,
  };
  const json = (schema: z.ZodType) => ({ content: { 'application/json': { schema } } });
  const secured = [{ [bearer.name]: [] }];
  const schoolParam = z.object({ schoolId: Uuid });

  type Def = {
    method: 'get' | 'post' | 'patch';
    path: string;
    summary: string;
    tag: string;
    request?: z.ZodType;
    query?: z.ZodObject;
    params?: z.ZodObject;
    response?: z.ZodType;
    status?: number;
    public?: boolean;
    idempotent?: boolean;
  };

  const defs: Def[] = [
    {
      method: 'post',
      path: '/api/v1/auth/otp/start',
      summary: 'Start one-time-code sign-in (non-enumerating)',
      tag: 'auth',
      request: identity.OtpStartRequest,
      response: identity.OtpChallengeResponse,
      status: 202,
      public: true,
    },
    {
      method: 'post',
      path: '/api/v1/auth/otp/verify',
      summary: 'Verify a one-time code and create a session',
      tag: 'auth',
      request: identity.OtpVerifyRequest,
      response: identity.SessionResponse,
      public: true,
    },
    {
      method: 'post',
      path: '/api/v1/auth/invitations/redeem',
      summary: 'Redeem an invitation token; sends a code to the invited contact',
      tag: 'auth',
      request: identity.InvitationRedeemRequest,
      response: identity.OtpChallengeResponse,
      status: 202,
      public: true,
    },
    {
      method: 'post',
      path: '/api/v1/auth/mfa/totp/enroll',
      summary: 'Begin TOTP enrollment',
      tag: 'auth',
      response: identity.TotpEnrollResponse,
    },
    {
      method: 'post',
      path: '/api/v1/auth/mfa/totp/activate',
      summary: 'Activate TOTP and raise the session to AAL2',
      tag: 'auth',
      request: identity.TotpCodeRequest,
      response: identity.SessionResponse,
    },
    {
      method: 'post',
      path: '/api/v1/auth/mfa/verify',
      summary: 'Verify TOTP (AAL2 and freshness for sensitive actions)',
      tag: 'auth',
      request: identity.TotpCodeRequest,
      response: identity.SessionResponse,
    },
    {
      method: 'post',
      path: '/api/v1/auth/refresh',
      summary: 'Rotate the refresh token (reuse revokes the session)',
      tag: 'auth',
      request: identity.RefreshRequest,
      response: identity.SessionResponse,
      public: true,
    },
    {
      method: 'post',
      path: '/api/v1/auth/logout',
      summary: 'End the session and release any privileged lease',
      tag: 'auth',
      status: 204,
    },
    {
      method: 'get',
      path: '/api/v1/me',
      summary: 'Own profile',
      tag: 'me',
      response: identity.MeResponse,
    },
    {
      method: 'patch',
      path: '/api/v1/me',
      summary: 'Update own profile',
      tag: 'me',
      request: identity.UpdateMeRequest,
      response: identity.MeResponse,
    },
    {
      method: 'get',
      path: '/api/v1/me/sessions',
      summary: 'Own active sessions',
      tag: 'me',
      response: identity.SessionListResponse,
    },
    {
      method: 'post',
      path: '/api/v1/me/sessions/{sessionId}/revoke',
      summary: 'Revoke one of your sessions',
      tag: 'me',
      params: z.object({ sessionId: Uuid }),
      status: 204,
    },
    {
      method: 'get',
      path: '/api/v1/me/consents',
      summary: 'Own consent records',
      tag: 'me',
      response: identity.ConsentListResponse,
    },
    {
      method: 'post',
      path: '/api/v1/me/consents',
      summary: 'Acknowledge a current policy document',
      tag: 'me',
      request: identity.ConsentRequest,
      response: identity.ConsentRecordView,
      status: 201,
    },
    {
      method: 'get',
      path: '/api/v1/me/security-events',
      summary: 'Own security events',
      tag: 'me',
      query: PageQuery,
      response: audit.SecurityEventListResponse,
    },
    {
      method: 'get',
      path: '/api/v1/policies/current',
      summary: 'Current policy document versions',
      tag: 'me',
      response: identity.PolicyDocumentsResponse,
      public: true,
    },
    {
      method: 'get',
      path: '/api/v1/access/contexts',
      summary: 'Role contexts for navigation (not an authorization grant)',
      tag: 'access',
      response: administration.AccessContextsResponse,
    },
    {
      method: 'post',
      path: '/api/v1/privileged-access/acquire',
      summary: 'Acquire the workspace lease (409 ADMIN_WORKSPACE_IN_USE when occupied)',
      tag: 'privileged-access',
      request: administration.AcquireLeaseRequest,
      response: administration.LeaseView,
    },
    {
      method: 'post',
      path: '/api/v1/privileged-access/heartbeat',
      summary: 'Renew the lease',
      tag: 'privileged-access',
      request: administration.HeartbeatRequest,
      response: administration.LeaseView,
    },
    {
      method: 'post',
      path: '/api/v1/privileged-access/release',
      summary: 'Release the lease',
      tag: 'privileged-access',
      request: administration.ReleaseRequest,
      status: 204,
    },
    {
      method: 'post',
      path: '/api/v1/privileged-access/takeover',
      summary: 'Emergency takeover (fresh MFA and reason required)',
      tag: 'privileged-access',
      request: administration.TakeoverRequest,
      response: administration.LeaseView,
    },
    {
      method: 'get',
      path: '/api/v1/privileged-access/current',
      summary: 'Lease held by this session',
      tag: 'privileged-access',
      response: administration.CurrentLeaseResponse,
    },
    {
      method: 'get',
      path: '/api/v1/administration/session-history',
      summary: 'Privileged session history of the leased workspace',
      tag: 'administration',
      query: PageQuery,
      response: administration.SessionHistoryResponse,
    },
    {
      method: 'get',
      path: '/api/v1/administration/activity-journal',
      summary: 'Append-only journal of the leased workspace',
      tag: 'administration',
      query: audit.JournalQuery,
      response: audit.JournalResponse,
    },
    {
      method: 'post',
      path: '/api/v1/platform/schools',
      summary: 'Manually provision a school tenant and its first administrator',
      tag: 'platform',
      request: administration.ProvisionSchoolRequest,
      response: administration.ProvisionSchoolResponse,
      status: 201,
      idempotent: true,
    },
    {
      method: 'get',
      path: '/api/v1/platform/schools',
      summary: 'List school tenants (metadata only)',
      tag: 'platform',
      query: PageQuery,
      response: administration.SchoolListResponse,
    },
    {
      method: 'post',
      path: '/api/v1/platform/schools/{schoolId}/suspend',
      summary: 'Suspend a school tenant',
      tag: 'platform',
      params: schoolParam,
      request: administration.StatusChangeRequest,
      response: administration.SchoolView,
    },
    {
      method: 'post',
      path: '/api/v1/platform/schools/{schoolId}/reactivate',
      summary: 'Reactivate a school tenant',
      tag: 'platform',
      params: schoolParam,
      request: administration.StatusChangeRequest,
      response: administration.SchoolView,
    },
    {
      method: 'post',
      path: '/api/v1/platform/schools/{schoolId}/privileged-access/revoke',
      summary: 'Revoke a stuck school lease (no data access granted)',
      tag: 'platform',
      params: schoolParam,
      request: administration.StatusChangeRequest,
      response: administration.RevokeSchoolLeaseResponse,
    },
    {
      method: 'post',
      path: '/api/v1/platform/admin-operators',
      summary: 'Invite a platform operator',
      tag: 'platform',
      request: administration.CreateOperatorRequest,
      response: administration.OperatorView,
      status: 201,
    },
    {
      method: 'get',
      path: '/api/v1/platform/admin-operators',
      summary: 'List platform operators',
      tag: 'platform',
      query: PageQuery,
      response: administration.OperatorListResponse,
    },
    {
      method: 'post',
      path: '/api/v1/schools/{schoolId}/user-invitations',
      summary: 'Invite a driver, guardian, or enabled role into this school',
      tag: 'school',
      params: schoolParam,
      request: administration.InviteSchoolUserRequest,
      response: administration.MembershipView,
      status: 201,
      idempotent: true,
    },
    {
      method: 'get',
      path: '/api/v1/schools/{schoolId}/memberships',
      summary: 'List school memberships',
      tag: 'school',
      params: schoolParam,
      query: administration.MembershipListQuery,
      response: administration.MembershipListResponse,
    },
    {
      method: 'post',
      path: '/api/v1/schools/{schoolId}/admin-operators',
      summary: 'Invite another school administrator',
      tag: 'school',
      params: schoolParam,
      request: administration.CreateOperatorRequest,
      response: administration.OperatorView,
      status: 201,
    },
    {
      method: 'get',
      path: '/api/v1/schools/{schoolId}/admin-operators',
      summary: 'List school administrators',
      tag: 'school',
      params: schoolParam,
      query: PageQuery,
      response: administration.OperatorListResponse,
    },
  ];

  for (const def of defs) {
    const status = def.status ?? 200;
    registry.registerPath({
      method: def.method,
      path: def.path,
      summary: def.summary,
      tags: [def.tag],
      security: def.public === true ? [] : secured,
      request: {
        ...(def.request === undefined ? {} : { body: json(def.request) }),
        ...(def.query === undefined ? {} : { query: def.query }),
        ...(def.params === undefined ? {} : { params: def.params }),
        ...(def.idempotent === true
          ? { headers: z.object({ 'idempotency-key': z.string().min(16).max(128) }) }
          : {}),
      },
      responses: {
        [status]:
          def.response === undefined
            ? { description: 'No content' }
            : { description: 'Success', ...json(def.response) },
        ...errors,
      },
    });
  }

  return new OpenApiGeneratorV31(registry.definitions).generateDocument({
    openapi: '3.1.0',
    info: {
      title: 'Aegis public API',
      version: '1.0.0',
      description:
        'Public API served through api-gateway. Errors use RFC 9457 problem details with a correlationId.',
    },
    servers: [{ url: '/' }],
  });
}

import { z } from 'zod';
import {
  ContactIdentifier,
  CountryCode,
  DisplayName,
  IanaTimezone,
  IsoDateTime,
  LanguageTag,
  PageQuery,
  Reason,
  Uuid,
  WorkspaceSelector,
  WorkspaceTypeSchema,
  page,
} from './common';

// ---------- Access contexts ----------

export const OperatorStatusSchema = z.enum(['INVITED', 'ACTIVE', 'SUSPENDED']);
export const MembershipStatusSchema = z.enum(['INVITED', 'ACTIVE', 'SUSPENDED', 'REVOKED']);
export const SchoolStatusSchema = z.enum(['ACTIVE', 'SUSPENDED']);
export const RoleKeySchema = z.enum([
  'PLATFORM_ADMIN',
  'SCHOOL_ADMIN',
  'DRIVER',
  'GUARDIAN',
  'TRANSPORT_MANAGER',
  'DISPATCHER',
  'BUS_ATTENDANT',
]);
export const SchoolInvitableRoleSchema = z.enum([
  'DRIVER',
  'GUARDIAN',
  'TRANSPORT_MANAGER',
  'DISPATCHER',
  'BUS_ATTENDANT',
]);

export const LeaseView = z.object({
  grantId: Uuid,
  fencingToken: z.number().int().positive(),
  workspace: z.object({
    type: WorkspaceTypeSchema,
    workspaceId: Uuid,
    schoolId: Uuid.nullable(),
    schoolName: z.string().nullable(),
  }),
  operator: z.object({ profileId: Uuid, displayName: z.string() }),
  acquiredAt: IsoDateTime,
  expiresAt: IsoDateTime,
  idleExpiresAt: IsoDateTime,
  heartbeatIntervalSeconds: z.number().int().positive(),
});
export type LeaseView = z.infer<typeof LeaseView>;

export const AccessContextsResponse = z.object({
  userId: Uuid,
  platformOperator: z
    .object({ profileId: Uuid, displayName: z.string(), status: OperatorStatusSchema })
    .nullable(),
  schools: z.array(
    z.object({
      schoolId: Uuid,
      schoolName: z.string(),
      schoolStatus: SchoolStatusSchema,
      membershipStatus: MembershipStatusSchema,
      roles: z.array(RoleKeySchema),
      operatorProfile: z
        .object({ profileId: Uuid, displayName: z.string(), status: OperatorStatusSchema })
        .nullable(),
    }),
  ),
  activeLease: LeaseView.nullable(),
});
export type AccessContextsResponse = z.infer<typeof AccessContextsResponse>;

// ---------- Privileged access ----------

export const AcquireLeaseRequest = z.strictObject({ workspace: WorkspaceSelector });
export const HeartbeatRequest = z.strictObject({ grantId: Uuid, userActive: z.boolean() });
export const ReleaseRequest = z.strictObject({ grantId: Uuid });
export const TakeoverRequest = z.strictObject({ workspace: WorkspaceSelector, reason: Reason });
export const CurrentLeaseResponse = z.object({ lease: LeaseView.nullable() });

export const SessionHistoryItem = z.object({
  id: Uuid,
  workspaceType: WorkspaceTypeSchema,
  operatorProfileId: Uuid.nullable(),
  operatorDisplayName: z.string().nullable(),
  userId: Uuid,
  sessionId: Uuid,
  grantId: Uuid.nullable(),
  outcome: z.string(),
  attemptedAt: IsoDateTime,
  acquiredAt: IsoDateTime.nullable(),
  lastActiveAt: IsoDateTime.nullable(),
  endedAt: IsoDateTime.nullable(),
  endReason: z.string().nullable(),
  sourceIp: z.string().nullable(),
  userAgent: z.string().nullable(),
});
export const SessionHistoryQuery = PageQuery;
export const SessionHistoryResponse = page(SessionHistoryItem);

// ---------- Platform administration ----------

export const SchoolView = z.object({
  schoolId: Uuid,
  name: z.string(),
  slug: z.string(),
  status: SchoolStatusSchema,
  timezone: z.string(),
  countryCode: z.string(),
  defaultLanguage: z.string(),
  createdAt: IsoDateTime,
});

export const ProvisionSchoolRequest = z.strictObject({
  name: z.string().trim().min(3).max(160),
  slug: z
    .string()
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
    .min(3)
    .max(60),
  timezone: IanaTimezone,
  countryCode: CountryCode,
  defaultLanguage: LanguageTag,
  firstAdministrator: z.strictObject({ displayName: DisplayName, contact: ContactIdentifier }),
});
export const ProvisionSchoolResponse = z.object({
  school: SchoolView,
  firstAdministrator: z.object({
    userId: Uuid,
    operatorProfileId: Uuid,
    status: OperatorStatusSchema,
    contactMasked: z.string(),
  }),
});

export const SchoolListResponse = page(SchoolView);

export const OperatorView = z.object({
  profileId: Uuid,
  userId: Uuid,
  displayName: z.string(),
  contactMasked: z.string(),
  status: OperatorStatusSchema,
  createdAt: IsoDateTime,
});
export const OperatorListResponse = page(OperatorView);

export const CreateOperatorRequest = z.strictObject({
  displayName: DisplayName,
  contact: ContactIdentifier,
});

export const RevokeSchoolLeaseResponse = z.object({ revoked: z.boolean() });

// ---------- School administration ----------

export const InviteSchoolUserRequest = z.strictObject({
  displayName: DisplayName,
  contact: ContactIdentifier,
  role: SchoolInvitableRoleSchema,
});

export const MembershipView = z.object({
  membershipId: Uuid,
  userId: Uuid,
  displayName: z.string(),
  contactMasked: z.string(),
  status: MembershipStatusSchema,
  roles: z.array(RoleKeySchema),
  createdAt: IsoDateTime,
});
export const MembershipListQuery = PageQuery.extend({ role: RoleKeySchema.optional() });
export const MembershipListResponse = page(MembershipView);

export const StatusChangeRequest = z.strictObject({ reason: Reason });

// ---------- Internal: /internal/v1 (administration-service) ----------

export const ValidateLeaseRequest = z.strictObject({
  sessionId: Uuid,
  userId: Uuid,
  /** When omitted, validates whatever lease the session currently holds. */
  workspace: WorkspaceSelector.optional(),
  /** Count the call as operator activity (extends the idle window). */
  touch: z.boolean().default(true),
});
export const ValidatedLease = z.object({
  grantId: Uuid,
  fencingToken: z.number().int().positive(),
  workspaceType: WorkspaceTypeSchema,
  workspaceId: Uuid,
  schoolId: Uuid.nullable(),
  operatorProfileId: Uuid,
  operatorDisplayName: z.string(),
  expiresAt: IsoDateTime,
});
export type ValidatedLease = z.infer<typeof ValidatedLease>;
export const ValidateLeaseResponse = z.object({ lease: ValidatedLease });

export type SchoolView = z.infer<typeof SchoolView>;
export type ProvisionSchoolResponse = z.infer<typeof ProvisionSchoolResponse>;
export type OperatorView = z.infer<typeof OperatorView>;
export type MembershipView = z.infer<typeof MembershipView>;
export type SessionHistoryItem = z.infer<typeof SessionHistoryItem>;

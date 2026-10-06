import { z } from 'zod';
import { ContactIdentifier, DisplayName, IsoDateTime, LanguageTag, Uuid } from './common';

// ---------- Public: /api/v1/auth, /api/v1/me ----------

export const OtpStartRequest = z.strictObject({ identifier: ContactIdentifier });
export const OtpChallengeResponse = z.object({ challengeId: Uuid, expiresAt: IsoDateTime });

export const ClientDescriptor = z.strictObject({
  type: z.enum(['WEB', 'NATIVE']),
  deviceId: z.string().min(8).max(128),
  deviceName: z.string().max(64).optional(),
  platform: z.enum(['web', 'ios', 'android']),
});
export type ClientDescriptor = z.infer<typeof ClientDescriptor>;

export const OtpVerifyRequest = z.strictObject({
  challengeId: Uuid,
  code: z.string().regex(/^\d{6}$/),
  client: ClientDescriptor,
});

export const InvitationRedeemRequest = z.strictObject({
  token: z.string().min(32).max(256),
});

export const TotpCodeRequest = z.strictObject({ code: z.string().regex(/^\d{6}$/) });

export const TotpEnrollResponse = z.object({ secret: z.string(), otpauthUri: z.string() });

export const RefreshRequest = z.strictObject({
  refreshToken: z.string().min(32).max(256).optional(),
});

export const SessionView = z.object({
  sessionId: Uuid,
  userId: Uuid,
  aal: z.union([z.literal(1), z.literal(2)]),
  mfaEnrolled: z.boolean(),
  /** True when the user holds operator profiles and must complete MFA before privileged use. */
  mfaRequiredForPrivilegedUse: z.boolean(),
  accessTokenExpiresAt: IsoDateTime,
});

/** Native clients receive tokens in the body; web clients receive HttpOnly cookies instead. */
export const SessionResponse = z.object({
  session: SessionView,
  tokens: z.object({ accessToken: z.string(), refreshToken: z.string() }).nullable(),
});
export type SessionResponse = z.infer<typeof SessionResponse>;

export const MeResponse = z.object({
  userId: Uuid,
  displayName: z.string(),
  email: z.string().nullable(),
  phoneE164: z.string().nullable(),
  preferredLanguage: z.string(),
  status: z.enum(['INVITED', 'ACTIVE', 'SUSPENDED', 'DISABLED']),
  mfaEnrolled: z.boolean(),
  session: z.object({
    sessionId: Uuid,
    aal: z.number().int(),
    mfaVerifiedAt: IsoDateTime.nullable(),
  }),
});

export const UpdateMeRequest = z
  .strictObject({ displayName: DisplayName.optional(), preferredLanguage: LanguageTag.optional() })
  .refine((body) => Object.keys(body).length > 0, 'at least one field is required');

export const SessionListItem = z.object({
  sessionId: Uuid,
  current: z.boolean(),
  clientType: z.enum(['WEB', 'NATIVE']),
  platform: z.string(),
  deviceName: z.string().nullable(),
  aal: z.number().int(),
  createdAt: IsoDateTime,
  lastSeenAt: IsoDateTime,
});
export const SessionListResponse = z.object({ items: z.array(SessionListItem) });

export const CONSENT_DOCUMENT_TYPES = [
  'PRIVACY_NOTICE',
  'TERMS_OF_USE',
  'LOCATION_PROCESSING',
] as const;
export const ConsentRequest = z.strictObject({
  documentType: z.enum(CONSENT_DOCUMENT_TYPES),
  documentVersion: z.string().regex(/^\d{4}-\d{2}-\d{2}(\.\d+)?$/),
});
export const ConsentRecordView = z.object({
  id: Uuid,
  documentType: z.enum(CONSENT_DOCUMENT_TYPES),
  documentVersion: z.string(),
  acceptedAt: IsoDateTime,
});
export const ConsentListResponse = z.object({ items: z.array(ConsentRecordView) });

export const PolicyDocumentsResponse = z.object({
  documents: z.array(
    z.object({ type: z.enum(CONSENT_DOCUMENT_TYPES), version: z.string(), title: z.string() }),
  ),
});

// ---------- Internal: /internal/v1 (identity-service) ----------

export const ProvisionUserRequest = z.strictObject({
  displayName: DisplayName,
  contact: ContactIdentifier,
});
export const ProvisionUserResponse = z.object({
  userId: Uuid,
  created: z.boolean(),
  status: z.enum(['INVITED', 'ACTIVE', 'SUSPENDED', 'DISABLED']),
  /** Masked contact for administrative display. The full contact never leaves identity-service. */
  contactMasked: z.string(),
});
export type ProvisionUserResponse = z.infer<typeof ProvisionUserResponse>;

export const SessionIntrospection = z.object({
  sessionId: Uuid,
  userId: Uuid,
  active: z.boolean(),
  userStatus: z.enum(['INVITED', 'ACTIVE', 'SUSPENDED', 'DISABLED']),
  aal: z.union([z.literal(1), z.literal(2)]),
  mfaVerifiedAt: IsoDateTime.nullable(),
});
export type SessionIntrospection = z.infer<typeof SessionIntrospection>;

/** Claims carried by Aegis access tokens (ES256, verified through the identity JWKS). */
export const AccessTokenClaims = z.object({
  sub: Uuid,
  sid: Uuid,
  aal: z.union([z.literal(1), z.literal(2)]),
  iss: z.string(),
  aud: z.union([z.string(), z.array(z.string())]),
  exp: z.number(),
  iat: z.number(),
});
export type AccessTokenClaims = z.infer<typeof AccessTokenClaims>;

import { maskContact } from '../identifiers';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export const JOURNAL_TARGET_TYPES = [
  'SCHOOL',
  'SCHOOL_SETTINGS',
  'PLATFORM_OPERATOR',
  'SCHOOL_OPERATOR',
  'USER',
  'MEMBERSHIP',
  'INVITATION',
  'PRIVILEGED_LEASE',
] as const;

export type JournalTargetType = (typeof JOURNAL_TARGET_TYPES)[number];

type FieldRule = 'keep' | 'mask_contact';

/**
 * Journal before/after fields are allowlisted per target type. Anything not listed is dropped,
 * so new columns never leak into the journal by accident. Contact details are masked, and
 * secrets, tokens, codes, and precise coordinates are never listed.
 */
const FIELD_POLICY: Readonly<Record<JournalTargetType, Readonly<Record<string, FieldRule>>>> = {
  SCHOOL: {
    name: 'keep',
    slug: 'keep',
    status: 'keep',
    timezone: 'keep',
    countryCode: 'keep',
    defaultLanguage: 'keep',
  },
  SCHOOL_SETTINGS: {
    staleLocationThresholdSeconds: 'keep',
    absenceCutoffMinutes: 'keep',
    gpsRetentionDays: 'keep',
    notificationRetentionDays: 'keep',
    supportEmail: 'mask_contact',
    supportPhone: 'mask_contact',
  },
  PLATFORM_OPERATOR: { displayName: 'keep', status: 'keep', userId: 'keep' },
  SCHOOL_OPERATOR: { displayName: 'keep', status: 'keep', userId: 'keep' },
  USER: { displayName: 'keep', status: 'keep', email: 'mask_contact', phoneE164: 'mask_contact' },
  MEMBERSHIP: { userId: 'keep', status: 'keep', roles: 'keep', role: 'keep' },
  INVITATION: {
    role: 'keep',
    status: 'keep',
    channel: 'keep',
    destination: 'mask_contact',
    expiresAt: 'keep',
  },
  PRIVILEGED_LEASE: {
    status: 'keep',
    grantId: 'keep',
    operatorProfileId: 'keep',
    sessionId: 'keep',
    releaseReason: 'keep',
    reason: 'keep',
  },
};

/** Keys that must never be journaled even if a future policy edit lists them. */
const FORBIDDEN_KEY_PATTERN =
  /pass(word)?|secret|token|otp|code|totp|cookie|authorization|latitude|longitude|^lat$|^lng$|^lon$/i;

function toJsonValue(value: unknown): JsonValue | undefined {
  if (value === null) return null;
  if (value instanceof Date) return value.toISOString();
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value;
    case 'number':
      return Number.isFinite(value) ? value : null;
    case 'object':
      if (Array.isArray(value)) {
        return value
          .map((item) => toJsonValue(item))
          .filter((item): item is JsonValue => item !== undefined && typeof item !== 'object');
      }
      // Nested objects are not journaled; they could carry unreviewed fields.
      return undefined;
    default:
      return undefined;
  }
}

export function redactForJournal(
  targetType: JournalTargetType,
  record: Readonly<Record<string, unknown>> | null | undefined,
): Record<string, JsonValue> | null {
  if (record === null || record === undefined) return null;
  const policy = FIELD_POLICY[targetType];
  const out: Record<string, JsonValue> = {};
  for (const [key, rule] of Object.entries(policy)) {
    if (FORBIDDEN_KEY_PATTERN.test(key)) continue;
    if (!(key in record)) continue;
    const value = toJsonValue(record[key]);
    if (value === undefined) continue;
    if (rule === 'mask_contact') {
      out[key] = typeof value === 'string' ? maskContact(value) : null;
    } else {
      out[key] = value;
    }
  }
  return out;
}

export interface JournalChanges {
  before: Record<string, JsonValue> | null;
  after: Record<string, JsonValue> | null;
}

export function journalChanges(
  targetType: JournalTargetType,
  before: Readonly<Record<string, unknown>> | null | undefined,
  after: Readonly<Record<string, unknown>> | null | undefined,
): JournalChanges {
  return {
    before: redactForJournal(targetType, before),
    after: redactForJournal(targetType, after),
  };
}

/** Canonical journal action names. Keep stable: they are searched and reported on. */
export const JOURNAL_ACTIONS = [
  'PRIVILEGED_LEASE_ACQUIRED',
  'PRIVILEGED_LEASE_DENIED',
  'PRIVILEGED_LEASE_RELEASED',
  'PRIVILEGED_LEASE_EXPIRED',
  'PRIVILEGED_LEASE_TAKEOVER',
  'PRIVILEGED_LEASE_REVOKED',
  'INVITATION_ACCEPTED',
  'SCHOOL_PROVISIONED',
  'SCHOOL_SUSPENDED',
  'SCHOOL_REACTIVATED',
  'PLATFORM_OPERATOR_CREATED',
  'PLATFORM_OPERATOR_SUSPENDED',
  'PLATFORM_OPERATOR_REACTIVATED',
  'SCHOOL_OPERATOR_CREATED',
  'SCHOOL_OPERATOR_SUSPENDED',
  'SCHOOL_OPERATOR_REACTIVATED',
  'SCHOOL_USER_INVITED',
  'MEMBERSHIP_SUSPENDED',
  'MEMBERSHIP_REACTIVATED',
  'INVITATION_REVOKED',
  'COMMAND_DENIED',
] as const;

export type JournalAction = (typeof JOURNAL_ACTIONS)[number];

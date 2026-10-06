import { describe, expect, it } from 'vitest';
import {
  OTP_POLICY,
  addSeconds,
  canEnrollMfa,
  canIssueOtp,
  canSchoolOperatorAssignRole,
  decideInvitationAcceptance,
  decideOtpVerification,
  decideRefresh,
  invitationExpiry,
  journalChanges,
  maskContact,
  parseContactIdentifier,
  redactForJournal,
} from './index';

const NOW = new Date('2026-05-04T06:30:00.000Z');

describe('role assignment by school operators', () => {
  it('allows drivers and guardians', () => {
    expect(canSchoolOperatorAssignRole('DRIVER', new Set())).toEqual({ allowed: true });
    expect(canSchoolOperatorAssignRole('GUARDIAN', new Set())).toEqual({ allowed: true });
  });

  it('never allows the platform role or the privileged school-admin role through invitations', () => {
    expect(canSchoolOperatorAssignRole('PLATFORM_ADMIN', new Set())).toEqual({
      allowed: false,
      reason: 'ROLE_NOT_ASSIGNABLE',
    });
    expect(canSchoolOperatorAssignRole('SCHOOL_ADMIN', new Set())).toEqual({
      allowed: false,
      reason: 'ROLE_NOT_ASSIGNABLE',
    });
    expect(canSchoolOperatorAssignRole('SUPERUSER', new Set())).toEqual({
      allowed: false,
      reason: 'ROLE_NOT_ASSIGNABLE',
    });
  });

  it('gates deferred roles behind the school feature flag', () => {
    expect(canSchoolOperatorAssignRole('BUS_ATTENDANT', new Set())).toEqual({
      allowed: false,
      reason: 'FEATURE_DISABLED',
    });
    expect(canSchoolOperatorAssignRole('BUS_ATTENDANT', new Set(['role.bus_attendant']))).toEqual({
      allowed: true,
    });
  });
});

describe('contact identifiers', () => {
  it('normalizes emails and E.164 phones', () => {
    expect(parseContactIdentifier('  Driver.One@Example.ORG ')).toEqual({
      kind: 'EMAIL',
      value: 'driver.one@example.org',
    });
    expect(parseContactIdentifier('+237 6 00 00 00 01')).toEqual({
      kind: 'PHONE',
      value: '+237600000001',
    });
  });

  it('rejects malformed identifiers', () => {
    expect(parseContactIdentifier('not-an-identifier')).toBeNull();
    expect(parseContactIdentifier('0600000001')).toBeNull();
    expect(parseContactIdentifier('a@b')).toBeNull();
  });

  it('masks contacts', () => {
    expect(maskContact('driver.one@example.org')).toBe('d***@example.org');
    expect(maskContact('+237600000001')).toBe('+237*******01');
  });
});

describe('OTP policy', () => {
  const challenge = {
    expiresAt: addSeconds(NOW, 60),
    consumedAt: null,
    attempts: 0,
    maxAttempts: 5,
    deliverable: true,
  };

  it('allows checking a fresh, deliverable challenge', () => {
    expect(decideOtpVerification(challenge, NOW)).toEqual({ kind: 'CHECK_CODE' });
  });

  it('rejects consumed, expired, exhausted, and undeliverable challenges', () => {
    expect(decideOtpVerification({ ...challenge, consumedAt: NOW }, NOW)).toEqual({
      kind: 'REJECT',
      reason: 'CONSUMED',
    });
    expect(decideOtpVerification(challenge, addSeconds(NOW, 60))).toEqual({
      kind: 'REJECT',
      reason: 'EXPIRED',
    });
    expect(decideOtpVerification({ ...challenge, attempts: 5 }, NOW)).toEqual({
      kind: 'REJECT',
      reason: 'TOO_MANY_ATTEMPTS',
    });
    expect(decideOtpVerification({ ...challenge, deliverable: false }, NOW)).toEqual({
      kind: 'REJECT',
      reason: 'UNDELIVERABLE',
    });
  });

  it('throttles challenges per destination', () => {
    expect(canIssueOtp(OTP_POLICY.maxChallengesPerDestination - 1)).toBe(true);
    expect(canIssueOtp(OTP_POLICY.maxChallengesPerDestination)).toBe(false);
  });
});

describe('refresh rotation', () => {
  const session = { status: 'ACTIVE' as const, absoluteExpiresAt: addSeconds(NOW, 3600) };

  it('rotates an active token', () => {
    expect(
      decideRefresh({ status: 'ACTIVE', expiresAt: addSeconds(NOW, 60) }, session, NOW),
    ).toEqual({ kind: 'ROTATE' });
  });

  it('detects reuse of a rotated token', () => {
    expect(
      decideRefresh({ status: 'ROTATED', expiresAt: addSeconds(NOW, 60) }, session, NOW),
    ).toEqual({
      kind: 'REUSE_DETECTED',
    });
  });

  it('rejects revoked sessions and absolute expiry', () => {
    const token = { status: 'ACTIVE' as const, expiresAt: addSeconds(NOW, 60) };
    expect(decideRefresh(token, { ...session, status: 'REVOKED' }, NOW)).toEqual({
      kind: 'REJECT',
      reason: 'SESSION_ENDED',
    });
    expect(decideRefresh(token, { ...session, absoluteExpiresAt: NOW }, NOW)).toEqual({
      kind: 'REJECT',
      reason: 'SESSION_ENDED',
    });
  });
});

describe('MFA enrollment window', () => {
  it('allows enrollment shortly after sign-in only, and never over an existing factor', () => {
    expect(canEnrollMfa({ authenticatedAt: NOW }, false, addSeconds(NOW, 300))).toBe(true);
    expect(canEnrollMfa({ authenticatedAt: NOW }, false, addSeconds(NOW, 601))).toBe(false);
    expect(canEnrollMfa({ authenticatedAt: NOW }, true, NOW)).toBe(false);
  });
});

describe('invitations', () => {
  it('accepts a pending invitation before expiry only once', () => {
    const invitation = { status: 'PENDING' as const, expiresAt: invitationExpiry(NOW) };
    expect(decideInvitationAcceptance(invitation, NOW)).toEqual({ kind: 'ACCEPTABLE' });
    expect(decideInvitationAcceptance(invitation, invitation.expiresAt)).toEqual({
      kind: 'REJECT',
      reason: 'EXPIRED',
    });
    expect(decideInvitationAcceptance({ ...invitation, status: 'ACCEPTED' }, NOW)).toEqual({
      kind: 'REJECT',
      reason: 'ALREADY_USED',
    });
  });
});

describe('journal redaction', () => {
  it('keeps allowlisted fields, masks contacts, and drops everything else', () => {
    const redacted = redactForJournal('USER', {
      displayName: 'Driver One Fictional',
      email: 'driver.one@example.org',
      phoneE164: '+237600000001',
      refreshToken: 'secret-value',
      otpCode: '123456',
      unexpectedColumn: 'x',
    });
    expect(redacted).toEqual({
      displayName: 'Driver One Fictional',
      email: 'd***@example.org',
      phoneE164: '+237*******01',
    });
  });

  it('never journals nested objects or coordinates', () => {
    expect(
      redactForJournal('SCHOOL', { name: 'Fictional Academy', settings: { a: 1 }, latitude: 4.05 }),
    ).toEqual({
      name: 'Fictional Academy',
    });
  });

  it('builds before and after views', () => {
    expect(journalChanges('MEMBERSHIP', { status: 'ACTIVE' }, { status: 'SUSPENDED' })).toEqual({
      before: { status: 'ACTIVE' },
      after: { status: 'SUSPENDED' },
    });
    expect(journalChanges('MEMBERSHIP', null, { status: 'ACTIVE' }).before).toBeNull();
  });
});

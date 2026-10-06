import { describe, expect, it } from 'vitest';
import { EVENTS, eventRoutingKey } from './events';
import { administration, identity } from './index';
import { buildOpenApiDocument } from './openapi';

describe('public OpenAPI document', () => {
  const document = buildOpenApiDocument() as { openapi: string; paths: Record<string, unknown> };

  it('is generated from the contracts and covers the Phase 1 public API', () => {
    expect(document.openapi).toBe('3.1.0');
    expect(Object.keys(document.paths)).toEqual(
      expect.arrayContaining([
        '/api/v1/auth/otp/start',
        '/api/v1/privileged-access/acquire',
        '/api/v1/platform/schools',
        '/api/v1/schools/{schoolId}/user-invitations',
        '/api/v1/administration/activity-journal',
      ]),
    );
  });

  it('never documents internal operations', () => {
    expect(Object.keys(document.paths).some((path) => path.startsWith('/internal'))).toBe(false);
  });
});

describe('contract strictness', () => {
  it('rejects tenant and role smuggling in school invitations', () => {
    const base = { displayName: 'Driver Fictional', contact: '+237600000001', role: 'DRIVER' };
    expect(administration.InviteSchoolUserRequest.safeParse(base).success).toBe(true);
    expect(
      administration.InviteSchoolUserRequest.safeParse({
        ...base,
        schoolId: '00000000-0000-4000-8000-000000000001',
      }).success,
    ).toBe(false);
    expect(
      administration.InviteSchoolUserRequest.safeParse({ ...base, role: 'PLATFORM_ADMIN' }).success,
    ).toBe(false);
    expect(
      administration.InviteSchoolUserRequest.safeParse({ ...base, role: 'SCHOOL_ADMIN' }).success,
    ).toBe(false);
  });

  it('requires a substantive reason for sensitive overrides', () => {
    expect(
      administration.TakeoverRequest.safeParse({
        workspace: { type: 'PLATFORM' },
        reason: 'too short',
      }).success,
    ).toBe(false);
    expect(
      administration.TakeoverRequest.safeParse({
        workspace: { type: 'PLATFORM' },
        reason: 'Holder unreachable during outage',
      }).success,
    ).toBe(true);
  });

  it('accepts only six-digit codes', () => {
    expect(identity.TotpCodeRequest.safeParse({ code: '12345' }).success).toBe(false);
    expect(identity.TotpCodeRequest.safeParse({ code: '123456' }).success).toBe(true);
  });
});

describe('event catalog', () => {
  it('uses unique, versioned routing keys', () => {
    const keys = (Object.keys(EVENTS) as Array<keyof typeof EVENTS>).map((name) =>
      eventRoutingKey(name),
    );
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) expect(key).toMatch(/^[a-z_]+\.[a-z_]+\.[a-z_.]+\.v\d+$/);
  });

  it('never carries contact details in invitation requests', () => {
    expect(Object.keys(EVENTS.invitationRequested.payload.shape)).not.toEqual(
      expect.arrayContaining(['contact', 'email', 'phone']),
    );
  });
});

import { describe, expect, it } from 'vitest';
import { checkCsrf, routeFor } from './routing';

describe('gateway routing', () => {
  it('routes public prefixes to their owning service, most specific first', () => {
    expect(routeFor('/api/v1/auth/otp/start')).toBe('identity');
    expect(routeFor('/api/v1/me')).toBe('identity');
    expect(routeFor('/api/v1/me/security-events?limit=5')).toBe('audit');
    expect(routeFor('/api/v1/administration/activity-journal')).toBe('audit');
    expect(routeFor('/api/v1/administration/session-history')).toBe('administration');
    expect(routeFor('/api/v1/schools/123/memberships')).toBe('administration');
    expect(routeFor('/realtime/socket.io/')).toBe('realtime');
  });

  it('never routes internal or unknown paths', () => {
    expect(routeFor('/internal/v1/users/provision')).toBeNull();
    expect(routeFor('/INTERNAL/v1/sessions/x')).toBeNull();
    expect(routeFor('/api/v1/me/../../internal/v1/users/provision')).toBeNull();
    expect(routeFor('/api/v1/schools/%2e%2e/internal/v1/x')).toBeNull();
    expect(routeFor('/api/v1/meantime')).toBeNull();
    expect(routeFor('/api/v2/me')).toBeNull();
  });
});

describe('CSRF double submit', () => {
  const csrf = 'c'.repeat(32);

  it('leaves bearer-token (native) requests unchanged', () => {
    expect(checkCsrf('POST', { authorization: 'Bearer abc' })).toEqual({
      ok: true,
      bearerFromCookie: null,
    });
  });

  it('allows safe methods with cookies and converts the cookie to a bearer token', () => {
    expect(checkCsrf('GET', { cookie: 'aegis_at=tok' })).toEqual({
      ok: true,
      bearerFromCookie: 'tok',
    });
  });

  it('requires a matching header for unsafe cookie-authenticated requests', () => {
    expect(checkCsrf('POST', { cookie: `aegis_at=tok; aegis_csrf=${csrf}` })).toEqual({
      ok: false,
    });
    expect(
      checkCsrf('POST', {
        cookie: `aegis_at=tok; aegis_csrf=${csrf}`,
        'x-csrf-token': 'd'.repeat(32),
      }),
    ).toEqual({ ok: false });
    expect(
      checkCsrf('POST', { cookie: `aegis_at=tok; aegis_csrf=${csrf}`, 'x-csrf-token': csrf }),
    ).toEqual({
      ok: true,
      bearerFromCookie: 'tok',
    });
  });

  it('protects refresh requests that carry only the refresh cookie', () => {
    expect(checkCsrf('POST', { cookie: `aegis_rt=r; aegis_csrf=${csrf}` })).toEqual({ ok: false });
    expect(
      checkCsrf('POST', { cookie: `aegis_rt=r; aegis_csrf=${csrf}`, 'x-csrf-token': csrf }),
    ).toEqual({
      ok: true,
      bearerFromCookie: null,
    });
  });
});

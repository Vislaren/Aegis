/**
 * Web session cookies. Browsers never see tokens in JavaScript-readable storage:
 *  - `aegis_at`  access token, HttpOnly, SameSite=Lax, path /
 *  - `aegis_rt`  refresh token, HttpOnly, SameSite=Strict, path /api/v1/auth
 *  - `aegis_csrf` random double-submit value, readable by the web client, echoed in `x-csrf-token`
 * The gateway converts `aegis_at` into an Authorization header after checking CSRF, so services
 * only ever see bearer tokens.
 */
export const ACCESS_COOKIE = 'aegis_at';
export const REFRESH_COOKIE = 'aegis_rt';
export const CSRF_COOKIE = 'aegis_csrf';
export const CSRF_HEADER = 'x-csrf-token';
export const REFRESH_COOKIE_PATH = '/api/v1/auth';

export function parseCookies(header: string | undefined): Record<string, string> {
  if (header === undefined || header.length === 0) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name.length > 0 && !(name in out)) {
      try {
        out[name] = decodeURIComponent(value);
      } catch {
        out[name] = value;
      }
    }
  }
  return out;
}

export interface CookieSpec {
  name: string;
  value: string;
  maxAgeSeconds: number;
  httpOnly: boolean;
  sameSite: 'Strict' | 'Lax';
  path: string;
  secure: boolean;
}

export function serializeCookie(spec: CookieSpec): string {
  const parts = [
    `${spec.name}=${encodeURIComponent(spec.value)}`,
    `Path=${spec.path}`,
    `Max-Age=${Math.max(0, Math.floor(spec.maxAgeSeconds))}`,
    `SameSite=${spec.sameSite}`,
  ];
  if (spec.httpOnly) parts.push('HttpOnly');
  if (spec.secure) parts.push('Secure');
  return parts.join('; ');
}

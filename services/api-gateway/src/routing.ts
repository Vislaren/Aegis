import {
  ACCESS_COOKIE,
  CSRF_COOKIE,
  CSRF_HEADER,
  REFRESH_COOKIE,
  parseCookies,
} from '@aegis/service-kit';
import { timingSafeEqual } from 'node:crypto';

export type Upstream = 'identity' | 'administration' | 'audit' | 'realtime';

/**
 * Public route table. Most specific prefixes first. Anything not listed is not routed, so new
 * internal endpoints can never become public by accident.
 */
export const ROUTES: ReadonlyArray<{ prefix: string; upstream: Upstream; websocket?: boolean }> = [
  { prefix: '/api/v1/me/security-events', upstream: 'audit' },
  { prefix: '/api/v1/administration/activity-journal', upstream: 'audit' },
  { prefix: '/api/v1/administration/session-history', upstream: 'administration' },
  { prefix: '/api/v1/auth', upstream: 'identity' },
  { prefix: '/api/v1/policies', upstream: 'identity' },
  { prefix: '/api/v1/me', upstream: 'identity' },
  { prefix: '/api/v1/access', upstream: 'administration' },
  { prefix: '/api/v1/privileged-access', upstream: 'administration' },
  { prefix: '/api/v1/platform', upstream: 'administration' },
  { prefix: '/api/v1/schools', upstream: 'administration' },
  { prefix: '/realtime', upstream: 'realtime', websocket: true },
];

export function routeFor(path: string): Upstream | null {
  const pathname = path.split('?')[0] ?? '';
  if (isBlockedPath(pathname)) return null;
  for (const route of ROUTES) {
    if (pathname === route.prefix || pathname.startsWith(`${route.prefix}/`)) return route.upstream;
  }
  return null;
}

/** Internal APIs and service health are never reachable through the public edge. */
export function isBlockedPath(pathname: string): boolean {
  const lowered = decodeURIComponentSafe(pathname).toLowerCase();
  return (
    lowered.startsWith('/internal') || lowered.includes('/../') || lowered.includes('/internal/')
  );
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export type CsrfDecision = { ok: true; bearerFromCookie: string | null } | { ok: false };

/**
 * Cookie-authenticated browser requests must echo the CSRF cookie in the `x-csrf-token` header
 * (double submit) for every unsafe method. Requests with an explicit Authorization header (native
 * clients) are not cookie-authenticated and are left unchanged.
 */
export function checkCsrf(
  method: string,
  headers: Record<string, string | string[] | undefined>,
): CsrfDecision {
  const authorization = headers.authorization;
  const cookies = parseCookies(typeof headers.cookie === 'string' ? headers.cookie : undefined);
  const accessCookie = cookies[ACCESS_COOKIE] ?? null;
  const usesCookies = accessCookie !== null || cookies[REFRESH_COOKIE] !== undefined;
  const bearerFromCookie = typeof authorization === 'string' ? null : accessCookie;

  if (!usesCookies || typeof authorization === 'string' || SAFE_METHODS.has(method.toUpperCase())) {
    return { ok: true, bearerFromCookie };
  }
  const headerToken = headers[CSRF_HEADER];
  const cookieToken = cookies[CSRF_COOKIE];
  if (typeof headerToken !== 'string' || cookieToken === undefined) return { ok: false };
  const a = Buffer.from(headerToken);
  const b = Buffer.from(cookieToken);
  if (a.length !== b.length || a.length < 16 || !timingSafeEqual(a, b)) return { ok: false };
  return { ok: true, bearerFromCookie };
}

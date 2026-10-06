/**
 * Central log redaction. Structured fields are redacted by key; free text is scrubbed for
 * values that look like tokens, phone numbers, emails, or coordinates. Child names cannot be
 * detected reliably in free text, so services must never log names: log identifiers instead.
 */

export const REDACTED = '[REDACTED]';

/** Paths for pino's built-in `redact` option (fast path for known request fields). */
export const PINO_REDACT_PATHS: readonly string[] = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-csrf-token"]',
  'req.headers["x-service-token"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.code',
  '*.otp',
  '*.secret',
  '*.totpSecret',
  '*.phone',
  '*.phoneE164',
  '*.email',
  '*.latitude',
  '*.longitude',
  '*.lat',
  '*.lng',
];

const SENSITIVE_KEY =
  /pass(word)?|secret|token|authorization|cookie|otp|^code$|totp|phone|email|^lat$|^lng$|^lon$|latitude|longitude|displayname|^name$/i;

const PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[JWT]'],
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[EMAIL]'],
  [/\+\d{8,15}\b/g, '[PHONE]'],
  [/-?\d{1,3}\.\d{4,},\s*-?\d{1,3}\.\d{4,}/g, '[COORDINATES]'],
];

export function scrubText(text: string): string {
  return PATTERNS.reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), text);
}

/** Deep-redacts a value for logging. Never mutates the input. */
export function redactForLog(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[TRUNCATED]';
  if (typeof value === 'string') return scrubText(value);
  if (Array.isArray(value)) return value.map((item) => redactForLog(item, depth + 1));
  if (value !== null && typeof value === 'object') {
    if (value instanceof Date) return value.toISOString();
    if (value instanceof Error) return { name: value.name, message: scrubText(value.message) };
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      out[key] = SENSITIVE_KEY.test(key) ? REDACTED : redactForLog(inner, depth + 1);
    }
    return out;
  }
  return value;
}

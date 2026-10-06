import { describe, expect, it } from 'vitest';
import { REDACTED, redactForLog, scrubText } from './redaction';

describe('log redaction', () => {
  it('redacts sensitive keys at any depth', () => {
    const out = redactForLog({
      userId: 'u1',
      session: { refreshToken: 'abc', accessToken: 'def' },
      contact: { email: 'guardian@example.org', phoneE164: '+237600000001' },
      position: { latitude: 4.0511, longitude: 9.7679 },
      displayName: 'Child Name Fictional',
    });
    expect(out).toEqual({
      userId: 'u1',
      session: { refreshToken: REDACTED, accessToken: REDACTED },
      contact: { email: REDACTED, phoneE164: REDACTED },
      position: { latitude: REDACTED, longitude: REDACTED },
      displayName: REDACTED,
    });
  });

  it('scrubs tokens, emails, phones, and coordinates from free text', () => {
    const text =
      'login eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ1MSJ9.c2lnbmF0dXJl for guardian@example.org +237600000001 at 4.051123, 9.767912';
    expect(scrubText(text)).toBe('login [JWT] for [EMAIL] [PHONE] at [COORDINATES]');
  });

  it('keeps errors to name and scrubbed message', () => {
    expect(redactForLog(new Error('bad token for guardian@example.org'))).toEqual({
      name: 'Error',
      message: 'bad token for [EMAIL]',
    });
  });
});

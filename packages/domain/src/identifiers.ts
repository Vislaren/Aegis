export type ContactIdentifier = { kind: 'EMAIL'; value: string } | { kind: 'PHONE'; value: string };

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
/** E.164: leading +, country code without a leading zero, 8 to 15 digits in total. */
const E164_PATTERN = /^\+[1-9]\d{7,14}$/;

/** Normalizes a sign-in identifier. Returns null when it is neither an email nor an E.164 phone. */
export function parseContactIdentifier(raw: string): ContactIdentifier | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 254) return null;
  if (trimmed.includes('@')) {
    const email = trimmed.toLowerCase();
    return EMAIL_PATTERN.test(email) ? { kind: 'EMAIL', value: email } : null;
  }
  const phone = trimmed.replace(/[\s().-]/g, '');
  return E164_PATTERN.test(phone) ? { kind: 'PHONE', value: phone } : null;
}

/** Masks a contact value for display or journaling: `a***@example.org`, `+237******12`. */
export function maskContact(value: string): string {
  if (value.includes('@')) {
    const [local = '', domain = ''] = value.split('@');
    return `${local.slice(0, 1)}***@${domain}`;
  }
  if (value.length <= 4) return '***';
  return `${value.slice(0, 4)}${'*'.repeat(Math.max(3, value.length - 6))}${value.slice(-2)}`;
}

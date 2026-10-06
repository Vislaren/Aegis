import { generateSecret, generateSync, generateURI } from 'otplib';

/** RFC 6238 TOTP port (30-second steps, 6 digits, SHA-1 for authenticator-app compatibility). */
export interface TotpPort {
  generateSecret(): string;
  keyUri(input: { secret: string; accountLabel: string; issuer: string }): string;
  /**
   * Returns the matched time step for a code within ±1 step of `now`, or null. The caller rejects
   * steps at or below the factor's last used step, which prevents code replay.
   */
  matchStep(secret: string, code: string, now: Date): number | null;
}

export const TOTP = Symbol('TOTP');
export const TOTP_PERIOD_SECONDS = 30;

export class OtplibTotp implements TotpPort {
  generateSecret(): string {
    return generateSecret();
  }

  keyUri(input: { secret: string; accountLabel: string; issuer: string }): string {
    return generateURI({ secret: input.secret, label: input.accountLabel, issuer: input.issuer });
  }

  matchStep(secret: string, code: string, now: Date): number | null {
    if (!/^\d{6}$/.test(code)) return null;
    const currentStep = Math.floor(now.getTime() / 1000 / TOTP_PERIOD_SECONDS);
    for (const delta of [0, -1, 1]) {
      const step = currentStep + delta;
      const expected = generateSync({ secret, epoch: step * TOTP_PERIOD_SECONDS });
      if (expected === code) return step;
    }
    return null;
  }
}

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { IDENTITY_CONFIG, type IdentityConfig } from '../config';

/**
 * Thin wrapper over Node's audited crypto primitives. No custom algorithms:
 *  - keyed HMAC-SHA-256 for low-entropy secrets (one-time codes, device IDs);
 *  - SHA-256 for high-entropy random tokens (refresh and invitation tokens);
 *  - AES-256-GCM for TOTP secrets at rest.
 */
@Injectable()
export class CryptoService {
  private readonly pepper: Buffer;
  private readonly encryptionKey: Buffer;

  constructor(@Inject(IDENTITY_CONFIG) config: IdentityConfig) {
    this.pepper = Buffer.from(config.OTP_PEPPER, 'utf8');
    this.encryptionKey = Buffer.from(config.MFA_ENCRYPTION_KEY, 'base64');
  }

  keyedHash(purpose: string, value: string): string {
    return createHmac('sha256', this.pepper).update(`${purpose}\u0000${value}`).digest('hex');
  }

  tokenHash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /** 256-bit URL-safe random token. */
  randomToken(): string {
    return randomBytes(32).toString('base64url');
  }

  /** Uniform 6-digit one-time code. */
  oneTimeCode(): string {
    return randomInt(0, 1_000_000).toString().padStart(6, '0');
  }

  constantTimeEqualHex(a: string, b: string): boolean {
    const left = Buffer.from(a, 'hex');
    const right = Buffer.from(b, 'hex');
    return left.length === right.length && timingSafeEqual(left, right);
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return [
      'v1',
      iv.toString('base64'),
      cipher.getAuthTag().toString('base64'),
      ciphertext.toString('base64'),
    ].join('.');
  }

  decrypt(sealed: string): string {
    const [version, iv, tag, ciphertext] = sealed.split('.');
    if (version !== 'v1' || iv === undefined || tag === undefined || ciphertext === undefined) {
      throw new Error('unsupported ciphertext format');
    }
    const decipher = createDecipheriv('aes-256-gcm', this.encryptionKey, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  }
}

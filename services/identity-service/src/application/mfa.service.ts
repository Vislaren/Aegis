import { Inject, Injectable } from '@nestjs/common';
import { canEnrollMfa, maskContact } from '@aegis/domain';
import { AppError, type AuthContext, type RequestMeta } from '@aegis/service-kit';
import { CryptoService } from '../infrastructure/crypto.service';
import { PrismaService, type Tx } from '../infrastructure/prisma.service';
import { TOTP, type TotpPort } from '../infrastructure/totp';
import { recordSecurityEvent } from './events';
import { SessionService, type IssuedSession } from './session.service';

type Meta = Pick<RequestMeta, 'correlationId' | 'sourceIp' | 'userAgent' | 'traceparent'>;

/** Consecutive wrong MFA codes allowed in one session before the session is revoked. */
export const MFA_MAX_FAILURES = 5;

/**
 * TOTP multi-factor authentication. Verifying a code raises the session to AAL2, records
 * `mfa_verified_at` (used as the freshness proof for takeover and forced revocation), and rotates
 * the session's tokens because the privilege level changed.
 */
@Injectable()
export class MfaService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CryptoService) private readonly crypto: CryptoService,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(TOTP) private readonly totp: TotpPort,
  ) {}

  async enroll(auth: AuthContext, meta: Meta): Promise<{ secret: string; otpauthUri: string }> {
    return this.prisma.tx(async (tx) => {
      const session = await this.sessions.requireActive(tx, auth);
      const active = await tx.authFactor.findFirst({
        where: { userId: auth.userId, status: 'ACTIVE' },
      });
      if (
        !canEnrollMfa({ authenticatedAt: session.authenticatedAt }, active !== null, new Date())
      ) {
        throw new AppError(active !== null ? 'CONFLICT' : 'REAUTHENTICATION_REQUIRED', {
          detail:
            active !== null
              ? 'Multi-factor authentication is already set up.'
              : 'Sign in again to set up multi-factor authentication.',
        });
      }
      await tx.authFactor.updateMany({
        where: { userId: auth.userId, status: 'PENDING' },
        data: { status: 'REVOKED', revokedAt: new Date() },
      });
      const user = await tx.user.findUniqueOrThrow({ where: { id: auth.userId } });
      const secret = this.totp.generateSecret();
      await tx.authFactor.create({
        data: {
          userId: auth.userId,
          type: 'TOTP',
          secretCiphertext: this.crypto.encrypt(secret),
          status: 'PENDING',
        },
      });
      await recordSecurityEvent(
        tx,
        {
          userId: auth.userId,
          sessionId: auth.sessionId,
          eventType: 'MFA_ENROLLMENT_STARTED',
          outcome: 'SUCCESS',
        },
        meta,
      );
      const label = maskContact(user.email ?? user.phoneE164 ?? user.id);
      // The secret is shown once, to the enrolling user only; it is never logged or returned again.
      return {
        secret,
        otpauthUri: this.totp.keyUri({ secret, accountLabel: label, issuer: 'Aegis' }),
      };
    });
  }

  async activate(auth: AuthContext, code: string, meta: Meta): Promise<IssuedSession> {
    return this.verifyFactor(auth, code, meta, 'PENDING');
  }

  async verify(auth: AuthContext, code: string, meta: Meta): Promise<IssuedSession> {
    return this.verifyFactor(auth, code, meta, 'ACTIVE');
  }

  private async verifyFactor(
    auth: AuthContext,
    code: string,
    meta: Meta,
    factorStatus: 'PENDING' | 'ACTIVE',
  ): Promise<IssuedSession> {
    const result = await this.prisma.tx(async (tx) => {
      const session = await this.sessions.requireActive(tx, auth);
      const factor = await tx.authFactor.findFirst({
        where: { userId: auth.userId, status: factorStatus },
      });
      if (factor === null)
        return {
          kind: 'fail' as const,
          error: new AppError('CONFLICT', { detail: 'No multi-factor setup is in progress.' }),
        };

      const now = new Date();
      const step = this.totp.matchStep(this.crypto.decrypt(factor.secretCiphertext), code, now);
      const replay =
        step !== null && factor.lastUsedStep !== null && BigInt(step) <= factor.lastUsedStep;
      if (step === null || replay) {
        return {
          kind: 'fail' as const,
          error: await this.recordFailure(tx, auth, session.mfaFailures, replay, now, meta),
        };
      }

      await tx.authFactor.update({
        where: { id: factor.id },
        data: {
          status: 'ACTIVE',
          lastUsedStep: BigInt(step),
          activatedAt: factor.activatedAt ?? now,
        },
      });
      const upgraded = await tx.session.update({
        where: { id: session.id },
        data: { aal: 2, mfaVerifiedAt: now, mfaFailures: 0, lastSeenAt: now },
      });
      // Privilege changed: retire existing refresh tokens and issue a new pair.
      await tx.refreshToken.updateMany({
        where: { sessionId: session.id, status: 'ACTIVE' },
        data: { status: 'ROTATED', usedAt: now },
      });
      await recordSecurityEvent(
        tx,
        {
          userId: auth.userId,
          sessionId: auth.sessionId,
          eventType: factorStatus === 'PENDING' ? 'MFA_ENROLLED' : 'MFA_VERIFIED',
          outcome: 'SUCCESS',
        },
        meta,
      );
      return { kind: 'ok' as const, issued: await this.sessions.issue(tx, upgraded, null, now) };
    });
    if (result.kind === 'fail') throw result.error;
    return result.issued;
  }

  private async recordFailure(
    tx: Tx,
    auth: AuthContext,
    previousFailures: number,
    replay: boolean,
    now: Date,
    meta: Meta,
  ): Promise<AppError> {
    const failures = previousFailures + 1;
    await recordSecurityEvent(
      tx,
      {
        userId: auth.userId,
        sessionId: auth.sessionId,
        eventType: 'MFA_FAILED',
        outcome: 'DENIED',
        details: { replay, failures },
      },
      meta,
    );
    if (failures >= MFA_MAX_FAILURES) {
      await this.sessions.revokeInTx(tx, auth.sessionId, auth.userId, 'USER_REVOKED', now, meta);
      return new AppError('UNAUTHENTICATED', {
        internalReason: 'too many MFA failures; session revoked',
      });
    }
    await tx.session.update({ where: { id: auth.sessionId }, data: { mfaFailures: failures } });
    return new AppError('OTP_INVALID');
  }
}

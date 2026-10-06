import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  OTP_POLICY,
  addSeconds,
  canIssueOtp,
  decideInvitationAcceptance,
  decideOtpVerification,
  parseContactIdentifier,
  type InvitationStatus,
} from '@aegis/domain';
import type { identity } from '@aegis/contracts';
import { AppError, OUTBOX_PRIORITY, enqueueEvent, type RequestMeta } from '@aegis/service-kit';
import { SERVICE_NAME } from '../config';
import { CryptoService } from '../infrastructure/crypto.service';
import { DELIVERY_DISPATCHER, type DeliveryDispatcher } from '../infrastructure/delivery';
import { PrismaService, type Tx } from '../infrastructure/prisma.service';
import { recordSecurityEvent } from './events';
import { SessionService, type IssuedSession } from './session.service';

type Meta = Pick<RequestMeta, 'correlationId' | 'sourceIp' | 'userAgent' | 'traceparent'>;

interface ChallengeRow {
  id: string;
  user_id: string | null;
  purpose: 'LOGIN' | 'INVITATION';
  code_hash: string;
  deliverable: boolean;
  invitation_id: string | null;
  attempts: number;
  max_attempts: number;
  expires_at: Date;
  consumed_at: Date | null;
}

/**
 * Passwordless sign-in with one-time codes, and invitation redemption.
 *
 * Non-enumeration: starting a challenge for an unknown, invited-but-unredeemed, or suspended
 * identifier returns the same response as for a valid one; nothing is delivered and the challenge
 * can never verify. Delivery happens after the response so timing does not differ either.
 */
@Injectable()
export class OtpService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CryptoService) private readonly crypto: CryptoService,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(DELIVERY_DISPATCHER) private readonly dispatcher: DeliveryDispatcher,
  ) {}

  async start(
    rawIdentifier: string,
    meta: Meta,
  ): Promise<{ challengeId: string; expiresAt: string }> {
    const contact = parseContactIdentifier(rawIdentifier);
    if (contact === null) {
      throw new AppError('VALIDATION_FAILED', {
        errors: [
          {
            path: 'identifier',
            message: 'Enter an email address or an international phone number (+...).',
          },
        ],
      });
    }
    const destinationHash = this.crypto.keyedHash('destination', contact.value);

    const result = await this.prisma.tx(async (tx) => {
      const now = new Date();
      if (!(await this.withinThrottle(tx, destinationHash, now))) {
        await recordSecurityEvent(
          tx,
          { userId: null, sessionId: null, eventType: 'OTP_THROTTLED', outcome: 'DENIED' },
          meta,
        );
        return { kind: 'throttled' as const };
      }
      const user =
        contact.kind === 'EMAIL'
          ? await tx.user.findUnique({ where: { email: contact.value } })
          : await tx.user.findUnique({ where: { phoneE164: contact.value } });
      const deliverable = user !== null && user.status === 'ACTIVE';
      const code = this.crypto.oneTimeCode();
      const challengeId = randomUUID();
      const expiresAt = addSeconds(now, OTP_POLICY.ttlSeconds);
      await tx.otpChallenge.create({
        data: {
          id: challengeId,
          userId: deliverable ? user.id : null,
          purpose: 'LOGIN',
          channel: contact.kind === 'EMAIL' ? 'EMAIL' : 'SMS',
          destinationHash,
          codeHash: this.crypto.keyedHash('otp', `${challengeId}:${code}`),
          deliverable,
          attempts: 0,
          maxAttempts: OTP_POLICY.maxVerifyAttempts,
          expiresAt,
          createdIp: meta.sourceIp,
        },
      });
      await recordSecurityEvent(
        tx,
        {
          userId: deliverable ? user.id : null,
          sessionId: null,
          eventType: 'OTP_REQUESTED',
          outcome: 'SUCCESS',
          details: { deliverable },
        },
        meta,
      );
      return {
        kind: 'ok' as const,
        challengeId,
        expiresAt,
        code,
        deliverable,
        channel: contact.kind,
      };
    });

    if (result.kind === 'throttled') throw new AppError('RATE_LIMITED');
    if (result.deliverable) {
      this.dispatcher.dispatch({
        channel: result.channel === 'EMAIL' ? 'EMAIL' : 'SMS',
        destination: contact.value,
        kind: 'OTP',
        subject: 'Your Aegis sign-in code',
        text: `Your Aegis sign-in code is ${result.code}. It expires in 5 minutes. Never share this code.`,
      });
    }
    return { challengeId: result.challengeId, expiresAt: result.expiresAt.toISOString() };
  }

  /** Exchanges a single-use invitation token for a one-time code sent to the invited contact. */
  async redeemInvitation(
    token: string,
    meta: Meta,
  ): Promise<{ challengeId: string; expiresAt: string }> {
    const tokenHash = this.crypto.tokenHash(token);
    const result = await this.prisma.tx(async (tx) => {
      const now = new Date();
      const invitation = await tx.invitation.findUnique({
        where: { tokenHash },
        include: { user: true },
      });
      if (invitation === null) return { kind: 'invalid' as const };
      const decision = decideInvitationAcceptance(
        { status: invitation.status as InvitationStatus, expiresAt: invitation.expiresAt },
        now,
      );
      if (decision.kind === 'REJECT') {
        if (decision.reason === 'EXPIRED' && invitation.status === 'PENDING') {
          await tx.invitation.update({ where: { id: invitation.id }, data: { status: 'EXPIRED' } });
        }
        return { kind: 'invalid' as const };
      }
      const user = invitation.user;
      if (user.status === 'SUSPENDED' || user.status === 'DISABLED')
        return { kind: 'invalid' as const };
      const destination = user.email ?? user.phoneE164;
      if (destination === null) return { kind: 'invalid' as const };
      const destinationHash = this.crypto.keyedHash('destination', destination);
      if (!(await this.withinThrottle(tx, destinationHash, now)))
        return { kind: 'throttled' as const };

      const code = this.crypto.oneTimeCode();
      const challengeId = randomUUID();
      const expiresAt = addSeconds(now, OTP_POLICY.ttlSeconds);
      await tx.otpChallenge.create({
        data: {
          id: challengeId,
          userId: user.id,
          purpose: 'INVITATION',
          channel: user.email !== null ? 'EMAIL' : 'SMS',
          destinationHash,
          codeHash: this.crypto.keyedHash('otp', `${challengeId}:${code}`),
          deliverable: true,
          invitationId: invitation.id,
          attempts: 0,
          maxAttempts: OTP_POLICY.maxVerifyAttempts,
          expiresAt,
          createdIp: meta.sourceIp,
        },
      });
      await recordSecurityEvent(
        tx,
        {
          userId: user.id,
          sessionId: null,
          eventType: 'INVITATION_REDEEM_STARTED',
          outcome: 'SUCCESS',
        },
        meta,
      );
      return {
        kind: 'ok' as const,
        challengeId,
        expiresAt,
        code,
        destination,
        channel: user.email !== null ? ('EMAIL' as const) : ('SMS' as const),
      };
    });

    if (result.kind === 'invalid') throw new AppError('INVITATION_INVALID');
    if (result.kind === 'throttled') throw new AppError('RATE_LIMITED');
    this.dispatcher.dispatch({
      channel: result.channel,
      destination: result.destination,
      kind: 'OTP',
      subject: 'Confirm your Aegis invitation',
      text: `Your Aegis confirmation code is ${result.code}. It expires in 5 minutes. Never share this code.`,
    });
    return { challengeId: result.challengeId, expiresAt: result.expiresAt.toISOString() };
  }

  async verify(
    input: { challengeId: string; code: string; client: identity.ClientDescriptor },
    meta: Meta,
  ): Promise<IssuedSession> {
    const result = await this.prisma.tx(async (tx) => {
      const now = new Date();
      const rows = await tx.$queryRawUnsafe<ChallengeRow[]>(
        `SELECT id, user_id, purpose, code_hash, deliverable, invitation_id, attempts, max_attempts, expires_at, consumed_at
           FROM otp_challenges WHERE id = $1::uuid FOR UPDATE`,
        input.challengeId,
      );
      const challenge = rows[0];
      if (challenge === undefined) return { kind: 'fail' as const };

      const decision = decideOtpVerification(
        {
          expiresAt: challenge.expires_at,
          consumedAt: challenge.consumed_at,
          attempts: challenge.attempts,
          maxAttempts: challenge.max_attempts,
          deliverable: challenge.deliverable,
        },
        now,
      );
      await tx.otpChallenge.update({
        where: { id: challenge.id },
        data: { attempts: { increment: 1 } },
      });
      const matches =
        decision.kind === 'CHECK_CODE' &&
        this.crypto.constantTimeEqualHex(
          this.crypto.keyedHash('otp', `${challenge.id}:${input.code}`),
          challenge.code_hash,
        );
      if (!matches || challenge.user_id === null) {
        await recordSecurityEvent(
          tx,
          {
            userId: challenge.user_id,
            sessionId: null,
            eventType: 'OTP_VERIFICATION_FAILED',
            outcome: 'DENIED',
            details: { reason: decision.kind === 'REJECT' ? decision.reason : 'CODE_MISMATCH' },
          },
          meta,
        );
        return { kind: 'fail' as const };
      }
      await tx.otpChallenge.update({ where: { id: challenge.id }, data: { consumedAt: now } });

      let user = await tx.user.findUniqueOrThrow({ where: { id: challenge.user_id } });
      let acceptedInvitation: { invitationRequestId: string; schoolId: string | null } | null =
        null;

      if (challenge.purpose === 'INVITATION') {
        const accepted = await this.acceptInvitation(tx, challenge, user, now);
        if (accepted === null) return { kind: 'fail' as const };
        acceptedInvitation = accepted.invitation;
        user = accepted.user;
      }
      if (user.status !== 'ACTIVE') return { kind: 'fail' as const };

      const issued = await this.sessions.create(tx, user, input.client, meta, now);
      const sessionId = issued.response.session.sessionId;
      if (acceptedInvitation !== null) {
        await enqueueEvent(
          tx,
          'invitationAccepted',
          {
            invitationRequestId: acceptedInvitation.invitationRequestId,
            userId: user.id,
            sessionId,
            acceptedAt: now.toISOString(),
          },
          {
            producer: SERVICE_NAME,
            schoolId: acceptedInvitation.schoolId,
            correlationId: meta.correlationId,
            traceparent: meta.traceparent,
          },
          OUTBOX_PRIORITY.security,
        );
      }
      await recordSecurityEvent(
        tx,
        {
          userId: user.id,
          sessionId,
          eventType: challenge.purpose === 'INVITATION' ? 'INVITATION_ACCEPTED' : 'LOGIN_SUCCEEDED',
          outcome: 'SUCCESS',
        },
        meta,
      );
      return { kind: 'ok' as const, issued };
    });
    if (result.kind === 'fail') throw new AppError('OTP_INVALID');
    return result.issued;
  }

  private async acceptInvitation(
    tx: Tx,
    challenge: ChallengeRow,
    user: {
      id: string;
      status: string;
      email: string | null;
      phoneE164: string | null;
      emailVerifiedAt: Date | null;
      phoneVerifiedAt: Date | null;
    },
    now: Date,
  ) {
    if (challenge.invitation_id === null) return null;
    const invitation = await tx.invitation.findUnique({ where: { id: challenge.invitation_id } });
    if (invitation === null) return null;
    const decision = decideInvitationAcceptance(
      { status: invitation.status as InvitationStatus, expiresAt: invitation.expiresAt },
      now,
    );
    if (decision.kind === 'REJECT') return null;
    if (user.status === 'SUSPENDED' || user.status === 'DISABLED') return null;

    await tx.invitation.update({
      where: { id: invitation.id },
      data: { status: 'ACCEPTED', acceptedAt: now },
    });
    // The code reached the contact on record, which verifies that channel.
    const updated = await tx.user.update({
      where: { id: user.id },
      data: {
        status: 'ACTIVE',
        ...(user.email !== null
          ? { emailVerifiedAt: user.emailVerifiedAt ?? now }
          : { phoneVerifiedAt: user.phoneVerifiedAt ?? now }),
      },
    });
    return {
      invitation: {
        invitationRequestId: invitation.invitationRequestId,
        schoolId: invitation.schoolId,
      },
      user: updated,
    };
  }

  private async withinThrottle(tx: Tx, destinationHash: string, now: Date): Promise<boolean> {
    const recent = await tx.otpChallenge.count({
      where: {
        destinationHash,
        createdAt: { gt: addSeconds(now, -OTP_POLICY.destinationWindowSeconds) },
      },
    });
    return canIssueOtp(recent);
  }
}

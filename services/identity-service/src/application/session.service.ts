import { Inject, Injectable } from '@nestjs/common';
import {
  SESSION_POLICY,
  addSeconds,
  decideRefresh,
  type RefreshTokenStatus,
  type SessionStatus,
} from '@aegis/domain';
import type { identity } from '@aegis/contracts';
import {
  AccessTokenSigner,
  AppError,
  type AuthContext,
  type RequestMeta,
} from '@aegis/service-kit';
import { IDENTITY_CONFIG, type IdentityConfig } from '../config';
import { CryptoService } from '../infrastructure/crypto.service';
import { PrismaService, type Tx } from '../infrastructure/prisma.service';
import { publishSessionRevoked, recordSecurityEvent } from './events';

type Meta = Pick<RequestMeta, 'correlationId' | 'sourceIp' | 'userAgent' | 'traceparent'>;

export const ACCESS_TOKEN_SIGNER = Symbol('ACCESS_TOKEN_SIGNER');

export interface IssuedSession {
  response: identity.SessionResponse;
  clientType: 'WEB' | 'NATIVE';
  accessToken: string;
  refreshToken: string;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
}

interface SessionRow {
  id: string;
  userId: string;
  status: string;
  aal: number;
  clientType: string;
  absoluteExpiresAt: Date;
}

export type SessionRevokeReason =
  'LOGOUT' | 'USER_REVOKED' | 'REFRESH_REUSE' | 'EXPIRED' | 'USER_SUSPENDED';

/**
 * Sessions are server-side records. Access tokens are short-lived ES256 JWTs naming the session;
 * refresh tokens rotate on every use and a reused (already rotated) token revokes the session.
 */
@Injectable()
export class SessionService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CryptoService) private readonly crypto: CryptoService,
    @Inject(ACCESS_TOKEN_SIGNER) private readonly signer: AccessTokenSigner,
    @Inject(IDENTITY_CONFIG) private readonly config: IdentityConfig,
  ) {}

  /** Creates a session after a successful one-time-code verification. */
  async create(
    tx: Tx,
    user: { id: string; requiresMfa: boolean },
    client: identity.ClientDescriptor,
    meta: Meta,
    now: Date,
  ): Promise<IssuedSession> {
    const deviceIdHash = this.crypto.keyedHash('device', client.deviceId);
    const device = await tx.trustedDevice.upsert({
      where: { userId_deviceIdHash: { userId: user.id, deviceIdHash } },
      create: {
        userId: user.id,
        deviceIdHash,
        platform: client.platform,
        deviceName: client.deviceName ?? null,
      },
      update: { lastSeenAt: now, deviceName: client.deviceName ?? undefined },
    });
    if (device.revokedAt !== null) {
      throw new AppError('FORBIDDEN', { internalReason: 'device revoked by user' });
    }
    const absoluteTtl = user.requiresMfa
      ? SESSION_POLICY.privilegedSessionAbsoluteTtlSeconds
      : SESSION_POLICY.sessionAbsoluteTtlSeconds;
    const session = await tx.session.create({
      data: {
        userId: user.id,
        status: 'ACTIVE',
        aal: 1,
        authenticatedAt: now,
        clientType: client.type,
        platform: client.platform,
        trustedDeviceId: device.id,
        deviceName: client.deviceName ?? null,
        userAgent: meta.userAgent,
        ip: meta.sourceIp,
        absoluteExpiresAt: addSeconds(now, absoluteTtl),
      },
    });
    return this.issue(tx, session, null, now);
  }

  /** Issues a fresh access token and a rotated refresh token for a session. */
  async issue(
    tx: Tx,
    session: SessionRow,
    parentRefreshId: string | null,
    now: Date,
  ): Promise<IssuedSession> {
    const refreshToken = this.crypto.randomToken();
    const refreshExpiresAt = new Date(
      Math.min(
        addSeconds(now, SESSION_POLICY.refreshTokenTtlSeconds).getTime(),
        session.absoluteExpiresAt.getTime(),
      ),
    );
    await tx.refreshToken.create({
      data: {
        sessionId: session.id,
        tokenHash: this.crypto.tokenHash(refreshToken),
        parentId: parentRefreshId,
        status: 'ACTIVE',
        expiresAt: refreshExpiresAt,
      },
    });
    const aal = session.aal === 2 ? 2 : 1;
    const access = await this.signer.sign(
      { userId: session.userId, sessionId: session.id, aal },
      this.config.ACCESS_TOKEN_TTL_SECONDS,
    );
    const user = await tx.user.findUniqueOrThrow({ where: { id: session.userId } });
    const factor = await tx.authFactor.findFirst({
      where: { userId: session.userId, status: 'ACTIVE' },
    });
    const clientType = session.clientType === 'WEB' ? 'WEB' : 'NATIVE';
    return {
      clientType,
      accessToken: access.token,
      refreshToken,
      accessTokenTtlSeconds: this.config.ACCESS_TOKEN_TTL_SECONDS,
      refreshTokenTtlSeconds: Math.floor((refreshExpiresAt.getTime() - now.getTime()) / 1000),
      response: {
        session: {
          sessionId: session.id,
          userId: session.userId,
          aal,
          mfaEnrolled: factor !== null,
          mfaRequiredForPrivilegedUse: user.requiresMfa,
          accessTokenExpiresAt: access.expiresAt.toISOString(),
        },
        // Web clients get HttpOnly cookies instead; the controller strips tokens for them.
        tokens: { accessToken: access.token, refreshToken },
      },
    };
  }

  async refresh(rawToken: string, meta: Meta): Promise<IssuedSession> {
    const tokenHash = this.crypto.tokenHash(rawToken);
    const outcome = await this.prisma.tx(async (tx) => {
      const now = new Date();
      const token = await tx.refreshToken.findUnique({
        where: { tokenHash },
        include: { session: true },
      });
      if (token === null) return { kind: 'fail' as const };
      const decision = decideRefresh(
        { status: token.status as RefreshTokenStatus, expiresAt: token.expiresAt },
        {
          status: token.session.status as SessionStatus,
          absoluteExpiresAt: token.session.absoluteExpiresAt,
        },
        now,
      );
      if (decision.kind === 'REUSE_DETECTED') {
        // A rotated token was presented again: someone holds a copy. End the whole session.
        await this.revokeInTx(
          tx,
          token.session.id,
          token.session.userId,
          'REFRESH_REUSE',
          now,
          meta,
        );
        await recordSecurityEvent(
          tx,
          {
            userId: token.session.userId,
            sessionId: token.session.id,
            eventType: 'REFRESH_TOKEN_REUSE_DETECTED',
            outcome: 'DENIED',
          },
          meta,
        );
        return { kind: 'fail' as const };
      }
      if (decision.kind === 'REJECT') return { kind: 'fail' as const };
      const user = await tx.user.findUniqueOrThrow({ where: { id: token.session.userId } });
      if (user.status !== 'ACTIVE') return { kind: 'fail' as const };

      await tx.refreshToken.update({
        where: { id: token.id },
        data: { status: 'ROTATED', usedAt: now },
      });
      await tx.session.update({ where: { id: token.session.id }, data: { lastSeenAt: now } });
      return { kind: 'ok' as const, issued: await this.issue(tx, token.session, token.id, now) };
    });
    if (outcome.kind === 'fail')
      throw new AppError('UNAUTHENTICATED', { internalReason: 'refresh rejected' });
    return outcome.issued;
  }

  /** Ends a session, its refresh tokens, and (via event) any privileged lease it held. */
  async revokeInTx(
    tx: Tx,
    sessionId: string,
    userId: string,
    reason: SessionRevokeReason,
    now: Date,
    meta: Meta,
  ): Promise<boolean> {
    const updated = await tx.session.updateMany({
      where: { id: sessionId, userId, status: 'ACTIVE' },
      data: { status: 'REVOKED', revokedAt: now, revokeReason: reason },
    });
    await tx.refreshToken.updateMany({
      where: { sessionId, status: 'ACTIVE' },
      data: { status: 'REVOKED' },
    });
    if (updated.count === 0) return false;
    await publishSessionRevoked(tx, { sessionId, userId, reason }, meta);
    return true;
  }

  async logout(auth: AuthContext, meta: Meta): Promise<void> {
    await this.prisma.tx(async (tx) => {
      const now = new Date();
      if (await this.revokeInTx(tx, auth.sessionId, auth.userId, 'LOGOUT', now, meta)) {
        await recordSecurityEvent(
          tx,
          {
            userId: auth.userId,
            sessionId: auth.sessionId,
            eventType: 'LOGOUT',
            outcome: 'SUCCESS',
          },
          meta,
        );
      }
    });
  }

  /**
   * Loads the caller's session and rejects it unless active. Used on every identity endpoint so
   * revocation takes effect immediately, not when the access token expires.
   */
  async requireActive(
    tx: Tx,
    auth: AuthContext,
  ): Promise<
    SessionRow & { authenticatedAt: Date; mfaVerifiedAt: Date | null; mfaFailures: number }
  > {
    const session = await tx.session.findUnique({ where: { id: auth.sessionId } });
    const now = new Date();
    if (
      session === null ||
      session.userId !== auth.userId ||
      session.status !== 'ACTIVE' ||
      session.absoluteExpiresAt.getTime() <= now.getTime()
    ) {
      throw new AppError('UNAUTHENTICATED', { internalReason: 'session not active' });
    }
    return session;
  }

  async introspect(sessionId: string): Promise<identity.SessionIntrospection | null> {
    const session = await this.prisma.session.findUnique({
      where: { id: sessionId },
      include: { user: true },
    });
    if (session === null) return null;
    const now = Date.now();
    const active =
      session.status === 'ACTIVE' &&
      session.absoluteExpiresAt.getTime() > now &&
      session.user.status === 'ACTIVE';
    return {
      sessionId: session.id,
      userId: session.userId,
      active,
      userStatus: session.user.status as identity.SessionIntrospection['userStatus'],
      aal: session.aal === 2 ? 2 : 1,
      mfaVerifiedAt: session.mfaVerifiedAt?.toISOString() ?? null,
    };
  }
}

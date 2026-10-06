import { Inject, Injectable } from '@nestjs/common';
import type { identity } from '@aegis/contracts';
import { AppError, type AuthContext, type RequestMeta } from '@aegis/service-kit';
import type { z } from 'zod';
import { PrismaService } from '../infrastructure/prisma.service';
import { recordSecurityEvent } from './events';
import { SessionService } from './session.service';

type Meta = Pick<RequestMeta, 'correlationId' | 'sourceIp' | 'userAgent' | 'traceparent'>;

/** Current published policy documents. Content is served by the web client; versions are authoritative here. */
export const POLICY_DOCUMENTS = [
  { type: 'PRIVACY_NOTICE' as const, version: '2026-10-01', title: 'Privacy notice' },
  { type: 'TERMS_OF_USE' as const, version: '2026-10-01', title: 'Terms of use' },
  {
    type: 'LOCATION_PROCESSING' as const,
    version: '2026-10-01',
    title: 'Transport location processing notice',
  },
];

/** Common capabilities every authenticated role has, limited strictly to the caller's own data. */
@Injectable()
export class MeService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(SessionService) private readonly sessions: SessionService,
  ) {}

  async me(auth: AuthContext): Promise<z.infer<typeof identity.MeResponse>> {
    return this.prisma.tx(async (tx) => {
      const session = await this.sessions.requireActive(tx, auth);
      const user = await tx.user.findUniqueOrThrow({ where: { id: auth.userId } });
      const factor = await tx.authFactor.findFirst({
        where: { userId: auth.userId, status: 'ACTIVE' },
      });
      return {
        userId: user.id,
        displayName: user.displayName,
        email: user.email,
        phoneE164: user.phoneE164,
        preferredLanguage: user.preferredLanguage,
        status: user.status as 'ACTIVE',
        mfaEnrolled: factor !== null,
        session: {
          sessionId: session.id,
          aal: session.aal,
          mfaVerifiedAt: session.mfaVerifiedAt?.toISOString() ?? null,
        },
      };
    });
  }

  async update(
    auth: AuthContext,
    body: { displayName?: string; preferredLanguage?: string },
  ): Promise<z.infer<typeof identity.MeResponse>> {
    await this.prisma.tx(async (tx) => {
      await this.sessions.requireActive(tx, auth);
      await tx.user.update({
        where: { id: auth.userId },
        data: {
          ...(body.displayName === undefined ? {} : { displayName: body.displayName }),
          ...(body.preferredLanguage === undefined
            ? {}
            : { preferredLanguage: body.preferredLanguage }),
        },
      });
    });
    return this.me(auth);
  }

  async listSessions(auth: AuthContext): Promise<z.infer<typeof identity.SessionListResponse>> {
    return this.prisma.tx(async (tx) => {
      await this.sessions.requireActive(tx, auth);
      const rows = await tx.session.findMany({
        where: { userId: auth.userId, status: 'ACTIVE', absoluteExpiresAt: { gt: new Date() } },
        orderBy: { lastSeenAt: 'desc' },
        take: 50,
      });
      return {
        items: rows.map((s) => ({
          sessionId: s.id,
          current: s.id === auth.sessionId,
          clientType: s.clientType as 'WEB' | 'NATIVE',
          platform: s.platform,
          deviceName: s.deviceName,
          aal: s.aal,
          createdAt: s.createdAt.toISOString(),
          lastSeenAt: s.lastSeenAt.toISOString(),
        })),
      };
    });
  }

  /** Revokes one of the caller's own sessions. Another user's session is indistinguishable from none. */
  async revokeSession(auth: AuthContext, sessionId: string, meta: Meta): Promise<void> {
    await this.prisma.tx(async (tx) => {
      await this.sessions.requireActive(tx, auth);
      const revoked = await this.sessions.revokeInTx(
        tx,
        sessionId,
        auth.userId,
        'USER_REVOKED',
        new Date(),
        meta,
      );
      if (!revoked) throw new AppError('NOT_FOUND');
      await recordSecurityEvent(
        tx,
        {
          userId: auth.userId,
          sessionId: auth.sessionId,
          eventType: 'SESSION_REVOKED_BY_USER',
          outcome: 'SUCCESS',
          details: { revokedSessionId: sessionId },
        },
        meta,
      );
    });
  }

  async listConsents(auth: AuthContext): Promise<z.infer<typeof identity.ConsentListResponse>> {
    return this.prisma.tx(async (tx) => {
      await this.sessions.requireActive(tx, auth);
      const rows = await tx.consentRecord.findMany({
        where: { userId: auth.userId },
        orderBy: { acceptedAt: 'desc' },
        take: 100,
      });
      return {
        items: rows.map((r) => ({
          id: r.id,
          documentType: r.documentType as 'PRIVACY_NOTICE',
          documentVersion: r.documentVersion,
          acceptedAt: r.acceptedAt.toISOString(),
        })),
      };
    });
  }

  async recordConsent(
    auth: AuthContext,
    body: { documentType: (typeof POLICY_DOCUMENTS)[number]['type']; documentVersion: string },
    meta: Meta,
  ): Promise<z.infer<typeof identity.ConsentRecordView>> {
    const current = POLICY_DOCUMENTS.find((d) => d.type === body.documentType);
    if (current === undefined || current.version !== body.documentVersion) {
      throw new AppError('VALIDATION_FAILED', {
        errors: [
          {
            path: 'documentVersion',
            message: 'Only the current published version can be acknowledged.',
          },
        ],
      });
    }
    return this.prisma.tx(async (tx) => {
      await this.sessions.requireActive(tx, auth);
      const record = await tx.consentRecord.create({
        data: {
          userId: auth.userId,
          documentType: body.documentType,
          documentVersion: body.documentVersion,
          ip: meta.sourceIp,
          userAgent: meta.userAgent,
        },
      });
      await recordSecurityEvent(
        tx,
        {
          userId: auth.userId,
          sessionId: auth.sessionId,
          eventType: 'CONSENT_RECORDED',
          outcome: 'SUCCESS',
          details: { documentType: body.documentType, documentVersion: body.documentVersion },
        },
        meta,
      );
      return {
        id: record.id,
        documentType: body.documentType,
        documentVersion: record.documentVersion,
        acceptedAt: record.acceptedAt.toISOString(),
      };
    });
  }
}

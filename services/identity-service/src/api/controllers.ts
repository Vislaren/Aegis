import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import { Uuid, identity } from '@aegis/contracts';
import {
  ACCESS_COOKIE,
  AppError,
  Auth,
  CSRF_COOKIE,
  InternalRoute,
  Meta,
  Public,
  REFRESH_COOKIE,
  REFRESH_COOKIE_PATH,
  ResponseSchema,
  ZodPipe,
  parseCookies,
  serializeCookie,
  type AuthContext,
  type RequestMeta,
} from '@aegis/service-kit';
import { randomBytes } from 'node:crypto';
import { IDENTITY_CONFIG, type IdentityConfig } from '../config';
import { MeService, POLICY_DOCUMENTS } from '../application/me.service';
import { MfaService } from '../application/mfa.service';
import { OtpService } from '../application/otp.service';
import { ProvisioningService } from '../application/provisioning.service';
import { SessionService, type IssuedSession } from '../application/session.service';
import { JWKS_DOCUMENT, type JwksDocument } from '../infrastructure/jwks';

/**
 * Web clients receive tokens only as HttpOnly cookies plus a CSRF double-submit cookie; native
 * clients receive tokens in the body and keep them in the OS keystore.
 */
function respondWithSession(
  reply: FastifyReply,
  issued: IssuedSession,
  config: IdentityConfig,
): identity.SessionResponse {
  if (issued.clientType === 'NATIVE') return issued.response;
  const secure = config.COOKIE_SECURE;
  void reply.header('set-cookie', [
    serializeCookie({
      name: ACCESS_COOKIE,
      value: issued.accessToken,
      maxAgeSeconds: issued.accessTokenTtlSeconds,
      httpOnly: true,
      sameSite: 'Lax',
      path: '/',
      secure,
    }),
    serializeCookie({
      name: REFRESH_COOKIE,
      value: issued.refreshToken,
      maxAgeSeconds: issued.refreshTokenTtlSeconds,
      httpOnly: true,
      sameSite: 'Strict',
      path: REFRESH_COOKIE_PATH,
      secure,
    }),
    serializeCookie({
      name: CSRF_COOKIE,
      value: randomBytes(24).toString('base64url'),
      maxAgeSeconds: issued.refreshTokenTtlSeconds,
      httpOnly: false,
      sameSite: 'Lax',
      path: '/',
      secure,
    }),
  ]);
  return { session: issued.response.session, tokens: null };
}

function clearCookies(reply: FastifyReply, config: IdentityConfig): void {
  const secure = config.COOKIE_SECURE;
  void reply.header('set-cookie', [
    serializeCookie({
      name: ACCESS_COOKIE,
      value: '',
      maxAgeSeconds: 0,
      httpOnly: true,
      sameSite: 'Lax',
      path: '/',
      secure,
    }),
    serializeCookie({
      name: REFRESH_COOKIE,
      value: '',
      maxAgeSeconds: 0,
      httpOnly: true,
      sameSite: 'Strict',
      path: REFRESH_COOKIE_PATH,
      secure,
    }),
    serializeCookie({
      name: CSRF_COOKIE,
      value: '',
      maxAgeSeconds: 0,
      httpOnly: false,
      sameSite: 'Lax',
      path: '/',
      secure,
    }),
  ]);
}

@Controller('api/v1/auth')
export class AuthController {
  constructor(
    @Inject(OtpService) private readonly otp: OtpService,
    @Inject(MfaService) private readonly mfa: MfaService,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(IDENTITY_CONFIG) private readonly config: IdentityConfig,
  ) {}

  @Public()
  @Post('otp/start')
  @HttpCode(202)
  @ResponseSchema(identity.OtpChallengeResponse)
  start(
    @Meta() meta: RequestMeta,
    @Body(new ZodPipe(identity.OtpStartRequest)) body: z.infer<typeof identity.OtpStartRequest>,
  ) {
    return this.otp.start(body.identifier, meta);
  }

  @Public()
  @Post('otp/verify')
  @HttpCode(200)
  @ResponseSchema(identity.SessionResponse)
  async verify(
    @Meta() meta: RequestMeta,
    @Body(new ZodPipe(identity.OtpVerifyRequest)) body: z.infer<typeof identity.OtpVerifyRequest>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return respondWithSession(reply, await this.otp.verify(body, meta), this.config);
  }

  @Public()
  @Post('invitations/redeem')
  @HttpCode(202)
  @ResponseSchema(identity.OtpChallengeResponse)
  redeem(
    @Meta() meta: RequestMeta,
    @Body(new ZodPipe(identity.InvitationRedeemRequest))
    body: z.infer<typeof identity.InvitationRedeemRequest>,
  ) {
    return this.otp.redeemInvitation(body.token, meta);
  }

  @Post('mfa/totp/enroll')
  @HttpCode(200)
  @ResponseSchema(identity.TotpEnrollResponse)
  enroll(@Auth() auth: AuthContext, @Meta() meta: RequestMeta) {
    return this.mfa.enroll(auth, meta);
  }

  @Post('mfa/totp/activate')
  @HttpCode(200)
  @ResponseSchema(identity.SessionResponse)
  async activate(
    @Auth() auth: AuthContext,
    @Meta() meta: RequestMeta,
    @Body(new ZodPipe(identity.TotpCodeRequest)) body: z.infer<typeof identity.TotpCodeRequest>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return respondWithSession(reply, await this.mfa.activate(auth, body.code, meta), this.config);
  }

  @Post('mfa/verify')
  @HttpCode(200)
  @ResponseSchema(identity.SessionResponse)
  async mfaVerify(
    @Auth() auth: AuthContext,
    @Meta() meta: RequestMeta,
    @Body(new ZodPipe(identity.TotpCodeRequest)) body: z.infer<typeof identity.TotpCodeRequest>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return respondWithSession(reply, await this.mfa.verify(auth, body.code, meta), this.config);
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  @ResponseSchema(identity.SessionResponse)
  async refresh(
    @Meta() meta: RequestMeta,
    @Req() request: FastifyRequest,
    @Body(new ZodPipe(identity.RefreshRequest)) body: z.infer<typeof identity.RefreshRequest>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const token = body.refreshToken ?? parseCookies(request.headers.cookie)[REFRESH_COOKIE];
    if (token === undefined) throw new AppError('UNAUTHENTICATED');
    return respondWithSession(reply, await this.sessions.refresh(token, meta), this.config);
  }

  @Post('logout')
  @HttpCode(204)
  async logout(
    @Auth() auth: AuthContext,
    @Meta() meta: RequestMeta,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    await this.sessions.logout(auth, meta);
    clearCookies(reply, this.config);
  }
}

@Controller('api/v1/me')
export class MeController {
  constructor(@Inject(MeService) private readonly me: MeService) {}

  @Get()
  @ResponseSchema(identity.MeResponse)
  profile(@Auth() auth: AuthContext) {
    return this.me.me(auth);
  }

  @Patch()
  @ResponseSchema(identity.MeResponse)
  update(
    @Auth() auth: AuthContext,
    @Body(new ZodPipe(identity.UpdateMeRequest)) body: z.infer<typeof identity.UpdateMeRequest>,
  ) {
    return this.me.update(auth, body);
  }

  @Get('sessions')
  @ResponseSchema(identity.SessionListResponse)
  sessions(@Auth() auth: AuthContext) {
    return this.me.listSessions(auth);
  }

  @Post('sessions/:sessionId/revoke')
  @HttpCode(204)
  async revoke(
    @Auth() auth: AuthContext,
    @Meta() meta: RequestMeta,
    @Param('sessionId', new ZodPipe(Uuid)) sessionId: string,
  ): Promise<void> {
    await this.me.revokeSession(auth, sessionId, meta);
  }

  @Get('consents')
  @ResponseSchema(identity.ConsentListResponse)
  consents(@Auth() auth: AuthContext) {
    return this.me.listConsents(auth);
  }

  @Post('consents')
  @ResponseSchema(identity.ConsentRecordView)
  consent(
    @Auth() auth: AuthContext,
    @Meta() meta: RequestMeta,
    @Body(new ZodPipe(identity.ConsentRequest)) body: z.infer<typeof identity.ConsentRequest>,
  ) {
    return this.me.recordConsent(auth, body, meta);
  }
}

@Controller('api/v1/policies')
export class PoliciesController {
  @Public()
  @Get('current')
  @ResponseSchema(identity.PolicyDocumentsResponse)
  current() {
    return { documents: POLICY_DOCUMENTS };
  }
}

@Controller('internal/v1')
export class InternalIdentityController {
  constructor(
    @Inject(ProvisioningService) private readonly provisioning: ProvisioningService,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(JWKS_DOCUMENT) private readonly jwks: JwksDocument,
  ) {}

  @Post('users/provision')
  @HttpCode(200)
  @InternalRoute('administration-service')
  @ResponseSchema(identity.ProvisionUserResponse)
  provision(
    @Body(new ZodPipe(identity.ProvisionUserRequest))
    body: z.infer<typeof identity.ProvisionUserRequest>,
  ) {
    return this.provisioning.provisionUser(body);
  }

  @Get('sessions/:sessionId')
  @InternalRoute('administration-service', 'audit-service', 'realtime-gateway')
  @ResponseSchema(identity.SessionIntrospection)
  async session(@Param('sessionId', new ZodPipe(Uuid)) sessionId: string) {
    const result = await this.sessions.introspect(sessionId);
    if (result === null) throw new AppError('NOT_FOUND');
    return result;
  }

  /** Public keys only; reachable on the private network for token verification by services. */
  @Public()
  @Get('.well-known/jwks.json')
  keys(): JwksDocument {
    return this.jwks;
  }
}

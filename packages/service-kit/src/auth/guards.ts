import {
  Inject,
  Injectable,
  SetMetadata,
  createParamDecorator,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { AppError } from '../errors';
import {
  SERVICE_TOKEN_HEADER,
  type AccessTokenVerifier,
  type AuthContext,
  type ServiceTokenVerifier,
} from './tokens';

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthContext;
    serviceCaller?: string;
  }
}

export const ACCESS_TOKEN_VERIFIER = Symbol('ACCESS_TOKEN_VERIFIER');
export const SERVICE_TOKEN_VERIFIER = Symbol('SERVICE_TOKEN_VERIFIER');

const PUBLIC_ROUTE = 'aegis:public-route';
const INTERNAL_CALLERS = 'aegis:internal-callers';

/** Marks an endpoint that needs no end-user session (sign-in, health, JWKS). */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(PUBLIC_ROUTE, true);

/**
 * Marks an internal endpoint and lists the services allowed to call it. Internal endpoints never
 * accept end-user tokens and are never routed by the public gateway.
 */
export const InternalRoute = (...callers: string[]): MethodDecorator & ClassDecorator =>
  SetMetadata(INTERNAL_CALLERS, callers);

function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer ([A-Za-z0-9._-]{20,4096})$/.exec(header);
  return match?.[1] ?? null;
}

/**
 * Global, deny-by-default authentication guard. Every route is authenticated unless explicitly
 * marked `@Public()` or `@InternalRoute(...)`. Authorization (who may do what to which object)
 * happens in each service's application layer through the domain policy.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(ACCESS_TOKEN_VERIFIER) private readonly accessTokens: AccessTokenVerifier,
    @Inject(SERVICE_TOKEN_VERIFIER) private readonly serviceTokens: ServiceTokenVerifier | null,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const targets = [context.getHandler(), context.getClass()];

    const callers = this.reflector.getAllAndOverride<string[] | undefined>(
      INTERNAL_CALLERS,
      targets,
    );
    if (callers !== undefined) {
      const token = request.headers[SERVICE_TOKEN_HEADER];
      if (this.serviceTokens === null || typeof token !== 'string')
        throw new AppError('UNAUTHENTICATED');
      let caller: string;
      try {
        caller = await this.serviceTokens.verify(token);
      } catch {
        throw new AppError('UNAUTHENTICATED', { internalReason: 'invalid service token' });
      }
      if (!callers.includes(caller)) {
        throw new AppError('FORBIDDEN', { internalReason: `service ${caller} not allowed` });
      }
      request.serviceCaller = caller;
      return true;
    }

    if (this.reflector.getAllAndOverride<boolean | undefined>(PUBLIC_ROUTE, targets) === true)
      return true;

    const token = bearerToken(request);
    if (token === null) throw new AppError('UNAUTHENTICATED');
    try {
      request.auth = await this.accessTokens.verify(token);
    } catch {
      throw new AppError('UNAUTHENTICATED', { internalReason: 'invalid access token' });
    }
    return true;
  }
}

/** The verified end-user identity of the request. */
export const Auth = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthContext => {
  const request = ctx.switchToHttp().getRequest<FastifyRequest>();
  if (request.auth === undefined) throw new AppError('UNAUTHENTICATED');
  return request.auth;
});

/** The verified calling service of an internal request. */
export const ServiceCaller = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string => {
    const request = ctx.switchToHttp().getRequest<FastifyRequest>();
    if (request.serviceCaller === undefined) throw new AppError('UNAUTHENTICATED');
    return request.serviceCaller;
  },
);

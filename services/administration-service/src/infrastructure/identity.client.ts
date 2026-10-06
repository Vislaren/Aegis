import { Inject, Injectable } from '@nestjs/common';
import { identity } from '@aegis/contracts';
import { AppError, InternalServiceClient, type InternalCallMeta } from '@aegis/service-kit';

export const IDENTITY_CLIENT = Symbol('IDENTITY_CLIENT');

/** Port for the identity-service internal API. Tests substitute an in-memory fake. */
export interface IdentityPort {
  provisionUser(
    input: { displayName: string; contact: string },
    meta: InternalCallMeta,
  ): Promise<identity.ProvisionUserResponse>;
  introspectSession(
    sessionId: string,
    meta: InternalCallMeta,
  ): Promise<identity.SessionIntrospection | null>;
}

@Injectable()
export class HttpIdentityClient implements IdentityPort {
  constructor(@Inject(InternalServiceClient) private readonly client: InternalServiceClient) {}

  async provisionUser(
    input: { displayName: string; contact: string },
    meta: InternalCallMeta,
  ): Promise<identity.ProvisionUserResponse> {
    const result = await this.client.call(
      'POST',
      '/internal/v1/users/provision',
      meta,
      identity.ProvisionUserResponse,
      input,
    );
    if (result.ok) return result.data;
    if (result.status === 400) {
      throw new AppError('VALIDATION_FAILED', {
        errors: [
          {
            path: 'contact',
            message: 'Enter a valid email address or an international phone number (+...).',
          },
        ],
      });
    }
    throw new AppError('DEPENDENCY_UNAVAILABLE', {
      internalReason: `provisionUser returned ${result.status}`,
    });
  }

  async introspectSession(
    sessionId: string,
    meta: InternalCallMeta,
  ): Promise<identity.SessionIntrospection | null> {
    const result = await this.client.call(
      'GET',
      `/internal/v1/sessions/${encodeURIComponent(sessionId)}`,
      meta,
      identity.SessionIntrospection,
    );
    if (result.ok) return result.data;
    if (result.status === 404) return null;
    throw new AppError('DEPENDENCY_UNAVAILABLE', {
      internalReason: `introspectSession returned ${result.status}`,
    });
  }
}

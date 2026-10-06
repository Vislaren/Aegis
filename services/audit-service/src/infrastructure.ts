import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { administration, type WorkspaceSelector } from '@aegis/contracts';
import {
  AppError,
  InternalServiceClient,
  applyTenantContext,
  type InternalCallMeta,
  type TenantContext,
} from '@aegis/service-kit';
import { Prisma, PrismaClient } from './generated/prisma/client';
import { AUDIT_CONFIG, type AuditConfig } from './config';

export type Tx = Prisma.TransactionClient;

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor(@Inject(AUDIT_CONFIG) config: AuditConfig) {
    // Sessions run in UTC: with a non-UTC server timezone the driver adapter mis-parses timestamptz
    // values from raw queries by the local offset (found by the integration suite on a UTC+1 host).
    super({
      adapter: new PrismaPg({
        connectionString: config.DATABASE_URL,
        max: 10,
        options: '-c TimeZone=UTC',
      }),
    });
  }

  async withContext<T>(context: TenantContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.$transaction(
      async (tx) => {
        await applyTenantContext(tx, context);
        return fn(tx);
      },
      { maxWait: 5_000, timeout: 15_000 },
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}

/** Port for administration-service's lease validation (fail closed on any failure). */
export interface LeaseValidationPort {
  validate(
    input: { sessionId: string; userId: string; workspace?: WorkspaceSelector; touch: boolean },
    meta: InternalCallMeta,
  ): Promise<administration.ValidatedLease>;
}

export const LEASE_VALIDATION = Symbol('LEASE_VALIDATION');

export class HttpLeaseValidation implements LeaseValidationPort {
  constructor(private readonly client: InternalServiceClient) {}

  async validate(
    input: { sessionId: string; userId: string; workspace?: WorkspaceSelector; touch: boolean },
    meta: InternalCallMeta,
  ): Promise<administration.ValidatedLease> {
    const result = await this.client.call(
      'POST',
      '/internal/v1/privileged-access/validate',
      meta,
      administration.ValidateLeaseResponse,
      input,
    );
    if (result.ok) return result.data.lease;
    // Relay lease problems with the same safe codes; anything else is a denial.
    const code = result.problem?.code;
    if (
      code === 'PRIVILEGED_LEASE_LOST' ||
      code === 'PRIVILEGED_LEASE_REQUIRED' ||
      code === 'UNAUTHENTICATED' ||
      code === 'MFA_REQUIRED'
    ) {
      throw new AppError(code);
    }
    throw new AppError('PRIVILEGED_LEASE_REQUIRED', {
      internalReason: `lease validation returned ${result.status}`,
    });
  }
}

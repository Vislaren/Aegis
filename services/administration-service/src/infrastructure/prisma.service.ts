import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { AppError, applyTenantContext, type TenantContext } from '@aegis/service-kit';
import { Prisma, PrismaClient } from '../generated/prisma/client';
import { ADMINISTRATION_CONFIG, type AdministrationConfig } from '../config';

export type Tx = Prisma.TransactionClient;

/**
 * Database access for administration-service. Every operation on tenant data runs inside
 * `withContext`, which opens a transaction and sets the row-level-security context first.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor(@Inject(ADMINISTRATION_CONFIG) config: AdministrationConfig) {
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
    try {
      return await this.$transaction(
        async (tx) => {
          await applyTenantContext(tx, context);
          return fn(tx);
        },
        { maxWait: 5_000, timeout: 15_000 },
      );
    } catch (error) {
      throw mapDatabaseError(error);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}

/** Unique violations become CONFLICT; everything else propagates unchanged. */
export function mapDatabaseError(error: unknown): unknown {
  if (error instanceof AppError) return error;
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    return new AppError('CONFLICT', { internalReason: 'unique constraint', cause: error });
  }
  return error;
}

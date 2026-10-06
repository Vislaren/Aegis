import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { AppError } from '@aegis/service-kit';
import { Prisma, PrismaClient } from '../generated/prisma/client';
import { IDENTITY_CONFIG, type IdentityConfig } from '../config';

export type Tx = Prisma.TransactionClient;

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor(@Inject(IDENTITY_CONFIG) config: IdentityConfig) {
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

  async tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    try {
      return await this.$transaction(fn, { maxWait: 5_000, timeout: 15_000 });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new AppError('CONFLICT', { internalReason: 'unique constraint', cause: error });
      }
      throw error;
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}

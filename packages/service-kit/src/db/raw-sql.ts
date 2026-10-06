/**
 * The minimal raw-SQL surface shared by Prisma clients and Prisma transaction clients.
 * `$queryRawUnsafe` with positional parameters is still parameterized: values are bound,
 * never interpolated. Query text must be constant.
 */
export interface RawSqlClient {
  $executeRawUnsafe(query: string, ...values: unknown[]): PromiseLike<number>;
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): PromiseLike<T>;
}

export type TenantContextKind = 'platform' | 'school' | 'user' | 'system';

export interface TenantContext {
  kind: TenantContextKind;
  schoolId: string | null;
  userId: string | null;
}

/**
 * Sets the PostgreSQL row-level-security context for the current transaction only
 * (`set_config(..., true)`), so it can never leak to another request through the pool.
 * Must be the first statement inside an interactive transaction.
 */
export async function applyTenantContext(tx: RawSqlClient, context: TenantContext): Promise<void> {
  await tx.$queryRawUnsafe(
    `SELECT set_config('aegis.context', $1, true),
            set_config('aegis.school_id', $2, true),
            set_config('aegis.user_id', $3, true)`,
    context.kind,
    context.schoolId ?? '',
    context.userId ?? '',
  );
}

export const SCHOOL_CONTEXT = (schoolId: string, userId: string | null): TenantContext => ({
  kind: 'school',
  schoolId,
  userId,
});

export const PLATFORM_CONTEXT = (userId: string | null): TenantContext => ({
  kind: 'platform',
  schoolId: null,
  userId,
});

export const USER_CONTEXT = (userId: string): TenantContext => ({
  kind: 'user',
  schoolId: null,
  userId,
});

import { createHash } from 'node:crypto';
import { AppError } from '@aegis/service-kit';
import { Prisma } from '../generated/prisma/client';
import type { Tx } from '../infrastructure/prisma.service';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function requestHash(operation: string, body: unknown): string {
  return createHash('sha256')
    .update(`${operation}\n${canonical(body)}`)
    .digest('hex');
}

export interface IdempotentResult<T> {
  status: number;
  body: T;
  replayed: boolean;
}

/**
 * Executes `fn` at most once per (actor, Idempotency-Key). The record is written in the same
 * transaction as the command, so a retry after a timeout returns the original result instead
 * of provisioning twice. Reusing a key for a different request is rejected.
 */
export async function idempotent<T>(
  tx: Tx,
  input: {
    actorUserId: string;
    key: string | null;
    operation: string;
    body: unknown;
    status: number;
  },
  fn: () => Promise<T>,
): Promise<IdempotentResult<T>> {
  if (input.key === null) throw new AppError('IDEMPOTENCY_KEY_REQUIRED');
  const hash = requestHash(input.operation, input.body);
  const existing = await tx.idempotencyRecord.findUnique({
    where: { actorUserId_key: { actorUserId: input.actorUserId, key: input.key } },
  });
  if (existing !== null) {
    if (existing.requestHash !== hash || existing.operation !== input.operation) {
      throw new AppError('IDEMPOTENCY_KEY_REUSED');
    }
    return { status: existing.responseStatus, body: existing.responseBody as T, replayed: true };
  }
  const body = await fn();
  await tx.idempotencyRecord.create({
    data: {
      actorUserId: input.actorUserId,
      key: input.key,
      operation: input.operation,
      requestHash: hash,
      responseStatus: input.status,
      responseBody: body as Prisma.InputJsonValue,
    },
  });
  return { status: input.status, body, replayed: false };
}

import type { Pool } from 'pg';
import { EventEnvelope } from '@aegis/contracts';
import type { Logger } from '@aegis/observability';
import type { MessageBroker } from './broker';

export interface OutboxRelayOptions {
  batchSize?: number;
  maxAttempts?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  random?: () => number;
}

interface OutboxRow {
  id: string;
  routing_key: string;
  envelope: unknown;
  attempts: number;
}

/** Exponential backoff with full jitter, capped. */
export function backoffMs(
  attempt: number,
  base: number,
  cap: number,
  random: () => number,
): number {
  const ceiling = Math.min(cap, base * 2 ** Math.max(0, attempt - 1));
  return Math.floor(random() * ceiling) + Math.floor(base / 2);
}

/**
 * Publishes committed outbox rows to the broker (at-least-once). Rows are claimed with
 * `FOR UPDATE SKIP LOCKED`, so several relay instances can run safely. A row that keeps failing
 * becomes DEAD and must be investigated: it is never silently dropped.
 */
export class OutboxRelay {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly options: Required<OutboxRelayOptions>;

  constructor(
    private readonly pool: Pool,
    private readonly broker: MessageBroker,
    private readonly logger: Pick<Logger, 'info' | 'warn' | 'error'>,
    options: OutboxRelayOptions = {},
  ) {
    this.options = {
      batchSize: options.batchSize ?? 50,
      maxAttempts: options.maxAttempts ?? 12,
      baseBackoffMs: options.baseBackoffMs ?? 500,
      maxBackoffMs: options.maxBackoffMs ?? 60_000,
      random: options.random ?? Math.random,
    };
  }

  /** Publishes one batch. Returns the number of rows published. */
  async runOnce(): Promise<number> {
    const client = await this.pool.connect();
    let published = 0;
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<OutboxRow>(
        `SELECT id, routing_key, envelope, attempts FROM outbox_messages
          WHERE status = 'PENDING' AND next_attempt_at <= now()
          ORDER BY priority, created_at
          LIMIT $1
          FOR UPDATE SKIP LOCKED`,
        [this.options.batchSize],
      );
      for (const row of rows) {
        try {
          const envelope = EventEnvelope.parse(row.envelope);
          await this.broker.publish(envelope, row.routing_key);
          await client.query(
            `UPDATE outbox_messages SET status = 'PUBLISHED', published_at = now(), attempts = attempts + 1, last_error = NULL
              WHERE id = $1`,
            [row.id],
          );
          published += 1;
        } catch (error) {
          const attempts = row.attempts + 1;
          const dead = attempts >= this.options.maxAttempts;
          const delay = backoffMs(
            attempts,
            this.options.baseBackoffMs,
            this.options.maxBackoffMs,
            this.options.random,
          );
          await client.query(
            `UPDATE outbox_messages
                SET attempts = $2, status = $3, last_error = $4,
                    next_attempt_at = now() + ($5::int * interval '1 millisecond')
              WHERE id = $1`,
            [row.id, attempts, dead ? 'DEAD' : 'PENDING', String(error).slice(0, 500), delay],
          );
          const log = { outboxId: row.id, routingKey: row.routing_key, attempts };
          if (dead) this.logger.error(log, 'outbox message moved to DEAD; manual action required');
          else this.logger.warn(log, 'outbox publish failed; will retry');
        }
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    return published;
  }

  /** Drains until no publishable rows remain (bounded), then returns the count. */
  async drain(maxBatches = 100): Promise<number> {
    let total = 0;
    for (let i = 0; i < maxBatches; i += 1) {
      const count = await this.runOnce();
      total += count;
      if (count === 0) break;
    }
    return total;
  }

  start(intervalMs = 250): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = true;
      this.drain(10)
        .catch((error: unknown) =>
          this.logger.error({ err: error }, 'outbox relay iteration failed'),
        )
        .finally(() => {
          this.running = false;
        });
    }, intervalMs);
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }
}

/** Outbox health for readiness probes and alerting: backlog size, oldest pending age, dead count. */
export async function outboxStats(
  pool: Pool,
): Promise<{ pending: number; dead: number; oldestPendingSeconds: number }> {
  const { rows } = await pool.query<{ pending: string; dead: string; oldest: number | null }>(
    `SELECT count(*) FILTER (WHERE status = 'PENDING') AS pending,
            count(*) FILTER (WHERE status = 'DEAD') AS dead,
            EXTRACT(EPOCH FROM (now() - min(created_at) FILTER (WHERE status = 'PENDING')))::float8 AS oldest
       FROM outbox_messages`,
  );
  const row = rows[0];
  return {
    pending: Number(row?.pending ?? 0),
    dead: Number(row?.dead ?? 0),
    oldestPendingSeconds: row?.oldest ?? 0,
  };
}

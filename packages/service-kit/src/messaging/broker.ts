import type { EventEnvelope } from '@aegis/contracts';

export type EventHandler = (envelope: EventEnvelope) => Promise<void>;

export interface SubscriptionSpec {
  /** Durable queue name owned by the consuming service, e.g. `administration-service.events`. */
  queue: string;
  /** Topic routing keys such as `identity.session.revoked.v1`. `#` and `*` wildcards are allowed. */
  routingKeys: readonly string[];
  /**
   * Durable subscriptions survive restarts and retry with dead-lettering. Ephemeral subscriptions
   * (realtime fan-out) get a private auto-deleted queue per instance.
   */
  durable: boolean;
  maxAttempts?: number;
  retryDelayMs?: number;
  prefetch?: number;
}

/** Broker port. RabbitMQ in deployed environments; in-memory for tests. */
export interface MessageBroker {
  publish(envelope: EventEnvelope, routingKey: string): Promise<void>;
  subscribe(spec: SubscriptionSpec, handler: EventHandler): Promise<void>;
  isHealthy(): boolean;
  close(): Promise<void>;
}

export const MESSAGE_BROKER = Symbol('MESSAGE_BROKER');
export const EVENTS_EXCHANGE = 'aegis.events';

/** AMQP topic matching: `*` matches one word, `#` matches zero or more words. */
export function topicMatches(pattern: string, key: string): boolean {
  const p = pattern.split('.');
  const k = key.split('.');
  const match = (pi: number, ki: number): boolean => {
    if (pi === p.length) return ki === k.length;
    const word = p[pi];
    if (word === '#') {
      for (let skip = ki; skip <= k.length; skip += 1) if (match(pi + 1, skip)) return true;
      return false;
    }
    if (ki === k.length) return false;
    return (word === '*' || word === k[ki]) && match(pi + 1, ki + 1);
  };
  return match(0, 0);
}

/**
 * Deterministic in-process broker for unit and integration tests. Delivery is synchronous with
 * publish, retries are immediate, and exhausted messages are kept in `deadLetters`.
 */
export class InMemoryBroker implements MessageBroker {
  readonly published: Array<{ routingKey: string; envelope: EventEnvelope }> = [];
  readonly deadLetters: Array<{ queue: string; envelope: EventEnvelope; error: string }> = [];
  private readonly subscriptions: Array<{ spec: SubscriptionSpec; handler: EventHandler }> = [];
  private healthy = true;

  async publish(envelope: EventEnvelope, routingKey: string): Promise<void> {
    if (!this.healthy) throw new Error('broker unavailable');
    this.published.push({ routingKey, envelope });
    for (const { spec, handler } of this.subscriptions) {
      if (!spec.routingKeys.some((pattern) => topicMatches(pattern, routingKey))) continue;
      const maxAttempts = spec.durable ? (spec.maxAttempts ?? 5) : 1;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          await handler(structuredClone(envelope));
          break;
        } catch (error) {
          if (attempt === maxAttempts) {
            this.deadLetters.push({ queue: spec.queue, envelope, error: String(error) });
          }
        }
      }
    }
  }

  async subscribe(spec: SubscriptionSpec, handler: EventHandler): Promise<void> {
    this.subscriptions.push({ spec, handler });
  }

  /** Simulates a broker outage for resilience tests. */
  setHealthy(healthy: boolean): void {
    this.healthy = healthy;
  }

  isHealthy(): boolean {
    return this.healthy;
  }

  async close(): Promise<void> {
    this.subscriptions.length = 0;
  }
}

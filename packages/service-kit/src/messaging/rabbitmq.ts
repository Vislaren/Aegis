import * as amqp from 'amqplib';
import { EventEnvelope } from '@aegis/contracts';
import type { Logger } from '@aegis/observability';
import {
  EVENTS_EXCHANGE,
  type EventHandler,
  type MessageBroker,
  type SubscriptionSpec,
} from './broker';

const ATTEMPT_HEADER = 'x-aegis-attempt';

/**
 * RabbitMQ adapter.
 *
 * Topology per durable subscription `Q`:
 *  - `Q` (quorum) bound to `aegis.events` with the listed routing keys;
 *  - `Q.retry` holds failed messages for `retryDelayMs`, then dead-letters them back into `Q`;
 *  - `Q.dead` keeps messages that exhausted `maxAttempts`, for investigation and replay.
 * Publishing uses a confirm channel; a publish resolves only after the broker confirms.
 */
export class RabbitMqBroker implements MessageBroker {
  private connection: amqp.ChannelModel | null = null;
  private publishChannel: amqp.ConfirmChannel | null = null;
  private readonly consumerChannels: amqp.ConfirmChannel[] = [];
  private healthy = false;

  constructor(
    private readonly url: string,
    private readonly logger: Pick<Logger, 'info' | 'warn' | 'error'>,
  ) {}

  async connect(): Promise<void> {
    const connection = await amqp.connect(this.url, {
      clientProperties: { connection_name: 'aegis' },
    });
    connection.on('error', (error: unknown) => {
      this.healthy = false;
      this.logger.error({ err: error }, 'broker connection error');
    });
    connection.on('close', () => {
      this.healthy = false;
      this.logger.warn({}, 'broker connection closed');
    });
    const channel = await connection.createConfirmChannel();
    await channel.assertExchange(EVENTS_EXCHANGE, 'topic', { durable: true });
    this.connection = connection;
    this.publishChannel = channel;
    this.healthy = true;
  }

  async publish(envelope: EventEnvelope, routingKey: string): Promise<void> {
    const channel = this.publishChannel;
    if (channel === null || !this.healthy) throw new Error('broker not connected');
    await new Promise<void>((resolve, reject) => {
      channel.publish(
        EVENTS_EXCHANGE,
        routingKey,
        Buffer.from(JSON.stringify(envelope)),
        {
          persistent: true,
          contentType: 'application/json',
          messageId: envelope.eventId,
          correlationId: envelope.correlationId,
          timestamp: Math.floor(Date.parse(envelope.occurredAt) / 1000),
          type: envelope.type,
        },
        (error: unknown) =>
          error ? reject(error instanceof Error ? error : new Error(String(error))) : resolve(),
      );
    });
  }

  async subscribe(spec: SubscriptionSpec, handler: EventHandler): Promise<void> {
    const connection = this.connection;
    if (connection === null) throw new Error('broker not connected');
    const channel = await connection.createConfirmChannel();
    this.consumerChannels.push(channel);
    await channel.prefetch(spec.prefetch ?? 16);
    await channel.assertExchange(EVENTS_EXCHANGE, 'topic', { durable: true });

    let queueName = spec.queue;
    if (spec.durable) {
      await channel.assertQueue(spec.queue, {
        durable: true,
        arguments: { 'x-queue-type': 'quorum' },
      });
      await channel.assertQueue(`${spec.queue}.retry`, {
        durable: true,
        arguments: {
          'x-queue-type': 'quorum',
          'x-message-ttl': spec.retryDelayMs ?? 5000,
          'x-dead-letter-exchange': '',
          'x-dead-letter-routing-key': spec.queue,
        },
      });
      await channel.assertQueue(`${spec.queue}.dead`, {
        durable: true,
        arguments: { 'x-queue-type': 'quorum' },
      });
    } else {
      const ephemeral = await channel.assertQueue('', {
        exclusive: true,
        autoDelete: true,
        durable: false,
      });
      queueName = ephemeral.queue;
    }
    for (const key of spec.routingKeys) await channel.bindQueue(queueName, EVENTS_EXCHANGE, key);

    const maxAttempts = spec.maxAttempts ?? 8;
    await channel.consume(queueName, (message: amqp.ConsumeMessage | null) => {
      if (message === null) return;
      void this.handle(channel, spec, maxAttempts, message, handler);
    });
  }

  private async handle(
    channel: amqp.ConfirmChannel,
    spec: SubscriptionSpec,
    maxAttempts: number,
    message: amqp.ConsumeMessage,
    handler: EventHandler,
  ): Promise<void> {
    const attempt = Number(message.properties.headers?.[ATTEMPT_HEADER] ?? 1);
    try {
      const envelope = EventEnvelope.parse(JSON.parse(message.content.toString('utf8')));
      await handler(envelope);
      channel.ack(message);
    } catch (error) {
      if (!spec.durable) {
        this.logger.warn(
          { err: error, queue: spec.queue },
          'ephemeral event handler failed; dropping',
        );
        channel.ack(message);
        return;
      }
      const target = attempt >= maxAttempts ? `${spec.queue}.dead` : `${spec.queue}.retry`;
      try {
        await new Promise<void>((resolve, reject) => {
          channel.sendToQueue(
            target,
            message.content,
            {
              ...message.properties,
              persistent: true,
              headers: { ...message.properties.headers, [ATTEMPT_HEADER]: attempt + 1 },
            },
            (err: unknown) =>
              err ? reject(err instanceof Error ? err : new Error(String(err))) : resolve(),
          );
        });
        channel.ack(message);
        const log = { queue: spec.queue, attempt, messageId: message.properties.messageId };
        if (target.endsWith('.dead')) this.logger.error(log, 'event moved to dead-letter queue');
        else this.logger.warn(log, 'event handler failed; scheduled retry');
      } catch (republishError) {
        // Could not park the message: leave it unacked so the broker redelivers it.
        this.logger.error(
          { err: republishError },
          'failed to schedule retry; message will be redelivered',
        );
        channel.nack(message, false, true);
      }
    }
  }

  isHealthy(): boolean {
    return this.healthy;
  }

  async close(): Promise<void> {
    this.healthy = false;
    for (const channel of this.consumerChannels) await channel.close().catch(() => undefined);
    await this.publishChannel?.close().catch(() => undefined);
    await this.connection?.close().catch(() => undefined);
    this.connection = null;
    this.publishChannel = null;
  }
}

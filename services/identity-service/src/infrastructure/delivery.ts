import { createTransport, type Transporter } from 'nodemailer';
import type { Logger } from '@aegis/observability';

export interface OutboundMessage {
  channel: 'EMAIL' | 'SMS';
  destination: string;
  /** Message intent, for provider templates and metrics. */
  kind: 'OTP' | 'INVITATION';
  subject: string;
  text: string;
}

/** Message delivery port. Provider adapters (SMS, WhatsApp, email) implement it. */
export interface MessageDelivery {
  send(message: OutboundMessage): Promise<void>;
}

export const MESSAGE_DELIVERY = Symbol('MESSAGE_DELIVERY');

/** Test adapter: records messages so tests can read codes and invitation links. */
export class InMemoryDelivery implements MessageDelivery {
  readonly sent: OutboundMessage[] = [];

  async send(message: OutboundMessage): Promise<void> {
    this.sent.push(message);
  }

  lastTo(destination: string): OutboundMessage | undefined {
    return [...this.sent].reverse().find((m) => m.destination === destination);
  }
}

/**
 * Local-development adapter: email through SMTP (Mailpit), and SMS captured as email to
 * `sms+<number>@sms.aegis.invalid` so no real SMS is sent. Configuration validation forbids it
 * in deployed environments, where a contracted SMS provider adapter must be configured.
 */
export class SmtpDevDelivery implements MessageDelivery {
  private readonly transport: Transporter;

  constructor(
    smtpUrl: string,
    private readonly from: string,
    private readonly logger: Pick<Logger, 'warn'>,
  ) {
    this.transport = createTransport(smtpUrl);
  }

  async send(message: OutboundMessage): Promise<void> {
    const to =
      message.channel === 'EMAIL'
        ? message.destination
        : `sms+${message.destination.replace('+', '')}@sms.aegis.invalid`;
    await this.transport.sendMail({
      from: this.from,
      to,
      subject: message.subject,
      text: message.text,
    });
  }
}

/**
 * Sends after the HTTP response is produced so that response timing does not reveal whether an
 * identifier exists (unknown identifiers produce no delivery). Tests await `idle()`.
 */
export class DeliveryDispatcher {
  private pending = new Set<Promise<void>>();

  constructor(
    private readonly delivery: MessageDelivery,
    private readonly logger: Pick<Logger, 'error'>,
  ) {}

  dispatch(message: OutboundMessage): void {
    const job = new Promise<void>((resolve) => setImmediate(resolve))
      .then(() => this.delivery.send(message))
      .catch((error: unknown) =>
        this.logger.error(
          { err: error, kind: message.kind, channel: message.channel },
          'message delivery failed',
        ),
      )
      .finally(() => this.pending.delete(job));
    this.pending.add(job);
  }

  async idle(): Promise<void> {
    while (this.pending.size > 0) await Promise.all([...this.pending]);
  }
}

export const DELIVERY_DISPATCHER = Symbol('DELIVERY_DISPATCHER');

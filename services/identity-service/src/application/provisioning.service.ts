import { Inject, Injectable } from '@nestjs/common';
import { INVITATION_POLICY, addSeconds, maskContact, parseContactIdentifier } from '@aegis/domain';
import { parseEventPayload, type EventEnvelope, type identity } from '@aegis/contracts';
import { AppError, claimInbox } from '@aegis/service-kit';
import { IDENTITY_CONFIG, type IdentityConfig } from '../config';
import { CryptoService } from '../infrastructure/crypto.service';
import { DELIVERY_DISPATCHER, type DeliveryDispatcher } from '../infrastructure/delivery';
import { PrismaService } from '../infrastructure/prisma.service';
import { Prisma } from '../generated/prisma/client';

const CONSUMER = 'identity-service';

/**
 * Identity provisioning for administration-service and invitation issuance. Identities are
 * created only by an administration workflow (no self-registration); a new identity stays
 * INVITED, with no access, until its invitation is redeemed through a one-time code.
 */
@Injectable()
export class ProvisioningService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CryptoService) private readonly crypto: CryptoService,
    @Inject(DELIVERY_DISPATCHER) private readonly dispatcher: DeliveryDispatcher,
    @Inject(IDENTITY_CONFIG) private readonly config: IdentityConfig,
  ) {}

  /** Idempotent by contact: returns the existing identity when the contact is already known. */
  async provisionUser(input: {
    displayName: string;
    contact: string;
  }): Promise<identity.ProvisionUserResponse> {
    const contact = parseContactIdentifier(input.contact);
    if (contact === null)
      throw new AppError('VALIDATION_FAILED', {
        errors: [{ path: 'contact', message: 'invalid contact' }],
      });
    const where =
      contact.kind === 'EMAIL' ? { email: contact.value } : { phoneE164: contact.value };

    const find = () => this.prisma.user.findUnique({ where });
    let user = await find();
    let created = false;
    if (user === null) {
      try {
        user = await this.prisma.user.create({
          data: { displayName: input.displayName, status: 'INVITED', ...where },
        });
        created = true;
      } catch (error) {
        // A concurrent provisioning of the same contact won the race: return that identity.
        if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'))
          throw error;
        user = await find();
        if (user === null) throw error;
      }
    }
    return {
      userId: user.id,
      created,
      status: user.status as identity.ProvisionUserResponse['status'],
      contactMasked: maskContact(contact.value),
    };
  }

  /** administration.invitation.requested → issue a single-use token and deliver the link. */
  async onInvitationRequested(envelope: EventEnvelope): Promise<void> {
    const payload = parseEventPayload('invitationRequested', envelope);
    const delivery = await this.prisma.tx(async (tx) => {
      if (!(await claimInbox(tx, envelope, CONSUMER))) return null;
      const user = await tx.user.findUnique({ where: { id: payload.userId } });
      if (user === null) throw new Error('invited user does not exist yet');
      const token = this.crypto.randomToken();
      const now = new Date();
      await tx.invitation.create({
        data: {
          invitationRequestId: payload.invitationRequestId,
          userId: user.id,
          schoolId: payload.schoolId,
          schoolName: payload.schoolName,
          kind: payload.kind,
          role: payload.role,
          tokenHash: this.crypto.tokenHash(token),
          status: 'PENDING',
          expiresAt: addSeconds(now, INVITATION_POLICY.ttlSeconds),
          deliveredAt: now,
        },
      });
      if (payload.kind !== 'SCHOOL_MEMBER' && !user.requiresMfa) {
        await tx.user.update({ where: { id: user.id }, data: { requiresMfa: true } });
      }
      const destination = user.email ?? user.phoneE164;
      if (destination === null) return null;
      return {
        token,
        destination,
        channel: user.email !== null ? ('EMAIL' as const) : ('SMS' as const),
        schoolName: payload.schoolName,
      };
    });
    if (delivery === null) return;

    // The link carries the token in the URL fragment, which browsers never send to servers or logs.
    const link = `${this.config.APP_PUBLIC_URL.replace(/\/$/, '')}/invite#token=${delivery.token}`;
    const inviter = delivery.schoolName ?? 'the Aegis platform team';
    this.dispatcher.dispatch({
      channel: delivery.channel,
      destination: delivery.destination,
      kind: 'INVITATION',
      subject: 'You have been invited to Aegis',
      text: `You have been invited to Aegis by ${inviter}. Open this link within 72 hours to accept: ${link}`,
    });
  }

  /** administration.invitation.cancelled → the token can no longer be redeemed. */
  async onInvitationCancelled(envelope: EventEnvelope): Promise<void> {
    const payload = parseEventPayload('invitationCancelled', envelope);
    await this.prisma.tx(async (tx) => {
      if (!(await claimInbox(tx, envelope, CONSUMER))) return;
      await tx.invitation.updateMany({
        where: {
          invitationRequestId: payload.invitationRequestId,
          userId: payload.userId,
          status: 'PENDING',
        },
        data: { status: 'REVOKED', revokedAt: new Date() },
      });
    });
  }
}

/**
 * One-time bootstrap of the first named platform operator for a new environment (there is no
 * self-registration, and every later operator is invited by an existing one).
 *
 *   pnpm --filter @aegis/administration-service bootstrap:platform-operator -- --name "Full Name" --contact person@example.org
 *
 * Runs with the service's runtime configuration. It provisions the identity through
 * identity-service's internal API, creates the INVITED operator profile and PLATFORM_ADMIN role
 * in the platform context, stages the invitation request, and journals the bootstrap. Refuses to
 * run when any platform operator already exists.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { PLATFORM_CONTEXT } from '@aegis/service-kit';
import { loadAdministrationConfig } from '../src/config';
import { journal } from '../src/application/journal';
import { requestInvitation } from '../src/application/invitations';
import { requireContact } from '../src/application/platform.service';
import { PrismaService } from '../src/infrastructure/prisma.service';
import { buildDependencies } from '../src/runtime';

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { name: { type: 'string' }, contact: { type: 'string' } },
  });
  if (values.name === undefined || values.contact === undefined || values.name.trim().length < 2) {
    throw new Error('Usage: --name "Full Name" --contact <email or +E.164 phone>');
  }
  const contact = requireContact(values.contact);
  const config = loadAdministrationConfig(process.env);
  const deps = await buildDependencies(config);
  const prisma = new PrismaService(config);
  const meta = {
    correlationId: randomUUID(),
    traceparent: null,
    sourceIp: null,
    userAgent: 'bootstrap-platform-operator',
  };

  try {
    const user = await deps.identity.provisionUser(
      { displayName: values.name.trim(), contact },
      meta,
    );
    await prisma.withContext(PLATFORM_CONTEXT(null), async (tx) => {
      if ((await tx.platformAdminOperatorProfile.count()) > 0) {
        throw new Error(
          'A platform operator already exists; invite further operators from the platform console.',
        );
      }
      const workspace = await tx.platformAdministrationWorkspace.findFirstOrThrow();
      const invitationRequestId = await requestInvitation(
        tx,
        {
          userId: user.userId,
          schoolId: null,
          schoolName: null,
          kind: 'PLATFORM_OPERATOR',
          role: 'PLATFORM_ADMIN',
        },
        meta,
      );
      const profile = await tx.platformAdminOperatorProfile.create({
        data: {
          workspaceId: workspace.id,
          userId: user.userId,
          displayName: values.name?.trim() ?? '',
          contactMasked: user.contactMasked,
          status: 'INVITED',
          invitationRequestId,
        },
      });
      await tx.roleAssignment.create({
        data: {
          userId: user.userId,
          roleKey: 'PLATFORM_ADMIN',
          roleScope: 'PLATFORM',
          status: 'ACTIVE',
        },
      });
      await journal(
        tx,
        { type: 'PLATFORM', workspaceId: workspace.id, schoolId: null },
        {
          userId: null,
          operatorProfileId: null,
          sessionId: null,
          grantId: null,
          fencingToken: null,
        },
        {
          action: 'PLATFORM_OPERATOR_CREATED',
          targetType: 'PLATFORM_OPERATOR',
          targetId: profile.id,
          outcome: 'SUCCESS',
          after: { ...profile, reason: 'bootstrap' },
        },
        meta,
      );
    });
    process.stdout.write(
      `Platform operator invited (${user.contactMasked}). The invitation is delivered once the workers are running.\n`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `bootstrap failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});

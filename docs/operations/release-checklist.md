# Release checklist and rollback

## Before promoting to production

- [ ] CI passed on the release commit: typecheck, lint, unit, integration, contract, secret scan, dependency audit, and container scan.
- [ ] Migrations are backward compatible with the currently deployed code (expand and contract) and were reviewed by a second engineer.
- [ ] API and event changes are backward compatible with the deployed consumers. Contract tests pass against the deployed versions.
- [ ] Changes to authorization, tenancy, authentication, journal, or location handling have a security reviewer's sign-off.
- [ ] The staging deployment passed the smoke tests:
  - [ ] health and readiness;
  - [ ] sign-in;
  - [ ] lease acquire and release;
  - [ ] provisioning on synthetic data;
  - [ ] journal chain verified.
- [ ] A backup was taken within the last hour, and its restore was tested this quarter.
- [ ] The outbox backlog and dead-letter queues are empty in production.

## Deployment order

1. Run the migration tasks for each changed service, in dependency order.
2. Deploy workers, then APIs, as rolling deployments behind health checks.
3. Deploy the gateway last.

## Rollback

- Code: redeploy the previous image tag. It stays compatible, because migrations are additive.
- Never roll back a migration destructively. Ship a forward fix.
- If the journal chain verification fails after a release, stop privileged writes (release the leases) and follow `runbooks/incident-response.md`.

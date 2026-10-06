# ADR-0014: Build and deployment

- **Status:** Accepted direction. The Terraform modules are not written yet.

## Decision

- **Images.** One image per service, built from `infrastructure/docker/service.Dockerfile` with `--build-arg SERVICE=<name>`.
  - The build is multi-stage; the runtime image runs as a non-root user on a read-only root filesystem with a tmpfs `/tmp`.
  - The same image runs the API (`node dist/main.js`) or the worker (`node dist/worker.js`).
  - Migrations run as a one-shot task using the owner role's credentials (`npx prisma migrate deploy`). Migrations always run before the code that depends on them (expand and contract).
- **Recommended production target.**
  - One ECS Fargate service per API and per worker, with ECS Service Connect for private discovery.
  - An ALB and WAF in front of `api-gateway` and `realtime-gateway` only.
  - RDS PostgreSQL 17 with PostGIS, with one database per service.
  - Amazon MQ (RabbitMQ) and ElastiCache Valkey.
  - Secrets Manager and KMS, with per-service secrets and IAM task roles.
  - CloudWatch, plus OTLP traces to the chosen backend.
  - Staging and production in separate accounts.
- **Lower-cost pilot alternative.** The same images on one well-operated VM with Docker Compose or k3s, managed PostgreSQL, TLS termination, off-host encrypted backups, and the same secrets discipline.
- **CI** (`.github/workflows/ci.yml): install, then typecheck, lint, unit tests, and integration tests against a PostgreSQL service container. It also runs the migration check, secret scanning (gitleaks), dependency audit, and a container build with a Trivy scan.
- **Delivery.** Staging deploys automatically, and production promotion is gated (`docs/operations/release-checklist.md`). Signed mobile builds go through EAS.

## Open items

- Terraform modules (`infrastructure/terraform/README.md`).
- Pinning GitHub Actions to commit SHAs. The workflow pins versions now; switch to SHAs before production.
- SBOM generation and artifact signing.

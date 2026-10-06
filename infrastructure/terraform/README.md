# Infrastructure as code (not yet implemented)

No Terraform has been written yet. This file records the intended module layout from ADR-0014 so that the first Phase 6 infrastructure change starts from an agreed shape. Do not treat this folder as deployable.

```
infrastructure/terraform/
  modules/
    network/          VPC, private subnets, NAT, security groups per declared service call path
    database/         RDS PostgreSQL 17 + PostGIS, KMS encryption, automated backups, per-service databases and roles
    broker/           Amazon MQ (RabbitMQ), TLS only
    cache/            ElastiCache Valkey
    service/          ECS Fargate service (API or worker), task role, secrets wiring, autoscaling, health checks
    edge/             ALB, WAF, ACM certificates, Route 53 records for api-gateway and realtime-gateway
    observability/    CloudWatch log groups and alarms, OTLP collector
  environments/
    staging/
    production/
```

Every module must enforce:

- encryption at rest;
- least-privilege IAM;
- no public database or broker endpoints;
- per-service secrets in Secrets Manager.

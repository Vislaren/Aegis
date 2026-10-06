import { Module, type DynamicModule } from '@nestjs/common';
import {
  InternalServiceClient,
  ServiceKitModule,
  ServiceTokenSigner,
  ServiceTokenVerifier,
  createAccessTokenVerifier,
  type AccessTokenVerifier,
  type ReadinessCheck,
  type ServiceTokenVerifier as Verifier,
} from '@aegis/service-kit';
import { JournalController, SecurityEventsController } from './api';
import { AuditService } from './audit.service';
import { AUDIT_CONFIG, SERVICE_NAME, type AuditConfig } from './config';
import {
  HttpLeaseValidation,
  LEASE_VALIDATION,
  PrismaService,
  type LeaseValidationPort,
} from './infrastructure';

export interface AuditDependencies {
  config: AuditConfig;
  leaseValidation: LeaseValidationPort;
  accessTokenVerifier: AccessTokenVerifier;
  serviceTokenVerifier: Verifier | null;
  readinessChecks?: ReadinessCheck[];
}

@Module({})
export class AuditModule {
  static register(
    deps: AuditDependencies,
    options: { withHttp: boolean } = { withHttp: true },
  ): DynamicModule {
    return {
      module: AuditModule,
      imports: [
        ServiceKitModule.forRoot({
          accessTokenVerifier: deps.accessTokenVerifier,
          serviceTokenVerifier: deps.serviceTokenVerifier,
          readinessChecks: deps.readinessChecks ?? [],
        }),
      ],
      controllers: options.withHttp ? [JournalController, SecurityEventsController] : [],
      providers: [
        { provide: AUDIT_CONFIG, useValue: deps.config },
        { provide: LEASE_VALIDATION, useValue: deps.leaseValidation },
        PrismaService,
        AuditService,
      ],
      exports: [AuditService, PrismaService],
    };
  }
}

export async function buildDependencies(config: AuditConfig): Promise<AuditDependencies> {
  const signer = await ServiceTokenSigner.fromJwk(SERVICE_NAME, config.SERVICE_PRIVATE_KEY);
  return {
    config,
    leaseValidation: new HttpLeaseValidation(
      new InternalServiceClient({
        baseUrl: config.ADMINISTRATION_INTERNAL_URL,
        callee: 'administration-service',
        signer,
        timeoutMs: 3000,
      }),
    ),
    accessTokenVerifier: createAccessTokenVerifier({
      issuer: config.ACCESS_TOKEN_ISSUER,
      jwksUrl: config.IDENTITY_JWKS_URL,
    }),
    serviceTokenVerifier: await ServiceTokenVerifier.create(
      SERVICE_NAME,
      config.TRUSTED_SERVICE_KEYS,
    ),
  };
}

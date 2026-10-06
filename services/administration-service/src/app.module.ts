import { Module, type DynamicModule } from '@nestjs/common';
import {
  ServiceKitModule,
  type AccessTokenVerifier,
  type ReadinessCheck,
  type ServiceTokenVerifier,
} from '@aegis/service-kit';
import { ADMINISTRATION_CONFIG, type AdministrationConfig } from './config';
import {
  AccessController,
  PlatformController,
  PrivilegedAccessController,
  SchoolAdminController,
  SessionHistoryController,
} from './api/controllers';
import { InternalPrivilegedAccessController } from './api/internal.controller';
import { AccessService } from './application/access.service';
import { ActorService } from './application/actor.service';
import { AdministrationEventHandlers } from './application/event-handlers';
import { PlatformService } from './application/platform.service';
import { PrivilegedAccessService } from './application/privileged-access.service';
import { SchoolAdminService } from './application/school-admin.service';
import { IDENTITY_CLIENT, type IdentityPort } from './infrastructure/identity.client';
import { PrismaService } from './infrastructure/prisma.service';

export interface AdministrationDependencies {
  config: AdministrationConfig;
  identity: IdentityPort;
  accessTokenVerifier: AccessTokenVerifier;
  serviceTokenVerifier: ServiceTokenVerifier | null;
  readinessChecks?: ReadinessCheck[];
}

@Module({})
export class AdministrationModule {
  /** Explicit wiring: production builds HTTP adapters, tests pass in-memory fakes. */
  static register(
    deps: AdministrationDependencies,
    options: { withHttp: boolean } = { withHttp: true },
  ): DynamicModule {
    return {
      module: AdministrationModule,
      imports: [
        ServiceKitModule.forRoot({
          accessTokenVerifier: deps.accessTokenVerifier,
          serviceTokenVerifier: deps.serviceTokenVerifier,
          readinessChecks: deps.readinessChecks ?? [],
        }),
      ],
      controllers: options.withHttp
        ? [
            AccessController,
            PrivilegedAccessController,
            SessionHistoryController,
            PlatformController,
            SchoolAdminController,
            InternalPrivilegedAccessController,
          ]
        : [],
      providers: [
        { provide: ADMINISTRATION_CONFIG, useValue: deps.config },
        { provide: IDENTITY_CLIENT, useValue: deps.identity },
        PrismaService,
        ActorService,
        PrivilegedAccessService,
        PlatformService,
        SchoolAdminService,
        AccessService,
        AdministrationEventHandlers,
      ],
      exports: [PrismaService, AdministrationEventHandlers, PrivilegedAccessService],
    };
  }
}

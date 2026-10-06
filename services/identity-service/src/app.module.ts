import { Module, type DynamicModule } from '@nestjs/common';
import {
  ServiceKitModule,
  type AccessTokenSigner,
  type AccessTokenVerifier,
  type ReadinessCheck,
  type ServiceTokenVerifier,
} from '@aegis/service-kit';
import { IDENTITY_CONFIG, type IdentityConfig } from './config';
import {
  AuthController,
  InternalIdentityController,
  MeController,
  PoliciesController,
} from './api/controllers';
import { MeService } from './application/me.service';
import { MfaService } from './application/mfa.service';
import { OtpService } from './application/otp.service';
import { ProvisioningService } from './application/provisioning.service';
import { ACCESS_TOKEN_SIGNER, SessionService } from './application/session.service';
import { CryptoService } from './infrastructure/crypto.service';
import { DELIVERY_DISPATCHER, type DeliveryDispatcher } from './infrastructure/delivery';
import { JWKS_DOCUMENT, type JwksDocument } from './infrastructure/jwks';
import { PrismaService } from './infrastructure/prisma.service';
import { TOTP, type TotpPort } from './infrastructure/totp';

export interface IdentityDependencies {
  config: IdentityConfig;
  signer: AccessTokenSigner;
  jwks: JwksDocument;
  accessTokenVerifier: AccessTokenVerifier;
  serviceTokenVerifier: ServiceTokenVerifier | null;
  dispatcher: DeliveryDispatcher;
  totp: TotpPort;
  readinessChecks?: ReadinessCheck[];
}

@Module({})
export class IdentityModule {
  static register(
    deps: IdentityDependencies,
    options: { withHttp: boolean } = { withHttp: true },
  ): DynamicModule {
    return {
      module: IdentityModule,
      imports: [
        ServiceKitModule.forRoot({
          accessTokenVerifier: deps.accessTokenVerifier,
          serviceTokenVerifier: deps.serviceTokenVerifier,
          readinessChecks: deps.readinessChecks ?? [],
        }),
      ],
      controllers: options.withHttp
        ? [AuthController, MeController, PoliciesController, InternalIdentityController]
        : [],
      providers: [
        { provide: IDENTITY_CONFIG, useValue: deps.config },
        { provide: ACCESS_TOKEN_SIGNER, useValue: deps.signer },
        { provide: JWKS_DOCUMENT, useValue: deps.jwks },
        { provide: DELIVERY_DISPATCHER, useValue: deps.dispatcher },
        { provide: TOTP, useValue: deps.totp },
        PrismaService,
        CryptoService,
        SessionService,
        OtpService,
        MfaService,
        MeService,
        ProvisioningService,
      ],
      exports: [PrismaService, ProvisioningService, SessionService],
    };
  }
}

import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AccessTokenSigner,
  ServiceTokenVerifier,
  correlationIdFor,
  createAccessTokenVerifier,
  generateSigningJwk,
  publicJwk,
} from '@aegis/service-kit';
import { AdministrationModule } from '../../src/app.module';
import { loadAdministrationConfig } from '../../src/config';

/**
 * Boots the real module graph without a database (no query is issued) to prove dependency
 * injection, deny-by-default authentication, strict validation, and internal-route protection.
 */
let app: NestFastifyApplication;
let token: string;

beforeAll(async () => {
  const accessKey = await generateSigningJwk('boot-access');
  const issuer = 'https://identity.aegis.test';
  const config = loadAdministrationConfig({
    NODE_ENV: 'test',
    PORT: '3002',
    SERVICE_NAME: 'administration-service',
    SERVICE_PRIVATE_KEY: JSON.stringify(await generateSigningJwk('administration-service')),
    IDENTITY_JWKS_URL: 'http://identity.test/jwks',
    IDENTITY_INTERNAL_URL: 'http://identity.test',
    ACCESS_TOKEN_ISSUER: issuer,
    BROKER: 'memory',
    DATABASE_URL: 'postgresql://nobody:nothing@127.0.0.1:1/none',
  });
  app = await NestFactory.create<NestFastifyApplication>(
    AdministrationModule.register({
      config,
      identity: {
        provisionUser: async () => {
          throw new Error('not used');
        },
        introspectSession: async () => null,
      },
      accessTokenVerifier: createAccessTokenVerifier({
        issuer,
        jwks: { keys: [publicJwk(accessKey)] },
      }),
      serviceTokenVerifier: await ServiceTokenVerifier.create('administration-service', {}),
    }),
    new FastifyAdapter({ genReqId: correlationIdFor }),
    { logger: false },
  );
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  const signer = await AccessTokenSigner.fromJwk(accessKey, issuer);
  token = (
    await signer.sign(
      {
        userId: '00000000-0000-4000-8000-000000000001',
        sessionId: '00000000-0000-4000-8000-000000000002',
        aal: 2,
      },
      60,
    )
  ).token;
});

afterAll(async () => {
  await app?.close();
});

describe('administration-service boot', () => {
  it('serves health without authentication', async () => {
    const res = await request(app.getHttpServer()).get('/health/live');
    expect(res.status).toBe(200);
  });

  it('denies every API route without a valid token, with problem details and a correlation ID', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/access/contexts')
      .set('x-correlation-id', 'corr-boot-12345');
    expect(res.status).toBe(401);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body).toMatchObject({ code: 'UNAUTHENTICATED', correlationId: 'corr-boot-12345' });
  });

  it('rejects a valid user token whose session identity-service does not confirm', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/access/contexts')
      .set('authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
  });

  it('never accepts user tokens on internal routes', async () => {
    const res = await request(app.getHttpServer())
      .post('/internal/v1/privileged-access/validate')
      .set('authorization', `Bearer ${token}`)
      .send({
        sessionId: '00000000-0000-4000-8000-000000000002',
        userId: '00000000-0000-4000-8000-000000000001',
      });
    expect(res.status).toBe(401);
  });

  it('rejects unknown fields before any authorization work (mass assignment)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/privileged-access/acquire')
      .set('authorization', `Bearer ${token}`)
      .send({ workspace: { type: 'PLATFORM' }, operatorProfileId: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
  });

  it('returns NOT_FOUND problem details for unknown routes', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/nope')
      .set('authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
  });
});

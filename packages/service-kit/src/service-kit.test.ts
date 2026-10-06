import { describe, expect, it } from 'vitest';
import { ZodError, z } from 'zod';
import { EVENTS, eventRoutingKey } from '@aegis/contracts';
import { AppError, errorForDenial } from './errors';
import { toAppError } from './http/problem-filter';
import { InMemoryBroker, topicMatches } from './messaging/broker';
import { createEnvelope } from './messaging/envelope';
import { backoffMs } from './messaging/outbox-relay';
import { parseCookies, serializeCookie } from './auth/cookies';
import {
  AccessTokenSigner,
  ServiceTokenSigner,
  ServiceTokenVerifier,
  createAccessTokenVerifier,
  generateSigningJwk,
  publicJwk,
} from './auth/tokens';

describe('problem details', () => {
  it('maps object-level denials to NOT_FOUND so existence is never disclosed', () => {
    expect(errorForDenial('NOT_FOUND').code).toBe('NOT_FOUND');
    expect(errorForDenial('NO_PRIVILEGED_LEASE').code).toBe('PRIVILEGED_LEASE_REQUIRED');
    expect(errorForDenial('MFA_NOT_FRESH').code).toBe('REAUTHENTICATION_REQUIRED');
    expect(errorForDenial('ROLE_NOT_ASSIGNABLE').code).toBe('FORBIDDEN');
  });

  it('turns validation errors into field-level problems and hides internals of unknown errors', () => {
    const zodError = (() => {
      try {
        z.strictObject({ name: z.string() }).parse({ name: 1, schoolId: 'x' });
      } catch (error) {
        return error as ZodError;
      }
      throw new Error('expected failure');
    })();
    const validation = toAppError(zodError).toProblem('c1');
    expect(validation.code).toBe('VALIDATION_FAILED');
    expect(validation.errors?.length).toBeGreaterThan(0);

    const internal = toAppError(new Error('relation "schools" does not exist at /srv/app.js:12'));
    const problem = internal.toProblem('c2');
    expect(problem).toMatchObject({ status: 500, code: 'INTERNAL', correlationId: 'c2' });
    expect(JSON.stringify(problem)).not.toContain('schools');
  });

  it('includes occupancy only for the workspace-in-use problem', () => {
    const problem = new AppError('ADMIN_WORKSPACE_IN_USE', {
      occupancy: {
        operatorDisplayName: 'Operator Fictional',
        acquiredAt: '2026-01-01T00:00:00.000Z',
        lastActivityAt: '2026-01-01T00:01:00.000Z',
      },
      internalReason: 'secret detail',
    }).toProblem('c3');
    expect(problem.status).toBe(409);
    expect(problem.occupancy?.operatorDisplayName).toBe('Operator Fictional');
    expect(JSON.stringify(problem)).not.toContain('secret detail');
  });
});

describe('topic routing', () => {
  it('matches AMQP topic wildcards', () => {
    expect(topicMatches('audit.journal.entry.v1', 'audit.journal.entry.v1')).toBe(true);
    expect(topicMatches('audit.#', 'audit.journal.entry.v1')).toBe(true);
    expect(topicMatches('audit.*.entry.v1', 'audit.journal.entry.v1')).toBe(true);
    expect(topicMatches('audit.*', 'audit.journal.entry.v1')).toBe(false);
    expect(topicMatches('identity.#', 'audit.journal.entry.v1')).toBe(false);
  });
});

describe('event envelopes and the in-memory broker', () => {
  const meta = { producer: 'test-service', schoolId: null, correlationId: 'corr-1' };

  it('refuses to create a contract-violating event', () => {
    expect(() =>
      createEnvelope(
        'sessionRevoked',
        { sessionId: 'not-a-uuid', userId: 'x', reason: 'LOGOUT' } as never,
        meta,
      ),
    ).toThrow();
  });

  it('delivers to matching subscribers, retries durable handlers, and dead-letters exhausted messages', async () => {
    const broker = new InMemoryBroker();
    let attempts = 0;
    await broker.subscribe(
      { queue: 'q.flaky', routingKeys: ['identity.#'], durable: true, maxAttempts: 3 },
      async () => {
        attempts += 1;
        if (attempts < 3) throw new Error('transient');
      },
    );
    await broker.subscribe(
      {
        queue: 'q.broken',
        routingKeys: ['identity.session.revoked.v1'],
        durable: true,
        maxAttempts: 2,
      },
      async () => {
        throw new Error('permanent');
      },
    );
    const envelope = createEnvelope(
      'sessionRevoked',
      {
        sessionId: '00000000-0000-4000-8000-000000000001',
        userId: '00000000-0000-4000-8000-000000000002',
        reason: 'LOGOUT',
      },
      meta,
    );
    await broker.publish(envelope, eventRoutingKey('sessionRevoked'));
    expect(attempts).toBe(3);
    expect(broker.deadLetters).toHaveLength(1);
    expect(broker.deadLetters[0]?.queue).toBe('q.broken');
    expect(EVENTS.sessionRevoked.type).toBe('identity.session.revoked');
  });
});

describe('outbox backoff', () => {
  it('grows exponentially, is capped, and is jittered', () => {
    const fixed = () => 0.999;
    expect(backoffMs(1, 500, 60_000, fixed)).toBeLessThan(backoffMs(4, 500, 60_000, fixed));
    expect(backoffMs(30, 500, 60_000, fixed)).toBeLessThanOrEqual(60_000 + 250);
    expect(backoffMs(3, 500, 60_000, () => 0)).toBe(250);
  });
});

describe('cookies', () => {
  it('parses and serializes with security attributes', () => {
    expect(parseCookies('a=1; aegis_at=tok%20en; a=2')).toEqual({ a: '1', aegis_at: 'tok en' });
    const cookie = serializeCookie({
      name: 'aegis_rt',
      value: 'v',
      maxAgeSeconds: 60,
      httpOnly: true,
      sameSite: 'Strict',
      path: '/api/v1/auth',
      secure: true,
    });
    expect(cookie).toBe(
      'aegis_rt=v; Path=/api/v1/auth; Max-Age=60; SameSite=Strict; HttpOnly; Secure',
    );
  });
});

describe('tokens', () => {
  it('signs and verifies access tokens against a JWKS, rejecting other issuers and keys', async () => {
    const key = await generateSigningJwk('k1');
    const signer = await AccessTokenSigner.fromJwk(key, 'https://identity.test');
    const verifier = createAccessTokenVerifier({
      issuer: 'https://identity.test',
      jwks: { keys: [publicJwk(key)] },
    });
    const { token } = await signer.sign(
      {
        userId: '00000000-0000-4000-8000-0000000000aa',
        sessionId: '00000000-0000-4000-8000-0000000000bb',
        aal: 2,
      },
      60,
    );
    await expect(verifier.verify(token)).resolves.toEqual({
      userId: '00000000-0000-4000-8000-0000000000aa',
      sessionId: '00000000-0000-4000-8000-0000000000bb',
      aal: 2,
    });

    const otherIssuer = createAccessTokenVerifier({
      issuer: 'https://evil.test',
      jwks: { keys: [publicJwk(key)] },
    });
    await expect(otherIssuer.verify(token)).rejects.toThrow();
    const otherKey = await generateSigningJwk('k2');
    const wrongKeys = createAccessTokenVerifier({
      issuer: 'https://identity.test',
      jwks: { keys: [publicJwk(otherKey)] },
    });
    await expect(wrongKeys.verify(token)).rejects.toThrow();
    expect(publicJwk(key)).not.toHaveProperty('d');
  });

  it('accepts service tokens only from allowlisted callers addressed to this service', async () => {
    const adminKey = await generateSigningJwk('administration');
    const rogueKey = await generateSigningJwk('rogue');
    const adminSigner = await ServiceTokenSigner.fromJwk('administration-service', adminKey);
    const rogueSigner = await ServiceTokenSigner.fromJwk('administration-service', rogueKey);
    const verifier = await ServiceTokenVerifier.create('identity-service', {
      'administration-service': publicJwk(adminKey),
    });

    await expect(verifier.verify(await adminSigner.tokenFor('identity-service'))).resolves.toBe(
      'administration-service',
    );
    await expect(verifier.verify(await adminSigner.tokenFor('audit-service'))).rejects.toThrow();
    await expect(verifier.verify(await rogueSigner.tokenFor('identity-service'))).rejects.toThrow();
  });
});

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ConfigError, baseServiceEnv, commonSafetyRules, envBoolean, loadConfig } from './index';

const schema = baseServiceEnv.extend({
  DATABASE_URL: z.string().min(1),
  FAKE_DELIVERY: envBoolean.default(false),
});

describe('loadConfig', () => {
  it('parses and applies defaults', () => {
    const config = loadConfig('svc', schema, { PORT: '3001', DATABASE_URL: 'postgres://db/aegis' });
    expect(config).toMatchObject({ NODE_ENV: 'development', PORT: 3001, FAKE_DELIVERY: false });
  });

  it('reports names of invalid variables without echoing their values', () => {
    try {
      loadConfig('svc', schema, { PORT: 'abc', DATABASE_URL: 'postgres://user:hunter2@db/aegis' });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).message).toContain('PORT');
      expect((error as ConfigError).message).not.toContain('hunter2');
    }
  });

  it('refuses unsafe settings only in deployed environments', () => {
    const rules = [
      ...commonSafetyRules<z.infer<typeof schema>>(),
      {
        description: 'fake delivery is forbidden',
        violated: (c: z.infer<typeof schema>) => c.FAKE_DELIVERY,
      },
    ];
    const env = { PORT: '3001', DATABASE_URL: 'postgres://db/aegis', FAKE_DELIVERY: 'true' };
    expect(() => loadConfig('svc', schema, env, rules)).not.toThrow();
    expect(() => loadConfig('svc', schema, { ...env, NODE_ENV: 'production' }, rules)).toThrow(
      /fake delivery/,
    );
  });

  it('parses the string "false" as false', () => {
    expect(envBoolean.parse('false')).toBe(false);
    expect(envBoolean.parse('1')).toBe(true);
  });
});

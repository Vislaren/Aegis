import pino, { type Logger, type LoggerOptions } from 'pino';
import { PINO_REDACT_PATHS, REDACTED, redactForLog } from './redaction';

export type { Logger } from 'pino';

export interface LoggerConfig {
  service: string;
  level: string;
  environment: string;
}

/**
 * Pino options shared by every service. Request bodies are never logged; serializers only
 * keep method, URL path, status, and correlation ID.
 */
export function loggerOptions(config: LoggerConfig): LoggerOptions {
  return {
    level: config.level,
    base: { service: config.service, env: config.environment },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: [...PINO_REDACT_PATHS], censor: REDACTED },
    messageKey: 'message',
    serializers: {
      req: (req: { method?: string; url?: string; id?: string }) => ({
        method: req.method,
        // Query strings can carry identifiers; keep the path only.
        path: typeof req.url === 'string' ? req.url.split('?')[0] : undefined,
        correlationId: req.id,
      }),
      res: (res: { statusCode?: number }) => ({ statusCode: res.statusCode }),
      err: (err: Error) => redactForLog(err),
    },
    formatters: {
      level: (label) => ({ level: label }),
    },
  };
}

export function createLogger(config: LoggerConfig): Logger {
  return pino(loggerOptions(config));
}

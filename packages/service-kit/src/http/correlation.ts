import { randomUUID } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

const SAFE_ID = /^[A-Za-z0-9-]{8,100}$/;

/**
 * Fastify `genReqId`: reuse a well-formed incoming correlation ID (set by the gateway or a calling
 * service) so a request can be traced across services; otherwise mint one.
 */
export function correlationIdFor(request: { headers: IncomingHttpHeaders }): string {
  const incoming = request.headers['x-correlation-id'];
  if (typeof incoming === 'string' && SAFE_ID.test(incoming)) return incoming;
  return randomUUID();
}

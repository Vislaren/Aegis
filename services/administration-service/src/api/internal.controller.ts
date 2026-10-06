import { Body, Controller, HttpCode, Inject, Post } from '@nestjs/common';
import type { z } from 'zod';
import { administration } from '@aegis/contracts';
import { InternalRoute, Meta, ResponseSchema, ZodPipe, type RequestMeta } from '@aegis/service-kit';
import { PrivilegedAccessService } from '../application/privileged-access.service';

/**
 * Internal API for other services. Never routed by the public gateway; requires a service token
 * from an allowlisted caller.
 */
@Controller('internal/v1/privileged-access')
export class InternalPrivilegedAccessController {
  constructor(
    @Inject(PrivilegedAccessService) private readonly privileged: PrivilegedAccessService,
  ) {}

  /**
   * Validates that a session holds a live lease (optionally on a specific workspace) and returns
   * the grant and fencing token. Downstream services call this on every privileged command and
   * must deny the command when this call fails or cannot be made.
   */
  @Post('validate')
  @HttpCode(200)
  @InternalRoute('audit-service', 'realtime-gateway', 'school-setup-service', 'trip-service')
  @ResponseSchema(administration.ValidateLeaseResponse)
  async validate(
    @Meta() meta: RequestMeta,
    @Body(new ZodPipe(administration.ValidateLeaseRequest))
    body: z.infer<typeof administration.ValidateLeaseRequest>,
  ) {
    const lease = await this.privileged.validateForService(body, meta);
    return { lease };
  }
}

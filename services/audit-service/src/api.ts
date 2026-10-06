import { Controller, Get, Inject, Query } from '@nestjs/common';
import type { z } from 'zod';
import { audit } from '@aegis/contracts';
import {
  Auth,
  Meta,
  ResponseSchema,
  ZodPipe,
  type AuthContext,
  type RequestMeta,
} from '@aegis/service-kit';
import { AuditService } from './audit.service';

@Controller('api/v1/administration')
export class JournalController {
  constructor(@Inject(AuditService) private readonly auditService: AuditService) {}

  /** Requires a live privileged lease; scope comes from that lease, never from the query. */
  @Get('activity-journal')
  @ResponseSchema(audit.JournalResponse)
  journal(
    @Auth() auth: AuthContext,
    @Meta() meta: RequestMeta,
    @Query(new ZodPipe(audit.JournalQuery)) query: z.infer<typeof audit.JournalQuery>,
  ) {
    return this.auditService.searchJournal(auth, meta, query);
  }
}

@Controller('api/v1/me')
export class SecurityEventsController {
  constructor(@Inject(AuditService) private readonly auditService: AuditService) {}

  @Get('security-events')
  @ResponseSchema(audit.SecurityEventListResponse)
  events(
    @Auth() auth: AuthContext,
    @Query(new ZodPipe(audit.SecurityEventQuery)) query: z.infer<typeof audit.SecurityEventQuery>,
  ) {
    return this.auditService.mySecurityEvents(auth, query);
  }
}

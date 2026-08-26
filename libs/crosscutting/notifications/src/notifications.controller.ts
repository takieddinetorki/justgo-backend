import { Body, Controller, Get, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { CurrentAuth, RequirePermissions, type AuthContext } from '@justgo/auth';
import { asId, ValidationError, type Uuid } from '@justgo/kernel';
import { NOTIFICATIONS_PORT, type NotificationsPort } from './contract/notifications.port';
import type { NotificationDTO, Recipient } from './contract/dto';

const deviceSchema = z
  .object({
    fcmToken: z.string().min(1).max(4096),
    platform: z.enum(['android', 'ios', 'web']).optional(),
  })
  .strict();

/**
 * §15 Shared: GET /v1/notifications, PATCH /v1/notifications/{id}/read,
 * POST /v1/devices. A supplier-scoped session sees its supplier's feed;
 * everyone else sees their personal account feed.
 */
@Controller()
export class NotificationsController {
  constructor(@Inject(NOTIFICATIONS_PORT) private readonly notifications: NotificationsPort) {}

  private recipient(auth: AuthContext): Recipient {
    return auth.supplierScope
      ? { supplier: auth.supplierScope.supplierId }
      : { account: auth.accountId };
  }

  @Get('notifications')
  @RequirePermissions()
  async list(
    @CurrentAuth() auth: AuthContext,
    @Query('limit') limit?: string,
  ): Promise<{ items: NotificationDTO[]; unread: number }> {
    const n = limit ? Number(limit) : 50;
    if (auth.supplierScope) {
      const supplierId = auth.supplierScope.supplierId;
      const [items, unread] = await Promise.all([
        this.notifications.listForSupplier(supplierId, n),
        this.notifications.unreadForSupplier(supplierId),
      ]);
      return { items, unread };
    }
    const [items, unread] = await Promise.all([
      this.notifications.listForAccount(auth.accountId, n),
      this.notifications.unreadForAccount(auth.accountId),
    ]);
    return { items, unread };
  }

  @Patch('notifications/:id/read')
  @RequirePermissions()
  async markRead(
    @CurrentAuth() auth: AuthContext,
    @Param('id') id: string,
  ): Promise<{ ok: true }> {
    await this.notifications.markRead(this.recipient(auth), asId<Uuid>(id));
    return { ok: true };
  }

  @Post('devices')
  @RequirePermissions()
  async registerDevice(
    @CurrentAuth() auth: AuthContext,
    @Body() body: unknown,
  ): Promise<{ ok: true }> {
    const parsed = deviceSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError('Invalid device registration', { issues: parsed.error.issues });
    }
    await this.notifications.registerDevice(
      auth.accountId,
      auth.supplierScope?.supplierId ?? null,
      parsed.data,
    );
    return { ok: true };
  }
}

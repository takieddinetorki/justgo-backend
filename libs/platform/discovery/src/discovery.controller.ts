import { Controller, Get, Inject, Query } from '@nestjs/common';
import { z } from 'zod';
import { Public } from '@justgo/auth';
import { ValidationError } from '@justgo/kernel';
import { DISCOVERY_PORT, type DiscoveryPort } from './contract/discovery.port';
import type { NearbySupplierDTO } from './contract/dto';

const querySchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  radius: z.coerce.number().positive().optional(),
  vertical: z.string().max(64).optional(),
  category: z.string().max(64).optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
});

/** Nearby supplier discovery (§15 client — discovery). Public read model. */
@Controller('discovery')
export class DiscoveryController {
  constructor(@Inject(DISCOVERY_PORT) private readonly discovery: DiscoveryPort) {}

  @Get('suppliers')
  @Public()
  async suppliers(@Query() query: unknown): Promise<{ items: NearbySupplierDTO[] }> {
    const parsed = querySchema.safeParse(query);
    if (!parsed.success) throw new ValidationError('Invalid query', { issues: parsed.error.issues });
    const { lat, lng, radius, vertical, category, limit } = parsed.data;
    const items = await this.discovery.nearby({
      lat,
      lng,
      radiusM: radius,
      verticalKeys: vertical ? [vertical] : undefined,
      categoryKey: category,
      limit,
    });
    return { items };
  }
}

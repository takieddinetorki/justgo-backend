import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import { z } from 'zod';
import { Public } from '@justgo/auth';
import { NotFoundError, ValidationError } from '@justgo/kernel';
import { DISCOVERY_PORT, type DiscoveryPort } from './contract/discovery.port';
import type { DirectoryPage, DirectorySupplierDTO, NearbySupplierDTO } from './contract/dto';

const querySchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  radius: z.coerce.number().positive().optional(),
  vertical: z.string().max(64).optional(),
  category: z.string().max(64).optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
});

/**
 * Services Directory query. Every field optional, INCLUDING location —
 * that is what separates it from `nearby`, which demands a lat/lng the
 * user may never have granted.
 */
const directorySchema = z.object({
  q: z.string().min(1).max(120).optional(),
  vertical: z.string().max(64).optional(),
  category: z.string().max(64).optional(),
  city: z.string().max(120).optional(),
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
  cursor: z.string().max(400).optional(),
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

  /**
   * `GET /v1/discovery/directory` — the Services Directory.
   *
   * Deliberately a separate route from `/suppliers` rather than making
   * that one's lat/lng optional: the shipped app calls `/suppliers` and
   * relies on distance ranking, and widening it would change its result
   * order under a client we cannot redeploy.
   */
  @Get('directory')
  @Public()
  async directory(@Query() query: unknown): Promise<DirectoryPage> {
    const parsed = directorySchema.safeParse(query);
    if (!parsed.success) throw new ValidationError('Invalid query', { issues: parsed.error.issues });
    const { vertical, ...rest } = parsed.data;
    return this.discovery.directory({
      ...rest,
      verticalKeys: vertical ? [vertical] : undefined,
    });
  }

  /** `GET /v1/discovery/suppliers/{id}` — the public provider profile. */
  @Get('suppliers/:id')
  @Public()
  async supplier(@Param('id') id: string): Promise<DirectorySupplierDTO> {
    const found = await this.discovery.getSupplier(id);
    if (!found) throw new NotFoundError('Supplier', id);
    return found;
  }

}

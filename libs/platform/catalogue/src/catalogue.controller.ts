import { Controller, Get, Inject, NotFoundException, Param, Query } from '@nestjs/common';
import { z } from 'zod';
import { RequirePermissions } from '@justgo/auth';
import { ValidationError } from '@justgo/kernel';
import {
  CATALOGUE_PORT,
  type ArticleDetail,
  type ArticleRef,
  type AssemblyGroup,
  type CataloguePort,
  type VehicleTypeRef,
} from '@justgo/contracts';

const intParam = (name: string) =>
  z.coerce.number({ message: `${name} must be a number` }).int().positive();

const articleQuerySchema = z
  .object({
    kType: intParam('kType').optional(),
    group: intParam('group').optional(),
    oe: z.string().max(64).optional(),
    text: z.string().max(120).optional(),
    limit: z.coerce.number().int().positive().max(100).optional(),
  })
  .strict();

const vehicleQuerySchema = z
  .object({
    manufacturer: z.string().max(80).optional(),
    model: z.string().max(120).optional(),
    year: z.coerce.number().int().min(1950).max(2100).optional(),
    vin: z.string().length(17).optional(),
  })
  .strict();

/**
 * §15 Catalogue endpoints — a read-only browse surface over CataloguePort
 * (the TecDoc anti-corruption boundary). The controller never touches TecDoc
 * directly (§10, §17.4).
 */
@Controller('catalogue')
export class CatalogueController {
  constructor(@Inject(CATALOGUE_PORT) private readonly catalogue: CataloguePort) {}

  @Get('vehicles/resolve')
  @RequirePermissions()
  async resolveVehicle(@Query() query: unknown): Promise<{ items: VehicleTypeRef[] }> {
    const parsed = vehicleQuerySchema.safeParse(query ?? {});
    if (!parsed.success) {
      throw new ValidationError('Invalid vehicle query', { issues: parsed.error.issues });
    }
    return { items: await this.catalogue.resolveVehicle(parsed.data) };
  }

  @Get('assembly-groups')
  @RequirePermissions()
  async assemblyGroups(@Query('kType') kType?: string): Promise<{ items: AssemblyGroup[] }> {
    const parsed = intParam('kType').safeParse(kType);
    if (!parsed.success) {
      throw new ValidationError('kType is required and must be a positive integer');
    }
    return { items: await this.catalogue.assemblyGroups(parsed.data) };
  }

  @Get('articles')
  @RequirePermissions()
  async articles(@Query() query: unknown): Promise<{ items: ArticleRef[] }> {
    const parsed = articleQuerySchema.safeParse(query ?? {});
    if (!parsed.success) {
      throw new ValidationError('Invalid article query', { issues: parsed.error.issues });
    }
    const { group, ...rest } = parsed.data;
    return {
      items: await this.catalogue.searchArticles({ ...rest, assemblyGroupId: group }),
    };
  }

  @Get('articles/:id')
  @RequirePermissions()
  async articleDetail(@Param('id') id: string): Promise<ArticleDetail> {
    const parsed = intParam('id').safeParse(id);
    if (!parsed.success) throw new ValidationError('Invalid article id');
    const detail = await this.catalogue.articleDetail(parsed.data);
    if (!detail) throw new NotFoundException(`Article ${id} not found`);
    return detail;
  }

  @Get('cross-refs')
  @RequirePermissions()
  async crossRefs(
    @Query('oe') oe?: string,
    @Query('articleId') articleId?: string,
  ): Promise<{ items: ArticleRef[] }> {
    if (oe) return { items: await this.catalogue.crossReferences(oe) };
    const parsed = intParam('articleId').safeParse(articleId);
    if (!parsed.success) {
      throw new ValidationError('Provide either oe or a numeric articleId');
    }
    return { items: await this.catalogue.crossReferences(parsed.data) };
  }
}

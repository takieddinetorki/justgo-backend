import { Controller, Get, Inject, Query } from '@nestjs/common';
import { Public } from '@justgo/auth';
import { SERVICE_CATALOG_PORT, type ServiceCatalogPort, type ServiceTypeDTO } from '@justgo/contracts';

/** Data-driven service catalogue browse (§15 catalogue). Public read model. */
@Controller('catalogue/service-types')
export class ServiceTypesController {
  constructor(@Inject(SERVICE_CATALOG_PORT) private readonly catalog: ServiceCatalogPort) {}

  @Public()
  @Get()
  async list(@Query('vertical') vertical?: string): Promise<{ items: ServiceTypeDTO[] }> {
    return { items: await this.catalog.listServiceTypes(vertical) };
  }
}

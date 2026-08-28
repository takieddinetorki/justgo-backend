import { Pool } from 'pg';
import type { ServiceCatalogPort, ServiceTypeDTO } from '@justgo/contracts';

interface Row {
  key: string;
  vertical_key: string;
  label_i18n: Record<string, string>;
  pricing_model: string;
  requires_calendar: boolean;
  requires_vehicle: boolean;
  active: boolean;
}

const COLS = `key, vertical_key, label_i18n, pricing_model, requires_calendar, requires_vehicle, active`;

function toDTO(r: Row): ServiceTypeDTO {
  return {
    key: r.key,
    verticalKey: r.vertical_key,
    labelI18n: r.label_i18n,
    pricingModel: r.pricing_model as ServiceTypeDTO['pricingModel'],
    requiresCalendar: r.requires_calendar,
    requiresVehicle: r.requires_vehicle,
    active: r.active,
  };
}

/** Reads catalogue.service_types — the only module that touches this schema. */
export class PgServiceCatalogRepository implements ServiceCatalogPort {
  constructor(private readonly pool: Pool) {}

  async getServiceType(key: string): Promise<ServiceTypeDTO | null> {
    const res = await this.pool.query<Row>(
      `select ${COLS} from catalogue.service_types where key = $1`,
      [key],
    );
    return res.rows[0] ? toDTO(res.rows[0]) : null;
  }

  async listServiceTypes(verticalKey?: string): Promise<ServiceTypeDTO[]> {
    const res = verticalKey
      ? await this.pool.query<Row>(
          `select ${COLS} from catalogue.service_types where active and vertical_key = $1 order by key`,
          [verticalKey],
        )
      : await this.pool.query<Row>(
          `select ${COLS} from catalogue.service_types where active order by key`,
        );
    return res.rows.map(toDTO);
  }
}

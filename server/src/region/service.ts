import type { Queryable } from '../persistence/db.js';
import type { RegionData } from './data.js';
import { buildRegionGrid, type RegionGrid } from './grid.js';
import { RegionNetwork } from './network.js';

/** Региональные запросы: карта РБ, города, ресурсы, фрахт, экономические графики. */
export class RegionService {
  readonly network: RegionNetwork;
  readonly grid: RegionGrid;
  constructor(readonly data: RegionData) {
    this.network = new RegionNetwork(data);
    this.grid = buildRegionGrid(data);
  }

  /** Публичный снимок региона: города (динамические показатели из БД), сеть, хабы, месторождения, контур и реки. */
  async getRegion(q: Queryable) {
    const rows = (await q.query(
      `SELECT c.id, c.population, c.wage_rub, c.land_base_cents,
              (SELECT count(*) FROM buildings b WHERE b.city_id = c.id) AS buildings,
              (SELECT count(*) FROM parcels p WHERE p.city_id = c.id) AS owned_cells
         FROM cities c`,
    )).rows;
    const dyn = new Map(rows.map((r) => [r.id as string, r]));
    const res = (await q.query('SELECT id, remaining_units, owner_company_id FROM resource_sites')).rows;
    const resDyn = new Map(res.map((r) => [r.id as string, r]));
    const hubCity = new Set(this.data.transport.hubs.map((h) => h.city));
    return {
      id: this.data.id,
      name: this.data.name,
      approximate: true,
      bbox: this.data.geo.bbox,
      grid: this.grid,
      cities: this.data.cities.map((c) => {
        const d = dyn.get(c.id);
        return {
          id: c.id, name: c.name, lat: c.lat, lon: c.lon, cell: this.grid.cities[c.id], specialization: c.specialization, farmland_index: c.farmland_index,
          population: d ? Number(d.population) : c.population, wage_rub: d?.wage_rub ?? c.wage_rub,
          land_base_cents_per_tile: d ? Number(d.land_base_cents) : c.land_base_cents_per_tile,
          buildings: d ? Number(d.buildings) : 0, owned_cells: d ? Number(d.owned_cells) : 0, has_hub: hubCity.has(c.id),
        };
      }),
      roads: this.data.transport.roads.map(([a, b]) => ({ a, b, km: Math.round(this.network.roadKm(a, b)! * 10) / 10 })),
      rails: this.data.transport.rails.map(([a, b]) => ({ a, b, km: Math.round(this.network.railKm(a, b)! * 10) / 10 })),
      hubs: this.data.transport.hubs,
      resources: this.data.resources.map((r) => {
        const d = resDyn.get(r.id);
        return { id: r.id, resource: r.resource, name: r.name, lat: r.lat, lon: r.lon, cell: this.grid.resources[r.id], reserve: r.reserve, quality: r.quality,
          remaining: d ? Number(d.remaining_units) : r.reserve, owned: d ? d.owner_company_id != null : false };
      }),
    };
  }

  /** Экономические графики города: помесячная история показателей. */
  async cityStats(q: Queryable, cityId: string, months: number) {
    const city = (await q.query('SELECT id, name, population, wage_rub, base_population FROM cities WHERE id = $1', [cityId])).rows[0];
    if (!city) return null;
    const hist = (await q.query(
      `SELECT month_index, year, month, population, wage_rub, price_index, housing_cap, buildings, owned_cells
         FROM city_stats_history WHERE city_id = $1 ORDER BY month_index DESC LIMIT $2`,
      [cityId, months],
    )).rows.reverse().map((r) => ({
      month_index: r.month_index as number, year: r.year as number, month: r.month as number, population: r.population as number,
      wage_rub: r.wage_rub as number, price_index: r.price_index as number, housing_cap: r.housing_cap as number,
      buildings: r.buildings as number, owned_cells: r.owned_cells as number,
    }));
    return { city_id: city.id as string, name: city.name as string, population: city.population as number, wage_rub: city.wage_rub as number, history: hist };
  }

  /** Запись показателей всех городов за закрытый месяц (идемпотентна по (city_id, month_index)). */
  async recordMonthlyStats(q: Queryable, monthIndex: number, year: number, month: number): Promise<number> {
    const r = await q.query(
      `INSERT INTO city_stats_history (city_id, month_index, year, month, population, wage_rub, price_index, housing_cap, buildings, owned_cells)
       SELECT c.id, $1, $2, $3, c.population, coalesce(c.wage_rub, 0), round(c.price_factor * 100)::int, c.housing_cap,
              (SELECT count(*) FROM buildings b WHERE b.city_id = c.id)::int, (SELECT count(*) FROM parcels p WHERE p.city_id = c.id)::int
         FROM cities c
       ON CONFLICT (city_id, month_index) DO NOTHING`,
      [monthIndex, year, month],
    );
    return r.rowCount ?? 0;
  }
}

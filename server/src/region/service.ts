import type { Queryable } from '../persistence/db.js';
import type { RegionData } from './data.js';
import { RegionNetwork } from './network.js';

/** Региональные запросы: карта РБ, города, ресурсы, фрахт, экономические графики. */
export class RegionService {
  readonly network: RegionNetwork;
  constructor(readonly data: RegionData) {
    this.network = new RegionNetwork(data);
  }

  /** Публичный снимок региона: города (динамические показатели из БД), сеть, хабы, месторождения, контур и реки. */
  async getRegion(q: Queryable) {
    const rows = (await q.query(
      `SELECT c.id, c.population, c.wage_rub, c.land_base_cents,
              (SELECT count(*) FROM map_lots l WHERE l.city_id = c.id) AS lots,
              (SELECT count(*) FROM map_lots l WHERE l.city_id = c.id AND l.owner_company_id IS NOT NULL) AS owned_lots
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
      outline: this.data.geo.outline,
      rivers: this.data.geo.rivers,
      cities: this.data.cities.map((c) => {
        const d = dyn.get(c.id);
        return {
          id: c.id, name: c.name, lat: c.lat, lon: c.lon, specialization: c.specialization, farmland_index: c.farmland_index,
          population: d ? Number(d.population) : c.population, wage_rub: d?.wage_rub ?? c.wage_rub,
          land_base_cents_per_tile: d ? Number(d.land_base_cents) : c.land_base_cents_per_tile,
          lots: d ? Number(d.lots) : 0, owned_lots: d ? Number(d.owned_lots) : 0, has_hub: hubCity.has(c.id),
        };
      }),
      roads: this.data.transport.roads.map(([a, b]) => ({ a, b, km: Math.round(this.network.roadKm(a, b)! * 10) / 10 })),
      rails: this.data.transport.rails.map(([a, b]) => ({ a, b, km: Math.round(this.network.railKm(a, b)! * 10) / 10 })),
      hubs: this.data.transport.hubs,
      resources: this.data.resources.map((r) => {
        const d = resDyn.get(r.id);
        return { id: r.id, resource: r.resource, name: r.name, lat: r.lat, lon: r.lon, reserve: r.reserve, quality: r.quality,
          remaining: d ? Number(d.remaining_units) : r.reserve, owned: d ? d.owner_company_id != null : false };
      }),
    };
  }

  /** Экономические графики города: помесячная история показателей. */
  async cityStats(q: Queryable, cityId: string, months: number) {
    const city = (await q.query('SELECT id, name, population, wage_rub, base_population FROM cities WHERE id = $1', [cityId])).rows[0];
    if (!city) return null;
    const hist = (await q.query(
      `SELECT month_index, year, month, population, wage_rub, land_index, traffic_index, built_share, lots
         FROM city_stats_history WHERE city_id = $1 ORDER BY month_index DESC LIMIT $2`,
      [cityId, months],
    )).rows.reverse().map((r) => ({
      month_index: r.month_index as number, year: r.year as number, month: r.month as number, population: r.population as number,
      wage_rub: r.wage_rub as number, land_index: r.land_index as number, traffic_index: r.traffic_index as number,
      built_share: Number(r.built_share), lots: r.lots as number,
    }));
    return { city_id: city.id as string, name: city.name as string, population: city.population as number, wage_rub: city.wage_rub as number, history: hist };
  }

  /** Запись показателей всех городов за закрытый месяц (идемпотентна по (city_id, month_index)). */
  async recordMonthlyStats(q: Queryable, monthIndex: number, year: number, month: number): Promise<number> {
    const r = await q.query(
      `INSERT INTO city_stats_history (city_id, month_index, year, month, population, wage_rub, land_index, traffic_index, built_share, lots)
       SELECT c.id, $1, $2, $3, c.population, coalesce(c.wage_rub, 0),
              coalesce(round(avg(l.land_value))::int, 0), coalesce(round(avg(l.traffic))::int, 0),
              coalesce(avg((l.development > 0 OR l.owner_company_id IS NOT NULL)::int), 0), count(l.id)::int
         FROM cities c LEFT JOIN map_lots l ON l.city_id = c.id AND l.zone <> 'park'
        GROUP BY c.id
       ON CONFLICT (city_id, month_index) DO NOTHING`,
      [monthIndex, year, month],
    );
    return r.rowCount ?? 0;
  }
}

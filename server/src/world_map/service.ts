import type { CompanyService } from '../companies/index.js';
import { ENTERPRISE_ZONES, type EnterpriseKind } from '../companies/catalog.js';
import { NPC } from '../companies/npc.js';
import { DomainError } from '../errors.js';
import { writeAudit } from '../persistence/audit.js';
import { withTransaction, type Db, type Queryable } from '../persistence/db.js';
import type { RegionData } from '../region/data.js';
import { generateInitialCity, lotOverlays, stateTiles, tilesToGrid, type CityState, type Lot, type Zone } from './generator.js';
import { calibrateCapacity, housingCap, stepCity, type CityStats, type CityStep, type GrowthSignals } from './growth.js';

export const MAIN_CITY = 'ufa';

const lotRow = (r: Record<string, unknown>): Lot => ({
  id: r.id as string, x: r.x as number, y: r.y as number, w: r.w as number, h: r.h as number,
  zone: r.zone as Zone, base_price_cents: Number(r.base_price_cents), price_cents: Number(r.price_cents),
  development: r.development as number, land_value: r.land_value as number, traffic: r.traffic as number,
  owned: r.owner_company_id != null,
});

export class MapService {
  constructor(private readonly companies: CompanyService) {}

  /**
   * Создаёт города региона по данным (план + участки) и обновляет метаданные, ресурсы и хабы. Идемпотентно:
   * существующий город и его участки не пересоздаются; для городов старого формата заполняются недостающие поля.
   */
  async bootstrap(db: Db, region: RegionData): Promise<void> {
    for (const c of region.cities) {
      await withTransaction(db, async (tx) => {
        const exists = (await tx.query('SELECT lat FROM cities WHERE id = $1 FOR UPDATE', [c.id])).rows[0];
        if (!exists) {
          const st = generateInitialCity(c.id, c.plan.seed, c.plan.target_lots, {
            width: c.plan.width, height: c.plan.height,
            params: { landBaseCents: c.land_base_cents_per_tile, river: c.plan.river },
          });
          st.params.capacityPerTile = calibrateCapacity(st.lots, c.population);
          await tx.query(
            `INSERT INTO cities (id, name, seed, width, height, tiles, center_x, center_y, population, housing_cap, jobs, next_lot_seq,
                                 lat, lon, wage_rub, land_base_cents, farmland_index, specialization, capacity_per_tile, base_population, has_river)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,0,$11,$12,$13,$14,$15,$16,$17,$18,$9,$19)`,
            [c.id, c.name, c.plan.seed, st.width, st.height, JSON.stringify(stateTiles(st)), st.center.x, st.center.y, c.population,
              Math.round(housingCap(st.lots, st.params.capacityPerTile)), st.nextLotSeq, c.lat, c.lon, c.wage_rub,
              c.land_base_cents_per_tile, c.farmland_index, JSON.stringify(c.specialization), st.params.capacityPerTile, c.plan.river],
          );
          for (const l of st.lots) await this.insertLot(tx, c.id, l);
        } else if (exists.lat === null) {
          await this.upgradeLegacyCity(tx, c);
        }
      });
    }
    await withTransaction(db, async (tx) => {
      for (const h of region.transport.hubs) {
        await tx.query(
          `INSERT INTO hubs (id, city_id, name, kind, gateway, gateway_km) VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (id) DO UPDATE SET city_id = $2, name = $3, kind = $4, gateway = $5, gateway_km = $6`,
          [h.id, h.city, h.name, h.kind, h.gateway, h.gateway_km],
        );
      }
      for (const r of region.resources) {
        const nearest = [...region.cities].sort((a, b) => Math.hypot(a.lat - r.lat, (a.lon - r.lon) * 0.6) - Math.hypot(b.lat - r.lat, (b.lon - r.lon) * 0.6))[0]!;
        await tx.query(
          `INSERT INTO resource_sites (id, resource, name, lat, lon, city_id, reserve_units, remaining_units, quality)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8)
           ON CONFLICT (id) DO UPDATE SET resource = $2, name = $3, lat = $4, lon = $5, city_id = $6, quality = $8`,
          [r.id, r.resource, r.name, r.lat, r.lon, nearest.id, r.reserve, r.quality],
        );
      }
    });
  }

  /** Город, созданный до этапа 2 (только план и участки): заполняем метаданные региона и оверлеи участков. */
  private async upgradeLegacyCity(tx: Queryable, c: RegionData['cities'][number]) {
    const loaded = await this.loadState(tx, c.id, true);
    if (!loaded) return;
    const { st } = loaded;
    st.params.landBaseCents = c.land_base_cents_per_tile;
    const cpt = calibrateCapacity(st.lots, c.population);
    for (const l of st.lots) {
      const ov = lotOverlays(st, l.x, l.y, l.w, l.h, l.zone);
      await tx.query('UPDATE map_lots SET land_value = $2, traffic = $3 WHERE id = $1', [l.id, ov.land_value, ov.traffic]);
    }
    await tx.query(
      `UPDATE cities SET lat = $2, lon = $3, wage_rub = $4, land_base_cents = $5, farmland_index = $6, specialization = $7,
              capacity_per_tile = $8, base_population = $9, population = $9, housing_cap = $10, has_river = $11 WHERE id = $1`,
      [c.id, c.lat, c.lon, c.wage_rub, c.land_base_cents_per_tile, c.farmland_index, JSON.stringify(c.specialization), cpt, c.population,
        Math.round(housingCap(st.lots, cpt)), c.plan.river],
    );
  }

  private insertLot(tx: Queryable, cityId: string, l: Lot) {
    return tx.query(
      `INSERT INTO map_lots (id, city_id, x, y, w, h, zone, price_cents, base_price_cents, development, land_value, traffic)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [l.id, cityId, l.x, l.y, l.w, l.h, l.zone, l.price_cents, l.base_price_cents, l.development, l.land_value, l.traffic],
    );
  }

  async loadState(q: Queryable, cityId: string, lock = false): Promise<{ st: CityState; stats: CityStats; baseline: number } | null> {
    const c = (await q.query(`SELECT * FROM cities WHERE id = $1 ${lock ? 'FOR UPDATE' : ''}`, [cityId])).rows[0];
    if (!c) return null;
    const lots = (await q.query('SELECT * FROM map_lots WHERE city_id = $1 ORDER BY x, y', [cityId])).rows.map(lotRow);
    const st: CityState = {
      params: { landBaseCents: Number(c.land_base_cents ?? 2_000_000), capacityPerTile: Number(c.capacity_per_tile), river: c.has_river as boolean },
      cityId, seed: c.seed, width: c.width, height: c.height, center: { x: c.center_x, y: c.center_y },
      tiles: tilesToGrid(c.tiles as string[]), lots, nextLotSeq: c.next_lot_seq,
    };
    return { st, stats: { population: c.population, housing_cap: c.housing_cap, jobs: c.jobs }, baseline: c.base_population };
  }

  async cityIds(q: Queryable): Promise<string[]> {
    return (await q.query<{ id: string }>('SELECT id FROM cities ORDER BY id')).rows.map((r) => r.id);
  }

  async getCity(q: Queryable, cityId: string) {
    const c = (await q.query(
      `SELECT id, name, width, height, tiles, center_x, center_y, population, housing_cap, jobs, growth_day,
              lat, lon, wage_rub, land_base_cents, farmland_index, specialization FROM cities WHERE id = $1`, [cityId])).rows[0];
    if (!c) throw new DomainError('not_found');
    const lots = (
      await q.query(
        `SELECT l.id, l.x, l.y, l.w, l.h, l.zone, l.price_cents, l.development, l.land_value, l.traffic, l.owner_company_id, co.name AS owner_name,
                e.id AS b_id, e.kind AS b_kind, e.name AS b_name
           FROM map_lots l LEFT JOIN companies co ON co.id = l.owner_company_id
           LEFT JOIN enterprises e ON e.lot_id = l.id
          WHERE l.city_id = $1 ORDER BY l.x, l.y`,
        [cityId],
      )
    ).rows.map((r) => {
      const owner = (r.owner_company_id as string | null) ?? null;
      return {
        id: r.id as string, x: r.x as number, y: r.y as number, w: r.w as number, h: r.h as number,
        zone: r.zone as string, development: r.development as number, land_value: r.land_value as number, traffic: r.traffic as number,
        for_sale: owner === null && r.development === 0 && r.zone !== 'park',
        price_cents: Number(r.price_cents),
        owner_company_id: owner, owner_name: (r.owner_name as string | null) ?? null,
        building: r.b_id ? { enterprise_id: r.b_id as string, kind: r.b_kind as string, name: r.b_name as string } : null,
      };
    });
    return {
      id: c.id as string, name: c.name as string, width: c.width as number, height: c.height as number,
      center: { x: c.center_x as number, y: c.center_y as number }, tiles: c.tiles as string[], lots,
      population: c.population as number, housing_cap: c.housing_cap as number, jobs: c.jobs as number, growth_day: c.growth_day as number,
      wage_rub: c.wage_rub as number | null, land_base_cents: Number(c.land_base_cents ?? 0), farmland_index: c.farmland_index as number | null,
      specialization: (c.specialization as string[]) ?? [],
    };
  }

  // ------------------------------------------------------------------ рост городов

  /** Недельный шаг одного города (прототип до этапа 13): население, застройка, новые улицы и участки, цены на землю. */
  async step(tx: Queryable, cityId: string, day: number, signals: GrowthSignals): Promise<CityStep> {
    const loaded = await this.loadState(tx, cityId, true);
    if (!loaded) throw new DomainError('not_found');
    const { st, stats, baseline } = loaded;
    const step = stepCity(st, stats, signals, day, baseline);
    for (const d of step.developed) await tx.query('UPDATE map_lots SET development = $2 WHERE id = $1', [d.lot_id, d.development]);
    for (const l of step.new_lots) await this.insertLot(tx, cityId, l);
    await tx.query(
      `UPDATE cities SET tiles = $2, population = $3, housing_cap = $4, jobs = $5, next_lot_seq = $6, growth_day = $7 WHERE id = $1`,
      [cityId, JSON.stringify(stateTiles(st)), step.stats.population, step.stats.housing_cap, step.stats.jobs, st.nextLotSeq, day],
    );
    await tx.query(
      `UPDATE map_lots SET price_cents = GREATEST(1, round(base_price_cents * $2::numeric)::bigint)
        WHERE city_id = $1 AND owner_company_id IS NULL AND development = 0 AND zone <> 'park'`,
      [cityId, step.price_factor],
    );
    await writeAudit(tx, {
      eventType: 'city_growth',
      details: { city: cityId, day, points: step.construction_points, developed: step.developed.length, new_lots: step.new_lots.length, new_road_tiles: step.new_road_tiles, population: step.stats.population },
    });
    return step;
  }

  // ------------------------------------------------------------------ участки и здания

  /** Покупка участка: деньги → казна, владелец — компания. Гонка за один участок: выигрывает ровно один. */
  async buyLot(tx: Queryable, playerId: string, companyId: string, lotId: string) {
    const company = await this.companies.getOwned(tx, playerId, companyId, true);
    this.companies.assertActive(company);
    const lot = (await tx.query('SELECT id, zone, price_cents, development, owner_company_id FROM map_lots WHERE id = $1 FOR UPDATE', [lotId])).rows[0];
    if (!lot) throw new DomainError('not_found');
    if (lot.zone === 'park' || lot.development > 0) throw new DomainError('lot_not_for_sale');
    if (lot.owner_company_id) throw new DomainError('lot_taken');
    const price = Number(lot.price_cents);
    const balance = await this.companies.debit(tx, companyId, price, 'land_purchase', playerId, { lot_id: lotId });
    await this.companies.credit(tx, NPC.treasury.id, price, 'land_purchase', null, { company_id: companyId, lot_id: lotId });
    await tx.query('UPDATE map_lots SET owner_company_id = $2, bought_at = now() WHERE id = $1', [lotId, companyId]);
    return { lot_id: lotId, price_cents: price, balance_cents: balance };
  }

  /** Постройка предприятия на своём участке: зонирование, один объект на участок, стоимость списывается. */
  async construct(tx: Queryable, playerId: string, companyId: string, lotId: string, kind: EnterpriseKind, name: string) {
    const company = await this.companies.getOwned(tx, playerId, companyId, true);
    this.companies.assertActive(company);
    const lot = (await tx.query('SELECT id, zone, owner_company_id FROM map_lots WHERE id = $1 FOR UPDATE', [lotId])).rows[0];
    if (!lot) throw new DomainError('not_found');
    if (lot.owner_company_id !== companyId) throw new DomainError('lot_not_owned');
    if (!ENTERPRISE_ZONES[kind].includes(lot.zone as string)) throw new DomainError('zoning_violation');
    const taken = await tx.query('SELECT 1 FROM enterprises WHERE lot_id = $1', [lotId]);
    if (taken.rowCount) throw new DomainError('lot_occupied');
    const enterprise = await this.companies.createEnterprise(tx, playerId, companyId, kind, name, lotId);
    return { enterprise, lot_id: lotId, zone: lot.zone as string };
  }
}

export type { Db };

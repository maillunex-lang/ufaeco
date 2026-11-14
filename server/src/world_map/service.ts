import type { CompanyService } from '../companies/index.js';
import { ENTERPRISE_FOOTPRINT, ENTERPRISE_ZONES, type EnterpriseKind } from '../companies/catalog.js';
import { NPC } from '../companies/npc.js';
import { DomainError } from '../errors.js';
import { writeAudit } from '../persistence/audit.js';
import { withTransaction, type Db, type Queryable } from '../persistence/db.js';
import type { RegionData } from '../region/data.js';
import {
  assignInitialFloors, cellOverlays, cellPrice, generateInitialCity, housingCapacity, mulberry32, Occupancy, populateCity, roadDistance,
  stateTiles, tilesToGrid, zoneOfCell, type Building, type CityState, type Zone,
} from './generator.js';
import { calibrateCapacity, stepCity, type CityStats, type CityStep, type GrowthSignals } from './growth.js';

export const MAIN_CITY = 'ufa';
export const MAX_PURCHASE_CELLS = 400;
const URBAN_REACH = 4;

const zoneChar: Record<Zone, string> = { residential: 'r', commercial: 'c', industrial: 'i', park: 'p' };
const hex2 = (n: number) => n.toString(16).padStart(2, '0');

interface Rect { x: number; y: number; w: number; h: number }

export class MapService {
  constructor(private readonly companies: CompanyService) {}

  // ------------------------------------------------------------------ создание городов

  /**
   * Создаёт города региона по данным и обновляет хабы и месторождения. Идемпотентно: существующий город не пересоздаётся;
   * город старого формата (grid_version 1) получает городскую застройку на клетках.
   */
  async bootstrap(db: Db, region: RegionData): Promise<void> {
    for (const c of region.cities) {
      await withTransaction(db, async (tx) => {
        const row = (await tx.query('SELECT grid_version FROM cities WHERE id = $1 FOR UPDATE', [c.id])).rows[0];
        if (row && row.grid_version >= 2) return;
        if (!row) {
          const st = generateInitialCity(c.id, c.plan.seed, c.plan.target_buildings, {
            width: c.plan.width, height: c.plan.height, params: { landBaseCents: c.land_base_cents_per_tile, river: c.plan.river },
          });
          st.params.capacityScale = calibrateCapacity(st, c.population);
          await tx.query(
            `INSERT INTO cities (id, name, seed, width, height, tiles, center_x, center_y, population, housing_cap, jobs,
                                 lat, lon, wage_rub, land_base_cents, farmland_index, specialization, capacity_per_tile, base_population, has_river, grid_version)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,0,$11,$12,$13,$14,$15,$16,$17,$9,$18,2)`,
            [c.id, c.name, c.plan.seed, st.width, st.height, JSON.stringify(stateTiles(st)), st.center.x, st.center.y, c.population,
              Math.round(housingCapacity(st)), c.lat, c.lon, c.wage_rub, c.land_base_cents_per_tile, c.farmland_index,
              JSON.stringify(c.specialization), st.params.capacityScale, c.plan.river],
          );
          await this.insertBuildings(tx, c.id, st.buildings);
        } else {
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

  /** Город до этапа 2.5: есть дороги, парцеллы и здания игроков, но нет городской застройки — достраиваем на клетках. */
  private async upgradeLegacyCity(tx: Queryable, c: RegionData['cities'][number]) {
    const loaded = await this.loadState(tx, c.id, true);
    if (!loaded) return;
    const { st } = loaded;
    st.params.landBaseCents = c.land_base_cents_per_tile;
    const rng = mulberry32(c.plan.seed ^ 0x1234567);
    const before = st.buildings.length;
    populateCity(st, rng, new Occupancy(st), before + c.plan.target_buildings);
    const fresh = st.buildings.slice(before);
    const tmp = { ...st, buildings: fresh };
    assignInitialFloors(tmp, c.plan.seed);
    st.params.capacityScale = calibrateCapacity(st, c.population);
    await this.insertBuildings(tx, c.id, fresh);
    await tx.query(
      `UPDATE cities SET tiles = $2, capacity_per_tile = $3, population = $4, base_population = $4, housing_cap = $5,
              lat = $6, lon = $7, wage_rub = $8, land_base_cents = $9, farmland_index = $10, specialization = $11, has_river = $12, grid_version = 2
        WHERE id = $1`,
      [c.id, JSON.stringify(stateTiles(st)), st.params.capacityScale, c.population, Math.round(housingCapacity(st)),
        c.lat, c.lon, c.wage_rub, c.land_base_cents_per_tile, c.farmland_index, JSON.stringify(c.specialization), c.plan.river],
    );
  }

  /** Пакетная вставка зданий и их клеток; возвращает id в порядке входа. */
  private async insertBuildings(tx: Queryable, cityId: string, list: Building[]): Promise<string[]> {
    if (list.length === 0) return [];
    const r = await tx.query<{ id: string; ord: number }>(
      `INSERT INTO buildings (city_id, x, y, w, h, kind, floors, owner_company_id, name)
       SELECT $1, t.x, t.y, t.w, t.h, t.kind, t.floors, t.owner, t.name
         FROM unnest($2::int[], $3::int[], $4::int[], $5::int[], $6::text[], $7::int[], $8::uuid[], $9::text[]) WITH ORDINALITY
              AS t(x, y, w, h, kind, floors, owner, name, ord)
       ORDER BY t.ord RETURNING id`,
      [cityId, list.map((b) => b.x), list.map((b) => b.y), list.map((b) => b.w), list.map((b) => b.h), list.map((b) => b.kind),
        list.map((b) => b.floors), list.map((b) => b.owner), list.map((b) => b.name ?? null)],
    );
    const ids = r.rows.map((x) => x.id);
    const cx: number[] = [], cy: number[] = [], cb: string[] = [];
    list.forEach((b, i) => {
      for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) { cx.push(x); cy.push(y); cb.push(ids[i]!); }
    });
    await tx.query('INSERT INTO building_cells (city_id, x, y, building_id) SELECT $1, * FROM unnest($2::int[], $3::int[], $4::uuid[])', [cityId, cx, cy, cb]);
    ids.forEach((id, i) => { list[i]!.id = id; });
    return ids;
  }

  // ------------------------------------------------------------------ загрузка

  async loadState(q: Queryable, cityId: string, lock = false, withBuildings = true): Promise<{ st: CityState; stats: CityStats; baseline: number; priceFactor: number } | null> {
    const c = (await q.query(`SELECT * FROM cities WHERE id = $1 ${lock ? 'FOR UPDATE' : ''}`, [cityId])).rows[0];
    if (!c) return null;
    const st: CityState = {
      params: { landBaseCents: Number(c.land_base_cents ?? 2_000_000), capacityScale: Number(c.capacity_per_tile), river: c.has_river as boolean },
      cityId, seed: c.seed, width: c.width, height: c.height, center: { x: c.center_x, y: c.center_y },
      tiles: tilesToGrid(c.tiles as string[]), buildings: [], parcels: new Set(), nextTempId: 1,
    };
    if (withBuildings) {
      st.buildings = (await q.query('SELECT id, x, y, w, h, kind, floors, owner_company_id AS owner, name FROM buildings WHERE city_id = $1 ORDER BY created_at, id', [cityId]))
        .rows.map((r) => ({ id: r.id, x: r.x, y: r.y, w: r.w, h: r.h, kind: r.kind, floors: r.floors, owner: r.owner ?? null, name: r.name ?? undefined }));
      for (const r of (await q.query('SELECT x, y FROM parcels WHERE city_id = $1', [cityId])).rows) st.parcels.add(`${r.x},${r.y}`);
    }
    return { st, stats: { population: c.population, housing_cap: c.housing_cap, jobs: c.jobs }, baseline: c.base_population, priceFactor: Number(c.price_factor) };
  }

  async cityIds(q: Queryable): Promise<string[]> {
    return (await q.query<{ id: string }>('SELECT id FROM cities ORDER BY id')).rows.map((r) => r.id);
  }

  // ------------------------------------------------------------------ карта города для клиента

  /** Состояние города для клиента: сетки клеток (зона, стоимость земли, трафик, доступность), здания и владение. */
  async getCity(q: Queryable, cityId: string) {
    const loaded = await this.loadState(q, cityId, false, false);
    if (!loaded) throw new DomainError('not_found');
    const { st, priceFactor } = loaded;
    const c = (await q.query(
      `SELECT id, name, population, housing_cap, jobs, growth_day, lat, lon, wage_rub, land_base_cents, farmland_index, specialization FROM cities WHERE id = $1`, [cityId])).rows[0];
    const dist = roadDistance(st, URBAN_REACH);
    const zones: string[] = [], buyable: string[] = [], land: string[] = [], traffic: string[] = [];
    for (let y = 0; y < st.height; y++) {
      let z = '', b = '', l = '', t = '';
      for (let x = 0; x < st.width; x++) {
        if (st.tiles[y]![x] !== '.') { z += '-'; b += '0'; l += '00'; t += '00'; continue; }
        const zone = zoneOfCell(st, x, y);
        const ov = cellOverlays(st, x, y, zone);
        z += zoneChar[zone];
        b += zone !== 'park' && dist[y * st.width + x]! <= URBAN_REACH ? '1' : '0';
        l += hex2(ov.land_value);
        t += hex2(ov.traffic);
      }
      zones.push(z); buyable.push(b); land.push(l); traffic.push(t);
    }
    const buildings = (await q.query(
      `SELECT b.id, b.x, b.y, b.w, b.h, b.kind, b.floors, b.rotated, b.name, b.owner_company_id, co.name AS owner_name, e.id AS enterprise_id
         FROM buildings b LEFT JOIN companies co ON co.id = b.owner_company_id LEFT JOIN enterprises e ON e.building_id = b.id
        WHERE b.city_id = $1 ORDER BY b.y, b.x`, [cityId])).rows.map((r) => ({
      id: r.id as string, x: r.x as number, y: r.y as number, w: r.w as number, h: r.h as number, kind: r.kind as string,
      floors: r.floors as number, rotated: r.rotated as boolean, name: (r.name as string | null) ?? null,
      owner_company_id: (r.owner_company_id as string | null) ?? null, owner_name: (r.owner_name as string | null) ?? null,
      enterprise_id: (r.enterprise_id as string | null) ?? null, city_owned: r.owner_company_id === null,
    }));
    // Владение клетками — отрезками по строкам: [y, x0, длина, индекс владельца]
    const owners: { id: string; name: string }[] = [];
    const ownerIdx = new Map<string, number>();
    const runs: [number, number, number, number][] = [];
    const rows = (await q.query('SELECT p.y, p.x, p.owner_company_id, co.name FROM parcels p JOIN companies co ON co.id = p.owner_company_id WHERE p.city_id = $1 ORDER BY p.y, p.x', [cityId])).rows;
    for (const r of rows) {
      if (!ownerIdx.has(r.owner_company_id)) { ownerIdx.set(r.owner_company_id, owners.length); owners.push({ id: r.owner_company_id, name: r.name }); }
      const oi = ownerIdx.get(r.owner_company_id)!;
      const last = runs.at(-1);
      if (last && last[0] === r.y && last[3] === oi && last[1] + last[2] === r.x) last[2] += 1;
      else runs.push([r.y, r.x, 1, oi]);
    }
    return {
      id: c.id as string, name: c.name as string, width: st.width, height: st.height, center: st.center, tiles: stateTiles(st),
      cells: { zones, buyable, land_value: land, traffic },
      land_base_cents: Number(c.land_base_cents ?? 0), price_factor: priceFactor,
      buildings, parcels: { owners, runs },
      population: c.population as number, housing_cap: c.housing_cap as number, jobs: c.jobs as number, growth_day: c.growth_day as number,
      wage_rub: c.wage_rub as number | null, farmland_index: c.farmland_index as number | null, specialization: (c.specialization as string[]) ?? [],
    };
  }

  // ------------------------------------------------------------------ рост городов

  /** Шаг одного города (прототип до этапа 13): население, застройка, этажность, новые улицы, цены на землю. */
  async step(tx: Queryable, cityId: string, tick: number, signals: GrowthSignals): Promise<CityStep> {
    const loaded = await this.loadState(tx, cityId, true);
    if (!loaded) throw new DomainError('not_found');
    const { st, stats, baseline } = loaded;
    const step = stepCity(st, stats, signals, tick, baseline);
    if (step.added.length) await this.insertBuildings(tx, cityId, step.added);
    if (step.floors.length) {
      await tx.query('UPDATE buildings b SET floors = t.f FROM unnest($1::uuid[], $2::int[]) AS t(id, f) WHERE b.id = t.id', [step.floors.map((x) => x.id), step.floors.map((x) => x.floors)]);
    }
    await tx.query(
      `UPDATE cities SET tiles = $2, population = $3, housing_cap = $4, jobs = $5, growth_day = $6, price_factor = $7 WHERE id = $1`,
      [cityId, JSON.stringify(stateTiles(st)), step.stats.population, step.stats.housing_cap, step.stats.jobs, tick, step.price_factor],
    );
    await writeAudit(tx, {
      eventType: 'city_growth',
      details: { city: cityId, tick, points: step.construction_points, added: step.added.length, floors: step.floors.length, new_road_tiles: step.new_road_tiles, population: step.stats.population },
    });
    return step;
  }

  // ------------------------------------------------------------------ земля: покупка клеток

  private rect(a: Rect, maxArea = 10_000): Rect {
    if (![a.x, a.y, a.w, a.h].every(Number.isInteger) || a.w < 1 || a.h < 1 || a.w * a.h > maxArea) throw new DomainError('invalid_payload');
    return a;
  }

  /**
   * Покупка прямоугольника клеток: все клетки должны быть землёй в городской зоне (не дорога, вода, парк), без зданий и без владельца.
   * Деньги — в казну через журнал. Гонка: клетка достаётся одному (PK parcels), остальные откатываются.
   */
  async buyCells(tx: Queryable, playerId: string, companyId: string, cityId: string, r: Rect) {
    this.rect(r, MAX_PURCHASE_CELLS);
    const company = await this.companies.getOwned(tx, playerId, companyId, true);
    this.companies.assertActive(company);
    const loaded = await this.loadState(tx, cityId, false, false);
    if (!loaded) throw new DomainError('not_found');
    const { st, priceFactor } = loaded;
    if (r.x < 0 || r.y < 0 || r.x + r.w > st.width || r.y + r.h > st.height) throw new DomainError('out_of_bounds');
    const dist = roadDistance(st, URBAN_REACH);
    let total = 0;
    const xs: number[] = [], ys: number[] = [], prices: number[] = [];
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) {
      const zone = zoneOfCell(st, x, y);
      if (st.tiles[y]![x] !== '.' || zone === 'park' || dist[y * st.width + x]! > URBAN_REACH) throw new DomainError('cell_not_for_sale');
      const price = cellPrice(st.params.landBaseCents, cellOverlays(st, x, y, zone).land_value, zone, priceFactor);
      total += price; xs.push(x); ys.push(y); prices.push(price);
    }
    const occupied = await tx.query('SELECT 1 FROM building_cells WHERE city_id = $1 AND x BETWEEN $2 AND $3 AND y BETWEEN $4 AND $5 LIMIT 1', [cityId, r.x, r.x + r.w - 1, r.y, r.y + r.h - 1]);
    if (occupied.rowCount) throw new DomainError('cell_occupied');
    const ins = await tx.query(
      `INSERT INTO parcels (city_id, x, y, owner_company_id, price_paid_cents)
       SELECT $1, t.x, t.y, $2, t.p FROM unnest($3::int[], $4::int[], $5::bigint[]) AS t(x, y, p)
       ON CONFLICT (city_id, x, y) DO NOTHING RETURNING x`,
      [cityId, companyId, xs, ys, prices],
    );
    if ((ins.rowCount ?? 0) !== xs.length) throw new DomainError('cell_taken'); // откатывается вся транзакция
    const balance = await this.companies.debit(tx, companyId, total, 'land_purchase', playerId, { city_id: cityId, ...r, cells: xs.length });
    await this.companies.credit(tx, NPC.treasury.id, total, 'land_purchase', null, { company_id: companyId, city_id: cityId, ...r });
    return { city_id: cityId, ...r, cells: xs.length, price_cents: total, balance_cents: balance };
  }

  // ------------------------------------------------------------------ здания игроков

  /** Постройка здания с габаритами из каталога (с поворотом) на своих свободных клетках нужной зоны. Стоимость списывается. */
  async placeBuilding(tx: Queryable, playerId: string, companyId: string, cityId: string, x: number, y: number, kind: EnterpriseKind, rotated: boolean, name: string) {
    const fp = ENTERPRISE_FOOTPRINT[kind];
    const w = rotated ? fp.h : fp.w, h = rotated ? fp.w : fp.h;
    const company = await this.companies.getOwned(tx, playerId, companyId, true);
    this.companies.assertActive(company);
    const loaded = await this.loadState(tx, cityId, false, false);
    if (!loaded) throw new DomainError('not_found');
    const { st } = loaded;
    if (x < 0 || y < 0 || x + w > st.width || y + h > st.height) throw new DomainError('out_of_bounds');
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) {
      if (!ENTERPRISE_ZONES[kind].includes(zoneOfCell(st, xx, yy))) throw new DomainError('zoning_violation');
    }
    const owned = await tx.query<{ n: string }>('SELECT count(*) n FROM parcels WHERE city_id = $1 AND owner_company_id = $2 AND x BETWEEN $3 AND $4 AND y BETWEEN $5 AND $6', [cityId, companyId, x, x + w - 1, y, y + h - 1]);
    if (Number(owned.rows[0]!.n) !== w * h) throw new DomainError('cells_not_owned');
    const occupied = await tx.query('SELECT 1 FROM building_cells WHERE city_id = $1 AND x BETWEEN $2 AND $3 AND y BETWEEN $4 AND $5 LIMIT 1', [cityId, x, x + w - 1, y, y + h - 1]);
    if (occupied.rowCount) throw new DomainError('cell_occupied');
    const b = (await tx.query<{ id: string }>(
      'INSERT INTO buildings (city_id, x, y, w, h, kind, rotated, owner_company_id, name) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id',
      [cityId, x, y, w, h, kind, rotated, companyId, name])).rows[0]!;
    const cx: number[] = [], cy: number[] = [];
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) { cx.push(xx); cy.push(yy); }
    try {
      await tx.query('INSERT INTO building_cells (city_id, x, y, building_id) SELECT $1, t.x, t.y, $2 FROM unnest($3::int[], $4::int[]) AS t(x, y)', [cityId, b.id, cx, cy]);
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new DomainError('cell_occupied');
      throw e;
    }
    const enterprise = await this.companies.createEnterprise(tx, playerId, companyId, kind, name, b.id);
    return { enterprise, building: { id: b.id, city_id: cityId, x, y, w, h, kind, rotated } };
  }

  /** Снос своего здания: без возврата денег; клетки остаются в собственности. */
  async demolish(tx: Queryable, playerId: string, buildingId: string) {
    const b = (await tx.query('SELECT b.id, b.city_id, b.owner_company_id, c.owner_player_id FROM buildings b LEFT JOIN companies c ON c.id = b.owner_company_id WHERE b.id = $1 FOR UPDATE OF b', [buildingId])).rows[0];
    if (!b) throw new DomainError('not_found');
    if (b.owner_company_id === null || b.owner_player_id !== playerId) throw new DomainError('forbidden');
    await tx.query('DELETE FROM enterprises WHERE building_id = $1', [buildingId]);
    await tx.query('DELETE FROM buildings WHERE id = $1', [buildingId]); // клетки удаляются каскадом
    return { building_id: buildingId };
  }
}

export type { Db };

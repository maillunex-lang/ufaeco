import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccountService } from '../src/accounts/index.js';
import { CompanyService } from '../src/companies/index.js';
import { ENTERPRISE_FOOTPRINT, ENTERPRISE_KINDS, ENTERPRISE_ZONES, type EnterpriseKind } from '../src/companies/catalog.js';
import { ensureNpcCompanies, NPC } from '../src/companies/npc.js';
import { createPool, withTransaction, type Db } from '../src/persistence/db.js';
import { runMigrations } from '../src/persistence/migrate.js';
import { loadRegionData } from '../src/region/data.js';
import { cellOverlays, cellPrice, zoneOfCell } from '../src/world_map/generator.js';
import { MapService } from '../src/world_map/service.js';
import { buildOnFreshLand, findFreeRect, startServer, TEST_DB_URL, TestClient } from './helpers.js';

const region = loadRegionData();
let db: Db;
const companies = new CompanyService();
const map = new MapService(companies);
const accounts = new AccountService();

beforeAll(async () => {
  db = createPool(TEST_DB_URL);
  await runMigrations(db);
  await ensureNpcCompanies(db);
  await map.bootstrap(db, region);
  // Тестовая БД одноразовая: освобождаем землю и сносим здания игроков, чтобы повторные прогоны не исчерпали карту.
  await db.query('DELETE FROM enterprises WHERE building_id IS NOT NULL');
  await db.query('DELETE FROM buildings WHERE owner_company_id IS NOT NULL');
  await db.query('DELETE FROM parcels');
});
afterAll(async () => { await db.end(); });

const tx = <T>(fn: Parameters<typeof withTransaction<T>>[1]) => withTransaction(db, fn);
const newCo = (rich = true) =>
  tx(async (t) => {
    const p = await accounts.createGuestPlayer(t);
    const c = await companies.create(t, p.id, 'Земля ' + randomUUID().slice(0, 10));
    if (rich) await companies.credit(t, c.id, 50_000_000_000, 'test_grant', null, {});
    return { playerId: p.id, companyId: c.id };
  });
const bal = async (id: string) => Number((await db.query('SELECT balance_cents b FROM companies WHERE id = $1', [id])).rows[0].b);
const cellsOwned = async (id: string) => Number((await db.query('SELECT count(*) n FROM parcels WHERE owner_company_id = $1', [id])).rows[0].n);

describe('города и сетка в БД', () => {
  it('bootstrap идемпотентен: города, здания и клетки не дублируются', async () => {
    const snap = async () => ({
      cities: Number((await db.query('SELECT count(*) n FROM cities')).rows[0].n),
      buildings: Number((await db.query('SELECT count(*) n FROM buildings')).rows[0].n),
      cells: Number((await db.query('SELECT count(*) n FROM building_cells')).rows[0].n),
    });
    const before = await snap();
    await map.bootstrap(db, region);
    await map.bootstrap(db, region);
    expect(await snap()).toEqual(before);
    expect(before.cities).toBe(region.cities.length);
    expect((await db.query('SELECT count(*) n FROM cities WHERE grid_version < 2')).rows[0].n).toBe('0');
  });

  it('инвариант БД: клетки зданий совпадают с их габаритами, пересечений нет (PK), здание на земле', async () => {
    const bad = await db.query(`SELECT b.id FROM buildings b
       WHERE (SELECT count(*) FROM building_cells c WHERE c.building_id = b.id) <> b.w * b.h`);
    expect(bad.rowCount).toBe(0);
    const b = (await db.query('SELECT id, city_id FROM buildings LIMIT 1')).rows[0];
    await expect(db.query('INSERT INTO building_cells (city_id, x, y, building_id) SELECT city_id, x, y, building_id FROM building_cells WHERE building_id = $1 LIMIT 1', [b.id])).rejects.toThrow(/building_cells_pkey|duplicate key/);
  });

  it('getCity: размеры сеток, здания и парцеллы в границах, цена считается из оверлеев', async () => {
    const city = await tx((t) => map.getCity(t, 'sterlitamak'));
    expect(city.tiles).toHaveLength(city.height);
    for (const g of [city.cells.zones, city.cells.buyable]) { expect(g).toHaveLength(city.height); for (const r of g) expect(r).toHaveLength(city.width); }
    for (const g of [city.cells.land_value, city.cells.traffic]) { expect(g).toHaveLength(city.height); for (const r of g) expect(r).toHaveLength(city.width * 2); }
    for (const b of city.buildings) { expect(b.x + b.w).toBeLessThanOrEqual(city.width); expect(b.y + b.h).toBeLessThanOrEqual(city.height); }
    expect(city.buildings.some((b) => b.w * b.h > 1)).toBe(true);
    // покупаемые клетки — только земля, не парк, у дорог
    for (let y = 0; y < city.height; y++) for (let x = 0; x < city.width; x++) {
      if (city.cells.buyable[y]![x] === '1') { expect(city.tiles[y]![x]).toBe('.'); expect(city.cells.zones[y]![x]).not.toBe('p'); }
    }
    expect(city).toMatchObject({ wage_rub: 58000 });
    expect(city.land_base_cents).toBeGreaterThan(0);
  });
});

describe('покупка земли клетками', () => {
  it('успех: клетки в собственность, цена = сумма цен клеток, деньги в казну через журнал, видно в getCity', async () => {
    const co = await newCo();
    const spot = (await findFreeRect(db, 'ufa', 3, 2))!;
    const treasury = await bal(NPC.treasury.id);
    const before = await bal(co.companyId);
    const r = await tx((t) => map.buyCells(t, co.playerId, co.companyId, 'ufa', { ...spot, w: 3, h: 2 }));
    expect(r.cells).toBe(6);
    // независимый расчёт цены по формуле
    const { st, priceFactor } = (await map.loadState(db, 'ufa', false, false))!;
    let expected = 0;
    for (let y = spot.y; y < spot.y + 2; y++) for (let x = spot.x; x < spot.x + 3; x++) {
      const z = zoneOfCell(st, x, y);
      expected += cellPrice(st.params.landBaseCents, cellOverlays(st, x, y, z).land_value, z, priceFactor);
    }
    expect(r.price_cents).toBe(expected);
    expect(await bal(co.companyId)).toBe(before - expected);
    expect(await bal(NPC.treasury.id)).toBe(treasury + expected);
    expect(await cellsOwned(co.companyId)).toBe(6);
    const city = await tx((t) => map.getCity(t, 'ufa'));
    const mineIdx = city.parcels.owners.findIndex((o) => o.id === co.companyId);
    expect(mineIdx).toBeGreaterThanOrEqual(0);
    const runs = city.parcels.runs.filter((x) => x[3] === mineIdx);
    expect(runs.reduce((s, x) => s + x[2], 0)).toBe(6);
    const led = Number((await db.query('SELECT sum(amount_cents) s FROM ledger_entries WHERE company_id = $1', [co.companyId])).rows[0].s);
    expect(led).toBe(await bal(co.companyId));
  });

  it('ошибки: границы, не продаётся (дорога/вода/парк/вне города), здание города, уже чьё-то, чужая компания, слишком большая площадь', async () => {
    const a = await newCo(), b = await newCo();
    const st = (await map.loadState(db, 'ufa', false, false))!.st;
    await expect(tx((t) => map.buyCells(t, a.playerId, a.companyId, 'ufa', { x: -1, y: 0, w: 1, h: 1 }))).rejects.toMatchObject({ code: 'out_of_bounds' });
    await expect(tx((t) => map.buyCells(t, a.playerId, a.companyId, 'ufa', { x: st.width - 1, y: 5, w: 3, h: 1 }))).rejects.toMatchObject({ code: 'out_of_bounds' });
    const road = roadCell(st);
    await expect(tx((t) => map.buyCells(t, a.playerId, a.companyId, 'ufa', { ...road, w: 1, h: 1 }))).rejects.toMatchObject({ code: 'cell_not_for_sale' });
    const city0 = await tx((t) => map.getCity(t, 'ufa'));
    let far: { x: number; y: number } | null = null, park: { x: number; y: number } | null = null;
    for (let y = 0; y < city0.height; y++) for (let x = 0; x < city0.width; x++) {
      if (city0.tiles[y]![x] !== '.') continue;
      if (!far && city0.cells.buyable[y]![x] === '0' && city0.cells.zones[y]![x] !== 'p') far = { x, y }; // далеко от дорог
      if (!park && city0.cells.zones[y]![x] === 'p') park = { x, y };
    }
    await expect(tx((t) => map.buyCells(t, a.playerId, a.companyId, 'ufa', { ...far!, w: 1, h: 1 }))).rejects.toMatchObject({ code: 'cell_not_for_sale' });
    await expect(tx((t) => map.buyCells(t, a.playerId, a.companyId, 'ufa', { ...park!, w: 1, h: 1 }))).rejects.toMatchObject({ code: 'cell_not_for_sale' });
    const water = roadCellOf(st, '~');
    await expect(tx((t) => map.buyCells(t, a.playerId, a.companyId, 'ufa', { ...water, w: 1, h: 1 }))).rejects.toMatchObject({ code: 'cell_not_for_sale' });
    const npcB = (await tx((t) => map.getCity(t, 'ufa'))).buildings.find((x) => x.city_owned)!;
    await expect(tx((t) => map.buyCells(t, a.playerId, a.companyId, 'ufa', { x: npcB.x, y: npcB.y, w: 1, h: 1 }))).rejects.toMatchObject({ code: 'cell_occupied' });
    await expect(tx((t) => map.buyCells(t, a.playerId, a.companyId, 'ufa', { x: 10, y: 10, w: 21, h: 20 }))).rejects.toMatchObject({ code: 'invalid_payload' });
    const spot = (await findFreeRect(db, 'ufa', 2, 2))!;
    await tx((t) => map.buyCells(t, a.playerId, a.companyId, 'ufa', { ...spot, w: 2, h: 2 }));
    await expect(tx((t) => map.buyCells(t, b.playerId, b.companyId, 'ufa', { ...spot, w: 1, h: 1 }))).rejects.toMatchObject({ code: 'cell_taken' });
    await expect(tx((t) => map.buyCells(t, b.playerId, a.companyId, 'ufa', { ...spot, w: 1, h: 1 }))).rejects.toMatchObject({ code: 'forbidden' });
    await expect(tx((t) => map.buyCells(t, a.playerId, a.companyId, 'nowhere', { x: 1, y: 1, w: 1, h: 1 }))).rejects.toMatchObject({ code: 'not_found' });
  });

  it('частичное пересечение откатывает всю покупку; нет денег — ничего не куплено', async () => {
    const a = await newCo(), b = await newCo();
    const spot = (await findFreeRect(db, 'ufa', 4, 1))!;
    await tx((t) => map.buyCells(t, a.playerId, a.companyId, 'ufa', { x: spot.x + 2, y: spot.y, w: 2, h: 1 }));
    const before = await bal(b.companyId);
    await expect(tx((t) => map.buyCells(t, b.playerId, b.companyId, 'ufa', { ...spot, w: 4, h: 1 }))).rejects.toMatchObject({ code: 'cell_taken' });
    expect(await cellsOwned(b.companyId)).toBe(0);
    expect(await bal(b.companyId)).toBe(before);
    const poor = await newCo(false);
    await tx((t) => companies.debit(t, poor.companyId, 99_999_000, 'test_drain', null, {}).then(() => undefined));
    const spot2 = (await findFreeRect(db, 'ufa', 2, 2))!;
    await expect(tx((t) => map.buyCells(t, poor.playerId, poor.companyId, 'ufa', { ...spot2, w: 2, h: 2 }))).rejects.toMatchObject({ code: 'insufficient_funds' });
    expect(await cellsOwned(poor.companyId)).toBe(0);
  });

  it('гонка за один прямоугольник: покупает ровно одна компания, у остальных деньги целы', async () => {
    const cos = await Promise.all([newCo(), newCo(), newCo(), newCo()]);
    const spot = (await findFreeRect(db, 'ufa', 3, 3))!;
    const before = await Promise.all(cos.map((c) => bal(c.companyId)));
    const res = await Promise.allSettled(cos.map((c) => tx((t) => map.buyCells(t, c.playerId, c.companyId, 'ufa', { ...spot, w: 3, h: 3 }))));
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(res.filter((r) => r.status === 'rejected').every((r) => (r as PromiseRejectedResult).reason.code === 'cell_taken')).toBe(true);
    const after = await Promise.all(cos.map((c) => bal(c.companyId)));
    expect(after.filter((v, i) => v === before[i])).toHaveLength(3);
    expect(Number((await db.query('SELECT count(*) n FROM parcels WHERE city_id = $1 AND x BETWEEN $2 AND $3 AND y BETWEEN $4 AND $5', ['ufa', spot.x, spot.x + 2, spot.y, spot.y + 2])).rows[0].n)).toBe(9);
  });
});

function roadCellOf(st: { tiles: string[][] }, ch: string): { x: number; y: number } {
  for (let y = 0; y < st.tiles.length; y++) for (let x = 0; x < st.tiles[y]!.length; x++) if (st.tiles[y]![x] === ch) return { x, y };
  throw new Error('нет клеток ' + ch);
}
const roadCell = (st: { tiles: string[][] }) => roadCellOf(st, '#');

describe('здания с габаритами', () => {
  const kinds = Object.keys(ENTERPRISE_KINDS) as EnterpriseKind[];

  it('габариты из каталога: все виды, обе ориентации; клетки здания = W×H; поворот меняет стороны', async () => {
    for (const kind of kinds) {
      for (const rotated of [false, true]) {
        const co = await newCo();
        const fp = ENTERPRISE_FOOTPRINT[kind];
        const w = rotated ? fp.h : fp.w, h = rotated ? fp.w : fp.h;
        const spot = (await findFreeRect(db, 'ufa', w, h, ENTERPRISE_ZONES[kind]))!;
        expect(spot, `нет места под ${kind}`).not.toBeNull();
        await tx((t) => map.buyCells(t, co.playerId, co.companyId, 'ufa', { ...spot, w, h }));
        const r = await tx((t) => map.placeBuilding(t, co.playerId, co.companyId, 'ufa', spot.x, spot.y, kind, rotated, `${kind}-${rotated}`));
        expect(r.building).toMatchObject({ w, h, kind, rotated });
        const n = Number((await db.query('SELECT count(*) n FROM building_cells WHERE building_id = $1', [r.building.id])).rows[0].n);
        expect(n).toBe(w * h);
        expect(r.enterprise.building_id).toBe(r.building.id);
        expect(w * h).toBe(fp.w * fp.h);
      }
    }
    expect(Math.max(...kinds.map((k) => ENTERPRISE_FOOTPRINT[k].w * ENTERPRISE_FOOTPRINT[k].h))).toBeGreaterThan(1);
  });

  it('стоимость списывается через журнал; здание видно в getCity и в company.get', async () => {
    const co = await newCo();
    const spot = (await findFreeRect(db, 'ufa', 2, 2, ENTERPRISE_ZONES.bakery))!;
    await tx((t) => map.buyCells(t, co.playerId, co.companyId, 'ufa', { ...spot, w: 2, h: 2 }));
    const before = await bal(co.companyId);
    await tx((t) => map.placeBuilding(t, co.playerId, co.companyId, 'ufa', spot.x, spot.y, 'bakery', false, 'Пекарня-1'));
    expect(await bal(co.companyId)).toBe(before - ENTERPRISE_KINDS.bakery);
    const city = await tx((t) => map.getCity(t, 'ufa'));
    expect(city.buildings.find((b) => b.x === spot.x && b.y === spot.y)).toMatchObject({ kind: 'bakery', name: 'Пекарня-1', owner_company_id: co.companyId, city_owned: false });
    expect((await tx((t) => companies.enterprises(t, co.companyId)))[0]).toMatchObject({ kind: 'bakery', city_id: 'ufa', x: spot.x, y: spot.y });
    const led = Number((await db.query('SELECT sum(amount_cents) s FROM ledger_entries WHERE company_id = $1', [co.companyId])).rows[0].s);
    expect(led).toBe(await bal(co.companyId));
  });

  it('ошибки: чужие клетки, частично свои, зона, границы, занято своим зданием, чужая компания, банкрот, нет денег', async () => {
    const a = await newCo(), b = await newCo();
    const spot = (await findFreeRect(db, 'ufa', 3, 2, ENTERPRISE_ZONES.mill))!;
    // не куплено вообще
    await expect(tx((t) => map.placeBuilding(t, a.playerId, a.companyId, 'ufa', spot.x, spot.y, 'mill', false, 'Мельница'))).rejects.toMatchObject({ code: 'cells_not_owned' });
    // куплено частично (3×1 из 3×2)
    await tx((t) => map.buyCells(t, a.playerId, a.companyId, 'ufa', { ...spot, w: 3, h: 1 }));
    await expect(tx((t) => map.placeBuilding(t, a.playerId, a.companyId, 'ufa', spot.x, spot.y, 'mill', false, 'Мельница'))).rejects.toMatchObject({ code: 'cells_not_owned' });
    await tx((t) => map.buyCells(t, a.playerId, a.companyId, 'ufa', { x: spot.x, y: spot.y + 1, w: 3, h: 1 }));
    await expect(tx((t) => map.placeBuilding(t, b.playerId, a.companyId, 'ufa', spot.x, spot.y, 'mill', false, 'Мельница'))).rejects.toMatchObject({ code: 'forbidden' });
    await expect(tx((t) => map.placeBuilding(t, a.playerId, a.companyId, 'ufa', -1, 0, 'mill', false, 'Мельница'))).rejects.toMatchObject({ code: 'out_of_bounds' });
    await tx((t) => map.placeBuilding(t, a.playerId, a.companyId, 'ufa', spot.x, spot.y, 'mill', false, 'Мельница'));
    // повторная постройка на тех же клетках
    await expect(tx((t) => map.placeBuilding(t, a.playerId, a.companyId, 'ufa', spot.x, spot.y, 'mill', false, 'Мельница-2'))).rejects.toMatchObject({ code: 'cell_occupied' });
    // зонирование: магазин в промзоне
    const ind = (await findFreeRect(db, 'ufa', 2, 1, ['industrial']))!;
    await tx((t) => map.buyCells(t, a.playerId, a.companyId, 'ufa', { ...ind, w: 2, h: 1 }));
    await expect(tx((t) => map.placeBuilding(t, a.playerId, a.companyId, 'ufa', ind.x, ind.y, 'shop', false, 'Магазин'))).rejects.toMatchObject({ code: 'zoning_violation' });
    // нет денег
    const poor = await newCo(false);
    const spot2 = (await findFreeRect(db, 'ufa', 2, 2, ENTERPRISE_ZONES.bakery))!;
    await tx((t) => companies.credit(t, poor.companyId, 5_000_000_000, 'test_grant', null, {}));
    await tx((t) => map.buyCells(t, poor.playerId, poor.companyId, 'ufa', { ...spot2, w: 2, h: 2 }));
    const left = await bal(poor.companyId);
    await tx((t) => companies.debit(t, poor.companyId, left - 1000, 'test_drain', null, {}).then(() => undefined));
    await expect(tx((t) => map.placeBuilding(t, poor.playerId, poor.companyId, 'ufa', spot2.x, spot2.y, 'bakery', false, 'Пекарня'))).rejects.toMatchObject({ code: 'insufficient_funds' });
    expect(Number((await db.query('SELECT count(*) n FROM buildings WHERE owner_company_id = $1', [poor.companyId])).rows[0].n)).toBe(0); // откат
    await db.query("UPDATE companies SET status = 'bankrupt' WHERE id = $1", [poor.companyId]);
    await expect(tx((t) => map.placeBuilding(t, poor.playerId, poor.companyId, 'ufa', spot2.x, spot2.y, 'bakery', false, 'Пекарня'))).rejects.toMatchObject({ code: 'company_bankrupt' });
  });

  it('гонка: два одновременных строительства на одних клетках — построено одно, деньги списаны один раз', async () => {
    const co = await newCo();
    const spot = (await findFreeRect(db, 'ufa', 2, 2, ENTERPRISE_ZONES.bakery))!;
    await tx((t) => map.buyCells(t, co.playerId, co.companyId, 'ufa', { ...spot, w: 2, h: 2 }));
    const before = await bal(co.companyId);
    const res = await Promise.allSettled([
      tx((t) => map.placeBuilding(t, co.playerId, co.companyId, 'ufa', spot.x, spot.y, 'bakery', false, 'Гонка А')),
      tx((t) => map.placeBuilding(t, co.playerId, co.companyId, 'ufa', spot.x, spot.y, 'bakery', false, 'Гонка Б')),
    ]);
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((res.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason.code).toBe('cell_occupied');
    expect(before - (await bal(co.companyId))).toBe(ENTERPRISE_KINDS.bakery);
    expect(Number((await db.query('SELECT count(*) n FROM buildings WHERE owner_company_id = $1', [co.companyId])).rows[0].n)).toBe(1);
  });

  it('снос: здание и предприятие удаляются, клетки остаются своими; чужой и городской снести нельзя; можно построить заново', async () => {
    const a = await newCo(), b = await newCo();
    const spot = (await findFreeRect(db, 'ufa', 2, 2, ENTERPRISE_ZONES.bakery))!;
    await tx((t) => map.buyCells(t, a.playerId, a.companyId, 'ufa', { ...spot, w: 2, h: 2 }));
    const built = await tx((t) => map.placeBuilding(t, a.playerId, a.companyId, 'ufa', spot.x, spot.y, 'bakery', false, 'Пекарня'));
    await expect(tx((t) => map.demolish(t, b.playerId, built.building.id))).rejects.toMatchObject({ code: 'forbidden' });
    const npc = (await db.query('SELECT id FROM buildings WHERE owner_company_id IS NULL LIMIT 1')).rows[0];
    await expect(tx((t) => map.demolish(t, a.playerId, npc.id))).rejects.toMatchObject({ code: 'forbidden' });
    await expect(tx((t) => map.demolish(t, a.playerId, randomUUID()))).rejects.toMatchObject({ code: 'not_found' });
    await tx((t) => map.demolish(t, a.playerId, built.building.id));
    expect(Number((await db.query('SELECT count(*) n FROM building_cells WHERE building_id = $1', [built.building.id])).rows[0].n)).toBe(0);
    expect(Number((await db.query('SELECT count(*) n FROM enterprises WHERE building_id = $1', [built.building.id])).rows[0].n)).toBe(0);
    expect(await cellsOwned(a.companyId)).toBe(4);
    await tx((t) => map.placeBuilding(t, a.playerId, a.companyId, 'ufa', spot.x, spot.y, 'bakery', true, 'Пекарня-2'));
  });
});

describe('рост городов в БД', () => {
  /** Одноразовый город под тест: растёт в БД независимо от общих городов региона (они со временем насыщаются). */
  const makeCity = async () => {
    const id = 'g' + randomUUID().replace(/-/g, '').slice(0, 10);
    const base = region.cities.find((c) => c.id === 'yanaul')!;
    const custom = { ...region, cities: [{ ...base, id, name: 'Тестоград', plan: { ...base.plan, width: 56, height: 44, target_buildings: 60, river: false, seed: Math.floor(Math.random() * 1e6) } }], resources: [], transport: { ...region.transport, hubs: [] } };
    await map.bootstrap(db, custom);
    return id;
  };

  it('тик города сохраняется: население, здания и этажи без пересечений, уникальные id; клетки игроков целы', async () => {
    const id = await makeCity();
    try {
      const co = await newCo();
      const spot = (await findFreeRect(db, id, 3, 3))!;
      expect(spot).not.toBeNull();
      await tx((t) => map.buyCells(t, co.playerId, co.companyId, id, { ...spot, w: 3, h: 3 }));
      const before = await tx((t) => map.getCity(t, id));
      let grown = 0;
      const sig = { operatingEnterprises: 40, industrialEnterprises: 10, retailUnitsSold: 800 };
      for (let i = 0; i < 12; i++) {
        const s = await tx((t) => map.step(t, id, before.growth_day + 1 + i, sig));
        grown += s.added.length + s.floors.length;
      }
      expect(grown).toBeGreaterThan(0);
      const after = await tx((t) => map.getCity(t, id));
      expect(after.growth_day).toBeGreaterThan(before.growth_day);
      expect(after.buildings.length).toBeGreaterThan(before.buildings.length);
      expect(new Set(after.buildings.map((b) => b.id)).size).toBe(after.buildings.length);
      const bad = await db.query('SELECT b.id FROM buildings b WHERE b.city_id = $1 AND (SELECT count(*) FROM building_cells c WHERE c.building_id = b.id) <> b.w * b.h', [id]);
      expect(bad.rowCount).toBe(0);
      for (const b of before.buildings) expect(after.buildings.find((x) => x.id === b.id)).toMatchObject({ x: b.x, y: b.y, w: b.w, h: b.h, kind: b.kind });
      expect(Number((await db.query('SELECT count(*) n FROM parcels WHERE city_id = $1', [id])).rows[0].n)).toBe(9);
      expect(after.buildings.filter((b) => b.owner_company_id === co.companyId)).toHaveLength(0); // город не построил на чужой земле
      expect(after.population).toBeGreaterThan(0);
      expect(Number((await db.query("SELECT count(*) n FROM audit_log WHERE event_type = 'city_growth' AND details->>'city' = $1", [id])).rows[0].n)).toBe(12);
    } finally {
      await db.query('DELETE FROM parcels WHERE city_id = $1', [id]);
      await db.query('DELETE FROM cities WHERE id = $1', [id]);
    }
  });

  it('цены на землю следуют за населением: население выросло — клетки дороже', async () => {
    const id = await makeCity();
    try {
      const sig = { operatingEnterprises: 0, industrialEnterprises: 0, retailUnitsSold: 0 };
      await db.query('UPDATE cities SET population = base_population * 1.2 WHERE id = $1', [id]);
      await tx((t) => map.step(t, id, 1, sig));
      const p0 = (await tx((t) => map.getCity(t, id))).price_factor;
      await db.query('UPDATE cities SET population = base_population * 3 WHERE id = $1', [id]);
      await tx((t) => map.step(t, id, 2, sig));
      const p1 = (await tx((t) => map.getCity(t, id))).price_factor;
      expect(p1).toBeGreaterThan(p0);
    } finally {
      await db.query('DELETE FROM cities WHERE id = $1', [id]);
    }
  });
});

describe('команды по WebSocket: земля и здания', () => {
  it('map.buy_cells и building.place: идемпотентность, права, зонирование, габариты; цену клиент не задаёт', async () => {
    const ctx = await startServer();
    try {
      const c = await TestClient.connect(ctx.url);
      expect((await c.register('m' + randomUUID().replace(/-/g, '').slice(0, 12))).type).toBe('auth_ok');
      const co = (await c.command('company.create', { name: 'Сетка ' + randomUUID().slice(0, 8) })).payload.result.company.id;
      await tx((t) => companies.credit(t, co, 10_000_000_000, 'test_grant', null, {}));
      const spot = (await findFreeRect(ctx.server.db, 'ufa', 2, 2, ENTERPRISE_ZONES.bakery))!;
      const rid = randomUUID();
      const a = await c.command('map.buy_cells', { company_id: co, city_id: 'ufa', ...spot, w: 2, h: 2 }, rid);
      const b = await c.command('map.buy_cells', { company_id: co, city_id: 'ufa', ...spot, w: 2, h: 2 }, rid);
      expect(a.payload.ok).toBe(true);
      expect(b.payload.duplicate).toBe(true);
      expect(await cellsOwned(co)).toBe(4);
      expect((await c.command('map.buy_cells', { company_id: co, city_id: 'ufa', ...spot, w: 2, h: 2, price_cents: 1 })).payload.error.code).toBe('invalid_payload');
      expect((await c.command('map.buy_cells', { company_id: co, city_id: 'ufa', ...spot, w: 1, h: 1 })).payload.error.code).toBe('cell_taken');
      const placed = await c.command('building.place', { company_id: co, city_id: 'ufa', ...spot, kind: 'bakery', name: 'Моя пекарня' });
      expect(placed.payload.ok).toBe(true);
      expect(placed.payload.result.building).toMatchObject({ w: 2, h: 2, kind: 'bakery' });
      expect((await c.command('building.place', { company_id: co, city_id: 'ufa', ...spot, kind: 'bakery', name: 'Ещё' })).payload.error.code).toBe('cell_occupied');
      const city = (await c.command('map.get_city', { city_id: 'ufa' })).payload.result.city;
      expect(city.buildings.find((x: { x: number; y: number }) => x.x === spot.x && x.y === spot.y)).toMatchObject({ kind: 'bakery', name: 'Моя пекарня' });
      const intruder = await TestClient.connect(ctx.url);
      await intruder.register('i' + randomUUID().replace(/-/g, '').slice(0, 12));
      expect((await intruder.command('building.place', { company_id: co, city_id: 'ufa', ...spot, kind: 'bakery', name: 'Взлом' })).payload.error.code).toBe('forbidden');
      const id = placed.payload.result.building.id;
      expect((await intruder.command('building.demolish', { building_id: id })).payload.error.code).toBe('forbidden');
      expect((await c.command('building.demolish', { building_id: id })).payload.ok).toBe(true);
      // удобный помощник: купить землю и построить за один заход
      const r = await buildOnFreshLand(c, ctx.server.db, co, 'shop', 'Магазин у дома');
      expect(r.placed.payload.ok).toBe(true);
      await c.closeGracefully(); await intruder.closeGracefully();
    } finally {
      await ctx.server.stop();
    }
  });
});

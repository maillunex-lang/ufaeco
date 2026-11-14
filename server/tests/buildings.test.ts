import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccountService } from '../src/accounts/index.js';
import { CompanyService } from '../src/companies/index.js';
import { ENTERPRISE_KINDS, ENTERPRISE_ZONES } from '../src/companies/catalog.js';
import { ensureNpcCompanies } from '../src/companies/npc.js';
import { createPool, withTransaction, type Db } from '../src/persistence/db.js';
import { runMigrations } from '../src/persistence/migrate.js';
import { loadRegionData } from '../src/region/data.js';
import { MapService } from '../src/world_map/service.js';
import { startServer, TEST_DB_URL, TestClient } from './helpers.js';

let db: Db;
const companies = new CompanyService();
const map = new MapService(companies);
const accounts = new AccountService();

beforeAll(async () => {
  db = createPool(TEST_DB_URL);
  await runMigrations(db);
  await ensureNpcCompanies(db);
  await map.bootstrap(db, loadRegionData());
  // Тестовая БД одноразовая: освобождаем участки (и здания на них), чтобы прогоны не исчерпали карту.
  await db.query('UPDATE enterprises SET lot_id = NULL WHERE lot_id IS NOT NULL');
  await db.query("UPDATE map_lots SET owner_company_id = NULL, bought_at = NULL, development = 0 WHERE zone <> 'park'");
});
afterAll(async () => { await db.end(); });

const tx = <T>(fn: Parameters<typeof withTransaction<T>>[1]) => withTransaction(db, fn);
const newCo = () =>
  tx(async (t) => {
    const p = await accounts.createGuestPlayer(t);
    const c = await companies.create(t, p.id, 'Строй ' + randomUUID().slice(0, 10));
    return { playerId: p.id, companyId: c.id };
  });
const freeLot = async (zone: string) =>
  ((await db.query("SELECT id FROM map_lots WHERE city_id='ufa' AND zone=$1 AND owner_company_id IS NULL AND development = 0 ORDER BY random() LIMIT 1", [zone])).rows[0] as { id: string }).id;
const ownedLot = async (co: { playerId: string; companyId: string }, zone: string) => {
  const id = await freeLot(zone);
  await tx((t) => map.buyLot(t, co.playerId, co.companyId, id));
  return id;
};
const bal = async (id: string) => Number((await db.query('SELECT balance_cents b FROM companies WHERE id = $1', [id])).rows[0].b);

describe('постройка на участке', () => {
  it('успех: стоимость списана, предприятие привязано к участку и видно в карте', async () => {
    const co = await newCo();
    const lot = await ownedLot(co, 'industrial');
    const before = await bal(co.companyId);
    const r = await tx((t) => map.construct(t, co.playerId, co.companyId, lot, 'mill', 'Мельница №1'));
    expect(r.enterprise.lot_id).toBe(lot);
    expect(await bal(co.companyId)).toBe(before - ENTERPRISE_KINDS.mill);
    const city = await tx((t) => map.getCity(t, 'ufa'));
    expect(city.lots.find((l) => l.id === lot)!.building).toMatchObject({ kind: 'mill', name: 'Мельница №1' });
    const got = await tx((t) => companies.enterprises(t, co.companyId));
    expect(got[0]).toMatchObject({ kind: 'mill', lot_id: lot });
    const led = Number((await db.query('SELECT sum(amount_cents) s FROM ledger_entries WHERE company_id = $1', [co.companyId])).rows[0].s);
    expect(led).toBe(await bal(co.companyId));
  });

  it('ошибки: чужой/ничей участок, зонирование, занято, нет денег, банкрот', async () => {
    const a = await newCo();
    const b = await newCo();
    const lotA = await ownedLot(a, 'industrial');
    await expect(tx((t) => map.construct(t, b.playerId, b.companyId, lotA, 'mill', 'Чужой'))).rejects.toMatchObject({ code: 'lot_not_owned' });
    const unowned = await freeLot('commercial');
    await expect(tx((t) => map.construct(t, b.playerId, b.companyId, unowned, 'shop', 'Ничей'))).rejects.toMatchObject({ code: 'lot_not_owned' });
    await expect(tx((t) => map.construct(t, a.playerId, a.companyId, 'ufa-99999', 'mill', 'Нигде'))).rejects.toMatchObject({ code: 'not_found' });
    await expect(tx((t) => map.construct(t, a.playerId, a.companyId, lotA, 'shop', 'Магазин в промзоне'))).rejects.toMatchObject({ code: 'zoning_violation' });
    await tx((t) => map.construct(t, a.playerId, a.companyId, lotA, 'farm', 'Ферма'));
    await expect(tx((t) => map.construct(t, a.playerId, a.companyId, lotA, 'mill', 'Ещё'))).rejects.toMatchObject({ code: 'lot_occupied' });
    await expect(tx((t) => map.construct(t, b.playerId, a.companyId, lotA, 'mill', 'x'))).rejects.toMatchObject({ code: 'forbidden' });
    // нет денег: участок куплен, но баланс обнулён
    const poor = await newCo();
    const lotP = await ownedLot(poor, 'commercial');
    const left = await bal(poor.companyId);
    await tx((t) => companies.debit(t, poor.companyId, left - 1000, 'test_drain', null, {}).then(() => undefined));
    await expect(tx((t) => map.construct(t, poor.playerId, poor.companyId, lotP, 'shop', 'Бедный'))).rejects.toMatchObject({ code: 'insufficient_funds' });
    expect((await tx((t) => companies.enterprises(t, poor.companyId))).length).toBe(0); // откат: здание не создано
    await db.query("UPDATE companies SET status = 'bankrupt' WHERE id = $1", [poor.companyId]);
    await expect(tx((t) => map.construct(t, poor.playerId, poor.companyId, lotP, 'shop', 'Банкрот'))).rejects.toMatchObject({ code: 'company_bankrupt' });
  });

  it('зонирование: каждый вид строится ровно в разрешённых зонах', async () => {
    for (const [kind, zones] of Object.entries(ENTERPRISE_ZONES)) {
      for (const zone of ['residential', 'commercial', 'industrial']) {
        const co = await newCo();
        // бесплатный капитал: построить любой вид
        await tx((t) => companies.credit(t, co.companyId, 100_000_000, 'test_grant', null, {}));
        const lot = await ownedLot(co, zone);
        const attempt = tx((t) => map.construct(t, co.playerId, co.companyId, lot, kind as 'farm', `${kind}-${zone}`));
        if (zones.includes(zone)) await expect(attempt).resolves.toBeTruthy();
        else await expect(attempt).rejects.toMatchObject({ code: 'zoning_violation' });
      }
    }
  });

  it('гонка: два одновременных строительства на одном участке — построено одно, деньги списаны один раз', async () => {
    const co = await newCo();
    const lot = await ownedLot(co, 'industrial');
    const before = await bal(co.companyId);
    const res = await Promise.allSettled([
      tx((t) => map.construct(t, co.playerId, co.companyId, lot, 'mill', 'Гонка А')),
      tx((t) => map.construct(t, co.playerId, co.companyId, lot, 'farm', 'Гонка Б')),
    ]);
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((res.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason.code).toBe('lot_occupied');
    expect((await db.query('SELECT count(*) n FROM enterprises WHERE lot_id = $1', [lot])).rows[0].n).toBe('1');
    const spent = before - (await bal(co.companyId));
    expect([ENTERPRISE_KINDS.mill, ENTERPRISE_KINDS.farm]).toContain(spent);
  });

  it('участок со зданием нельзя удалить: связь защищена', async () => {
    const co = await newCo();
    await tx((t) => companies.credit(t, co.companyId, 100_000_000, 'test_grant', null, {}));
    const lot = await ownedLot(co, 'commercial');
    await tx((t) => map.construct(t, co.playerId, co.companyId, lot, 'shop', 'Магазин'));
    await expect(db.query('DELETE FROM map_lots WHERE id = $1', [lot])).rejects.toThrow();
  });
});

describe('постройка по WebSocket', () => {
  it('enterprise.create с lot_id, каталог с зонами, идемпотентность, права', async () => {
    const ctx = await startServer();
    try {
      const c = await TestClient.connect(ctx.url);
      expect((await c.register('b' + randomUUID().replace(/-/g, '').slice(0, 12))).type).toBe('auth_ok');
      const co = (await c.command('company.create', { name: 'WS Стройка ' + randomUUID().slice(0, 6) })).payload.result.company.id;
      const cat = (await c.command('catalog.get', {})).payload.result;
      expect(cat.enterprise_kinds.find((k: { kind: string }) => k.kind === 'shop').zones).toEqual(['commercial', 'residential']);
      const city = (await c.command('map.get_city', { city_id: 'ufa' })).payload.result.city;
      const lot = city.lots.find((l: { zone: string; for_sale: boolean }) => l.zone === 'commercial' && l.for_sale);
      const notYet = await c.command('enterprise.create', { company_id: co, kind: 'shop', name: 'Рано', lot_id: lot.id });
      expect(notYet.payload.error.code).toBe('lot_not_owned');
      expect((await c.command('map.buy_lot', { company_id: co, lot_id: lot.id })).payload.ok).toBe(true);
      const rid = randomUUID();
      const a = await c.command('enterprise.create', { company_id: co, kind: 'shop', name: 'Мой магазин', lot_id: lot.id }, rid);
      const b = await c.command('enterprise.create', { company_id: co, kind: 'shop', name: 'Мой магазин', lot_id: lot.id }, rid);
      expect(a.payload.ok).toBe(true);
      expect(b.payload.duplicate).toBe(true);
      const after = (await c.command('map.get_city', { city_id: 'ufa' })).payload.result.city;
      expect(after.lots.find((l: { id: string }) => l.id === lot.id).building).toMatchObject({ kind: 'shop', name: 'Мой магазин' });
      expect((await c.command('enterprise.create', { company_id: co, kind: 'mill', name: 'Двойник', lot_id: lot.id })).payload.error.code).toBe('zoning_violation');
      const intruder = await TestClient.connect(ctx.url);
      await intruder.register('i' + randomUUID().replace(/-/g, '').slice(0, 12));
      expect((await intruder.command('enterprise.create', { company_id: co, kind: 'shop', name: 'Взлом', lot_id: lot.id })).payload.error.code).toBe('forbidden');
      await c.closeGracefully(); await intruder.closeGracefully();
    } finally {
      await ctx.server.stop();
    }
  });
});

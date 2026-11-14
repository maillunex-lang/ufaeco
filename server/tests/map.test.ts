import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccountService } from '../src/accounts/index.js';
import { CompanyService } from '../src/companies/index.js';
import { NPC } from '../src/economy/catalog.js';
import { EconomyService } from '../src/economy/service.js';
import { createPool, withTransaction, type Db } from '../src/persistence/db.js';
import { runMigrations } from '../src/persistence/migrate.js';
import { generateCity } from '../src/world_map/generator.js';
import { MapService } from '../src/world_map/service.js';
import { startServer, TEST_DB_URL, TestClient } from './helpers.js';

// Тестовая БД одноразовая: перед файлом освобождаем все участки, чтобы повторные прогоны не исчерпали карту.
beforeAll(async () => {
  const pool = createPool(TEST_DB_URL);
  await runMigrations(pool);
  await pool.query('UPDATE map_lots SET owner_company_id = NULL, bought_at = NULL');
  await pool.end();
});

describe('генератор карты', () => {
  const city = generateCity('ufa', 20241114);

  it('детерминирован: тот же seed — та же карта; другой seed — другая', () => {
    expect(generateCity('ufa', 20241114)).toEqual(city);
    expect(generateCity('ufa', 7).tiles).not.toEqual(city.tiles);
  });
  it('размеры и символы корректны', () => {
    expect(city.tiles).toHaveLength(city.height);
    for (const row of city.tiles) {
      expect(row).toHaveLength(city.width);
      expect(row).toMatch(/^[.#~=]+$/);
    }
  });
  it('участки внутри карты, не пересекаются, не лежат на дорогах и воде', () => {
    const used = new Set<string>();
    for (const l of city.lots) {
      expect(l.x).toBeGreaterThanOrEqual(0);
      expect(l.y).toBeGreaterThanOrEqual(0);
      expect(l.x + l.w).toBeLessThanOrEqual(city.width);
      expect(l.y + l.h).toBeLessThanOrEqual(city.height);
      for (let y = l.y; y < l.y + l.h; y++) {
        for (let x = l.x; x < l.x + l.w; x++) {
          expect(city.tiles[y]![x]).toBe('.');
          expect(used.has(`${x},${y}`)).toBe(false);
          used.add(`${x},${y}`);
        }
      }
    }
    expect(new Set(city.lots.map((l) => l.id)).size).toBe(city.lots.length);
  });
  it('зоны осмысленны: центр коммерческий, восток промышленный, парки не продаются, цены положительны', () => {
    const zones = new Set(city.lots.map((l) => l.zone));
    expect([...zones].sort()).toEqual(['commercial', 'industrial', 'park', 'residential']);
    for (const l of city.lots) expect(l.zone === 'park' ? l.price_cents === 0 : l.price_cents > 0).toBe(true);
    const cx = city.width / 2;
    const commercial = city.lots.filter((l) => l.zone === 'commercial');
    expect(commercial.every((l) => Math.abs(l.x - cx) < city.width * 0.3)).toBe(true);
    const avg = (z: string) => { const a = city.lots.filter((l) => l.zone === z); return a.reduce((s, l) => s + l.price_cents, 0) / a.length; };
    expect(avg('commercial')).toBeGreaterThan(avg('residential'));
    expect(city.tiles.some((r) => r.includes('~'))).toBe(true);
    expect(city.tiles.some((r) => r.includes('='))).toBe(true); // мосты есть
  });
  it('река проходит через весь город сверху вниз', () => {
    for (const row of city.tiles) expect(row).toMatch(/[~=]/);
  });
});

describe('сервис карты и покупка участков', () => {
  let db: Db;
  const companies = new CompanyService();
  const map = new MapService(companies);
  const accounts = new AccountService();
  beforeAll(async () => {
    db = createPool(TEST_DB_URL);
    await runMigrations(db);
    await new EconomyService(companies).bootstrap(db);
    await map.bootstrap(db);
  });
  afterAll(async () => { await db.end(); });

  const tx = <T>(fn: Parameters<typeof withTransaction<T>>[1]) => withTransaction(db, fn);
  const newCo = (): Promise<{ playerId: string; companyId: string }> =>
    tx(async (t) => {
      const p = await accounts.createGuestPlayer(t);
      const c = await companies.create(t, p.id, 'Земля ' + randomUUID().slice(0, 10));
      return { playerId: p.id, companyId: c.id };
    });
  const freeLot = async (zone: string) =>
    (await db.query("SELECT id, price_cents FROM map_lots WHERE city_id = 'ufa' AND zone = $1 AND owner_company_id IS NULL ORDER BY random() LIMIT 1", [zone])).rows[0] as { id: string; price_cents: string };
  const bal = async (id: string) => Number((await db.query('SELECT balance_cents b FROM companies WHERE id = $1', [id])).rows[0].b);

  it('bootstrap идемпотентен: карта в БД совпадает с генератором и не дублируется', async () => {
    await map.bootstrap(db);
    await map.bootstrap(db);
    const gen = generateCity('ufa', 20241114);
    const city = await tx((t) => map.getCity(t, 'ufa'));
    expect(city.tiles).toEqual(gen.tiles);
    expect(city.lots).toHaveLength(gen.lots.length);
    expect((await db.query("SELECT count(*) n FROM map_lots WHERE city_id = 'ufa'")).rows[0].n).toBe(String(gen.lots.length));
    await expect(tx((t) => map.getCity(t, 'nowhere'))).rejects.toMatchObject({ code: 'not_found' });
  });

  it('покупка: деньги в казну через журнал, владелец записан, участок виден как занятый', async () => {
    const co = await newCo();
    const lot = await freeLot('residential');
    const treasury = await bal(NPC.treasury.id);
    const r = await tx((t) => map.buyLot(t, co.playerId, co.companyId, lot.id));
    expect(r.price_cents).toBe(Number(lot.price_cents));
    expect(await bal(co.companyId)).toBe(100_000_000 - Number(lot.price_cents));
    expect(await bal(NPC.treasury.id)).toBe(treasury + Number(lot.price_cents));
    const city = await tx((t) => map.getCity(t, 'ufa'));
    expect(city.lots.find((l) => l.id === lot.id)).toMatchObject({ owner_company_id: co.companyId });
    const led = (await db.query('SELECT sum(amount_cents) s FROM ledger_entries WHERE company_id = $1', [co.companyId])).rows[0].s;
    expect(Number(led)).toBe(await bal(co.companyId));
  });

  it('ошибки: занят, парк, нет денег, чужая компания, несуществующий', async () => {
    const a = await newCo();
    const b = await newCo();
    const lot = await freeLot('industrial');
    await tx((t) => map.buyLot(t, a.playerId, a.companyId, lot.id));
    await expect(tx((t) => map.buyLot(t, b.playerId, b.companyId, lot.id))).rejects.toMatchObject({ code: 'lot_taken' });
    const park = await freeLot('park');
    await expect(tx((t) => map.buyLot(t, b.playerId, b.companyId, park.id))).rejects.toMatchObject({ code: 'lot_not_for_sale' });
    await expect(tx((t) => map.buyLot(t, b.playerId, b.companyId, 'ufa-99999'))).rejects.toMatchObject({ code: 'not_found' });
    const resLot = await freeLot('residential');
    await expect(tx((t) => map.buyLot(t, a.playerId, b.companyId, resLot.id))).rejects.toMatchObject({ code: 'forbidden' });
    const poor = await newCo();
    await tx((t) => companies.debit(t, poor.companyId, 99_000_000, 'test_drain', null, {}).then(() => undefined));
    const comLot = await freeLot('commercial');
    await expect(tx((t) => map.buyLot(t, poor.playerId, poor.companyId, comLot.id))).rejects.toMatchObject({ code: 'insufficient_funds' });
    expect(await bal(poor.companyId)).toBe(1_000_000);
  });

  it('гонка за один участок: покупает ровно один, у проигравшего деньги не списаны', async () => {
    const cos = await Promise.all([newCo(), newCo(), newCo(), newCo()]);
    const lot = await freeLot('residential');
    const res = await Promise.allSettled(cos.map((c) => tx((t) => map.buyLot(t, c.playerId, c.companyId, lot.id))));
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(res.filter((r) => r.status === 'rejected').every((r) => (r as PromiseRejectedResult).reason.code === 'lot_taken')).toBe(true);
    const balances = await Promise.all(cos.map((c) => bal(c.companyId)));
    expect(balances.filter((b) => b === 100_000_000)).toHaveLength(3);
  });
});

describe('команды карты по WebSocket', () => {
  it('map.get_city и map.buy_lot, идемпотентность, цену клиент не задаёт', async () => {
    const ctx = await startServer();
    try {
      const c = await TestClient.connect(ctx.url);
      expect((await c.register('m' + randomUUID().replace(/-/g, '').slice(0, 12))).type).toBe('auth_ok');
      const co = (await c.command('company.create', { name: 'Карта ' + randomUUID().slice(0, 8) })).payload.result.company.id;
      const city = (await c.command('map.get_city', { city_id: 'ufa' })).payload.result.city;
      expect(city.tiles.length).toBe(city.height);
      const lot = city.lots.find((l: { zone: string; owner_company_id: string | null }) => l.zone === 'residential' && !l.owner_company_id);
      const rid = randomUUID();
      const b1 = await c.command('map.buy_lot', { company_id: co, lot_id: lot.id }, rid);
      const b2 = await c.command('map.buy_lot', { company_id: co, lot_id: lot.id }, rid);
      expect(b1.payload.ok).toBe(true);
      expect(b2.payload.duplicate).toBe(true);
      const bal = (await c.command('company.get', { company_id: co })).payload.result.company.balance_cents;
      expect(bal).toBe(100_000_000 - lot.price_cents); // второй раз не списано
      const again = await c.command('map.buy_lot', { company_id: co, lot_id: lot.id });
      expect(again.payload.error.code).toBe('lot_taken');
      const hack = await c.command('map.buy_lot', { company_id: co, lot_id: lot.id, price_cents: 1 });
      expect(hack.payload.error.code).toBe('invalid_payload');
      expect((await c.command('map.get_city', { city_id: '../etc' })).payload.error.code).toBe('invalid_payload');
      await c.closeGracefully();
    } finally {
      await ctx.server.stop();
    }
  });
});

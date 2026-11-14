import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccountService } from '../src/accounts/index.js';
import { CompanyService } from '../src/companies/index.js';
import { ensureNpcCompanies, NPC } from '../src/companies/npc.js';
import { createPool, withTransaction, type Db } from '../src/persistence/db.js';
import { runMigrations } from '../src/persistence/migrate.js';
import { MapService } from '../src/world_map/service.js';
import { startServer, TEST_DB_URL, TestClient } from './helpers.js';

// Тестовая БД одноразовая: перед файлом освобождаем все участки, чтобы повторные прогоны не исчерпали карту.
beforeAll(async () => {
  const pool = createPool(TEST_DB_URL);
  await runMigrations(pool);
  await pool.query('UPDATE enterprises SET lot_id = NULL WHERE lot_id IS NOT NULL');
  await pool.query("UPDATE map_lots SET owner_company_id = NULL, bought_at = NULL, development = 0 WHERE zone <> 'park'");
  await pool.end();
});

describe('сервис карты и покупка участков', () => {
  let db: Db;
  const companies = new CompanyService();
  const map = new MapService(companies);
  const accounts = new AccountService();
  beforeAll(async () => {
    db = createPool(TEST_DB_URL);
    await runMigrations(db);
    await ensureNpcCompanies(db);
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
    (await db.query("SELECT id, price_cents FROM map_lots WHERE city_id = 'ufa' AND zone = $1 AND owner_company_id IS NULL AND development = 0 ORDER BY random() LIMIT 1", [zone])).rows[0] as { id: string; price_cents: string };
  const bal = async (id: string) => Number((await db.query('SELECT balance_cents b FROM companies WHERE id = $1', [id])).rows[0].b);

  it('bootstrap идемпотентен: повторный запуск ничего не меняет, id участков уникальны', async () => {
    const before = await tx((t) => map.getCity(t, 'ufa'));
    await map.bootstrap(db);
    await map.bootstrap(db);
    const after = await tx((t) => map.getCity(t, 'ufa'));
    expect(after.tiles).toEqual(before.tiles);
    expect(after.lots).toHaveLength(before.lots.length);
    expect(new Set(after.lots.map((l) => l.id)).size).toBe(after.lots.length);
    expect(after.tiles.length).toBe(after.height);
    expect(after.tiles.every((r) => r.length === after.width)).toBe(true);
    await expect(tx((t) => map.getCity(t, 'nowhere'))).rejects.toMatchObject({ code: 'not_found' });
  });

  it('участок, застроенный городом, не продаётся', async () => {
    const co = await newCo();
    const lot = await freeLot('residential');
    await db.query('UPDATE map_lots SET development = 2 WHERE id = $1', [lot.id]);
    await expect(tx((t) => map.buyLot(t, co.playerId, co.companyId, lot.id))).rejects.toMatchObject({ code: 'lot_not_for_sale' });
    expect((await tx((t) => map.getCity(t, 'ufa'))).lots.find((l) => l.id === lot.id)).toMatchObject({ for_sale: false, development: 2 });
    await db.query('UPDATE map_lots SET development = 0 WHERE id = $1', [lot.id]);
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
    expect(city.lots.find((l) => l.id === lot.id)).toMatchObject({ owner_company_id: co.companyId, for_sale: false });
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

describe('рост города в БД (недельный шаг)', () => {
  let db: Db;
  const companies = new CompanyService();
  const map = new MapService(companies);
  const accounts = new AccountService();
  beforeAll(async () => {
    db = createPool(TEST_DB_URL);
    await runMigrations(db);
    await ensureNpcCompanies(db);
    await map.bootstrap(db);
  });
  afterAll(async () => { await db.end(); });
  const tx = <T>(fn: Parameters<typeof withTransaction<T>>[1]) => withTransaction(db, fn);

  it('день города сохраняется: население, рост участков и улиц, уникальные id, прогресс дня', async () => {
    const before = await tx((t) => map.getCity(t, 'ufa'));
    let grown = false;
    for (let i = 0; i < 60 && !grown; i++) {
      const s = await tx((t) => map.step(t, before.growth_day + 1 + i, { operatingEnterprises: 0, industrialEnterprises: 0, retailUnitsSold: 0 }));
      grown = s.new_lots.length > 0;
    }
    const after = await tx((t) => map.getCity(t, 'ufa'));
    expect(after.growth_day).toBeGreaterThan(before.growth_day);
    expect(new Set(after.lots.map((l) => l.id)).size).toBe(after.lots.length);
    expect(after.lots.length).toBeGreaterThanOrEqual(before.lots.length);
    if (grown) {
      expect(after.lots.length).toBeGreaterThan(before.lots.length);
      expect(after.tiles).not.toEqual(before.tiles);
    }
    // старые участки не сдвинулись и не изменили форму
    for (const l of before.lots) expect(after.lots.find((x) => x.id === l.id)).toMatchObject({ x: l.x, y: l.y, w: l.w, h: l.h, zone: l.zone });
    const audit = await db.query("SELECT count(*) n FROM audit_log WHERE event_type = 'city_growth'");
    expect(Number(audit.rows[0].n)).toBeGreaterThan(0);
  });

  it('город не застраивает участки компаний и меняет цены на свободную землю', async () => {
    const co = await tx(async (t) => {
      const p = await accounts.createGuestPlayer(t);
      const c = await companies.create(t, p.id, 'Земля роста ' + randomUUID().slice(0, 8));
      await companies.credit(t, c.id, 10_000_000_000, 'test_grant', null, {});
      return { playerId: p.id, companyId: c.id };
    });
    const mine: string[] = [];
    for (let i = 0; i < 3; i++) {
      const lot = (await db.query("SELECT id FROM map_lots WHERE city_id='ufa' AND zone='residential' AND owner_company_id IS NULL AND development = 0 ORDER BY random() LIMIT 1")).rows[0];
      await tx((t) => map.buyLot(t, co.playerId, co.companyId, lot.id));
      mine.push(lot.id);
    }
    await db.query('UPDATE cities SET population = 6000 WHERE id = $1', ['ufa']);
    for (let i = 0; i < 25; i++) await tx((t) => map.step(t, Date.now() % 1_000_000 + i, { operatingEnterprises: 0, industrialEnterprises: 0, retailUnitsSold: 0 }));
    const rows = (await db.query('SELECT id, development FROM map_lots WHERE id = ANY($1)', [mine])).rows;
    expect(rows.every((r) => r.development === 0)).toBe(true);
    const vac = (await db.query("SELECT price_cents, base_price_cents FROM map_lots WHERE city_id='ufa' AND owner_company_id IS NULL AND development = 0 AND zone <> 'park' LIMIT 20")).rows;
    expect(vac.length).toBeGreaterThan(0);
    const pop = Number((await db.query("SELECT population p FROM cities WHERE id='ufa'")).rows[0].p);
    const factor = Math.max(0.7, Math.min(3, 0.7 + 0.8 * (pop / 2000)));
    for (const v of vac) expect(Number(v.price_cents)).toBe(Math.max(1, Math.round(Number(v.base_price_cents) * factor)));
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
      const lot = city.lots.find((l: { zone: string; for_sale: boolean }) => l.zone === 'residential' && l.for_sale);
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

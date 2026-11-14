import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccountService } from '../src/accounts/index.js';
import { CompanyService } from '../src/companies/index.js';
import { ENTERPRISE_KINDS, type EnterpriseKind } from '../src/companies/catalog.js';
import {
  BASE_PRICES_CENTS, INSOLVENCY_DAYS, MAX_LOAN_CENTS, NPC, NPC_SPREAD_BPS, RECIPES, RESIDENT_BREAD_DEMAND,
  SALES_TAX_BPS, WAGES_CENTS,
} from '../src/economy/catalog.js';
import { nextPrice } from '../src/economy/pricing.js';
import { EconomyService } from '../src/economy/service.js';
import { createPool, withTransaction, type Db } from '../src/persistence/db.js';
import { runMigrations } from '../src/persistence/migrate.js';
import { startServer, TEST_DB_URL, TestClient } from './helpers.js';

let db: Db;
const companies = new CompanyService();
const economy = new EconomyService(companies);
const accounts = new AccountService();

beforeAll(async () => {
  db = createPool(TEST_DB_URL);
  await runMigrations(db);
  await economy.bootstrap(db);
});
afterAll(async () => {
  await db.end();
});

interface Co { playerId: string; companyId: string }
async function newCompany(enterprises: EnterpriseKind[] = [], inventory: Record<string, number> = {}): Promise<Co> {
  return withTransaction(db, async (tx) => {
    const p = await accounts.createGuestPlayer(tx);
    const c = await companies.create(tx, p.id, 'Эко ' + randomUUID().slice(0, 10));
    for (const [i, k] of enterprises.entries()) await companies.createEnterprise(tx, p.id, c.id, k, `${k}-${i}`);
    for (const [prod, q] of Object.entries(inventory)) await companies.addInventory(tx, c.id, prod, q);
    return { playerId: p.id, companyId: c.id };
  });
}
const tx = <T>(fn: (t: Parameters<Parameters<typeof withTransaction>[1]>[0]) => Promise<T>) => withTransaction(db, fn);
const balance = async (id: string) => Number((await db.query('SELECT balance_cents b FROM companies WHERE id = $1', [id])).rows[0].b);
const inv = (id: string) => tx((t) => companies.inventory(t, id));
const day = (co: Co[]) => economy.runDay(db, { companyIds: co.map((c) => c.companyId) });
const ledgerSum = async (id: string) => Number((await db.query('SELECT coalesce(sum(amount_cents),0) s FROM ledger_entries WHERE company_id = $1', [id])).rows[0].s);

describe('цены (чистая функция)', () => {
  const base = 10_000;
  it('дефицит повышает, избыток понижает', () => {
    expect(nextPrice(base, base, 100, 300)).toBeGreaterThan(base);
    expect(nextPrice(base, base, 300, 100)).toBeLessThan(base);
    expect(nextPrice(base, base, 200, 200)).toBe(base);
  });
  it('шаг ограничен, границы соблюдаются, цена всегда положительна', () => {
    expect(nextPrice(base, base, 0, 1e9)).toBeLessThanOrEqual(Math.round(base * 1.1));
    let p = base;
    for (let i = 0; i < 200; i++) p = nextPrice(p, base, 0, 1e9);
    expect(p).toBeLessThanOrEqual(base * 3);
    for (let i = 0; i < 400; i++) p = nextPrice(p, base, 1e9, 0);
    expect(p).toBeGreaterThanOrEqual(base * 0.4);
    expect(nextPrice(1, 1, 5, 0)).toBeGreaterThanOrEqual(1);
  });
  it('цена возвращается к базовой при равновесии', () => {
    let p = base * 2;
    for (let i = 0; i < 100; i++) p = nextPrice(p, base, 100, 100);
    expect(Math.abs(p - base)).toBeLessThan(base * 0.02);
  });
});

describe('NPC и ликвидность', () => {
  it('bootstrap идемпотентен и создаёт NPC-компании и цены', async () => {
    await economy.bootstrap(db);
    await economy.bootstrap(db);
    const npcs = (await db.query('SELECT id FROM companies WHERE is_npc')).rows.map((r) => r.id);
    for (const n of Object.values(NPC)) expect(npcs).toContain(n.id);
    expect((await tx((t) => economy.getPrices(t))).map((p) => p.product_id).sort()).toEqual(['bread', 'flour', 'fuel', 'grain']);
  });
  it('NPC-компания не принадлежит игроку: чужая для всех', async () => {
    const co = await newCompany();
    await expect(tx((t) => companies.getOwned(t, co.playerId, NPC.bank.id))).rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('торговля с NPC, спрос и предложение', () => {
  it('покупка и продажа по цене ± спред, через журнал обеих сторон', async () => {
    const co = await newCompany();
    const price = (await tx((t) => economy.getPrices(t))).find((p) => p.product_id === 'fuel')!.price_cents;
    const start = await balance(co.companyId);
    const traderBefore = await balance(NPC.trader.id);
    const buy = await tx((t) => economy.trade(t, co.playerId, co.companyId, 'fuel', 'buy', 100));
    expect(buy.unit_price_cents).toBe(Math.ceil((price * (10_000 + NPC_SPREAD_BPS)) / 10_000));
    expect(await balance(co.companyId)).toBe(start - buy.total_cents);
    expect(await inv(co.companyId)).toEqual({ fuel: 100 });
    const sell = await tx((t) => economy.trade(t, co.playerId, co.companyId, 'fuel', 'sell', 100));
    expect(sell.unit_price_cents).toBe(Math.floor((price * (10_000 - NPC_SPREAD_BPS)) / 10_000));
    expect(sell.unit_price_cents).toBeLessThan(buy.unit_price_cents); // спред — не арбитраж
    expect(await inv(co.companyId)).toEqual({});
    expect(await balance(co.companyId)).toBeLessThan(start);
    expect(await ledgerSum(co.companyId)).toBe(await balance(co.companyId));
    expect(await ledgerSum(NPC.trader.id)).toBe(await balance(NPC.trader.id));
    void traderBefore;
  });
  it('ошибки: мало денег / мало товара / чужая компания / слишком много', async () => {
    const co = await newCompany();
    const other = await newCompany();
    await expect(tx((t) => economy.trade(t, co.playerId, co.companyId, 'grain', 'buy', 10_000))).rejects.toMatchObject({ code: 'insufficient_funds' });
    await expect(tx((t) => economy.trade(t, co.playerId, co.companyId, 'grain', 'sell', 1))).rejects.toMatchObject({ code: 'insufficient_inventory' });
    await expect(tx((t) => economy.trade(t, other.playerId, co.companyId, 'fuel', 'buy', 1))).rejects.toMatchObject({ code: 'forbidden' });
    await expect(tx((t) => economy.trade(t, co.playerId, co.companyId, 'fuel', 'buy', 10_001))).rejects.toMatchObject({ code: 'invalid_payload' });
    expect(await balance(co.companyId)).toBe(100_000_000);
  });
  it('дефицит поднимает цену на следующий день, избыток опускает', async () => {
    const price = async (p: string) => (await tx((t) => economy.getPrices(t))).find((x) => x.product_id === p)!;
    await economy.runDay(db, { companyIds: [] }); // сброс накопленных счётчиков предыдущих тестов
    const rich = await newCompany();
    await tx((t) => companies.credit(t, rich.companyId, 50_000_000_000, 'test_grant', null, {}));
    const g0 = (await price('grain')).price_cents;
    await tx((t) => economy.trade(t, rich.playerId, rich.companyId, 'grain', 'buy', 5000)); // огромный спрос
    await economy.runDay(db, { companyIds: [] });
    const g1 = (await price('grain')).price_cents;
    expect(g1).toBeGreaterThan(g0);
    await tx((t) => economy.trade(t, rich.playerId, rich.companyId, 'grain', 'sell', 5000)); // огромное предложение
    await economy.runDay(db, { companyIds: [] });
    const g2 = (await price('grain')).price_cents;
    expect(g2).toBeLessThan(g1);
    const row = await price('grain');
    expect(row.price_cents).toBeGreaterThanOrEqual(BASE_PRICES_CENTS.grain * 0.4);
    expect(row.price_cents).toBeLessThanOrEqual(BASE_PRICES_CENTS.grain * 3);
  });
});

describe('производство, зарплаты, налоги', () => {
  it('ферма: зарплата списывается, топливо превращается в зерно', async () => {
    const co = await newCompany(['farm'], { fuel: 10 });
    const before = await balance(co.companyId);
    const s = await day([co]);
    expect(s.produced.grain).toBe(RECIPES.farm!.outputs.grain);
    expect(await inv(co.companyId)).toEqual({ fuel: 10 - RECIPES.farm!.inputs.fuel!, grain: RECIPES.farm!.outputs.grain });
    expect(await balance(co.companyId)).toBe(before - WAGES_CENTS.farm);
    const j = (await db.query("SELECT reason FROM ledger_entries WHERE company_id = $1 ORDER BY id DESC LIMIT 1", [co.companyId])).rows[0];
    expect(j.reason).toBe('wages');
  });
  it('без сырья предприятие простаивает, но зарплата платится', async () => {
    const co = await newCompany(['mill']);
    const before = await balance(co.companyId);
    const s = await day([co]);
    expect(s.produced).toEqual({});
    expect(s.idle_enterprises).toBe(1);
    expect(await balance(co.companyId)).toBe(before - WAGES_CENTS.mill);
  });
  it('полная цепочка: зерно → мука → хлеб → магазин → жители; налог уходит в казну', async () => {
    const co = await newCompany(['mill', 'bakery', 'shop'], { grain: 3, fuel: 2 });
    const treasury = await balance(NPC.treasury.id);
    // день 1 (порядок по созданию): мельница → пекарня → магазин
    const s = await day([co]);
    expect(s.produced.flour).toBe(3);
    expect(s.produced.bread).toBe(1500);
    const left = await inv(co.companyId);
    expect(left.flour).toBe(2);
    expect(left.bread).toBe(1500 - 300); // ёмкость магазина 300 в день
    expect(s.retail_units_sold).toBe(300);
    expect(s.taxes_cents).toBe(Math.floor((s.retail_revenue_cents * SALES_TAX_BPS) / 10_000));
    expect(await balance(NPC.treasury.id)).toBe(treasury + s.taxes_cents);
    const reasons = (await db.query('SELECT DISTINCT reason FROM ledger_entries WHERE company_id = $1', [co.companyId])).rows.map((r) => r.reason);
    expect(reasons).toEqual(expect.arrayContaining(['wages', 'retail_sales', 'sales_tax']));
    expect(await ledgerSum(co.companyId)).toBe(await balance(co.companyId));
  });
  it('жители не покупают больше своего спроса: доли магазинов пропорциональны', async () => {
    const a = await newCompany(['shop', 'shop', 'shop', 'shop'], { bread: 1000 });
    const b = await newCompany(['shop'], { bread: 1000 });
    const s = await day([a, b]);
    expect(s.retail_units_sold).toBeLessThanOrEqual(RESIDENT_BREAD_DEMAND);
    const sa = 1000 - (await inv(a.companyId)).bread!;
    const sb = 1000 - (await inv(b.companyId)).bread!;
    expect(sa).toBeGreaterThan(sb); // у компании с 4 магазинами больше доля
  });
  it('нехватка денег на зарплату: простой и счётчик пропусков; при выплате счётчик сбрасывается', async () => {
    const co = await newCompany(['shop']);
    await tx((t) => companies.debit(t, co.companyId, 100_000_000 - ENTERPRISE_KINDS.shop - 1000, 'test_drain', null, {}).then(() => undefined));
    const s = await day([co]);
    expect(s.idle_enterprises).toBe(1);
    expect((await db.query('SELECT missed_wage_days m FROM companies WHERE id = $1', [co.companyId])).rows[0].m).toBe(1);
    await tx((t) => companies.credit(t, co.companyId, 10_000_000, 'test_grant', null, {}));
    await day([co]);
    expect((await db.query('SELECT missed_wage_days m FROM companies WHERE id = $1', [co.companyId])).rows[0].m).toBe(0);
  });
});

describe('кредиты и банкротства', () => {
  it('выдача, проценты, погашение, лимит, права', async () => {
    const co = await newCompany(['shop']);
    const other = await newCompany();
    const loan = await tx((t) => economy.takeLoan(t, co.playerId, co.companyId, 10_000_000));
    expect(loan.loan_cents).toBe(10_000_000);
    await expect(tx((t) => economy.takeLoan(t, co.playerId, co.companyId, MAX_LOAN_CENTS))).rejects.toMatchObject({ code: 'loan_limit_exceeded' });
    await expect(tx((t) => economy.takeLoan(t, other.playerId, co.companyId, 1))).rejects.toMatchObject({ code: 'forbidden' });
    const bankBefore = await balance(NPC.bank.id);
    await day([co]);
    const owed = await tx((t) => economy.getLoan(t, co.companyId));
    expect(owed).toBe(10_000_000 + Math.floor((10_000_000 * 50) / 10_000));
    await expect(tx((t) => economy.repayLoan(t, co.playerId, co.companyId, owed + 1))).rejects.toMatchObject({ code: 'invalid_amount' });
    await tx((t) => economy.repayLoan(t, co.playerId, co.companyId, owed));
    expect(await tx((t) => economy.getLoan(t, co.companyId))).toBe(0);
    expect(await balance(NPC.bank.id)).toBeGreaterThan(bankBefore - 10_000_000);
    expect(await ledgerSum(co.companyId)).toBe(await balance(co.companyId));
  });
  it('банкротство: долг > активов N дней подряд → ликвидация, статус, блокировка команд', async () => {
    const co = await newCompany(['shop'], { bread: 10 });
    await tx((t) => economy.takeLoan(t, co.playerId, co.companyId, 50_000_000));
    // деньги «сгорели» (убытки): оставляем меньше долга
    await tx((t) => companies.debit(t, co.companyId, 140_000_000 - 5_000_000, 'test_losses', null, {}));
    const bankBefore = await balance(NPC.bank.id);
    let last;
    for (let i = 0; i < INSOLVENCY_DAYS; i++) last = await day([co]);
    expect(last!.bankruptcies).toEqual([co.companyId]);
    const row = (await db.query('SELECT status, bankrupt_day FROM companies WHERE id = $1', [co.companyId])).rows[0];
    expect(row.status).toBe('bankrupt');
    expect(await inv(co.companyId)).toEqual({});
    expect(await tx((t) => economy.getLoan(t, co.companyId))).toBe(0);
    expect(await balance(NPC.bank.id)).toBeGreaterThan(bankBefore); // банк получил часть
    expect(await ledgerSum(co.companyId)).toBe(await balance(co.companyId));
    await expect(tx((t) => economy.trade(t, co.playerId, co.companyId, 'fuel', 'buy', 1))).rejects.toMatchObject({ code: 'company_bankrupt' });
    await expect(tx((t) => economy.takeLoan(t, co.playerId, co.companyId, 1))).rejects.toMatchObject({ code: 'company_bankrupt' });
    await expect(tx((t) => companies.createEnterprise(t, co.playerId, co.companyId, 'shop', 'ещё'))).rejects.toMatchObject({ code: 'company_bankrupt' });
    // обанкротившаяся компания больше не обрабатывается
    const again = await day([co]);
    expect(again.wages_paid_cents).toBe(0);
    const audit = await db.query("SELECT details FROM audit_log WHERE event_type = 'company_bankrupt' AND details->>'company_id' = $1", [co.companyId]);
    expect(audit.rowCount).toBe(1);
  });
  it('длительная неуплата зарплат приводит к закрытию (без долга)', async () => {
    const co = await newCompany(['shop']);
    await tx((t) => companies.debit(t, co.companyId, 100_000_000 - ENTERPRISE_KINDS.shop - 1000, 'test_drain', null, {}).then(() => undefined));
    for (let i = 0; i < 7; i++) await day([co]);
    expect((await db.query('SELECT status FROM companies WHERE id = $1', [co.companyId])).rows[0].status).toBe('bankrupt');
  });
});

describe('экономические дни и согласованность', () => {
  it('дни идут строго последовательно даже при параллельном запуске; поток сериализован', async () => {
    const before = (await db.query('SELECT coalesce(max(day),0) d FROM economy_days')).rows[0].d;
    await Promise.all([1, 2, 3].map(() => economy.runDay(db, { companyIds: [] })));
    const days = (await db.query('SELECT day FROM economy_days WHERE day > $1 ORDER BY day', [before])).rows.map((r) => r.day);
    expect(days).toEqual([before + 1, before + 2, before + 3]);
    expect((await db.query('SELECT count(*) n FROM economy_days WHERE finished_at IS NULL')).rows[0].n).toBe('0');
  });
  it('инвариант журнала: у каждой компании баланс = сумма записей', async () => {
    const bad = await db.query(
      `SELECT c.id FROM companies c WHERE c.balance_cents <> coalesce((SELECT sum(amount_cents) FROM ledger_entries l WHERE l.company_id = c.id), 0)`);
    expect(bad.rowCount).toBe(0);
  });
  it('ошибка внутри дня откатывает весь день', async () => {
    const co = await newCompany(['farm'], { fuel: 10 });
    const before = (await db.query('SELECT coalesce(max(day),0) d FROM economy_days')).rows[0].d;
    const bad = { ...db, connect: db.connect.bind(db) } as Db;
    await db.query('ALTER TABLE market_prices ADD CONSTRAINT tmp_fail CHECK (price_cents < 1) NOT VALID');
    try {
      await expect(economy.runDay(bad, { companyIds: [co.companyId] })).rejects.toThrow();
    } finally {
      await db.query('ALTER TABLE market_prices DROP CONSTRAINT tmp_fail');
    }
    expect((await db.query('SELECT coalesce(max(day),0) d FROM economy_days')).rows[0].d).toBe(before);
    expect(await balance(co.companyId)).toBe(100_000_000 - ENTERPRISE_KINDS.farm);
    expect(await inv(co.companyId)).toEqual({ fuel: 10 });
  });
});

describe('команды по WebSocket и тик мира', () => {
  it('economy/bank команды, права и идемпотентность', async () => {
    const ctx = await startServer();
    try {
      const c = await TestClient.connect(ctx.url);
      const login = 'e' + randomUUID().replace(/-/g, '').slice(0, 12);
      expect((await c.register(login)).type).toBe('auth_ok');
      const cat = await c.command('economy.get_catalog', {});
      expect(cat.payload.result.enterprise_kinds.find((k: { kind: string }) => k.kind === 'bakery').recipe.outputs.bread).toBe(1500);
      const co = (await c.command('company.create', { name: 'WS ' + randomUUID().slice(0, 8) })).payload.result.company.id;
      const prices = await c.command('economy.get_prices', {});
      expect(prices.payload.result.prices).toHaveLength(4);
      const rid = randomUUID();
      const t1 = await c.command('economy.trade', { company_id: co, product_id: 'fuel', side: 'buy', quantity: 10 }, rid);
      const t2 = await c.command('economy.trade', { company_id: co, product_id: 'fuel', side: 'buy', quantity: 10 }, rid);
      expect(t1.payload.ok).toBe(true);
      expect(t2.payload.duplicate).toBe(true);
      const got = await c.command('company.get', { company_id: co });
      expect(got.payload.result.inventory).toEqual({ fuel: 10 }); // повтор не купил второй раз
      const loan = await c.command('bank.take_loan', { company_id: co, amount_cents: 1_000_000 });
      expect(loan.payload.result.loan.loan_cents).toBe(1_000_000);
      expect((await c.command('bank.get_loan', { company_id: co })).payload.result.loan_cents).toBe(1_000_000);
      expect((await c.command('bank.take_loan', { company_id: co, amount_cents: MAX_LOAN_CENTS })).payload.error.code).toBe('loan_limit_exceeded');
      const hack = await c.command('economy.trade', { company_id: co, product_id: 'fuel', side: 'buy', quantity: 1, price_cents: 1 });
      expect(hack.payload.error.code).toBe('invalid_payload'); // цену клиент задать не может
      const intruder = await TestClient.connect(ctx.url);
      await intruder.register('x' + randomUUID().replace(/-/g, '').slice(0, 12));
      expect((await intruder.command('bank.take_loan', { company_id: co, amount_cents: 1 })).payload.error.code).toBe('forbidden');
      expect((await intruder.command('economy.trade', { company_id: co, product_id: 'fuel', side: 'sell', quantity: 1 })).payload.error.code).toBe('forbidden');
      await c.closeGracefully(); await intruder.closeGracefully();
    } finally {
      await ctx.server.stop();
    }
  });

  it('мир сам запускает экономический день по тику; snapshot содержит день и цены', async () => {
    const ctx = await startServer({ ECONOMY_DAY_TICKS: '6', TICK_RATE: '20', SNAPSHOT_RATE: '10' });
    try {
      const c = await TestClient.connect(ctx.url);
      await c.authenticate();
      const first = c.messages.filter((m) => m.type === 'world_snapshot').at(-1)!.payload.economy_day as number;
      const next = await c.waitFor((m) => m.type === 'world_snapshot' && m.payload.economy_day > first, 8000);
      expect(next.payload.economy_day).toBeGreaterThan(first);
      expect(Object.keys(next.payload.prices).sort()).toEqual(['bread', 'flour', 'fuel', 'grain']);
      await c.closeGracefully();
    } finally {
      await ctx.server.stop();
    }
  });
});

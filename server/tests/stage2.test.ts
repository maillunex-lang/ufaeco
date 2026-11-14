import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { commandHandlers } from '../src/commands/registry.js';
import { CompanyService } from '../src/companies/index.js';
import { ENTERPRISE_KINDS, STARTING_CAPITAL_CENTS } from '../src/companies/catalog.js';
import { withTransaction } from '../src/persistence/db.js';
import { commandArgSchemas } from '../src/protocol/schemas.js';
import { buildOnFreshLand, findFreeRect, startServer, TestClient } from './helpers.js';

let ctx: Awaited<ReturnType<typeof startServer>>;
const opened: TestClient[] = [];
async function client(): Promise<TestClient> {
  const c = await TestClient.connect(ctx.url);
  opened.push(c);
  return c;
}
const newLogin = () => 'u' + randomUUID().replace(/-/g, '').slice(0, 14);
const newName = () => 'Компания ' + randomUUID().slice(0, 8);
async function player(): Promise<{ c: TestClient; playerId: string; login: string }> {
  const c = await client();
  const login = newLogin();
  const ok = await c.register(login);
  expect(ok.type).toBe('auth_ok');
  return { c, playerId: ok.payload.player_id, login };
}
async function company(c: TestClient): Promise<string> {
  const r = await c.command('company.create', { name: newName() });
  expect(r.payload.ok).toBe(true);
  return r.payload.result.company.id;
}
const db = () => ctx.server.db;

beforeAll(async () => {
  ctx = await startServer();
});
afterAll(async () => {
  await Promise.all(opened.map((c) => c.closeGracefully()));
  await ctx.server.stop();
});

describe('регистрация и авторизация', () => {
  it('регистрация создаёт игрока; пароль хранится только как хэш', async () => {
    const { playerId, login } = await player();
    const row = (await db().query('SELECT login, password_hash FROM players WHERE id = $1', [playerId])).rows[0];
    expect(row.login).toBe(login);
    expect(row.password_hash).toMatch(/^scrypt\$/);
    expect(row.password_hash).not.toContain('correct-horse-1');
    expect(Number((await db().query("SELECT count(*) n FROM audit_log WHERE player_id = $1 AND event_type = 'account_registered'", [playerId])).rows[0].n)).toBe(1);
  });

  it('логин: тот же игрок, новая сессия; профиль содержит login', async () => {
    const a = await player();
    a.c.terminate();
    const b = await client();
    const ok = await b.login(a.login.toUpperCase()); // регистр логина не важен
    expect(ok.type).toBe('auth_ok');
    expect(ok.payload.player_id).toBe(a.playerId);
    const prof = await b.command('session.get_profile', {});
    expect(prof.payload.result).toMatchObject({ login: a.login, is_guest: false });
  });

  it('занятый логин (без учёта регистра), слабый пароль и плохой логин отклоняются', async () => {
    const a = await player();
    const b = await client();
    expect((await b.register(a.login.toUpperCase())).payload.code).toBe('login_taken');
    const c = await client();
    expect((await c.register(newLogin(), 'short')).payload.code).toBe('invalid_payload');
    const d = await client();
    expect((await d.register('a b')).payload.code).toBe('invalid_payload');
  });

  it('неверный пароль и неизвестный логин дают одинаковую ошибку', async () => {
    const a = await player();
    const b = await client();
    expect((await b.login(a.login, 'wrong-password-1')).payload.code).toBe('invalid_credentials');
    const c = await client();
    expect((await c.login(newLogin())).payload.code).toBe('invalid_credentials');
  });

  it('подбор пароля блокируется после 5 неудач', async () => {
    const a = await player();
    const attempts: string[] = [];
    for (let i = 0; i < 6; i++) {
      const c = await client();
      attempts.push((await c.login(a.login, 'wrong-password-' + i)).payload.code);
    }
    expect(attempts.slice(0, 5)).toEqual(Array(5).fill('invalid_credentials'));
    expect(attempts[5]).toBe('account_locked');
    // и верный пароль во время блокировки не принимается
    const d = await client();
    expect((await d.login(a.login)).payload.code).toBe('account_locked');
  });

  it('reconnect работает для зарегистрированного игрока', async () => {
    const a = await player();
    // получаем токен через повторный вход
    a.c.terminate();
    const b = await client();
    const ok = await b.login(a.login);
    b.terminate();
    await b.waitClose();
    await new Promise((r) => setTimeout(r, 200));
    const c = await client();
    await c.waitType('hello');
    c.send('reconnect', { session_id: ok.payload.session_id, resume_token: ok.payload.resume_token });
    const again = await c.waitType('auth_ok');
    expect(again.payload.player_id).toBe(a.playerId);
    expect(again.payload.resumed).toBe(true);
  });
});

describe('компании, баланс и журнал', () => {
  it('создание компании: стартовый капитал проведён через журнал', async () => {
    const { c } = await player();
    const r = await c.command('company.create', { name: newName() });
    expect(r.payload.ok).toBe(true);
    const id = r.payload.result.company.id as string;
    expect(r.payload.result.company.balance_cents).toBe(STARTING_CAPITAL_CENTS);
    const j = await c.command('company.journal', { company_id: id });
    expect(j.payload.result.entries).toHaveLength(1);
    expect(j.payload.result.entries[0]).toMatchObject({ amount_cents: STARTING_CAPITAL_CENTS, balance_after_cents: STARTING_CAPITAL_CENTS, reason: 'starting_capital' });
    const list = await c.command('company.list', {});
    expect(list.payload.result.companies.map((x: { id: string }) => x.id)).toEqual([id]);
  });

  it('повторный request_id не создаёт вторую компанию', async () => {
    const { c, playerId } = await player();
    const rid = randomUUID();
    const name = newName();
    const r1 = await c.command('company.create', { name }, rid);
    const r2 = await c.command('company.create', { name }, rid);
    expect(r2.payload.duplicate).toBe(true);
    expect(r2.payload.result.company.id).toBe(r1.payload.result.company.id);
    expect(Number((await db().query('SELECT count(*) n FROM companies WHERE owner_player_id = $1', [playerId])).rows[0].n)).toBe(1);
  });

  it('лимит компаний и уникальность названия', async () => {
    const a = await player();
    const name = newName();
    expect((await a.c.command('company.create', { name })).payload.ok).toBe(true);
    const dup = await a.c.command('company.create', { name: name.toUpperCase() });
    expect(dup.payload.error.code).toBe('company_name_taken');
    await company(a.c);
    await company(a.c);
    const over = await a.c.command('company.create', { name: newName() });
    expect(over.payload.error.code).toBe('limit_reached');
    const b = await player();
    const other = await b.c.command('company.create', { name });
    expect(other.payload.error.code).toBe('company_name_taken');
  });

  it('параллельное создание компаний не обходит лимит', async () => {
    const { c, playerId } = await player();
    const before = new Set(c.messages);
    const ids = Array.from({ length: 6 }, () => randomUUID());
    for (const id of ids) c.send('command', { name: 'company.create', args: { name: newName() } }, { request_id: id });
    await c.waitFor((m) => ids.every((id) => c.messages.some((x) => x.request_id === id && x.type === 'command_result' && !before.has(x))));
    expect(Number((await db().query('SELECT count(*) n FROM companies WHERE owner_player_id = $1', [playerId])).rows[0].n)).toBe(3);
  });
});

describe('права владельца', () => {
  it('чужую компанию нельзя читать, смотреть журнал и тратить её деньги', async () => {
    const a = await player();
    const b = await player();
    const id = await company(a.c);
    for (const [name, args] of [
      ['company.get', { company_id: id }],
      ['company.journal', { company_id: id }],
      ['building.place', { company_id: id, city_id: 'ufa', x: 10, y: 10, kind: 'shop', name: 'Чужой магазин' }],
    ] as const) {
      const r = await b.c.command(name, args);
      expect(r.payload.ok, name).toBe(false);
      expect(r.payload.error.code, name).toBe('forbidden');
    }
    const bal = Number((await db().query('SELECT balance_cents FROM companies WHERE id = $1', [id])).rows[0].balance_cents);
    expect(bal).toBe(STARTING_CAPITAL_CENTS);
    expect(Number((await db().query('SELECT count(*) n FROM enterprises WHERE company_id = $1', [id])).rows[0].n)).toBe(0);
    const missing = await b.c.command('company.get', { company_id: randomUUID() });
    expect(missing.payload.error.code).toBe('not_found');
  });

  it('клиент не может выдать себе деньги или товары: таких команд и полей нет', async () => {
    const a = await player();
    const id = await company(a.c);
    for (const name of ['inventory.add', 'company.set_balance', 'ledger.credit']) {
      expect((await a.c.command(name, { company_id: id, amount: 1e9 })).payload.error.code).toBe('unknown_command');
    }
    const r = await a.c.command('company.get', { company_id: id, balance_cents: 1e12 });
    expect(r.payload.error.code).toBe('invalid_payload');
  });
});

const credit = (companyId: string, cents: number) => withTransaction(db(), (tx) => new CompanyService().credit(tx, companyId, cents, 'test_grant', null, {}));
const balanceOf = async (id: string) => Number((await db().query('SELECT balance_cents FROM companies WHERE id = $1', [id])).rows[0].balance_cents);

describe('здания и баланс', () => {
  it('постройка списывает землю и стоимость здания; всё пишется в журнал; здание видно в компании', async () => {
    const { c } = await player();
    const id = await company(c);
    await credit(id, 5_000_000_000);
    const before = await balanceOf(id);
    const r = await buildOnFreshLand(c, db(), id, 'farm', 'Поле №1');
    expect(r.bought.payload.ok).toBe(true);
    expect(r.placed.payload.ok).toBe(true);
    const land = r.bought.payload.result.purchase.price_cents as number;
    expect(await balanceOf(id)).toBe(before - land - ENTERPRISE_KINDS.farm);
    expect(r.placed.payload.result.enterprise.balance_cents).toBe(before - land - ENTERPRISE_KINDS.farm);
    const got = await c.command('company.get', { company_id: id });
    expect(got.payload.result.enterprises).toEqual([expect.objectContaining({ kind: 'farm', name: 'Поле №1', city_id: 'ufa', x: r.spot.x, y: r.spot.y })]);
    const j = (await c.command('company.journal', { company_id: id })).payload.result.entries;
    expect(j.map((e: { reason: string }) => e.reason).slice(0, 2)).toEqual(['enterprise_created', 'land_purchase']);
    expect(j[0]).toMatchObject({ amount_cents: -ENTERPRISE_KINDS.farm });
  });

  it('недостаточно средств: здание не создаётся, request_id не тратится', async () => {
    const { c } = await player();
    const id = await company(c);
    await credit(id, 5_000_000_000);
    const spot = (await findFreeRect(db(), 'ufa', 2, 1, ['commercial', 'residential']))!;
    expect((await c.command('map.buy_cells', { company_id: id, city_id: 'ufa', ...spot, w: 2, h: 1 })).payload.ok).toBe(true);
    const left = await balanceOf(id);
    await withTransaction(db(), (tx) => new CompanyService().debit(tx, id, left - 1000, 'test_drain', null, {}).then(() => undefined));
    const rid = randomUUID();
    const bad = await c.command('building.place', { company_id: id, city_id: 'ufa', ...spot, kind: 'shop', name: 'Магазин' }, rid);
    expect(bad.payload.error.code).toBe('insufficient_funds');
    expect(Number((await db().query('SELECT count(*) n FROM enterprises WHERE company_id = $1', [id])).rows[0].n)).toBe(0);
    expect(Number((await db().query('SELECT count(*) n FROM idempotency_requests WHERE request_id = $1', [rid])).rows[0].n)).toBe(0);
  });

  it('параллельные постройки не уводят баланс в минус; журнал сходится с балансом', async () => {
    const { c } = await player();
    const id = await company(c);
    await credit(id, 5_000_000_000);
    const spots: { x: number; y: number }[] = [];
    for (let i = 0; i < 6; i++) {
      const s = (await findFreeRect(db(), 'ufa', 2, 1, ['commercial', 'residential']))!;
      expect((await c.command('map.buy_cells', { company_id: id, city_id: 'ufa', ...s, w: 2, h: 1 })).payload.ok).toBe(true);
      spots.push(s);
    }
    const left = await balanceOf(id);
    await withTransaction(db(), (tx) => new CompanyService().debit(tx, id, left - 3 * ENTERPRISE_KINDS.shop, 'test_drain', null, {}).then(() => undefined));
    const ids = spots.map(() => randomUUID());
    ids.forEach((rid, i) => c.send('command', { name: 'building.place', args: { company_id: id, city_id: 'ufa', ...spots[i], kind: 'shop', name: `Параллельный ${i}` } }, { request_id: rid }));
    await c.waitFor(() => ids.every((rid) => c.messages.some((x) => x.request_id === rid && x.type === 'command_result')));
    const results = ids.map((rid) => c.messages.find((x) => x.request_id === rid && x.type === 'command_result')!);
    expect(results.filter((r) => r.payload.ok)).toHaveLength(3);
    expect(results.filter((r) => !r.payload.ok).every((r) => r.payload.error.code === 'insufficient_funds')).toBe(true);
    const bal = await balanceOf(id);
    const sum = Number((await db().query('SELECT sum(amount_cents) s FROM ledger_entries WHERE company_id = $1', [id])).rows[0].s);
    expect(bal).toBe(0);
    expect(sum).toBe(bal);
  });

  it('уникальное имя предприятия внутри компании и неизвестный вид', async () => {
    const { c } = await player();
    const id = await company(c);
    await credit(id, 5_000_000_000);
    const a = await buildOnFreshLand(c, db(), id, 'shop', 'Магазин');
    expect(a.placed.payload.ok).toBe(true);
    const b = await buildOnFreshLand(c, db(), id, 'shop', 'магазин');
    expect(b.placed.payload.error.code).toBe('enterprise_name_taken');
    expect((await c.command('building.place', { company_id: id, city_id: 'ufa', x: 5, y: 5, kind: 'rocket', name: 'Ракета' })).payload.error.code).toBe('invalid_payload');
  });
});

describe('инвентарь (серверный API)', () => {
  it('добавление и списание товара атомарны; лишнее списать нельзя', async () => {
    const svc = new CompanyService();
    const { c, playerId } = await player();
    const id = await company(c);
    await withTransaction(db(), (tx) => svc.addInventory(tx, id, 'grain', 100));
    await withTransaction(db(), (tx) => svc.addInventory(tx, id, 'grain', 50));
    await withTransaction(db(), (tx) => svc.removeInventory(tx, id, 'grain', 120));
    await expect(withTransaction(db(), (tx) => svc.removeInventory(tx, id, 'grain', 31))).rejects.toMatchObject({ code: 'insufficient_inventory' });
    await expect(withTransaction(db(), (tx) => svc.addInventory(tx, id, 'gold', 1))).rejects.toMatchObject({ code: 'unknown_product' });
    const got = await c.command('company.get', { company_id: id });
    expect(got.payload.result.inventory).toEqual({ grain: 30 });
    void playerId;
  });
});

describe('согласованность протокола', () => {
  it('список команд в protocol.json совпадает с реализацией', () => {
    const spec = JSON.parse(readFileSync(new URL('../../protocol/protocol.json', import.meta.url), 'utf8'));
    expect([...spec.commands].sort()).toEqual(Object.keys(commandHandlers).sort());
    expect(Object.keys(commandArgSchemas).sort()).toEqual(Object.keys(commandHandlers).sort());
  });
});

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  alignToMonthStart, clockInfo, DAY_MS, describeTick, tickIndexAt, tickStartMs, ufaLocal, WEEK_MS, type ClockParams,
} from '../src/clock/calendar.js';
import { TickRunner, WEEKLY_PHASES, type PhaseDef } from '../src/clock/runner.js';
import { loadConfig } from '../src/config.js';
import { createPool, type Db } from '../src/persistence/db.js';
import { runMigrations } from '../src/persistence/migrate.js';
import { startServer, TEST_DB_URL, TestClient } from './helpers.js';

// 01.01.2026 09:00 по Уфе = 04:00 UTC
const EPOCH = Date.UTC(2026, 0, 1, 4, 0, 0);
const P: ClockParams = { epochMs: EPOCH, speed: 1, startYear: 2026, startMonth: 1 };

describe('календарь: время по Уфе (UTC+5)', () => {
  it('эпоха 04:00 UTC — это 09:00 по Уфе', () => {
    const l = ufaLocal(EPOCH);
    expect(l.getUTCHours()).toBe(9);
    expect(l.getUTCMinutes()).toBe(0);
  });

  it('alignToMonthStart: ближайшее 09:00 по Уфе не позже момента', () => {
    expect(alignToMonthStart(Date.UTC(2026, 2, 10, 4, 0, 0))).toBe(Date.UTC(2026, 2, 10, 4, 0, 0)); // ровно 09:00
    expect(alignToMonthStart(Date.UTC(2026, 2, 10, 3, 59, 59, 999))).toBe(Date.UTC(2026, 2, 9, 4, 0, 0)); // за миллисекунду до
    expect(alignToMonthStart(Date.UTC(2026, 2, 10, 23, 0, 0))).toBe(Date.UTC(2026, 2, 10, 4, 0, 0));
    expect(alignToMonthStart(Date.UTC(2026, 2, 10, 0, 30, 0))).toBe(Date.UTC(2026, 2, 9, 4, 0, 0)); // 05:30 по Уфе — ещё вчерашний месяц
    for (let h = 0; h < 24; h++) {
      const t = alignToMonthStart(Date.UTC(2026, 5, 15, h, 17, 0));
      expect(ufaLocal(t).getUTCHours()).toBe(9);
      expect(ufaLocal(t).getUTCMinutes()).toBe(0);
    }
  });

  it('не зависит от часового пояса процесса', () => {
    const before = alignToMonthStart(Date.UTC(2026, 6, 4, 11, 0, 0));
    const saved = process.env.TZ;
    for (const tz of ['UTC', 'Asia/Tokyo', 'America/New_York', 'Europe/Moscow']) {
      process.env.TZ = tz;
      expect(alignToMonthStart(Date.UTC(2026, 6, 4, 11, 0, 0))).toBe(before);
    }
    if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved;
  });

  it('4 тика в сутки: 09:00, 15:00, 21:00, 03:00 по Уфе', () => {
    const hours = [0, 1, 2, 3, 4].map((n) => ufaLocal(tickStartMs(P, n)).getUTCHours());
    expect(hours).toEqual([9, 15, 21, 3, 9]);
    expect(tickStartMs(P, 4) - tickStartMs(P, 0)).toBe(DAY_MS);
    expect(WEEK_MS).toBe(6 * 3_600_000);
  });

  it('месяц начинается ровно в 09:00 по Уфе', () => {
    const justBefore = describeTick(P, tickIndexAt(P, EPOCH + DAY_MS - 1));
    const exactly = describeTick(P, tickIndexAt(P, EPOCH + DAY_MS));
    expect(justBefore).toMatchObject({ month_index: 0, week: 4, is_month_end: true });
    expect(exactly).toMatchObject({ month_index: 1, week: 1, is_month_start: true, month_name: 'Февраль' });
    expect(tickIndexAt(P, EPOCH - 1)).toBe(-1); // до старта мира
  });

  it('игровая дата: недели 1..4, 12 месяцев, год = 12 суток, смена года', () => {
    expect(describeTick(P, 0)).toMatchObject({ year: 2026, month: 1, month_name: 'Январь', week: 1 });
    expect(describeTick(P, 3)).toMatchObject({ week: 4, month: 1 });
    expect(describeTick(P, 4 * 11)).toMatchObject({ year: 2026, month: 12, month_name: 'Декабрь' });
    expect(describeTick(P, 48)).toMatchObject({ year: 2027, month: 1, week: 1 });
    expect(describeTick(P, 48 + 4 * 5 + 2)).toMatchObject({ year: 2027, month: 6, week: 3 });
    const mid: ClockParams = { ...P, startMonth: 11 };
    expect(describeTick(mid, 0)).toMatchObject({ year: 2026, month: 11 });
    expect(describeTick(mid, 8)).toMatchObject({ year: 2027, month: 1 });
  });

  it('clockInfo: границы недели и месяца для клиента', () => {
    const t = EPOCH + 7 * 3_600_000; // 16:00 по Уфе, неделя 2... (04:00 UTC + 7 ч = 11:00 UTC)
    const info = clockInfo(P, t);
    expect(info).toMatchObject({ tick: 1, week: 2, month_index: 0 });
    expect(info.week_started_at).toBe(EPOCH + WEEK_MS);
    expect(info.next_week_at).toBe(EPOCH + 2 * WEEK_MS);
    expect(info.next_month_at).toBe(EPOCH + DAY_MS);
    expect(ufaLocal(info.next_month_at).getUTCHours()).toBe(9);
  });

  it('ускорение времени сжимает неделю', () => {
    const fast: ClockParams = { ...P, speed: 24 };
    expect(tickStartMs(fast, 1) - tickStartMs(fast, 0)).toBe(WEEK_MS / 24);
    expect(tickIndexAt(fast, EPOCH + 60 * 60_000)).toBe(4); // за реальный час при x24 — 24 игровых часа = 4 недели
  });
});

describe('конфигурация времени', () => {
  it('значения по умолчанию, запрет ускорения и неверной эпохи в production', () => {
    const c = loadConfig({});
    expect(c).toMatchObject({ worldId: 'main', gameStartYear: 2026, gameStartMonth: 1, timeSpeed: 1, ticksEnabled: true });
    expect(() => loadConfig({ ENVIRONMENT: 'production', DATABASE_URL: 'postgres://u:p@h/d', TIME_SPEED: '60' })).toThrow(/TIME_SPEED/);
    expect(() => loadConfig({ WORLD_EPOCH: '2026-01-01T05:00:00.000Z' })).toThrow(/09:00/);
    expect(loadConfig({ WORLD_EPOCH: '2026-01-01T04:00:00.000Z' }).worldEpochMs).toBe(EPOCH);
  });
});

describe('планировщик тиков (БД)', () => {
  let db: Db;
  beforeAll(async () => {
    db = createPool(TEST_DB_URL);
    await runMigrations(db);
  });
  afterAll(async () => { await db.end(); });

  const world = () => 'test-' + randomUUID().slice(0, 8);
  let now = EPOCH;
  const mk = async (over: Partial<ConstructorParameters<typeof TickRunner>[1]> = {}, startAt = EPOCH + 10 * 60_000) => {
    now = startAt;
    const r = new TickRunner(db, { worldId: world(), now: () => now, ...over });
    await r.ensureClock({ epochMs: EPOCH, speed: 1, startYear: 2026, startMonth: 1, seed: 777 });
    return r;
  };
  const ticksOf = async (r: TickRunner) =>
    (await db.query('SELECT tick, week, month_index, summary FROM world_ticks WHERE world_id = $1 ORDER BY tick', [r.worldId])).rows;

  it('при создании мира прошедшие недели не догоняются', async () => {
    const r = await mk({}, EPOCH + 3 * WEEK_MS + 1000); // мир создан в середине месяца
    expect(await r.lastTick()).toBe(3);
    expect(await r.processDue()).toEqual([]);
    expect(await ticksOf(r)).toHaveLength(0);
  });

  it('тик выполняется ровно в начале недели, фазы идут в фиксированном порядке', async () => {
    const r = await mk();
    expect(await r.processDue()).toEqual([]);
    now = EPOCH + WEEK_MS - 1; // за миллисекунду до 15:00 по Уфе
    expect(await r.processDue()).toEqual([]);
    now = EPOCH + WEEK_MS; // 15:00
    expect(await r.processDue()).toEqual([1]);
    const [t] = await ticksOf(r);
    expect(t.week).toBe(1); // рассчитана завершившаяся неделя 1
    expect(t.summary.phases.map((p: { name: string }) => p.name)).toEqual(WEEKLY_PHASES.map((p) => p.name));
    expect(t.summary.phases.every((p: { status: string }) => p.status === 'not_implemented')).toBe(true);
    expect(t.summary.month).toBeUndefined();
    expect(await r.processDue()).toEqual([]); // повторный запуск — ничего
  });

  it('месячные операции — ровно в 09:00 по Уфе (тик, кратный 4); годовые — каждые 48 тиков', async () => {
    const seen: string[] = [];
    const spy = (n: string) => async (ctx: { tick: number }) => { seen.push(`${n}@${ctx.tick}`); };
    const r = await mk({
      phases: [{ name: 'w', stage: null, run: spy('w') }],
      monthHooks: [{ name: 'm', stage: null, run: spy('m') }],
      yearHooks: [{ name: 'y', stage: null, run: spy('y') }],
    });
    now = EPOCH + DAY_MS - 1;
    await r.processDue();
    expect(seen).toEqual(['w@1', 'w@2', 'w@3']); // до 09:00 месячных операций нет
    now = EPOCH + DAY_MS;
    await r.processDue();
    expect(seen.slice(3)).toEqual(['w@4', 'm@4']);
    now = EPOCH + 12 * DAY_MS;
    const done = await r.processDue(100);
    expect(done[0]).toBe(5);
    expect(done.at(-1)).toBe(48);
    expect(seen.filter((x) => x.startsWith('y@'))).toEqual(['y@48']);
    expect(seen.filter((x) => x.startsWith('m@')).length).toBe(12); // 12 месяцев закрыты
  });

  it('догоняющий расчёт без пропусков, с пределом за вызов', async () => {
    const r = await mk();
    now = EPOCH + 20 * WEEK_MS + 5;
    const first = await r.processDue(16);
    expect(first).toEqual(Array.from({ length: 16 }, (_, i) => i + 1));
    expect(await r.processDue(16)).toEqual([17, 18, 19, 20]);
    const rows = await ticksOf(r);
    expect(rows.map((x) => Number(x.tick))).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  it('параллельные запуски не выполняют тик дважды', async () => {
    const calls: number[] = [];
    const r = await mk({ phases: [{ name: 'w', stage: null, run: async (c) => { calls.push(c.tick); } }] });
    now = EPOCH + 6 * WEEK_MS;
    const a = await Promise.all([r.processDue(), r.processDue(), r.processDue(), r.processDue()]);
    expect(a.flat().sort((x, y) => x - y)).toEqual([1, 2, 3, 4, 5, 6]);
    expect([...calls].sort((x, y) => x - y)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(Number((await db.query('SELECT count(*) n FROM world_ticks WHERE world_id = $1', [r.worldId])).rows[0].n)).toBe(6);
  });

  it('ошибка в фазе откатывает весь тик; после исправления тик выполняется', async () => {
    let boom = true;
    const writes: PhaseDef[] = [
      { name: 'writes', stage: null, run: async (c) => { await c.tx.query("INSERT INTO audit_log (event_type, details) VALUES ('test_tick_write', $1)", [JSON.stringify({ w: c.worldId, t: c.tick })]); } },
      { name: 'fails', stage: null, run: async () => { if (boom) throw new Error('сбой фазы'); } },
    ];
    const r = await mk({ phases: writes });
    now = EPOCH + WEEK_MS;
    await expect(r.processDue()).rejects.toThrow('сбой фазы');
    expect(await r.lastTick()).toBe(0);
    expect(await ticksOf(r)).toHaveLength(0);
    const leaked = await db.query("SELECT count(*) n FROM audit_log WHERE event_type = 'test_tick_write' AND details->>'w' = $1", [r.worldId]);
    expect(Number(leaked.rows[0].n)).toBe(0); // побочные эффекты откатились
    boom = false;
    expect(await r.processDue()).toEqual([1]);
  });

  it('детерминизм: одинаковый seed и тик дают одинаковый поток случайных чисел; другой seed — другой', async () => {
    const draw: Record<string, number[]> = {};
    const mkRunner = async (seed: number, tag: string) => {
      draw[tag] = [];
      now = EPOCH + 10 * 60_000;
      const r = new TickRunner(db, { worldId: world(), now: () => now, phases: [{ name: 'rng', stage: null, run: async (c) => { draw[tag]!.push(c.rng(), c.rng()); } }], monthHooks: [], yearHooks: [] });
      await r.ensureClock({ epochMs: EPOCH, speed: 1, startYear: 2026, startMonth: 1, seed });
      return r;
    };
    const a = await mkRunner(42, 'a'), b = await mkRunner(42, 'b'), c = await mkRunner(43, 'c');
    now = EPOCH + 3 * WEEK_MS;
    await a.processDue(); await b.processDue(); await c.processDue();
    expect(draw.a).toEqual(draw.b);
    expect(draw.a).not.toEqual(draw.c);
    expect(new Set(draw.a).size).toBe(draw.a!.length); // тики различаются между собой
  });

  it('тик пишет журнал аудита и сводку', async () => {
    const r = await mk({ phases: [{ name: 'x', stage: null, run: async () => ({ done: 1 }) }], monthHooks: [], yearHooks: [] });
    now = EPOCH + WEEK_MS;
    await r.processDue();
    const [t] = await ticksOf(r);
    expect(t.summary.phases[0]).toMatchObject({ name: 'x', status: 'ok', detail: { done: 1 } });
    const audit = await db.query("SELECT details FROM audit_log WHERE event_type = 'world_tick' AND details->>'world' = $1", [r.worldId]);
    expect(audit.rowCount).toBe(1);
  });

  it('смена скорости времени в существующем мире отклоняется с подсказкой', async () => {
    const r = await mk();
    const again = new TickRunner(db, { worldId: r.worldId, now: () => now });
    await expect(again.ensureClock({ epochMs: EPOCH, speed: 60, startYear: 2026, startMonth: 1, seed: 777 })).rejects.toThrow(/world:reset/);
  });

  it('перезапуск: мир с тем же id продолжается с последнего тика', async () => {
    const id = world();
    now = EPOCH + 10 * 60_000;
    const r1 = new TickRunner(db, { worldId: id, now: () => now, phases: [], monthHooks: [], yearHooks: [] });
    await r1.ensureClock({ epochMs: EPOCH, speed: 1, startYear: 2026, startMonth: 1, seed: 1 });
    now = EPOCH + 2 * WEEK_MS;
    await r1.processDue();
    const r2 = new TickRunner(db, { worldId: id, now: () => now, phases: [], monthHooks: [], yearHooks: [] });
    await r2.ensureClock({ epochMs: EPOCH + DAY_MS * 5, speed: 1, startYear: 1999, startMonth: 7, seed: 9 }); // другие параметры игнорируются
    expect(r2.clock.epochMs).toBe(EPOCH);
    expect(r2.clock.startYear).toBe(2026);
    expect(await r2.lastTick()).toBe(2);
    now = EPOCH + 4 * WEEK_MS;
    expect(await r2.processDue()).toEqual([3, 4]);
  });
});

describe('мир с ускоренным временем по WebSocket', () => {
  it('snapshot несёт игровые часы; тики идут сами; город достраивается', async () => {
    const wid = 'ws' + randomUUID().replace(/-/g, '').slice(0, 8);
    const ctx = await startServer({ WORLD_ID: wid, TICKS_ENABLED: 'true', TIME_SPEED: '21600' }); // 1 игровая неделя = 1 с
    try {
      const c = await TestClient.connect(ctx.url);
      await c.authenticate();
      const first = c.messages.filter((m) => m.type === 'world_snapshot').at(-1)!.payload.clock;
      expect(first).toMatchObject({ speed: 21600 });
      expect(first.week).toBeGreaterThanOrEqual(1);
      expect(first.next_week_at).toBeGreaterThan(first.server_time);
      const later = await c.waitFor((m) => m.type === 'world_snapshot' && m.payload.clock.tick >= first.tick + 2, 10_000);
      expect(later.payload.clock.tick).toBeGreaterThanOrEqual(first.tick + 2);
      await new Promise((r) => setTimeout(r, 500));
      const rows = await ctx.server.db.query('SELECT tick, summary FROM world_ticks WHERE world_id = $1 ORDER BY tick', [wid]);
      expect(rows.rowCount).toBeGreaterThanOrEqual(2);
      const ticks = rows.rows.map((r) => Number(r.tick));
      expect(ticks).toEqual(ticks.map((_, i) => ticks[0]! + i)); // подряд, без пропусков
      const city = rows.rows[0].summary.phases.find((p: { name: string }) => p.name === 'city_dynamics');
      expect(city).toMatchObject({ status: 'ok' });
      await c.closeGracefully();
    } finally {
      await ctx.server.stop();
    }
  });
});

import { createHash } from 'node:crypto';
import { writeAudit } from '../persistence/audit.js';
import { withTransaction, type Db, type Queryable } from '../persistence/db.js';
import { mulberry32 } from '../world_map/generator.js';
import {
  alignToMonthStart, clockInfo, DAYS_PER_MONTH, DAYS_PER_WEEK, DAYS_PER_YEAR, describeTick, tickIndexAt, tickStartMs,
  type ClockParams, type GameClockInfo, type GameDate,
} from './calendar.js';

export interface TickContext {
  tx: Queryable;
  worldId: string;
  /** номер тика: начало игрового дня n, рассчитывается завершившийся день n−1 */
  tick: number;
  /** завершившийся игровой день */
  completed: GameDate;
  /** детерминированный ГСЧ по (seed мира, тик, фаза) */
  rng: () => number;
  seed: number;
}

export type PhaseHandler = (ctx: TickContext) => Promise<Record<string, unknown> | void>;

export interface PhaseDef {
  name: string;
  /** этап дорожной карты, в котором фаза будет реализована; null — реализована */
  stage: number | null;
  run?: PhaseHandler;
}

/** Фазы игрового дня в фиксированном порядке (docs/TIME_MODEL.md). Нереализованные помечаются в сводке тика. */
export const DAILY_PHASES: PhaseDef[] = [
  { name: 'construction', stage: 4 },
  { name: 'extraction', stage: 5 },
  { name: 'production', stage: 7 },
  { name: 'supply', stage: 8 },
  { name: 'retail', stage: 9 },
  { name: 'rent_and_wages', stage: 12 },
  { name: 'events', stage: 13 },
];

export interface HookDef {
  name: string;
  stage: number | null;
  run?: PhaseHandler;
}

/** Недельные операции (каждый 6-й игровой день, в момент начала новой недели). */
export const WEEKLY_HOOKS: HookDef[] = [
  { name: 'demand_and_market_share', stage: 9 },
  { name: 'brand_decay', stage: 10 },
  { name: 'policies_and_ai', stage: 15 },
];

/** Месячные операции (каждый 24-й игровой день, в момент начала нового месяца). */
export const MONTHLY_HOOKS: HookDef[] = [
  { name: 'taxes_and_interest', stage: 14 },
  { name: 'financial_reports', stage: 3 },
  { name: 'macro_and_cities', stage: 13 },
  { name: 'bankruptcy_checks', stage: 14 },
];

/** Годовые операции (после месяца 12). */
export const YEARLY_HOOKS: HookDef[] = [
  { name: 'annual_reports_and_rankings', stage: 14 },
  { name: 'tech_and_resources_refresh', stage: 11 },
];

export interface RunnerOptions {
  worldId: string;
  phases?: PhaseDef[];
  weekHooks?: HookDef[];
  monthHooks?: HookDef[];
  yearHooks?: HookDef[];
  /** источник времени; в тестах подменяется */
  now?: () => number;
}

export interface ClockInit {
  /** по умолчанию — ближайшее 09:00 по Уфе не позже «сейчас» */
  epochMs?: number;
  speed: number;
  startYear: number;
  startMonth: number;
  seed: number;
}

const lockKey = (worldId: string): number => createHash('sha256').update('tick:' + worldId).digest().readInt32BE(0);
const phaseSeed = (seed: number, tick: number, name: string): number =>
  createHash('sha256').update(`${seed}:${tick}:${name}`).digest().readUInt32BE(0);

export class TickRunner {
  private params: ClockParams | null = null;
  private seed = 0;
  private readonly phases: PhaseDef[];
  private readonly weekHooks: HookDef[];
  private readonly monthHooks: HookDef[];
  private readonly yearHooks: HookDef[];
  private readonly now: () => number;
  readonly worldId: string;

  constructor(private readonly db: Db, opts: RunnerOptions) {
    this.worldId = opts.worldId;
    this.phases = opts.phases ?? DAILY_PHASES;
    this.weekHooks = opts.weekHooks ?? WEEKLY_HOOKS;
    this.monthHooks = opts.monthHooks ?? MONTHLY_HOOKS;
    this.yearHooks = opts.yearHooks ?? YEARLY_HOOKS;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Создаёт часы мира при первом запуске (без «долга» по тикам: прошедшие недели не догоняются) или загружает существующие.
   * Скорость времени в существующем мире менять нельзя (ошибка с подсказкой про `world:reset`); боевое значение — 1.
   */
  async ensureClock(init: ClockInit): Promise<ClockParams> {
    // Боевой мир (скорость 1) стартует с ближайшего 09:00 по Уфе; ускоренный dev-мир — с текущего момента (иначе сразу «прошли» бы годы).
    const epoch = init.epochMs ?? (init.speed === 1 ? alignToMonthStart(this.now()) : this.now());
    const p: ClockParams = { epochMs: epoch, speed: init.speed, startYear: init.startYear, startMonth: init.startMonth };
    await withTransaction(this.db, async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock($1)', [lockKey(this.worldId)]);
      const exists = await tx.query('SELECT 1 FROM world_clock WHERE world_id = $1', [this.worldId]);
      if (!exists.rowCount) {
        await tx.query(
          `INSERT INTO world_clock (world_id, epoch, speed, start_year, start_month, seed, last_tick)
           VALUES ($1, to_timestamp($2::double precision / 1000), $3, $4, $5, $6, $7)`,
          [this.worldId, epoch, init.speed, init.startYear, init.startMonth, init.seed, tickIndexAt(p, this.now())],
        );
      } else {
        const cur = Number((await tx.query('SELECT speed FROM world_clock WHERE world_id = $1', [this.worldId])).rows[0].speed);
        if (cur !== init.speed) {
          // Смена скорости посреди мира рассинхронизировала бы номера тиков и реальное время.
          throw new Error(`Мир «${this.worldId}» создан со скоростью времени ${cur}, а запрошена ${init.speed}. Сбросьте мир: npm run world:reset (только dev)`);
        }
      }
    });
    return this.load();
  }

  async load(): Promise<ClockParams> {
    const r = (await this.db.query(
      `SELECT extract(epoch FROM epoch) * 1000 AS epoch_ms, speed, start_year, start_month, seed FROM world_clock WHERE world_id = $1`,
      [this.worldId],
    )).rows[0];
    if (!r) throw new Error(`Часы мира «${this.worldId}» не созданы`);
    this.params = { epochMs: Math.round(Number(r.epoch_ms)), speed: Number(r.speed), startYear: r.start_year, startMonth: r.start_month };
    this.seed = r.seed;
    return this.params;
  }

  get clock(): ClockParams {
    if (!this.params) throw new Error('Часы мира не загружены');
    return this.params;
  }

  currentTick(): number {
    return tickIndexAt(this.clock, this.now());
  }

  info(): GameClockInfo {
    return clockInfo(this.clock, this.now());
  }

  /** Момент, когда должен выполниться следующий тик (мс Unix). */
  nextTickAtMs(): number {
    return tickStartMs(this.clock, this.currentTick() + 1);
  }

  async lastTick(): Promise<number> {
    const r = await this.db.query('SELECT last_tick FROM world_clock WHERE world_id = $1', [this.worldId]);
    return Number(r.rows[0].last_tick);
  }

  /**
   * Выполняет все наступившие, но не обработанные тики (игровые дни) по порядку (максимум maxTicks за вызов).
   * Параллельные вызовы безопасны: тик выполняется ровно один раз.
   */
  async processDue(maxTicks = 48): Promise<number[]> {
    const done: number[] = [];
    while (done.length < maxTicks) {
      const due = this.currentTick();
      const n = await this.runNext(due);
      if (n === null) break;
      done.push(n);
    }
    return done;
  }

  private async runNext(due: number): Promise<number | null> {
    return withTransaction(this.db, async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock($1)', [lockKey(this.worldId)]);
      const last = Number((await tx.query('SELECT last_tick FROM world_clock WHERE world_id = $1 FOR UPDATE', [this.worldId])).rows[0].last_tick);
      if (last >= due) return null;
      const tick = last + 1;
      const started = Date.now();
      const p = this.clock;
      const completed = describeTick(p, tick - 1);
      const ctxFor = (name: string): TickContext => ({
        tx, worldId: this.worldId, tick, completed, seed: this.seed, rng: mulberry32(phaseSeed(this.seed, tick, name)),
      });
      const summary: { phases: unknown[]; week?: unknown[]; month?: unknown[]; year?: unknown[] } = { phases: [] };
      const exec = async (list: { name: string; stage: number | null; run?: PhaseHandler }[], out: unknown[]) => {
        for (const ph of list) {
          const t0 = Date.now();
          if (!ph.run) {
            out.push({ name: ph.name, status: 'not_implemented', stage: ph.stage });
            continue;
          }
          const detail = (await ph.run(ctxFor(ph.name))) ?? {};
          out.push({ name: ph.name, status: 'ok', ms: Date.now() - t0, detail });
        }
      };
      await exec(this.phases, summary.phases);
      if (tick % DAYS_PER_WEEK === 0) {
        summary.week = [];
        await exec(this.weekHooks, summary.week);
      }
      if (tick % DAYS_PER_MONTH === 0) {
        summary.month = [];
        await exec(this.monthHooks, summary.month);
      }
      if (tick % DAYS_PER_YEAR === 0) {
        summary.year = [];
        await exec(this.yearHooks, summary.year);
      }
      await tx.query(
        `INSERT INTO world_ticks (world_id, tick, week, day, month_index, started_at, finished_at, duration_ms, summary)
         VALUES ($1, $2, $3, $4, $5, to_timestamp($6::double precision / 1000), now(), $7, $8)`,
        [this.worldId, tick, completed.week, completed.day, completed.month_index, started, Date.now() - started, JSON.stringify(summary)],
      );
      await tx.query('UPDATE world_clock SET last_tick = $2 WHERE world_id = $1', [this.worldId, tick]);
      const closed = tick % DAYS_PER_MONTH === 0;
      await writeAudit(tx, {
        eventType: 'world_tick',
        details: { world: this.worldId, tick, closed_day: completed.day, closed_month: closed ? completed.month_index : null },
      });
      return tick;
    });
  }
}

import Fastify, { type FastifyInstance } from 'fastify';
import type { AddressInfo } from 'node:net';
import { AccountService } from './accounts/index.js';
import { describeTick, tickIndexAt, tickStartMs } from './clock/calendar.js';
import { MONTHLY_HOOKS, TickRunner, WEEKLY_PHASES, type HookDef, type PhaseDef } from './clock/runner.js';
import { CompanyService } from './companies/index.js';
import { ensureNpcCompanies } from './companies/npc.js';
import type { ServerConfig } from './config.js';
import { Gateway } from './net/gateway.js';
import { createPool, type Db } from './persistence/db.js';
import { runMigrations } from './persistence/migrate.js';
import { SessionService } from './sessions/index.js';
import { World } from './world/index.js';
import { loadRegionData } from './region/data.js';
import { RegionService } from './region/service.js';
import { MapService } from './world_map/service.js';

export interface GameServer {
  readonly http: FastifyInstance;
  readonly db: Db;
  readonly world: World;
  readonly map: MapService;
  readonly region: RegionService;
  readonly ticks: TickRunner;
  start(): Promise<{ host: string; port: number }>;
  stop(): Promise<void>;
}

export function createGameServer(config: ServerConfig, opts: { db?: Db; now?: () => number } = {}): GameServer {
  const ownDb = !opts.db;
  const db = opts.db ?? createPool(config.databaseUrl);
  const accounts = new AccountService();
  const sessions = new SessionService(config.reconnectTimeout);
  const http = Fastify({ logger: config.environment !== 'test' });
  const companies = new CompanyService();
  const map = new MapService(companies);
  const region = new RegionService(loadRegionData());

  // Недельный тик. Прототипная динамика городов подключена как последняя фаза (до этапа 13);
  // помесячная запись показателей городов (графики) — месячный хук.
  const phases: PhaseDef[] = [
    ...WEEKLY_PHASES,
    {
      name: 'city_dynamics',
      stage: null,
      run: async (ctx) => {
        // Сигналы экономики — пока число предприятий на участках города (настоящие показатели появятся с этапами 7–9).
        const rows = (await ctx.tx.query<{ city_id: string; total: string; industrial: string }>(
          `SELECT l.city_id, count(*) AS total, count(*) FILTER (WHERE e.kind IN ('farm','elevator','mill','bakery')) AS industrial
             FROM enterprises e JOIN map_lots l ON l.id = e.lot_id GROUP BY l.city_id`,
        )).rows;
        const sig = new Map(rows.map((r) => [r.city_id, r]));
        const detail: Record<string, { population: number; developed: number; new_lots: number }> = {};
        for (const id of await map.cityIds(ctx.tx)) {
          const s = sig.get(id);
          const step = await map.step(ctx.tx, id, ctx.tick, {
            operatingEnterprises: Number(s?.total ?? 0), industrialEnterprises: Number(s?.industrial ?? 0), retailUnitsSold: 0,
          });
          detail[id] = { population: step.stats.population, developed: step.developed.length, new_lots: step.new_lots.length };
        }
        return { cities: Object.keys(detail).length, detail };
      },
    },
  ];
  const monthHooks: HookDef[] = MONTHLY_HOOKS.map((h) =>
    h.name === 'macro_and_cities'
      ? {
          name: 'city_stats_history',
          stage: null,
          run: async (ctx) => {
            const closed = describeTick(ticks.clock, ctx.tick - 1);
            return { recorded: await region.recordMonthlyStats(ctx.tx, closed.month_index, closed.year, closed.month) };
          },
        }
      : h,
  );
  const ticks: TickRunner = new TickRunner(db, { worldId: config.worldId, phases, monthHooks, now: opts.now });

  let gateway: Gateway;
  const world = new World(config.tickRate, config.snapshotRate, (s) => gateway.broadcastSnapshot(s), () => {
    try {
      return ticks.info();
    } catch {
      return null; // часы ещё не загружены
    }
  });
  gateway = new Gateway(config, db, accounts, sessions, world, companies, map, region);
  let sweeper: NodeJS.Timeout | undefined;
  let scheduler: NodeJS.Timeout | undefined;
  let stopped = false;

  /** Планировщик: просыпается к ближайшему началу недели; при ошибке повторяет через 5 с (тик не пропускается). */
  const scheduleTicks = () => {
    if (stopped || !config.ticksEnabled) return;
    const now = (opts.now ?? Date.now)();
    const next = tickStartMs(ticks.clock, tickIndexAt(ticks.clock, now) + 1);
    const delay = Math.min(60_000, Math.max(50, next - now + 20));
    scheduler = setTimeout(async () => {
      let retry = false;
      try {
        const done = await ticks.processDue();
        if (done.length) http.log.info({ ticks: done }, 'Выполнены недельные тики');
      } catch (e) {
        retry = true;
        http.log.error(e, 'Ошибка недельного тика — повтор через 5 с');
      }
      if (retry) scheduler = setTimeout(scheduleTicks, 5000);
      else scheduleTicks();
    }, delay);
  };

  http.get('/health', async () => {
    let database = 'ok';
    try {
      await db.query('SELECT 1');
    } catch {
      database = 'unavailable';
    }
    return { status: database === 'ok' ? 'ok' : 'degraded', database, protocol_version: config.protocolVersion, server_tick: world.serverTick };
  });

  return {
    http,
    db,
    world,
    map,
    region,
    ticks,
    async start() {
      await runMigrations(db);
      await ensureNpcCompanies(db);
      await map.bootstrap(db, region.data);
      await ticks.ensureClock({
        epochMs: config.worldEpochMs, speed: config.timeSpeed, startYear: config.gameStartYear,
        startMonth: config.gameStartMonth, seed: config.worldSeed,
      });
      await sessions.markAllActiveDisconnected(db);
      gateway.attach(http.server);
      await http.listen({ host: config.host, port: config.port });
      world.start();
      if (config.ticksEnabled) {
        // Догоняющий расчёт после простоя — до включения регулярного планировщика.
        await ticks.processDue();
        scheduleTicks();
      }
      sweeper = setInterval(() => void sessions.closeExpired(db).catch(() => undefined), 30_000);
      const addr = http.server.address() as AddressInfo;
      return { host: addr.address, port: addr.port };
    },
    async stop() {
      stopped = true;
      if (sweeper) clearInterval(sweeper);
      if (scheduler) clearTimeout(scheduler);
      world.stop();
      await gateway.close();
      await http.close();
      if (ownDb) await db.end();
    },
  };
}

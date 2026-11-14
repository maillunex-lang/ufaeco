import Fastify, { type FastifyInstance } from 'fastify';
import type { AddressInfo } from 'node:net';
import { AccountService } from './accounts/index.js';
import { tickIndexAt, tickStartMs } from './clock/calendar.js';
import { TickRunner, WEEKLY_PHASES, type PhaseDef } from './clock/runner.js';
import { CompanyService } from './companies/index.js';
import { ensureNpcCompanies } from './companies/npc.js';
import type { ServerConfig } from './config.js';
import { Gateway } from './net/gateway.js';
import { createPool, type Db } from './persistence/db.js';
import { runMigrations } from './persistence/migrate.js';
import { SessionService } from './sessions/index.js';
import { World } from './world/index.js';
import { MapService } from './world_map/service.js';

export interface GameServer {
  readonly http: FastifyInstance;
  readonly db: Db;
  readonly world: World;
  readonly map: MapService;
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

  // Недельный тик. Прототипная динамика города подключена как последняя фаза (до этапа 13).
  const phases: PhaseDef[] = [
    ...WEEKLY_PHASES,
    {
      name: 'city_dynamics',
      stage: null,
      run: async (ctx) => {
        // Сигналы экономики — пока число предприятий на участках (настоящие показатели появятся с этапами 7–9).
        const r = await ctx.tx.query<{ total: string; industrial: string }>(
          `SELECT count(*) AS total, count(*) FILTER (WHERE kind IN ('farm','elevator','mill','bakery')) AS industrial FROM enterprises WHERE lot_id IS NOT NULL`,
        );
        const step = await map.step(ctx.tx, ctx.tick, {
          operatingEnterprises: Number(r.rows[0]!.total),
          industrialEnterprises: Number(r.rows[0]!.industrial),
          retailUnitsSold: 0,
        });
        return { population: step.stats.population, developed: step.developed.length, new_lots: step.new_lots.length, new_road_tiles: step.new_road_tiles };
      },
    },
  ];
  const ticks = new TickRunner(db, { worldId: config.worldId, phases, now: opts.now });

  let gateway: Gateway;
  const world = new World(config.tickRate, config.snapshotRate, (s) => gateway.broadcastSnapshot(s), () => {
    try {
      return ticks.info();
    } catch {
      return null; // часы ещё не загружены
    }
  });
  gateway = new Gateway(config, db, accounts, sessions, world, companies, map);
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
    ticks,
    async start() {
      await runMigrations(db);
      await ensureNpcCompanies(db);
      await map.bootstrap(db);
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

import Fastify, { type FastifyInstance } from 'fastify';
import type { AddressInfo } from 'node:net';
import type { ServerConfig } from './config.js';
import { AccountService } from './accounts/index.js';
import { CompanyService } from './companies/index.js';
import { EconomyService } from './economy/service.js';
import { Gateway } from './net/gateway.js';
import { createPool, type Db } from './persistence/db.js';
import { runMigrations } from './persistence/migrate.js';
import { SessionService } from './sessions/index.js';
import { World } from './world/index.js';

export interface GameServer {
  readonly http: FastifyInstance;
  readonly db: Db;
  readonly world: World;
  readonly economy: EconomyService;
  start(): Promise<{ host: string; port: number }>;
  stop(): Promise<void>;
}

export function createGameServer(config: ServerConfig, opts: { db?: Db } = {}): GameServer {
  const ownDb = !opts.db;
  const db = opts.db ?? createPool(config.databaseUrl);
  const accounts = new AccountService();
  const sessions = new SessionService(config.reconnectTimeout);
  const http = Fastify({ logger: config.environment !== 'test' });
  let gateway: Gateway;
  const companies = new CompanyService();
  const economy = new EconomyService(companies);
  let dayRunning = false;
  const refreshEconomy = async () => {
    const [day, prices] = await Promise.all([economy.currentDay(db), economy.getPrices(db)]);
    world.setEconomy(day, Object.fromEntries(prices.map((p) => [p.product_id, p.price_cents])));
  };
  const world: World = new World(config.tickRate, config.snapshotRate, (s) => gateway.broadcastSnapshot(s), config.economyDayTicks, () => {
    if (dayRunning) return; // предыдущий день ещё считается
    dayRunning = true;
    economy.runDay(db).then(refreshEconomy).catch((e) => http.log.error(e, 'Ошибка экономического дня')).finally(() => { dayRunning = false; });
  });
  gateway = new Gateway(config, db, accounts, sessions, world, companies, economy);
  let sweeper: NodeJS.Timeout | undefined;

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
    economy,
    async start() {
      await runMigrations(db);
      await economy.bootstrap(db);
      await refreshEconomy();
      await sessions.markAllActiveDisconnected(db);
      gateway.attach(http.server);
      await http.listen({ host: config.host, port: config.port });
      world.start();
      sweeper = setInterval(() => void sessions.closeExpired(db).catch(() => undefined), 30_000);
      const addr = http.server.address() as AddressInfo;
      return { host: addr.address, port: addr.port };
    },
    async stop() {
      if (sweeper) clearInterval(sweeper);
      world.stop();
      await gateway.close();
      await http.close();
      if (ownDb) await db.end();
    },
  };
}

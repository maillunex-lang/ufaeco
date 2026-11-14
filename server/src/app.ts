import Fastify, { type FastifyInstance } from 'fastify';
import type { AddressInfo } from 'node:net';
import type { ServerConfig } from './config.js';
import { AccountService } from './accounts/index.js';
import { CompanyService } from './companies/index.js';
import { Gateway } from './net/gateway.js';
import { createPool, type Db } from './persistence/db.js';
import { runMigrations } from './persistence/migrate.js';
import { SessionService } from './sessions/index.js';
import { World } from './world/index.js';

export interface GameServer {
  readonly http: FastifyInstance;
  readonly db: Db;
  readonly world: World;
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
  const world = new World(config.tickRate, config.snapshotRate, (s) => gateway.broadcastSnapshot(s));
  gateway = new Gateway(config, db, accounts, sessions, world, new CompanyService());
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
    async start() {
      await runMigrations(db);
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

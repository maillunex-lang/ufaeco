import { z } from 'zod';

const intFrom = (def: number, min: number, max: number) =>
  z.coerce.number().int().min(min).max(max).default(def);

const schema = z.object({
  ENVIRONMENT: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('127.0.0.1'),
  PORT: intFrom(8080, 0, 65535),
  SERVER_URL: z.string().default('http://127.0.0.1:8080'),
  WEBSOCKET_URL: z.string().default('ws://127.0.0.1:8080/ws'),
  DATABASE_URL: z.string().default('postgres://basheco:basheco_dev_only@127.0.0.1:5432/basheco_dev'),
  PROTOCOL_VERSION: intFrom(1, 1, 1000),
  TICK_RATE: intFrom(10, 1, 60),
  SNAPSHOT_RATE: intFrom(2, 1, 20),
  RECONNECT_TIMEOUT: intFrom(60, 1, 86400),
  MAX_MESSAGE_SIZE: intFrom(16384, 256, 1048576),
  HEARTBEAT_INTERVAL_MS: intFrom(5000, 100, 60000),
  /** Тиков в экономическом дне; 0 — автоматический расчёт отключён (тесты). */
  ECONOMY_DAY_TICKS: intFrom(600, 0, 10_000_000),
  RATE_LIMIT_BURST: intFrom(30, 1, 1000),
  RATE_LIMIT_PER_SECOND: intFrom(10, 1, 1000),
});

export interface ServerConfig {
  environment: 'development' | 'test' | 'production';
  host: string;
  port: number;
  serverUrl: string;
  websocketUrl: string;
  databaseUrl: string;
  protocolVersion: number;
  tickRate: number;
  snapshotRate: number;
  /** секунды */
  reconnectTimeout: number;
  /** байты */
  maxMessageSize: number;
  heartbeatIntervalMs: number;
  economyDayTicks: number;
  rateLimitBurst: number;
  rateLimitPerSecond: number;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): ServerConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Неверная конфигурация сервера: ${details}`);
  }
  const e = parsed.data;
  if (e.ENVIRONMENT === 'production' && e.DATABASE_URL.includes('basheco_dev_only')) {
    throw new Error('Неверная конфигурация сервера: в production нельзя использовать dev-пароль базы данных');
  }
  return {
    environment: e.ENVIRONMENT,
    host: e.HOST,
    port: e.PORT,
    serverUrl: e.SERVER_URL,
    websocketUrl: e.WEBSOCKET_URL,
    databaseUrl: e.DATABASE_URL,
    protocolVersion: e.PROTOCOL_VERSION,
    tickRate: e.TICK_RATE,
    snapshotRate: e.SNAPSHOT_RATE,
    reconnectTimeout: e.RECONNECT_TIMEOUT,
    maxMessageSize: e.MAX_MESSAGE_SIZE,
    heartbeatIntervalMs: e.HEARTBEAT_INTERVAL_MS,
    economyDayTicks: e.ECONOMY_DAY_TICKS,
    rateLimitBurst: e.RATE_LIMIT_BURST,
    rateLimitPerSecond: e.RATE_LIMIT_PER_SECOND,
  };
}

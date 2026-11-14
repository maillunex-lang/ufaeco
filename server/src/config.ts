import { z } from 'zod';
import { alignToMonthStart } from './clock/calendar.js';

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
  WORLD_ID: z.string().regex(/^[a-z0-9_-]{1,32}$/).default('main'),
  WORLD_SEED: intFrom(20241114, 0, 2_147_483_647),
  /** Начало месяца №0 (ISO, 09:00 по Уфе = 04:00 UTC). Не задан — ближайшее 09:00 по Уфе. Применяется при создании мира. */
  WORLD_EPOCH: z.string().datetime().optional(),
  GAME_START_YEAR: intFrom(2026, 1900, 2200),
  GAME_START_MONTH: intFrom(1, 1, 12),
  /** Ускорение игрового времени. В production — только 1. */
  TIME_SPEED: z.coerce.number().min(1).max(1_000_000).default(1),
  /** false — планировщик тиков выключен (тесты вызывают TickRunner вручную). */
  TICKS_ENABLED: z.enum(['true', 'false']).default('true'),
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
  worldId: string;
  worldSeed: number;
  worldEpochMs: number | undefined;
  gameStartYear: number;
  gameStartMonth: number;
  timeSpeed: number;
  ticksEnabled: boolean;
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
  if (e.ENVIRONMENT === 'production' && e.TIME_SPEED !== 1) {
    throw new Error('Неверная конфигурация сервера: ускорение времени (TIME_SPEED) допустимо только вне production');
  }
  if (e.WORLD_EPOCH && alignToMonthStart(Date.parse(e.WORLD_EPOCH)) !== Date.parse(e.WORLD_EPOCH)) {
    throw new Error('Неверная конфигурация сервера: WORLD_EPOCH должен совпадать с 09:00 по Уфе (04:00 UTC)');
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
    worldId: e.WORLD_ID,
    worldSeed: e.WORLD_SEED,
    worldEpochMs: e.WORLD_EPOCH ? Date.parse(e.WORLD_EPOCH) : undefined,
    gameStartYear: e.GAME_START_YEAR,
    gameStartMonth: e.GAME_START_MONTH,
    timeSpeed: e.TIME_SPEED,
    ticksEnabled: e.TICKS_ENABLED === 'true',
    rateLimitBurst: e.RATE_LIMIT_BURST,
    rateLimitPerSecond: e.RATE_LIMIT_PER_SECOND,
  };
}

import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('конфигурация', () => {
  it('безопасные значения по умолчанию для локального запуска', () => {
    const c = loadConfig({});
    expect(c).toMatchObject({ environment: 'development', host: '127.0.0.1', port: 8080, protocolVersion: 1, tickRate: 10, snapshotRate: 2, reconnectTimeout: 60, maxMessageSize: 16384 });
    expect(c.websocketUrl).toBe('ws://127.0.0.1:8080/ws');
  });
  it('отклоняет неверные значения', () => {
    expect(() => loadConfig({ TICK_RATE: '0' })).toThrow(/Неверная конфигурация/);
    expect(() => loadConfig({ ENVIRONMENT: 'staging' })).toThrow(/Неверная конфигурация/);
  });
  it('в production нельзя использовать dev-пароль БД', () => {
    expect(() => loadConfig({ ENVIRONMENT: 'production' })).toThrow(/dev-пароль/);
    expect(() => loadConfig({ ENVIRONMENT: 'production', DATABASE_URL: 'postgres://u:secret@db/prod' })).not.toThrow();
  });
});

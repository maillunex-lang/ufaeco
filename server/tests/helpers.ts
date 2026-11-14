import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { createGameServer, type GameServer } from '../src/app.js';
import { loadConfig, type ServerConfig } from '../src/config.js';
import { serverMessageSchema } from '../src/protocol/schemas.js';

export const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://basheco:basheco_dev_only@127.0.0.1:5432/basheco_test';

export function testConfig(over: Record<string, string> = {}): ServerConfig {
  return loadConfig({
    ENVIRONMENT: 'test',
    PORT: '0',
    DATABASE_URL: TEST_DB_URL,
    TICK_RATE: '20',
    SNAPSHOT_RATE: '10',
    MAX_MESSAGE_SIZE: '4096',
    RECONNECT_TIMEOUT: '60',
    ...over,
  });
}

export async function startServer(over: Record<string, string> = {}) {
  const server: GameServer = createGameServer(testConfig(over));
  const addr = await server.start();
  return { server, url: `ws://127.0.0.1:${addr.port}/ws`, httpUrl: `http://127.0.0.1:${addr.port}` };
}

export interface Msg {
  protocol_version: number;
  message_id: string;
  type: string;
  request_id?: string;
  payload: Record<string, any>;
}

export class TestClient {
  readonly messages: Msg[] = [];
  closeCode: number | undefined;
  private waiters: { pred: (m: Msg) => boolean; resolve: (m: Msg) => void }[] = [];
  private closeWaiters: ((c: number) => void)[] = [];

  private constructor(readonly ws: WebSocket) {
    ws.on('message', (data) => {
      const m = JSON.parse(String(data)) as Msg;
      // каждое исходящее сообщение сервера обязано соответствовать схеме протокола
      const check = serverMessageSchema.safeParse(m);
      if (!check.success) throw new Error(`Сервер прислал сообщение вне схемы: ${JSON.stringify(m)} ${check.error.message}`);
      this.messages.push(m);
      this.waiters = this.waiters.filter((w) => {
        if (w.pred(m)) {
          w.resolve(m);
          return false;
        }
        return true;
      });
    });
    ws.on('close', (code) => {
      this.closeCode = code;
      this.closeWaiters.forEach((r) => r(code));
    });
  }

  static async connect(url: string): Promise<TestClient> {
    const ws = new WebSocket(url);
    const c = new TestClient(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    return c;
  }

  waitFor(pred: (m: Msg) => boolean, ms = 5000): Promise<Msg> {
    const found = this.messages.find(pred);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Таймаут ожидания сообщения')), ms);
      this.waiters.push({ pred, resolve: (m) => { clearTimeout(t); resolve(m); } });
    });
  }

  waitType(type: string, ms?: number) {
    return this.waitFor((m) => m.type === type, ms);
  }

  /** Ждёт НОВОЕ сообщение типа (игнорирует уже полученные). */
  nextOfType(type: string, ms = 5000): Promise<Msg> {
    const seen = new Set(this.messages);
    return this.waitFor((m) => m.type === type && !seen.has(m), ms);
  }

  waitClose(ms = 5000): Promise<number> {
    if (this.closeCode !== undefined) return Promise.resolve(this.closeCode);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Таймаут ожидания закрытия')), ms);
      this.closeWaiters.push((c) => { clearTimeout(t); resolve(c); });
    });
  }

  sendRaw(data: string | Buffer) {
    this.ws.send(data);
  }

  send(type: string, payload: Record<string, unknown>, extra: { request_id?: string; protocol_version?: number } = {}) {
    const msg: Record<string, unknown> = {
      protocol_version: extra.protocol_version ?? 1,
      message_id: randomUUID(),
      type,
      payload,
    };
    if (extra.request_id) msg.request_id = extra.request_id;
    this.ws.send(JSON.stringify(msg));
  }

  async authenticate(displayName?: string): Promise<Msg> {
    await this.waitType('hello');
    this.send('auth', { client_name: 'vitest', client_version: '0.0.1', ...(displayName ? { display_name: displayName } : {}) });
    return this.waitType('auth_ok');
  }

  async register(login: string, password = 'correct-horse-1', displayName?: string): Promise<Msg> {
    await this.waitType('hello');
    this.send('register', { client_name: 'vitest', client_version: '0.0.1', login, password, ...(displayName ? { display_name: displayName } : {}) });
    return this.waitFor((m) => m.type === 'auth_ok' || m.type === 'error');
  }

  async login(login: string, password = 'correct-horse-1'): Promise<Msg> {
    await this.waitType('hello');
    this.send('login', { client_name: 'vitest', client_version: '0.0.1', login, password });
    return this.waitFor((m) => m.type === 'auth_ok' || m.type === 'error');
  }

  command(name: string, args: Record<string, unknown>, requestId: string = randomUUID()) {
    const before = new Set(this.messages);
    this.send('command', { name, args }, { request_id: requestId });
    return this.waitFor((m) => (m.type === 'command_result' || m.type === 'error') && m.request_id === requestId && !before.has(m));
  }

  terminate() {
    this.ws.terminate();
  }

  async closeGracefully() {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.close();
      await this.waitClose().catch(() => undefined);
    }
  }
}

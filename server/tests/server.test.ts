import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, TestClient } from './helpers.js';

let ctx: Awaited<ReturnType<typeof startServer>>;
const opened: TestClient[] = [];
async function client(): Promise<TestClient> {
  const c = await TestClient.connect(ctx.url);
  opened.push(c);
  return c;
}
const count = async (sql: string, params: unknown[] = []) =>
  Number((await ctx.server.db.query(sql, params)).rows[0].n);

beforeAll(async () => {
  ctx = await startServer();
});
afterAll(async () => {
  await Promise.all(opened.map((c) => c.closeGracefully()));
  await ctx.server.stop();
});

describe('сервер и подключение', () => {
  it('1. сервер стартует и отвечает на /health', async () => {
    const res = await fetch(`${ctx.httpUrl}/health`);
    const body = (await res.json()) as { status: string; database: string; protocol_version: number };
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ status: 'ok', database: 'ok', protocol_version: 1 });
  });

  it('2-3. клиент подключается и проходит hello/auth', async () => {
    const c = await client();
    const hello = await c.waitType('hello');
    expect(hello.payload.protocol_version).toBe(1);
    c.send('auth', { client_name: 'vitest', client_version: '1.0.0', display_name: 'Тестовый игрок' });
    const ok = await c.waitType('auth_ok');
    expect(ok.payload.player_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(ok.payload.session_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(ok.payload.display_name).toBe('Тестовый игрок');
    expect(ok.payload.resumed).toBe(false);
    const snap = await c.waitType('world_snapshot');
    expect(snap.payload.world_id).toBe('bashkortostan-main');
  });

  it('heartbeat возвращает server_tick', async () => {
    const c = await client();
    await c.authenticate();
    c.send('heartbeat', { client_time: 123 });
    const hb = await c.waitType('heartbeat');
    expect(hb.payload.client_time).toBe(123);
    expect(hb.payload.server_tick).toBeGreaterThanOrEqual(0);
  });

  it('4-5. второй клиент подключается к тому же миру, оба видят одинаковый server_tick', async () => {
    const a = await client();
    const b = await client();
    const okA = await a.authenticate('Игрок А');
    const okB = await b.authenticate('Игрок Б');
    expect(okA.payload.player_id).not.toBe(okB.payload.player_id);

    await new Promise((r) => setTimeout(r, 800)); // несколько общих snapshots
    const ticks = (c: TestClient) =>
      new Set(c.messages.filter((m) => m.type === 'world_snapshot').map((m) => m.payload.server_tick as number));
    const tb = ticks(b);
    const common = [...ticks(a)].filter((t) => tb.has(t));
    expect(common.length).toBeGreaterThan(0);

    const last = b.messages.filter((m) => m.type === 'world_snapshot').at(-1)!;
    const ids = (last.payload.players as { player_id: string }[]).map((p) => p.player_id);
    expect(ids).toContain(okA.payload.player_id);
    expect(ids).toContain(okB.payload.player_id);
    // тик монотонно растёт
    const seq = a.messages.filter((m) => m.type === 'world_snapshot').map((m) => m.payload.server_tick as number);
    expect([...seq].sort((x, y) => x - y)).toEqual(seq);
  });
});

describe('reconnect', () => {
  it('6. reconnect восстанавливает сессию и ротирует resume_token', async () => {
    const a = await client();
    const ok = await a.authenticate('Возвращенец');
    a.terminate(); // обрыв без disconnect
    await a.waitClose();
    await new Promise((r) => setTimeout(r, 200));
    const status = (await ctx.server.db.query('SELECT status FROM sessions WHERE id = $1', [ok.payload.session_id])).rows[0].status;
    expect(status).toBe('disconnected');

    const b = await client();
    await b.waitType('hello');
    b.send('reconnect', { session_id: ok.payload.session_id, resume_token: ok.payload.resume_token });
    const again = await b.waitType('auth_ok');
    expect(again.payload.resumed).toBe(true);
    expect(again.payload.player_id).toBe(ok.payload.player_id);
    expect(again.payload.session_id).toBe(ok.payload.session_id);
    expect(again.payload.resume_token).not.toBe(ok.payload.resume_token);
    expect(again.payload.display_name).toBe('Возвращенец');

    // старый токен больше не действует
    const c = await client();
    await c.waitType('hello');
    c.send('reconnect', { session_id: ok.payload.session_id, resume_token: ok.payload.resume_token });
    const err = await c.waitType('error');
    expect(err.payload.code).toBe('invalid_session');
  });

  it('reconnect с неверным токеном отклоняется', async () => {
    const c = await client();
    await c.waitType('hello');
    c.send('reconnect', { session_id: randomUUID(), resume_token: 'x'.repeat(43) });
    expect((await c.waitType('error')).payload.code).toBe('invalid_session');
  });

  it('просроченная сессия не восстанавливается', async () => {
    const a = await client();
    const ok = await a.authenticate();
    a.terminate();
    await a.waitClose();
    await new Promise((r) => setTimeout(r, 200));
    await ctx.server.db.query("UPDATE sessions SET expires_at = now() - interval '1 second' WHERE id = $1", [ok.payload.session_id]);
    const b = await client();
    await b.waitType('hello');
    b.send('reconnect', { session_id: ok.payload.session_id, resume_token: ok.payload.resume_token });
    expect((await b.waitType('error')).payload.code).toBe('session_expired');
  });

  it('новое подключение с той же сессией вытесняет старое', async () => {
    const a = await client();
    const ok = await a.authenticate();
    const b = await client();
    await b.waitType('hello');
    b.send('reconnect', { session_id: ok.payload.session_id, resume_token: ok.payload.resume_token });
    await b.waitType('auth_ok');
    const d = await a.waitType('disconnect');
    expect(d.payload.reason).toBe('replaced_by_new_connection');
  });
});

describe('валидация протокола', () => {
  it('7. неправильная версия протокола отклоняется', async () => {
    const c = await client();
    await c.waitType('hello');
    c.send('auth', { client_name: 'x', client_version: '1' }, { protocol_version: 99 });
    expect((await c.waitType('error')).payload.code).toBe('unsupported_protocol_version');
    expect(await c.waitClose()).toBe(1002);
  });

  it('невалидный JSON, лишние поля и неизвестный тип отклоняются', async () => {
    const c = await client();
    await c.waitType('hello');
    c.sendRaw('{not json');
    expect((await c.nextOfType('error')).payload.code).toBe('invalid_message');
    c.sendRaw(JSON.stringify({ protocol_version: 1, message_id: randomUUID(), type: 'auth', payload: {}, extra: 1 }));
    expect((await c.nextOfType('error')).payload.code).toBe('invalid_message');
    c.send('teleport', {});
    expect((await c.nextOfType('error')).payload.code).toBe('unknown_message_type');
    c.send('auth', { client_name: 'x' }); // нет client_version
    expect((await c.nextOfType('error')).payload.code).toBe('invalid_payload');
  });

  it('8. слишком большое сообщение отклоняется (закрытие 1009)', async () => {
    const c = await client();
    await c.waitType('hello');
    c.sendRaw(JSON.stringify({ pad: 'я'.repeat(5000) }));
    expect(await c.waitClose()).toBe(1009);
  });

  it('команда до авторизации отклоняется', async () => {
    const c = await client();
    await c.waitType('hello');
    const r = await c.command('session.get_profile', {});
    expect(r.type).toBe('error');
    expect(r.payload.code).toBe('not_authenticated');
  });

  it('повторная авторизация отклоняется', async () => {
    const c = await client();
    await c.authenticate();
    c.send('auth', { client_name: 'x', client_version: '1' });
    expect((await c.nextOfType('error')).payload.code).toBe('already_authenticated');
  });
});

describe('команды, идемпотентность, недоверие клиенту', () => {
  it('9. неизвестная команда отклоняется', async () => {
    const c = await client();
    await c.authenticate();
    const r = await c.command('economy.give_money', { amount: 1000000 });
    expect(r.type).toBe('command_result');
    expect(r.payload.ok).toBe(false);
    expect(r.payload.error.code).toBe('unknown_command');
  });

  it('команда без request_id отклоняется', async () => {
    const c = await client();
    await c.authenticate();
    c.send('command', { name: 'session.get_profile', args: {} });
    expect((await c.nextOfType('error')).payload.code).toBe('request_id_required');
  });

  it('10. повторный request_id не выполняет операцию повторно', async () => {
    const c = await client();
    const ok = await c.authenticate('Исходное имя');
    const playerId = ok.payload.player_id as string;
    const first = randomUUID();

    const r1 = await c.command('session.set_display_name', { display_name: 'Имя А' }, first);
    expect(r1.payload.ok).toBe(true);
    expect(r1.payload.duplicate).toBe(false);

    const r2 = await c.command('session.set_display_name', { display_name: 'Имя Б' }, randomUUID());
    expect(r2.payload.duplicate).toBe(false);

    // повтор первого request_id: сохранённый результат, имя в БД остаётся «Имя Б»
    const r3 = await c.command('session.set_display_name', { display_name: 'Имя А' }, first);
    expect(r3.payload.duplicate).toBe(true);
    expect(r3.payload.result.display_name).toBe('Имя А');
    const name = (await ctx.server.db.query('SELECT display_name FROM players WHERE id = $1', [playerId])).rows[0].display_name;
    expect(name).toBe('Имя Б');
    expect(await count('SELECT count(*) n FROM idempotency_requests WHERE player_id = $1', [playerId])).toBe(2);
    expect(
      await count("SELECT count(*) n FROM audit_log WHERE player_id = $1 AND event_type = 'command_executed'", [playerId]),
    ).toBe(2);

    // тот же request_id с другим телом — конфликт
    const r4 = await c.command('session.set_display_name', { display_name: 'Имя В' }, first);
    expect(r4.type).toBe('error');
    expect(r4.payload.code).toBe('request_id_conflict');
  });

  it('параллельные дубликаты request_id выполняются один раз', async () => {
    const c = await client();
    const ok = await c.authenticate();
    const id = randomUUID();
    const before = new Set(c.messages);
    for (let i = 0; i < 3; i++) c.send('command', { name: 'session.set_display_name', args: { display_name: 'Параллель' } }, { request_id: id });
    await c.waitFor((m) => m.type === 'command_result' && m.request_id === id && !before.has(m));
    await new Promise((r) => setTimeout(r, 300));
    const results = c.messages.filter((m) => m.type === 'command_result' && m.request_id === id);
    expect(results.length).toBe(3);
    expect(results.filter((m) => m.payload.duplicate === false).length).toBe(1);
    expect(await count('SELECT count(*) n FROM idempotency_requests WHERE request_id = $1', [id])).toBe(1);
    expect(
      await count("SELECT count(*) n FROM audit_log WHERE player_id = $1 AND event_type = 'command_executed'", [ok.payload.player_id]),
    ).toBe(1);
  });

  it('11. сервер не принимает клиентский баланс, товары и собственность', async () => {
    const c = await client();
    const ok = await c.authenticate('Честный игрок');
    for (const extra of [{ balance: 999999999 }, { inventory: { grain: 1000 } }, { owner_company_id: randomUUID() }]) {
      const r = await c.command('session.set_display_name', { display_name: 'Хакер', ...extra });
      expect(r.payload.ok).toBe(false);
      expect(r.payload.error.code).toBe('invalid_payload');
    }
    const name = (await ctx.server.db.query('SELECT display_name FROM players WHERE id = $1', [ok.payload.player_id])).rows[0].display_name;
    expect(name).toBe('Честный игрок');
    // баланс в auth тоже запрещён
    const d = await client();
    await d.waitType('hello');
    d.send('auth', { client_name: 'x', client_version: '1', balance: 1e9 });
    expect((await d.waitType('error')).payload.code).toBe('invalid_payload');
    // отклонённая команда не расходует request_id
    expect(await count('SELECT count(*) n FROM idempotency_requests WHERE player_id = $1', [ok.payload.player_id])).toBe(0);
  });

  it('12. записи audit_log создаются', async () => {
    const c = await client();
    const ok = await c.authenticate();
    const pid = ok.payload.player_id as string;
    await c.command('session.get_profile', {});
    await c.command('nope.nope', {});
    await c.closeGracefully();
    await new Promise((r) => setTimeout(r, 300));
    const types = (await ctx.server.db.query('SELECT event_type FROM audit_log WHERE player_id = $1 ORDER BY id', [pid])).rows.map((r) => r.event_type);
    expect(types).toEqual(['session_created', 'command_executed', 'command_rejected', 'session_disconnected']);
  });

  it('client disconnect закрывает сессию без reconnect', async () => {
    const c = await client();
    const ok = await c.authenticate();
    c.send('disconnect', { reason: 'client_closing' });
    await c.waitClose();
    const b = await client();
    await b.waitType('hello');
    b.send('reconnect', { session_id: ok.payload.session_id, resume_token: ok.payload.resume_token });
    expect((await b.waitType('error')).payload.code).toBe('invalid_session');
  });
});

describe('rate limit', () => {
  it('частые сообщения ограничиваются, злоупотребление разрывает соединение', async () => {
    const limited = await startServer({ RATE_LIMIT_BURST: '5', RATE_LIMIT_PER_SECOND: '1' });
    try {
      const c = await TestClient.connect(limited.url);
      await c.waitType('hello');
      for (let i = 0; i < 20; i++) c.send('heartbeat', { client_time: i });
      const closeCode = await c.waitClose();
      const errors = c.messages.filter((m) => m.type === 'error' && m.payload.code === 'rate_limited');
      expect(errors.length).toBeGreaterThanOrEqual(5);
      expect(c.messages.some((m) => m.type === 'disconnect' && m.payload.reason === 'rate_limited')).toBe(true);
      expect(closeCode).toBe(1008);
    } finally {
      await limited.server.stop();
    }
  });
});

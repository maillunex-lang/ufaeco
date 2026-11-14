import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket } from 'ws';
import type { ServerConfig } from '../config.js';
import { SPEC } from '../protocol/constants.js';
import { ERROR_MESSAGES_RU, makeMessage } from '../protocol/messages.js';
import {
  clientPayloadSchemas,
  commandArgSchemas,
  envelopeSchema,
  type ClientMessageType,
  type CommandName,
  type Envelope,
  type ServerMessageType,
} from '../protocol/schemas.js';
import type { Db, Queryable } from '../persistence/db.js';
import { withTransaction } from '../persistence/db.js';
import { writeAudit } from '../persistence/audit.js';
import { executeOnce, hashRequest } from '../persistence/idempotency.js';
import { RateLimiter } from '../security/rate-limiter.js';
import type { AccountService, Player } from '../accounts/index.js';
import { commandHandlers, type Services } from '../commands/registry.js';
import { DomainError } from '../errors.js';
import { LoginGuard } from '../security/login-guard.js';
import type { SessionService } from '../sessions/index.js';
import type { World, WorldSnapshot } from '../world/index.js';
import type { CompanyService } from '../companies/index.js';

const MAX_RATE_VIOLATIONS = 5;

interface PasswordAuth {
  client_name: string;
  client_version: string;
  login: string;
  password: string;
  display_name?: string;
}

interface Conn {
  ws: WebSocket;
  limiter: RateLimiter;
  violations: number;
  lastActivity: number;
  authTimer?: NodeJS.Timeout;
  queue: Promise<void>;
  auth?: { playerId: string; sessionId: string; displayName: string };
  /** true, если сессия уже закрыта/заменена и при close() её не нужно помечать отключённой */
  detached: boolean;
}

export class Gateway {
  private readonly wss: WebSocketServer;
  private readonly conns = new Set<Conn>();
  private readonly bySession = new Map<string, Conn>();
  private heartbeatTimer?: NodeJS.Timeout;
  private readonly loginGuard = new LoginGuard();
  private readonly services: Services;

  constructor(
    private readonly cfg: ServerConfig,
    private readonly db: Db,
    private readonly accounts: AccountService,
    private readonly sessions: SessionService,
    private readonly world: World,
    private readonly companies: CompanyService,
  ) {
    this.services = { accounts, companies, world };
    this.wss = new WebSocketServer({ noServer: true, maxPayload: cfg.maxMessageSize });
    this.wss.on('connection', (ws) => this.onConnection(ws));
  }

  attach(server: Server): void {
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const path = (req.url ?? '').split('?')[0];
      if (path !== SPEC.websocket_path) {
        socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit('connection', ws, req));
    });
    this.heartbeatTimer = setInterval(() => this.sweepHeartbeats(), this.cfg.heartbeatIntervalMs);
  }

  broadcastSnapshot(s: WorldSnapshot): void {
    const raw = JSON.stringify(makeMessage(this.cfg.protocolVersion, 'world_snapshot', { ...s }));
    for (const c of this.conns) if (c.auth && c.ws.readyState === WebSocket.OPEN) c.ws.send(raw);
  }

  async close(): Promise<void> {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    const open = [...this.conns];
    for (const c of open) {
      this.send(c, 'disconnect', { reason: 'server_shutdown' });
      c.ws.close(1001, 'server_shutdown');
    }
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    // дождаться закрытия сокетов и отметки сессий как disconnected
    await Promise.all(open.map((c) => new Promise<void>((r) => (c.ws.readyState === WebSocket.CLOSED ? r() : c.ws.once('close', () => r())))));
    await Promise.all(open.map((c) => c.queue));
  }

  // ---------------------------------------------------------------- connection

  private onConnection(ws: WebSocket): void {
    const conn: Conn = {
      ws,
      limiter: new RateLimiter(this.cfg.rateLimitBurst, this.cfg.rateLimitPerSecond),
      violations: 0,
      lastActivity: Date.now(),
      queue: Promise.resolve(),
      detached: false,
    };
    this.conns.add(conn);
    conn.authTimer = setTimeout(() => {
      if (!conn.auth) {
        this.sendError(conn, 'auth_timeout');
        ws.close(1008, 'auth_timeout');
      }
    }, SPEC.limits.auth_timeout_ms);

    this.send(conn, 'hello', {
      server_name: 'basheco-server',
      protocol_version: this.cfg.protocolVersion,
      heartbeat_interval_ms: this.cfg.heartbeatIntervalMs,
      auth_timeout_ms: SPEC.limits.auth_timeout_ms,
      max_message_size: this.cfg.maxMessageSize,
    });

    ws.on('message', (data, isBinary) => {
      conn.lastActivity = Date.now();
      // Сообщения одного соединения обрабатываются строго по очереди.
      conn.queue = conn.queue.then(() => this.onRaw(conn, data, isBinary)).catch((err) => {
        console.error('Необработанная ошибка соединения', err);
        this.sendError(conn, 'internal_error');
      });
    });
    ws.on('error', () => {
      /* ошибки сокета (например, 1009) завершаются событием close */
    });
    ws.on('close', () => {
      conn.queue = conn.queue.then(() => this.onClose(conn)).catch((err) => console.error('Ошибка закрытия', err));
    });
  }

  private async onClose(conn: Conn): Promise<void> {
    if (conn.authTimer) clearTimeout(conn.authTimer);
    this.conns.delete(conn);
    const a = conn.auth;
    if (!a || conn.detached) return;
    if (this.bySession.get(a.sessionId) === conn) this.bySession.delete(a.sessionId);
    this.world.leave(a.sessionId);
    await withTransaction(this.db, async (tx) => {
      await this.sessions.markDisconnected(tx, a.sessionId);
      await writeAudit(tx, { playerId: a.playerId, sessionId: a.sessionId, eventType: 'session_disconnected' });
    });
  }

  private sweepHeartbeats(): void {
    const limit = this.cfg.heartbeatIntervalMs * 3;
    const now = Date.now();
    for (const c of this.conns) {
      if (c.auth && now - c.lastActivity > limit) {
        this.send(c, 'disconnect', { reason: 'heartbeat_timeout' });
        c.ws.close(1000, 'heartbeat_timeout');
      }
    }
  }

  // ---------------------------------------------------------------- sending

  private send(c: Conn, type: ServerMessageType, payload: Record<string, unknown>, requestId?: string): void {
    if (c.ws.readyState === WebSocket.OPEN) {
      c.ws.send(JSON.stringify(makeMessage(this.cfg.protocolVersion, type, payload, requestId)));
    }
  }

  private sendError(c: Conn, code: string, requestId?: string): void {
    this.send(c, 'error', { code, message: ERROR_MESSAGES_RU[code] ?? code }, requestId);
  }

  // ---------------------------------------------------------------- incoming

  private async onRaw(conn: Conn, data: unknown, isBinary: boolean): Promise<void> {
    if (isBinary) return this.sendError(conn, 'invalid_message');

    if (!conn.limiter.tryConsume()) {
      conn.violations += 1;
      this.sendError(conn, 'rate_limited');
      if (conn.violations >= MAX_RATE_VIOLATIONS) {
        this.send(conn, 'disconnect', { reason: 'rate_limited' });
        conn.ws.close(1008, 'rate_limited');
      }
      return;
    }

    let raw: unknown;
    try {
      raw = JSON.parse(String(data));
    } catch {
      return this.sendError(conn, 'invalid_message');
    }

    // Версию проверяем до остальной структуры, чтобы клиент получил точную причину.
    if (typeof raw === 'object' && raw !== null && 'protocol_version' in raw) {
      const v = (raw as { protocol_version: unknown }).protocol_version;
      if (typeof v === 'number' && v !== this.cfg.protocolVersion) {
        this.sendError(conn, 'unsupported_protocol_version');
        this.send(conn, 'disconnect', { reason: 'protocol_error' });
        conn.ws.close(1002, 'unsupported_protocol_version');
        return;
      }
    }

    const env = envelopeSchema.safeParse(raw);
    if (!env.success) return this.sendError(conn, 'invalid_message');
    const msg = env.data;

    if (!(msg.type in clientPayloadSchemas)) return this.sendError(conn, 'unknown_message_type', msg.request_id);
    const type = msg.type as ClientMessageType;
    const payload = clientPayloadSchemas[type].safeParse(msg.payload);
    if (!payload.success) return this.sendError(conn, 'invalid_payload', msg.request_id);

    switch (type) {
      case 'heartbeat': {
        const p = payload.data as { client_time: number };
        return this.send(conn, 'heartbeat', {
          client_time: p.client_time,
          server_time: Date.now(),
          server_tick: this.world.serverTick,
        }, msg.request_id);
      }
      case 'auth':
        return this.handleAuth(conn, payload.data as { client_name: string; client_version: string; display_name?: string });
      case 'register':
        return this.handlePasswordAuth(conn, 'register', payload.data as PasswordAuth);
      case 'login':
        return this.handlePasswordAuth(conn, 'login', payload.data as PasswordAuth);
      case 'reconnect':
        return this.handleReconnect(conn, payload.data as { session_id: string; resume_token: string });
      case 'disconnect':
        return this.handleClientDisconnect(conn);
      case 'command':
        return this.handleCommand(conn, msg, payload.data as { name: string; args: Record<string, unknown> });
    }
  }

  // ---------------------------------------------------------------- auth

  private bindAuthenticated(
    conn: Conn,
    a: { playerId: string; sessionId: string; displayName: string; token: string; resumed: boolean },
  ): void {
    if (conn.authTimer) clearTimeout(conn.authTimer);
    const previous = this.bySession.get(a.sessionId);
    if (previous && previous !== conn) {
      previous.detached = true;
      this.send(previous, 'disconnect', { reason: 'replaced_by_new_connection' });
      previous.ws.close(1000, 'replaced');
    }
    conn.auth = { playerId: a.playerId, sessionId: a.sessionId, displayName: a.displayName };
    this.bySession.set(a.sessionId, conn);
    this.world.join(a.sessionId, a.playerId, a.displayName);
    this.send(conn, 'auth_ok', {
      player_id: a.playerId,
      session_id: a.sessionId,
      resume_token: a.token,
      display_name: a.displayName,
      server_tick: this.world.serverTick,
      heartbeat_interval_ms: this.cfg.heartbeatIntervalMs,
      reconnect_timeout_s: this.cfg.reconnectTimeout,
      resumed: a.resumed,
    });
    this.send(conn, 'world_snapshot', { ...this.world.snapshot() });
  }

  private async handleAuth(conn: Conn, p: { client_name: string; client_version: string; display_name?: string }): Promise<void> {
    if (conn.auth) return this.sendError(conn, 'already_authenticated');
    const res = await withTransaction(this.db, async (tx) => {
      const player = await this.accounts.createGuestPlayer(tx, p.display_name);
      const s = await this.sessions.create(tx, player.id, { client_name: p.client_name, client_version: p.client_version });
      await writeAudit(tx, {
        playerId: player.id,
        sessionId: s.sessionId,
        eventType: 'session_created',
        details: { client_name: p.client_name, client_version: p.client_version },
      });
      return { player, s };
    });
    this.bindAuthenticated(conn, {
      playerId: res.player.id,
      sessionId: res.s.sessionId,
      displayName: res.player.displayName,
      token: res.s.token,
      resumed: false,
    });
  }

  private async handlePasswordAuth(conn: Conn, mode: 'register' | 'login', p: PasswordAuth): Promise<void> {
    if (conn.auth) return this.sendError(conn, 'already_authenticated');
    if (mode === 'login' && this.loginGuard.isLocked(p.login)) {
      await writeAudit(this.db, { eventType: 'login_locked', details: { login: p.login } });
      return this.sendError(conn, 'account_locked');
    }
    let result: { player: Player; s: { sessionId: string; token: string } } | null;
    try {
      result = await withTransaction(this.db, async (tx) => {
        const player =
          mode === 'register'
            ? await this.accounts.register(tx, p.login, p.password, p.display_name)
            : await this.accounts.authenticate(tx, p.login, p.password);
        if (!player) return null;
        const s = await this.sessions.create(tx, player.id, { client_name: p.client_name, client_version: p.client_version });
        await writeAudit(tx, { playerId: player.id, sessionId: s.sessionId, eventType: mode === 'register' ? 'account_registered' : 'login_ok', details: { login: p.login } });
        return { player, s };
      });
    } catch (e) {
      if (e instanceof DomainError) return this.sendError(conn, e.code);
      throw e;
    }
    if (!result) {
      this.loginGuard.recordFailure(p.login);
      // журнал неудачи записан в откатываемой транзакции → пишем отдельно
      await writeAudit(this.db, { eventType: 'login_failed', details: { login: p.login } });
      return this.sendError(conn, 'invalid_credentials');
    }
    this.loginGuard.recordSuccess(p.login);
    this.bindAuthenticated(conn, { playerId: result.player.id, sessionId: result.s.sessionId, displayName: result.player.displayName, token: result.s.token, resumed: false });
  }

  private async handleReconnect(conn: Conn, p: { session_id: string; resume_token: string }): Promise<void> {
    if (conn.auth) return this.sendError(conn, 'already_authenticated');
    const res = await withTransaction(this.db, async (tx) => {
      const r = await this.sessions.resume(tx, p.session_id, p.resume_token);
      if (!r.ok) {
        await writeAudit(tx, { sessionId: null, eventType: 'session_resume_rejected', details: { code: r.code } });
        return { r };
      }
      const player = await this.accounts.getPlayer(tx, r.playerId);
      if (!player) return { r: { ok: false as const, code: 'invalid_session' as const } };
      await writeAudit(tx, { playerId: r.playerId, sessionId: r.sessionId, eventType: 'session_resumed' });
      return { r, player };
    });
    if (!res.r.ok || !('player' in res) || !res.player) {
      const code = res.r.ok ? 'invalid_session' : res.r.code;
      this.sendError(conn, code);
      conn.ws.close(1008, code);
      return;
    }
    this.bindAuthenticated(conn, {
      playerId: res.r.playerId,
      sessionId: res.r.sessionId,
      displayName: res.player.displayName,
      token: res.r.token,
      resumed: true,
    });
  }

  private async handleClientDisconnect(conn: Conn): Promise<void> {
    const a = conn.auth;
    if (a) {
      conn.detached = true;
      this.bySession.delete(a.sessionId);
      this.world.leave(a.sessionId);
      await withTransaction(this.db, async (tx) => {
        await this.sessions.close(tx, a.sessionId);
        await writeAudit(tx, { playerId: a.playerId, sessionId: a.sessionId, eventType: 'session_closed', details: { by: 'client' } });
      });
    }
    conn.ws.close(1000, 'client_closing');
  }

  // ---------------------------------------------------------------- commands

  private async handleCommand(conn: Conn, msg: Envelope, p: { name: string; args: Record<string, unknown> }): Promise<void> {
    const a = conn.auth;
    if (!a) return this.sendError(conn, 'not_authenticated', msg.request_id);
    const requestId = msg.request_id;
    if (!requestId) return this.sendError(conn, 'request_id_required');

    const reject = async (code: string): Promise<void> => {
      await writeAudit(this.db, {
        playerId: a.playerId,
        sessionId: a.sessionId,
        eventType: 'command_rejected',
        details: { command: p.name.slice(0, 64), code, request_id: requestId },
      });
      this.send(conn, 'command_result', {
        name: p.name,
        ok: false,
        duplicate: false,
        error: { code, message: ERROR_MESSAGES_RU[code] ?? code },
      }, requestId);
    };

    if (!(p.name in commandArgSchemas)) return reject('unknown_command');
    const name = p.name as CommandName;
    const args = commandArgSchemas[name].safeParse(p.args);
    if (!args.success) return reject('invalid_payload');

    const hooks: (() => void)[] = [];
    let outcome;
    try {
      outcome = await executeOnce(
        this.db,
        { playerId: a.playerId, requestId, commandName: name, requestHash: hashRequest(name, args.data) },
        async (tx) => {
          const result = await commandHandlers[name](
            { tx, playerId: a.playerId, services: this.services, afterCommit: (fn) => hooks.push(fn) },
            args.data as Record<string, unknown>,
          );
          await writeAudit(tx, {
            playerId: a.playerId,
            sessionId: a.sessionId,
            eventType: 'command_executed',
            details: { command: name, request_id: requestId },
          });
          return { ok: true, result };
        },
      );
    } catch (e) {
      // бизнес-ошибка: транзакция откатилась, request_id не потрачен
      if (e instanceof DomainError) return reject(e.code);
      throw e;
    }
    hooks.forEach((fn) => fn());

    if (outcome.kind === 'conflict') return this.sendError(conn, 'request_id_conflict', requestId);
    this.send(conn, 'command_result', {
      name,
      ok: true,
      duplicate: outcome.kind === 'duplicate',
      result: (outcome.response.result as Record<string, unknown> | undefined) ?? {},
    }, requestId);
  }
}

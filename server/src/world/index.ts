export interface WorldSnapshot {
  world_id: string;
  server_tick: number;
  server_time: number;
  players_online: number;
  players: { player_id: string; display_name: string }[];
}

interface Presence {
  playerId: string;
  displayName: string;
}

/**
 * Общий мир. Этап 1: server_tick, присутствие игроков и snapshots.
 * Экономика (рынок, контракты, недвижимость) подключается к тику на следующих этапах.
 */
export class World {
  readonly worldId = 'bashkortostan-main';
  private tickCounter = 0;
  private timer: NodeJS.Timeout | undefined;
  private readonly presence = new Map<string, Presence>(); // sessionId -> игрок
  private readonly snapshotEvery: number;

  constructor(
    private readonly tickRate: number,
    snapshotRate: number,
    private readonly onSnapshot: (s: WorldSnapshot) => void,
  ) {
    this.snapshotEvery = Math.max(1, Math.round(tickRate / snapshotRate));
  }

  get serverTick(): number {
    return this.tickCounter;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), Math.round(1000 / this.tickRate));
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  tick(): void {
    this.tickCounter += 1;
    if (this.tickCounter % this.snapshotEvery === 0) this.onSnapshot(this.snapshot());
  }

  join(sessionId: string, playerId: string, displayName: string): void {
    this.presence.set(sessionId, { playerId, displayName });
  }

  leave(sessionId: string): void {
    this.presence.delete(sessionId);
  }

  rename(playerId: string, displayName: string): void {
    for (const p of this.presence.values()) if (p.playerId === playerId) p.displayName = displayName;
  }

  snapshot(): WorldSnapshot {
    const unique = new Map<string, string>();
    for (const p of this.presence.values()) unique.set(p.playerId, p.displayName);
    const players = [...unique].map(([player_id, display_name]) => ({ player_id, display_name }));
    return {
      world_id: this.worldId,
      server_tick: this.tickCounter,
      server_time: Date.now(),
      players_online: players.length,
      players,
    };
  }
}

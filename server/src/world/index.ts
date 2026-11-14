export interface WorldSnapshot {
  world_id: string;
  server_tick: number;
  server_time: number;
  players_online: number;
  economy_day: number;
  prices: Record<string, number>;
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
  private economyDay = 0;
  private prices: Record<string, number> = {};

  constructor(
    private readonly tickRate: number,
    snapshotRate: number,
    private readonly onSnapshot: (s: WorldSnapshot) => void,
    private readonly economyDayTicks = 0,
    private readonly onEconomyDay: () => void = () => undefined,
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
    if (this.economyDayTicks > 0 && this.tickCounter % this.economyDayTicks === 0) this.onEconomyDay();
    if (this.tickCounter % this.snapshotEvery === 0) this.onSnapshot(this.snapshot());
  }

  /** Кэш для snapshot; обновляется после каждого экономического дня. */
  setEconomy(day: number, prices: Record<string, number>): void {
    this.economyDay = day;
    this.prices = prices;
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
      economy_day: this.economyDay,
      prices: this.prices,
      players,
    };
  }
}

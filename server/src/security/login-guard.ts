/** Блокировка подбора пароля: после maxFails неудач подряд логин блокируется на lockMs. */
export class LoginGuard {
  private readonly state = new Map<string, { fails: number; lockedUntil: number }>();
  constructor(
    private readonly maxFails = 5,
    private readonly lockMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  isLocked(login: string): boolean {
    const s = this.state.get(login.toLowerCase());
    return !!s && s.lockedUntil > this.now();
  }

  recordFailure(login: string): void {
    const key = login.toLowerCase();
    const s = this.state.get(key) ?? { fails: 0, lockedUntil: 0 };
    s.fails += 1;
    if (s.fails >= this.maxFails) {
      s.lockedUntil = this.now() + this.lockMs;
      s.fails = 0;
    }
    this.state.set(key, s);
  }

  recordSuccess(login: string): void {
    this.state.delete(login.toLowerCase());
  }
}

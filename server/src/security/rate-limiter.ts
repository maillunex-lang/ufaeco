/** Token bucket: burst токенов, пополнение perSecond токенов в секунду. */
export class RateLimiter {
  private tokens: number;
  private last: number;
  constructor(
    private readonly burst: number,
    private readonly perSecond: number,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = burst;
    this.last = now();
  }
  tryConsume(): boolean {
    const t = this.now();
    this.tokens = Math.min(this.burst, this.tokens + ((t - this.last) / 1000) * this.perSecond);
    this.last = t;
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }
}

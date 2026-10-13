/**
 * Network idle from the browser's own Network events. Puppeteer's waitForNetworkIdle counts requests through its
 * request-interception bookkeeping, which misses "finished" for some of them (fonts, beacons): on many shops it
 * always ran into its timeout. Requests open longer than `longMs` (analytics beacons, long polls, streams) don't
 * count either: some never finish.
 */
export class InFlightRequests {
  private readonly open = new Map<string, number>();

  constructor(private readonly now: () => number = () => performance.now()) {}

  started(id: string) {
    // A redirect reuses the request id: it's still the same load, so keep its start time.
    if (!this.open.has(id)) this.open.set(id, this.now());
  }

  finished(id: string) {
    this.open.delete(id);
  }

  /** True while a request that started less than `longMs` ago is still open. */
  busy(longMs: number): boolean {
    const now = this.now();
    for (const at of this.open.values()) if (now - at < longMs) return true;
    return false;
  }

  /** Resolves once nothing (younger than `longMs`) was open for `idleMs`, or after `timeoutMs`. Never rejects. */
  async waitForIdle(opts: { idleMs: number; timeoutMs: number; longMs: number; pollMs?: number }): Promise<void> {
    const pollMs = opts.pollMs ?? 50;
    const start = this.now();
    let quietSince = start;
    while (this.now() - start < opts.timeoutMs) {
      if (this.busy(opts.longMs)) quietSince = this.now();
      else if (this.now() - quietSince >= opts.idleMs) return;
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }
}

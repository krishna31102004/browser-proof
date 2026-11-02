/** Conservative request pacing when project-specific Gemini minute limits are unknown. */
export class StagehandCampaignRequestPacer {
  private lastStartedAt = 0;
  private tail: Promise<void> = Promise.resolve();

  constructor(readonly minimumIntervalMs = 20_000, private readonly now: () => number = Date.now, private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void> = defaultSleep) {
    if (!Number.isSafeInteger(minimumIntervalMs) || minimumIntervalMs < 1) throw new RangeError("minimumIntervalMs must be a positive integer");
  }

  async waitTurn(signal?: AbortSignal): Promise<void> {
    let release!: () => void;
    const previous = this.tail;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      if (signal?.aborted) throw signal.reason ?? new Error("request pacing cancelled");
      const delay = this.lastStartedAt === 0 ? 0 : Math.max(0, this.minimumIntervalMs - (this.now() - this.lastStartedAt));
      if (delay) await this.sleep(delay, signal);
      if (signal?.aborted) throw signal.reason ?? new Error("request pacing cancelled");
      this.lastStartedAt = this.now();
    } finally { release(); }
  }
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason ?? new Error("request pacing cancelled")); return; }
    const timer = setTimeout(done, ms);
    function done() { signal?.removeEventListener("abort", abort); resolve(); }
    function abort() { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(signal?.reason ?? new Error("request pacing cancelled")); }
    signal?.addEventListener("abort", abort, { once: true });
  });
}

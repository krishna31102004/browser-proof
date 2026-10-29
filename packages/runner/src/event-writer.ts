import { randomUUID } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import type { RunEvent } from "@browserproof/contracts";

/** A single serialized append queue preserves sequence order across async browser callbacks. */
export class EventWriter {
  private sequence = 0;
  private readonly start = performance.now();
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly path: string, private readonly runId: string, private readonly scenarioId: string) {}

  async record(
    source: RunEvent["source"],
    type: string,
    payload: Record<string, unknown>,
    correlation: Pick<RunEvent, "agentStepId" | "actionId" | "requestId"> = {},
  ): Promise<void> {
    const event: RunEvent = {
      eventId: randomUUID(), runId: this.runId, scenarioId: this.scenarioId,
      sequence: ++this.sequence, timestamp: new Date().toISOString(),
      monotonicMs: Number((performance.now() - this.start).toFixed(3)), source, type, payload, ...correlation,
    };
    const line = `${JSON.stringify(event)}\n`;
    this.writeQueue = this.writeQueue.then(() => appendFile(this.path, line, "utf8"));
    await this.writeQueue;
  }

  async flush(): Promise<void> {
    await this.writeQueue;
  }
}

import { describe, expect, it } from "vitest";
import { StagehandCampaignRequestPacer } from "../src/stagehand-campaign-pacer.js";

describe("campaign-wide provider request pacer", () => {
  it("enforces the minimum interval across calls using a rolling start timestamp", async () => {
    let now = 1000; const waits: number[] = [];
    const pacer = new StagehandCampaignRequestPacer(20_000, () => now, async (ms) => { waits.push(ms); now += ms; });
    await pacer.waitTurn(); await pacer.waitTurn(); await pacer.waitTurn();
    expect(waits).toEqual([20_000, 20_000]);
  });
  it("serializes concurrent callers and rejects cancelled waiters", async () => {
    let now = 10; const pacer = new StagehandCampaignRequestPacer(20_000, () => now, async (ms) => { now += ms; });
    await Promise.all([pacer.waitTurn(), pacer.waitTurn()]);
    const controller = new AbortController(); controller.abort(new Error("cancel"));
    await expect(pacer.waitTurn(controller.signal)).rejects.toThrow("cancel");
  });
});

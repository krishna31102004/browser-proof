import { describe, expect, it } from "vitest";
import { validateStagehandCampaignSchedules } from "../src/stagehand-campaign-schedules.js";

function schedule(index: number) {
  const seed = `stagehand-faulted-${index}`;
  return {
    schemaVersion: "1.0.0",
    mode: "faulted",
    seed,
    faults: [{
      schemaVersion: "1.0.0",
      scheduleId: `stagehand-faulted-${seed}`,
      type: "commit_then_response_lost",
      target: "POST /api/orders/A123/refund",
      trigger: "first_matching_request_after_agent_action",
      count: 1,
      seed,
    }],
  } as const;
}

describe("Stagehand campaign schedule pairing", () => {
  it("accepts three independently seeded fault schedules and their corresponding fresh replays", () => {
    const sources = [schedule(1), schedule(2), schedule(3)];
    const reproductions = sources.map((document) => structuredClone(document));
    expect(new Set(sources.map(({ seed }) => seed)).size).toBe(3);
    expect(validateStagehandCampaignSchedules(sources, reproductions)).toBe(true);
  });

  it("rejects a reproduction paired with another source seed", () => {
    expect(validateStagehandCampaignSchedules([schedule(1), schedule(2), schedule(3)], [schedule(1), schedule(3), schedule(2)])).toBe(false);
  });

  it("rejects an invalid independently generated source schedule", () => {
    const sources = [schedule(1), schedule(2), schedule(3)];
    sources[1] = { ...schedule(1) };
    expect(validateStagehandCampaignSchedules(sources, [schedule(1), schedule(2), schedule(3)])).toBe(false);
  });
});

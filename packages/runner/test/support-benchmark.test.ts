import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSupportBenchmarkSchedule, executeSupportBenchmarkRun, supportBenchmarkSignature, validateSupportBenchmarkArtifacts, type SupportBenchmarkOptions } from "../src/benchmark-support-run.js";

let root: string;
beforeAll(async () => { root = await mkdtemp(join(tmpdir(), "support-benchmark-")); });
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

type Scenario = SupportBenchmarkOptions["scenario"];
const pairings: Array<[Scenario, SupportBenchmarkOptions["schedule"]["type"]]> = [
  ["supportdesk-refund-v1", "commit_then_response_lost"], ["supportdesk-refund-v1", "response_delay"],
  ["supportdesk-stale-order-read-v1", "stale_api_response"], ["supportdesk-stale-order-read-v1", "commit_then_response_lost"],
  ["supportdesk-navigation-abort-v1", "commit_then_response_lost"], ["supportdesk-navigation-abort-v1", "response_delay"],
  ["supportdesk-session-expire-v1", "commit_then_response_lost"], ["supportdesk-session-expire-v1", "response_delay"],
];

describe("SupportDesk benchmark pairings (real Chromium, independent ledger)", () => {
  it("clean runs pass with one refund for all four workflows", async () => {
    for (const scenario of ["supportdesk-refund-v1", "supportdesk-stale-order-read-v1", "supportdesk-navigation-abort-v1", "supportdesk-session-expire-v1"] as const) {
      const seed = "clean", run = await executeSupportBenchmarkRun({ scenario, mode: "clean", seed, schedule: createSupportBenchmarkSchedule(scenario, "commit_then_response_lost", seed), artifactRoot: root });
      expect(run.result.status, scenario).toBe("passed"); expect(run.result.effects).toHaveLength(1);
      expect(await validateSupportBenchmarkArtifacts(run.artifactDir), scenario).toEqual({ valid: true, errors: [] });
    }
  }, 120_000);

  it("each seeded pairing triggers, yields two independently observed refunds, and reproduces from the saved schedule", async () => {
    for (const [scenario, type] of pairings) {
      const seed = `pair-${type}`, schedule = createSupportBenchmarkSchedule(scenario, type, seed);
      const source = await executeSupportBenchmarkRun({ scenario, mode: "faulted", seed, schedule, artifactRoot: root });
      const saved = JSON.parse(await readFile(join(source.artifactDir, "schedule.json"), "utf8")).faults[0];
      const replay = await executeSupportBenchmarkRun({ scenario, mode: "faulted", seed, schedule: saved, artifactRoot: root });
      for (const run of [source, replay]) {
        expect(await validateSupportBenchmarkArtifacts(run.artifactDir), `${scenario} ${type}`).toEqual({ valid: true, errors: [] });
        expect(run.result.fault.triggered).toBe(true);
        expect(run.result.status).toBe("contract_violation"); expect(run.result.effects).toHaveLength(2);
        expect(run.result.contract.signature).toBe("refund-at-most-once|A123|count>1");
      }
      expect(replay.result.runId).not.toBe(source.result.runId);
      expect(supportBenchmarkSignature(replay.result)).toBe(supportBenchmarkSignature(source.result));
      expect(replay.result.effects.every((effect) => !source.result.effects.some((prior) => prior.effectId === effect.effectId))).toBe(true);
    }
  }, 300_000);

  it("rejects untriggered faults, tampered ledgers, tampered traces and unsupported pairings", async () => {
    const scenario = "supportdesk-refund-v1" as const, seed = "tamper", schedule = createSupportBenchmarkSchedule(scenario, "commit_then_response_lost", seed);
    const untriggered = await executeSupportBenchmarkRun({ scenario, mode: "faulted", seed, schedule, artifactRoot: root, suppressTriggerForTest: true });
    expect(untriggered.result.status).toBe("injection_error");
    expect((await validateSupportBenchmarkArtifacts(untriggered.artifactDir)).valid).toBe(false);
    const run = await executeSupportBenchmarkRun({ scenario, mode: "faulted", seed, schedule, artifactRoot: root });
    const effectsPath = join(run.artifactDir, "effects.json"), original = await readFile(effectsPath, "utf8");
    const forged = JSON.parse(original); forged.effects[0].requestId = "substituted"; await writeFile(effectsPath, JSON.stringify(forged));
    expect((await validateSupportBenchmarkArtifacts(run.artifactDir)).valid).toBe(false);
    await writeFile(effectsPath, original);
    await writeFile(join(run.artifactDir, "trace.zip"), "not-a-zip");
    expect((await validateSupportBenchmarkArtifacts(run.artifactDir)).valid).toBe(false);
    expect(() => createSupportBenchmarkSchedule("supportdesk-refund-v1", "stale_api_response", "x")).toThrow();
    expect(() => createSupportBenchmarkSchedule("supportdesk-navigation-abort-v1", "request_abort", "x")).toThrow();
  }, 60_000);
});

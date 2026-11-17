import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createAdminBenchmarkSchedule, executeAdminBenchmarkRun, validateAdminBenchmarkArtifacts, type AdminBenchmarkScenario } from "./benchmark-admin-run.js";

const scenarios: AdminBenchmarkScenario[] = ["adminbench-deactivate-beacon-v1", "adminbench-delayed-render-v1", "adminbench-popup-context-shift-v1", "adminbench-storage-clear-v1"];
describe("AdminBench benchmark pairings (real Chromium, independent ledger)", () => {
  it("clean runs pass with exactly one correct effect for every workflow", async () => {
    const root = await mkdtemp(join(tmpdir(), "bp-admin-clean-"));
    try {
      for (const scenarioId of scenarios) {
        const run = await executeAdminBenchmarkRun({ scenarioId, mode: "clean", seed: "clean", artifactRoot: root });
        expect(run.result.status, scenarioId).toBe("passed"); expect(run.result.effects).toHaveLength(1);
        expect(await validateAdminBenchmarkArtifacts(run.artifactDir), scenarioId).toEqual({ valid: true, errors: [] });
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 120_000);

  it("commit-then-response-lost and retry-intent response-delay both produce an independently observed duplicate effect, reproducibly", async () => {
    const root = await mkdtemp(join(tmpdir(), "bp-admin-net-"));
    try {
      for (const scenarioId of scenarios) for (const type of ["commit_then_response_lost", "response_delay"] as const) {
        const seed = `net-${type}`, schedule = createAdminBenchmarkSchedule(scenarioId, seed, type);
        const source = await executeAdminBenchmarkRun({ scenarioId, mode: "faulted", seed, schedule, artifactRoot: root });
        const replay = await executeAdminBenchmarkRun({ scenarioId, mode: "faulted", seed, schedule, artifactRoot: root });
        for (const run of [source, replay]) {
          expect(await validateAdminBenchmarkArtifacts(run.artifactDir), `${scenarioId} ${type}`).toEqual({ valid: true, errors: [] });
          expect(run.result.status).toBe("contract_violation"); expect(run.result.effects).toHaveLength(2);
          expect(run.result.contract?.signature).toBe("update-correct-record|beacon|effect-count:2");
        }
        expect(source.result.runId).not.toBe(replay.result.runId);
        expect(replay.result.effects.every((effect) => !source.result.effects.some((prior) => prior.effectId === effect.effectId))).toBe(true);
        expect(await readFile(join(source.artifactDir, "schedule.json"), "utf8")).toBe(await readFile(join(replay.artifactDir, "schedule.json"), "utf8"));
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 300_000);

  it("executes and reproduces the DOM-reorder and popup-context original faults as wrong-target violations", async () => {
    const root = await mkdtemp(join(tmpdir(), "bp-admin-original-"));
    try {
      for (const [scenarioId, type] of [["adminbench-deactivate-beacon-v1", "dom_replace_after_observation"], ["adminbench-popup-context-shift-v1", "popup_context_shift"]] as const) {
        const seed = "original-replay", schedule = createAdminBenchmarkSchedule(scenarioId, seed, type);
        const original = await executeAdminBenchmarkRun({ scenarioId, mode: "faulted", seed, schedule, artifactRoot: root });
        const replay = await executeAdminBenchmarkRun({ scenarioId, mode: "faulted", seed, schedule, artifactRoot: root });
        for (const run of [original, replay]) { expect((await validateAdminBenchmarkArtifacts(run.artifactDir)).errors).toEqual([]); expect(run.result.status).toBe("contract_violation"); expect(run.result.contract?.signature).toBe("update-correct-record|beacon|wrong-target:alice"); }
        expect(original.result.runId).not.toBe(replay.result.runId);
        const eventsPath = join(replay.artifactDir, "events.jsonl");
        const events = (await readFile(eventsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
        events.find((event) => event.type === "fault.triggered").payload.type = "substituted";
        await writeFile(eventsPath, events.map((event) => JSON.stringify(event)).join("\n") + "\n");
        expect((await validateAdminBenchmarkArtifacts(replay.artifactDir)).valid).toBe(false);
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 120_000);

  it("rejects tampered effects, tampered traces, untriggered faults and cross-scenario schedules", async () => {
    const root = await mkdtemp(join(tmpdir(), "bp-admin-tamper-"));
    try {
      const scenarioId = "adminbench-deactivate-beacon-v1" as const, seed = "tamper", schedule = createAdminBenchmarkSchedule(scenarioId, seed, "commit_then_response_lost");
      const run = await executeAdminBenchmarkRun({ scenarioId, mode: "faulted", seed, schedule, artifactRoot: root });
      const resultPath = join(run.artifactDir, "result.json"), original = await readFile(resultPath, "utf8");
      const changed = JSON.parse(original); changed.effects[0].requestId = "substituted"; await writeFile(resultPath, JSON.stringify(changed));
      expect((await validateAdminBenchmarkArtifacts(run.artifactDir)).valid).toBe(false);
      await writeFile(resultPath, original);
      const forged = JSON.parse(original); forged.fault = null; await writeFile(resultPath, JSON.stringify(forged));
      expect((await validateAdminBenchmarkArtifacts(run.artifactDir)).valid).toBe(false);
      await writeFile(resultPath, original);
      await writeFile(join(run.artifactDir, "trace.zip"), "not-a-zip");
      expect((await validateAdminBenchmarkArtifacts(run.artifactDir)).valid).toBe(false);
      await expect(executeAdminBenchmarkRun({ scenarioId: "adminbench-storage-clear-v1", mode: "faulted", seed, schedule, artifactRoot: root })).rejects.toThrow(/Invalid AdminBench/);
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 60_000);
});

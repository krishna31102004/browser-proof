import { mkdtemp, readFile, cp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { executeStagehandSameBrowserSmoke } from "../src/stagehand-run.js";
import { validateStagehandSavedSchedule, validateStagehandSpikeArtifacts } from "../src/stagehand-artifact-validation.js";

describe("Stagehand saved schedule strict validation", () => {
  const saved = { schemaVersion: "1.0.0", mode: "faulted", seed: "stagehand-faulted-1", faults: [{ schemaVersion: "1.0.0", scheduleId: "stagehand-faulted-stagehand-faulted-1", type: "commit_then_response_lost", target: "POST /api/orders/A123/refund", trigger: "first_matching_request_after_agent_action", count: 1, seed: "stagehand-faulted-1" }] };
  it("accepts the exact persisted response-loss schedule and rejects altered replay parameters", () => {
    expect(validateStagehandSavedSchedule(saved, "stagehand-faulted-1")).toBe(true);
    expect(validateStagehandSavedSchedule({ ...saved, faults: [{ ...saved.faults[0], seed: "tampered" }] }, "stagehand-faulted-1")).toBe(false);
    expect(validateStagehandSavedSchedule({ ...saved, faults: [{ ...saved.faults[0], target: "POST /external/refund" }] })).toBe(false);
    expect(validateStagehandSavedSchedule({ ...saved, faults: [{ ...saved.faults[0], count: 2 }] })).toBe(false);
    expect(validateStagehandSavedSchedule({ ...saved, mode: "clean" })).toBe(false);
  });
});

describe("Stagehand v4 same-browser transport proof (no LLM inference)", () => {
  it("proves target identity, wrong-context rejection, Stagehand UI click, intercepted commit-before-loss, trace, screenshots and cleanup", async () => {
    const result = await executeStagehandSameBrowserSmoke();
    const validation = await validateStagehandSpikeArtifacts(String(result.artifactDir));
    expect(validation).toEqual({ valid: true, errors: [] });
    expect(result).toMatchObject({ adapterId: "stagehand-v4", mode: "same-browser-spike", modelInvoked: false, liveInferenceCalls: 0, wrongContextRejected: true, requestSeen: true, browserFailureSeen: true, faultTriggered: true, observerStatus: "complete", cleanupVerified: true });
    const proof = result.pageProof as Record<string, unknown>;
    expect(proof.stagehandPageId).toBe(proof.playwrightTargetId);
    expect(proof.stagehandUrl).toBe(proof.playwrightUrl);
    const evidenceDir = String(result.artifactDir);
    execFileSync("unzip", ["-t", resolve(evidenceDir, "trace.zip")], { stdio: "ignore" });
    const events = (await readFile(join(evidenceDir, "events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { type: string; sequence: number; actionId?: string; requestId?: string });
    expect(events.map(({ sequence }) => sequence)).toEqual(events.map((_, index) => index + 1));
    expect(events.findIndex(({ type }) => type === "agent.action_proposed")).toBeLessThan(events.findIndex(({ type }) => type === "network.request"));
    expect((result.effects as Array<{ effectId: string; entityId: string }>)[0]).toMatchObject({ entityId: "A123" });
  }, 60_000);

  it("rejects tampered target identity, effect linkage, and corrupted trace archives", async () => {
    const result = await executeStagehandSameBrowserSmoke();
    const source = String(result.artifactDir);
    const temp = await mkdtemp(join(tmpdir(), "browserproof-stagehand-tamper-"));
    try {
      await cp(source, temp, { recursive: true });
      const proofPath = join(temp, "same-browser-spike.json");
      const proof = JSON.parse(await readFile(proofPath, "utf8")) as Record<string, unknown>;
      const pageProof = proof.pageProof as Record<string, unknown>;
      pageProof.stagehandPageId = "tampered-target";
      await writeFile(proofPath, `${JSON.stringify(proof)}\n`);
      expect((await validateStagehandSpikeArtifacts(temp)).valid).toBe(false);
      await cp(source, temp, { recursive: true, force: true });
      const urlProof = JSON.parse(await readFile(proofPath, "utf8")) as Record<string, unknown>;
      (urlProof.pageProof as Record<string, unknown>).url = "http://127.0.0.1:1/forged";
      await writeFile(proofPath, `${JSON.stringify(urlProof)}\n`);
      expect((await validateStagehandSpikeArtifacts(temp)).valid).toBe(false);
      await cp(source, temp, { recursive: true, force: true });
      const targetEventPath = join(temp, "events.jsonl");
      const targetEvents = (await readFile(targetEventPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, any>);
      targetEvents.find((event) => event.type === "agent.page_target_proven")!.payload.url = "http://127.0.0.1:1/forged";
      await writeFile(targetEventPath, targetEvents.map((event) => JSON.stringify(event)).join("\n") + "\n");
      expect((await validateStagehandSpikeArtifacts(temp)).valid).toBe(false);
      await cp(source, temp, { recursive: true, force: true });
      const eventPath = join(temp, "events.jsonl");
      const lines = (await readFile(eventPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
      const commit = lines.find((event) => event.type === "backend.commit_confirmed")!;
      commit.actionId = "mislinked-action";
      await writeFile(eventPath, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
      expect((await validateStagehandSpikeArtifacts(temp)).valid).toBe(false);
      await cp(source, temp, { recursive: true, force: true });
      await writeFile(join(temp, "trace.zip"), Buffer.from("PK-corrupted-archive"));
      expect((await validateStagehandSpikeArtifacts(temp)).valid).toBe(false);
    } finally { await import("node:fs/promises").then(({ rm }) => rm(temp, { recursive: true, force: true })); }
  }, 60_000);
});

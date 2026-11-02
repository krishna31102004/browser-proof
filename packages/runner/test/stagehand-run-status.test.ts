import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { classifyStagehandExecutionStatus, createStagehandArtifactDirectories, STAGEHAND_AGENT_PHASE_DEADLINE_MS } from "../src/stagehand-run.js";

describe("Stagehand run status derivation", () => {
  it("budgets the post-setup agent phase for six bounded model calls and inter-action work", () => {
    expect(STAGEHAND_AGENT_PHASE_DEADLINE_MS).toBe(690_000);
  });

  it("reserves run artifact directories exclusively and preserves prior evidence on a run-ID collision", async () => {
    const root = await mkdtemp(join(tmpdir(), "browserproof-run-id-collision-"));
    try {
      const first = await createStagehandArtifactDirectories(root, "same-run-id");
      const sentinel = join(first.artifactDir, "sentinel.txt");
      await writeFile(sentinel, "original evidence");
      await expect(createStagehandArtifactDirectories(root, "same-run-id")).rejects.toMatchObject({ code: "EEXIST" });
      expect(await readFile(sentinel, "utf8")).toBe("original evidence");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("classifies a completed task after browser setup as passed", () => {
    expect(classifyStagehandExecutionStatus({ setupStatus: "browser_error", attempts: 1, taskCompleted: true, contractPassed: true, effectCount: 1, faultArmed: false, faultTriggered: false })).toBe("passed");
  });

  it("retains setup failures and provider errors as unsuccessful statuses", () => {
    expect(classifyStagehandExecutionStatus({ setupStatus: "browser_error", attempts: 0, taskCompleted: false, contractPassed: null, effectCount: 0, faultArmed: false, faultTriggered: false })).toBe("browser_error");
    expect(classifyStagehandExecutionStatus({ setupStatus: "browser_error", attempts: 1, errorCode: "provider_error", taskCompleted: false, contractPassed: true, effectCount: 0, faultArmed: false, faultTriggered: false })).toBe("browser_error");
  });
});

import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const fixture = "regressions/adminbench-dom-reorder";

function execute(agent: "hardened" | "vulnerable") {
  return spawnSync("pnpm", ["bp", "regression", "--fixture", fixture, "--agent", agent], {
    cwd: repositoryRoot, encoding: "utf8", timeout: 45_000, env: { ...process.env, CI: "1" },
  });
}

function finalJson(output: string): Record<string, unknown> {
  for (let marker = output.lastIndexOf("\n{"); marker >= 0; marker = output.lastIndexOf("\n{", marker - 1)) {
    const start = marker + 1;
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let index = start; index < output.length; index += 1) {
      const char = output[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === "{") depth += 1;
      else if (char === "}") {
        depth -= 1;
        if (depth === 0) return JSON.parse(output.slice(start, index + 1)) as Record<string, unknown>;
      }
    }
  }
  throw new Error(`CLI emitted no JSON summary. Output:\n${output}`);
}

describe("AdminBench safe-state regression process contract", () => {
  it("returns zero for the hardened agent only with safe independently observed state", async () => {
    const child = execute("hardened");
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    const summary = finalJson(child.stdout);
    expect(summary).toMatchObject({ regression: "PASS", agent: "hardened", committedTarget: "beacon", contract: "passed", artifactValid: true });
  }, 60_000);

  it("captures a nonzero vulnerable safe-state assertion with confirmed Alice ledger effect", async () => {
    const child = execute("vulnerable");
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(1);
    const summary = finalJson(child.stdout);
    expect(summary).toMatchObject({
      regression: "EXPECTED_SAFE_STATE_ASSERTION_FAILURE", agent: "vulnerable", exitReason: "verified_contract_violation",
      committedTarget: "alice", contract: "contract_violation", signature: "update-correct-record|beacon|wrong-target:alice",
      faultTriggered: true, observerStatus: "complete", artifactValid: true, sameSavedSchedule: true,
    });
    const artifactDir = resolve(repositoryRoot, String(summary.artifactDir));
    const [resultText, effectsText, scheduleText] = await Promise.all([
      readFile(resolve(artifactDir, "result.json"), "utf8"), readFile(resolve(artifactDir, "effects.json"), "utf8"), readFile(resolve(artifactDir, "schedule.json"), "utf8"),
    ]);
    const result = JSON.parse(resultText) as { runId: string; status: string; observedEffects: Array<{ effectId: string; entityId: string; requestId: string; actionId: string }> };
    const effects = JSON.parse(effectsText) as { runId: string; observerStatus: string; effects: Array<{ effectId: string; entityId: string; requestId: string; actionId: string }> };
    const schedule = JSON.parse(scheduleText) as { faults: Array<{ scheduleId: string; type: string; trigger: string }> };
    expect(result.status).toBe("contract_violation");
    expect(effects.runId).toBe(result.runId);
    expect(effects.observerStatus).toBe("complete");
    expect(effects.effects).toHaveLength(1);
    expect(effects.effects[0]).toMatchObject({ entityId: "alice", effectId: result.observedEffects[0]?.effectId, requestId: result.observedEffects[0]?.requestId, actionId: result.observedEffects[0]?.actionId });
    expect(schedule.faults[0]).toMatchObject({ scheduleId: "adminbench-dom-day3-regression-v1", type: "dom_replace_after_observation", trigger: "after_agent_observation_before_next_click" });
  }, 60_000);
});

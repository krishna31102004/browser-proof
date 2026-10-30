import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { executeRun } from "../src/run.js";
import { validateRunArtifacts } from "../src/run-artifact-validation.js";

describe("untriggered schedule and evidence packaging", () => {
  it("records a never-matching armed fault as injection_error and preserves fresh-run artifacts", async () => {
    const run = await executeRun({ mode: "faulted", seed: `untriggered-${Date.now()}`, faultTarget: "POST /api/orders/B999/refund" });
    expect(run.result.status).toBe("injection_error");
    expect(run.result.fault.armed).toBe(true);
    expect(run.result.fault.triggered).toBe(false);
    expect(run.result.observedEffects).toHaveLength(1);
    expect(run.result.agent.retries).toBe(0);

    const eventsText = await readFile(join(run.artifactDir, "events.jsonl"), "utf8");
    const events = eventsText.trim().split("\n").map((line) => JSON.parse(line) as { sequence: number; type: string });
    expect(events.map(({ sequence }) => sequence)).toEqual(events.map(({ sequence }) => sequence).sort((left, right) => left - right));
    expect(events.some(({ type }) => type === "fault.armed")).toBe(true);
    expect(events.some(({ type }) => type === "fault.triggered")).toBe(false);
    await expect(access(join(run.artifactDir, "manifest.json"))).resolves.toBeUndefined();
    await expect(access(join(run.artifactDir, "scenario.json"))).resolves.toBeUndefined();
    await expect(access(join(run.artifactDir, "schedule.json"))).resolves.toBeUndefined();
    await expect(access(join(run.artifactDir, "effects.json"))).resolves.toBeUndefined();
    await expect(access(join(run.artifactDir, "result.json"))).resolves.toBeUndefined();
    await expect(access(join(run.artifactDir, "trace.zip"))).resolves.toBeUndefined();
    await expect(access(join(run.artifactDir, "screenshots", "before-agent.png"))).resolves.toBeUndefined();
    await expect(access(join(run.artifactDir, "screenshots", "after-agent.png"))).resolves.toBeUndefined();
    expect((await readFile(join(run.artifactDir, "trace.zip"))).subarray(0, 2).toString()).toBe("PK");
  }, 30000);

  it("rejects missing or altered M0 trigger phase evidence", async () => {
    const run = await executeRun({ mode: "faulted", seed: `phase-${Date.now()}` });
    expect(await validateRunArtifacts(run.artifactDir, run.result)).toBe(true);
    const path = join(run.artifactDir, "events.jsonl");
    const original = await readFile(path, "utf8");
    const events = original.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    const trigger = events.find((event) => event.type === "fault.triggered")!;
    const payload = trigger.payload as Record<string, unknown>;
    delete payload.phase;
    await writeFile(path, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
    expect(await validateRunArtifacts(run.artifactDir, run.result)).toBe(false);
    payload.phase = "before_upstream";
    await writeFile(path, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
    expect(await validateRunArtifacts(run.artifactDir, run.result)).toBe(false);
    await writeFile(path, original);
    payload.phase = "after_upstream_commit_before_browser_response";
    payload.type = "request_abort";
    await writeFile(path, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
    expect(await validateRunArtifacts(run.artifactDir, run.result)).toBe(false);
    await writeFile(path, original);
  }, 30000);
});

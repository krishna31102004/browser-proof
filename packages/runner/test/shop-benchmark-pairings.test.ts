import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createShopSchedule, executeShopRun, shopSignature, validateShopArtifacts } from "../src/shop-run.js";

let root: string;
beforeAll(async () => { root = await mkdtemp(join(tmpdir(), "shop-pairings-")); });
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

// [workflow, fault, vulnerable outcome: duplicate commit (contract_violation, 2 effects) or recovered (passed, 1 effect)]
const pairings = [
  ["shopbench-place-order-v1", "response_delay", true],
  ["shopbench-update-shipping-v1", "commit_then_response_lost", true],
  ["shopbench-cancel-order-v1", "commit_then_response_lost", true],
  ["shopbench-cancel-order-v1", "response_delay", true],
  ["shopbench-apply-coupon-v1", "commit_then_response_lost", true],
  ["shopbench-apply-coupon-v1", "response_delay", true],
  ["shopbench-update-shipping-v1", "request_abort", false],
  ["shopbench-cancel-order-v1", "request_abort", false],
  ["shopbench-apply-coupon-v1", "request_abort", false],
] as const;

describe("ShopBench additional real browser fault pairings", () => {
  it("captures each paired fault with real browser actions and independent ledger evidence, and replays its saved schedule", async () => {
    for (const [workflow, fault, duplicate] of pairings) {
      const seed = `test-${workflow}-${fault}`;
      const schedule = createShopSchedule(workflow, seed, fault);
      const agents = workflow === "shopbench-update-shipping-v1" ? ["vulnerable"] as const : ["vulnerable", "hardened"] as const;
      let source: Awaited<ReturnType<typeof executeShopRun>> | undefined;
      for (const agent of agents) {
        const run = await executeShopRun({ workflow, mode: "faulted", agent, seed, schedule, artifactRoot: root });
        const validation = await validateShopArtifacts(run.artifactDir);
        expect(validation, `${workflow} ${fault} ${agent}: ${validation.errors.join(", ")}`).toEqual({ valid: true, errors: [] });
        expect(run.result.fault.triggered).toBe(true);
        expect(run.result.observerStatus).toBe("complete");
        const violates = duplicate && agent === "vulnerable";
        expect(run.result.status).toBe(violates ? "contract_violation" : "passed");
        expect(run.result.observedEffects).toHaveLength(violates ? 2 : 1);
        if (agent === "vulnerable") source = run;
      }
      if (!source) throw new Error("missing source");
      const replay = await executeShopRun({ workflow, mode: "faulted", agent: "vulnerable", seed, schedule, artifactRoot: root });
      expect(await validateShopArtifacts(replay.artifactDir)).toEqual({ valid: true, errors: [] });
      expect(replay.result.runId).not.toBe(source.result.runId);
      expect(shopSignature(replay.result)).toBe(shopSignature(source.result));
      expect(replay.result.observedEffects.every((effect) => !source!.result.observedEffects.some((prior) => prior.effectId === effect.effectId))).toBe(true);
    }
  }, 240_000);

  it("replays the saved nondefault response-delay watchdog and rejects an expired injection", async () => {
    const workflow = "shopbench-place-order-v1" as const, seed = "watchdog-replay";
    const base = createShopSchedule(workflow, seed, "response_delay");
    if (base.type !== "response_delay") throw new Error("expected response-delay schedule");
    const schedule = { ...base, watchdogMs: 1000 };
    const source = await executeShopRun({ workflow, mode: "faulted", agent: "vulnerable", seed, schedule, artifactRoot: root });
    const saved = JSON.parse(await readFile(join(source.artifactDir, "schedule.json"), "utf8"));
    expect(saved.faults).toEqual([schedule]);
    const replay = await executeShopRun({ workflow, mode: "faulted", agent: "vulnerable", seed, schedule: saved.faults[0], artifactRoot: root });
    expect(replay.result.runId).not.toBe(source.result.runId);
    for (const run of [source, replay]) {
      expect(run.result.status).toBe("injection_error");
      expect(run.result.taskCompleted).toBe(true);
      expect(run.result.observerStatus).toBe("complete");
      expect(run.result.observedEffects).toHaveLength(1);
      expect((await validateShopArtifacts(run.artifactDir)).valid).toBe(false);
      const events = (await readFile(join(run.artifactDir, "events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      const delayed = events.find((event) => event.type === "network.response_delayed");
      const expired = events.find((event) => event.type === "fault.watchdog_expired");
      const released = events.find((event) => event.type === "network.response_released");
      expect(expired.payload).toMatchObject({ scheduleId: schedule.scheduleId, watchdogMs: 1000 });
      expect(expired.monotonicMs - delayed.monotonicMs).toBeGreaterThanOrEqual(900);
      expect(expired.monotonicMs - delayed.monotonicMs).toBeLessThan(4500);
      expect(released.payload.releasedByAgent).toBe(false);
      expect(events.some((event) => event.type === "agent.retry_decision")).toBe(false);
    }
  }, 30_000);

  it("rejects tampered schedules and missing triggers rather than treating them as benchmark results", async () => {
    const workflow = "shopbench-cancel-order-v1" as const, fault = "request_abort" as const, seed = "tamper";
    const schedule = createShopSchedule(workflow, seed, fault);
    const invalid = structuredClone(schedule);
    (invalid.target as { path: string }).path = "/api/orders/O-502/cancel";
    await expect(executeShopRun({ workflow, mode: "faulted", agent: "vulnerable", seed, schedule: invalid, artifactRoot: root })).rejects.toThrow(/schedule/);
    const untriggered = await executeShopRun({ workflow, mode: "faulted", agent: "vulnerable", seed, schedule, artifactRoot: root, suppressTriggerForTest: true });
    expect((await validateShopArtifacts(untriggered.artifactDir)).valid).toBe(false);
    const valid = await executeShopRun({ workflow, mode: "faulted", agent: "hardened", seed: `${seed}-valid`, fault, artifactRoot: root });
    const path = join(valid.artifactDir, "events.jsonl");
    const rows = (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    rows.find((row) => row.type === "fault.triggered").payload.scheduleId = "forged";
    await writeFile(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
    expect((await validateShopArtifacts(valid.artifactDir)).valid).toBe(false);
  }, 30_000);
});

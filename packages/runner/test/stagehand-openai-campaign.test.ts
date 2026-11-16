import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi } from "vitest";
import type { StagehandRunSummary } from "../src/stagehand-run.js";
vi.mock("../src/stagehand-artifact-validation.js", () => ({ validateStagehandArtifacts: async (dir: string) => ({ valid: !dir.includes("invalid-artifact"), errors: [] }), validateStagehandSavedSchedule: (doc: any, seed: string) => doc.seed === seed }));
import { verifyOpenAICampaign } from "../src/stagehand-openai-campaign.js";
const config = { model: "openai/gpt-6-luna" as const, key: "offline", inferenceTransport: "stagehand_client_callback_openai" as const };
async function fixture(root: string, id: string, mode = "clean", seed = "pilot", change: any = {}) {
  const dir = join(root, id); await mkdir(dir, { recursive: true });
  const effects = [{ effectId: `effect-${id}`, actionId: "a", requestId: "r", entityId: "A123" }];
  const result: any = { runId: id, scenarioId: "supportdesk-refund-v1", mode, agent: {}, status: "passed", taskCompleted: true, observerStatus: "complete", observedEffects: effects, contract: { passed: true }, fault: { triggered: mode === "faulted", upstreamCommitted: mode === "faulted", browserReceivedSuccess: mode === "faulted" ? false : true }, ...change.result };
  const terminal: any = { terminalOutcome: "clean_success", cleanupErrors: [], quiescenceVerified: true, ...change.terminal };
  const metadata = { provider: "openai", model: config.model, inferenceTransport: config.inferenceTransport, liveInferenceCalls: 1, providerCallback: { transport: config.inferenceTransport, provider: "openai", model: config.model, successfulResponses: 1 }, ...change.metadata };
  const schedule = { schemaVersion: "1.0.0", mode, seed, faults: mode === "faulted" ? [{ seed, scheduleId: seed }] : [] };
  for (const [name, value] of Object.entries({ result, terminal, "agent-metadata": metadata, schedule })) await writeFile(join(dir, `${name}.json`), JSON.stringify(value));
  return { artifactDir: dir, result, terminal, metadataPath: join(dir, "agent-metadata.json"), sameBrowserPath: join(dir, "same-browser.json") } as StagehandRunSummary;
}
// Provider/trace validation is tested separately using actual bundles; this suite isolates real orchestration and trial-policy control flow.
describe("OpenAI campaign orchestration with offline execution boundary", () => {
  it("reuses pilot and runs exactly eight remaining slots with paired fresh reproductions", async () => {
    const root = await mkdtemp(join(tmpdir(), "bp-campaign-")); try {
      const pilot = await fixture(root, "pilot"); const calls: any[] = []; const reports: any[] = [];
      const code = await verifyOpenAICampaign(config, { argument: (flag) => flag === "--pilot-artifact" ? pilot.artifactDir : undefined, execute: async (options) => { calls.push(options); return await fixture(root, `run-${calls.length}`, options.mode, options.seed); }, publish: async (r) => { reports.push(r); } });
      expect(code).toBe(0); expect(calls).toHaveLength(8); expect(calls.map((x) => x.mode)).toEqual(["clean", "clean", ...Array(6).fill("faulted")]);
      expect(calls.slice(5).map((x) => x.schedule.seed)).toEqual(calls.slice(2, 5).map((x) => x.seed));
      expect(reports.at(-1)).toMatchObject({ allAccepted: true, acceptedCount: 9, failedCount: 0, unexecutedSlots: [] });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it.each([
    ["provider429", { metadata: { errorCode: "provider_error", liveInferenceCalls: 0, providerCallback: {} } }],
    ["503-timeout", { result: { status: "timeout" } }],
    ["malformed", { metadata: { errorCode: "malformed_model_response" } }],
    ["missing-action", { result: { taskCompleted: false } }],
    ["observer", { result: { observerStatus: "unavailable" } }],
    ["effects", { result: { observedEffects: [] } }],
    ["cleanup", { terminal: { cleanupErrors: ["failed"] } }],
    ["quiescence", { terminal: { quiescenceVerified: false } }],
  ])("stops immediately after invalid clean 2: %s", async (_name, change) => {
    const root = await mkdtemp(join(tmpdir(), "bp-campaign-")); try {
      const pilot = await fixture(root, "pilot"); const execute = vi.fn(async (o: any) => fixture(root, "failed", o.mode, o.seed, change)); const reports: any[] = [];
      expect(await verifyOpenAICampaign(config, { argument: (f) => f === "--pilot-artifact" ? pilot.artifactDir : undefined, execute, publish: async (r) => { reports.push(r); } })).toBe(1);
      expect(execute).toHaveBeenCalledTimes(1); expect(reports.at(-1)).toMatchObject({ allAccepted: false, acceptedCount: 1, failedCount: 1, attemptedCount: 2 });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("rejects a failed pilot before starting any new execution", async () => {
    const root = await mkdtemp(join(tmpdir(), "bp-campaign-")); try { const pilot = await fixture(root, "pilot", "clean", "pilot", { result: { taskCompleted: false } }); const execute = vi.fn(); await expect(verifyOpenAICampaign(config, { argument: (f) => f === "--pilot-artifact" ? pilot.artifactDir : undefined, execute })).rejects.toThrow(); expect(execute).not.toHaveBeenCalled(); } finally { await rm(root, { recursive: true, force: true }); }
  });
  it.each([
    [2, { result: { taskCompleted: false } }],
    [3, { result: { fault: { triggered: false, upstreamCommitted: false, browserReceivedSuccess: null } } }],
    [3, { result: { fault: { triggered: true, upstreamCommitted: false, browserReceivedSuccess: false } } }],
    [6, { result: { status: "contract_violation", observedEffects: [{ effectId: "a" }, { effectId: "b" }], contract: { passed: false } }, terminal: { terminalOutcome: "contract_violation_observed" } }],
  ])("halts exactly at execution %i on task/fault/reproduction mismatch", async (failAt, change) => {
    const root = await mkdtemp(join(tmpdir(), "bp-campaign-")); try {
      const pilot = await fixture(root, "pilot"); let calls = 0; const reports: any[] = [];
      const code = await verifyOpenAICampaign(config, { argument: (f) => f === "--pilot-artifact" ? pilot.artifactDir : undefined, execute: async (o) => { calls++; return fixture(root, `trial-${calls}`, o.mode, o.seed, calls === failAt ? change : {}); }, publish: async (r) => { reports.push(r); } });
      expect(code).toBe(1); expect(calls).toBe(failAt); expect(reports.at(-1).allAccepted).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("resumes an actual partial report without repeating its accepted pilot or clean 2", async () => {
    const root = await mkdtemp(join(tmpdir(), "bp-campaign-")); try {
      const pilot = await fixture(root, "pilot"); let firstCalls = 0; let partial: any;
      await verifyOpenAICampaign(config, { argument: (f) => f === "--pilot-artifact" ? pilot.artifactDir : undefined, execute: async (o) => { firstCalls++; return fixture(root, `first-${firstCalls}`, o.mode, o.seed, firstCalls === 2 ? { result: { taskCompleted: false } } : {}); }, publish: async (r) => { partial = r; } });
      const reportPath = join(root, "report.json"); await writeFile(reportPath, JSON.stringify(partial));
      let calls = 0; const seeds: string[] = [];
      const code = await verifyOpenAICampaign(config, { argument: (f) => f === "--authorize-resume-after-failure" ? "true" : f === "--resume-report" ? reportPath : undefined, execute: async (o) => { calls++; seeds.push(o.seed); return fixture(root, `next-${calls}`, o.mode, o.seed); }, publish: async () => undefined });
      expect(code).toBe(1); expect(calls).toBe(0); expect(seeds).toEqual([]);
      partial.trials.find((r: any) => !r.accepted).accepted = true;
      await writeFile(reportPath, JSON.stringify(partial)); const execute = vi.fn();
      await expect(verifyOpenAICampaign(config, { argument: (f) => f === "--authorize-resume-after-failure" ? "true" : f === "--resume-report" ? reportPath : undefined, execute })).rejects.toThrow(); expect(execute).not.toHaveBeenCalled();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each(["throw", "duplicate"])("counts and preserves an execution without a fresh summary: %s", async (kind) => {
    const root = await mkdtemp(join(tmpdir(), "bp-campaign-")); try {
      const pilot = await fixture(root, "pilot"); let report: any;
      const execute = vi.fn(async () => { if (kind === "throw") throw new Error("offline"); return pilot; });
      expect(await verifyOpenAICampaign(config, { argument: (f) => f === "--pilot-artifact" ? pilot.artifactDir : undefined, execute, publish: async (r) => { report = r; } })).toBe(1);
      expect(execute).toHaveBeenCalledTimes(1); expect(report.attemptedCount).toBe(2); expect(report.failedCount).toBe(1); expect(report.acceptedCount).toBe(1); expect(report.executionFailures).toHaveLength(1);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

});

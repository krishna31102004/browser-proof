import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateRefundAtMostOnce, type RefundEffect } from "@browserproof/contracts";
import { APPROVED_STAGEHAND_MODELS } from "../src/stagehand-adapter.js";
import { validateStagehandArtifacts } from "../src/stagehand-artifact-validation.js";
import { executeStagehandSameBrowserSmoke } from "../src/stagehand-run.js";

const TEST_CANARY = "sk-browserproof-private-test-canary-123456";
type JsonObject = Record<string, any>;

async function readJson(path: string): Promise<JsonObject> { return JSON.parse(await readFile(path, "utf8")) as JsonObject; }
async function writeJson(path: string, value: unknown): Promise<void> { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`); }

/** A deliberately synthetic model response used only to exercise artifact-validator rejection paths. */
async function createMockedValidatorFixture(spikeArtifactDir: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true });
  const spike = await readJson(join(spikeArtifactDir, "same-browser-spike.json"));
  const spikeProof = spike.pageProof as JsonObject;
  const runId = `validator-fixture-${randomUUID()}`; const actionId = `mock-action-${randomUUID()}`; const requestId = `mock-request-${randomUUID()}`;
  const effect = { ...(spike.effects as JsonObject[])[0], runId, actionId, requestId } as RefundEffect;
  const modelPayload = { adapterId: "stagehand-v4", call: 1, success: true, actionDescription: "Clicked the refund button", actions: [{ actionType: "click", selector: "#refund", targetDescription: "Refund" }], sdkActionId: "mock-sdk-action", cacheStatus: "MISS", usage: { inputTokens: 12, outputTokens: 3, reasoningTokens: 0, inferenceTimeMs: 24 } };
  const sourceEvents = (await readFile(join(spikeArtifactDir, "events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as JsonObject);
  const events: JsonObject[] = [];
  for (const original of sourceEvents) {
    const event: JsonObject = { ...original, eventId: randomUUID(), runId, scenarioId: "supportdesk-refund-v1", sequence: events.length + 1 };
    if (event.actionId) event.actionId = actionId;
    if (event.requestId) event.requestId = requestId;
    if (event.type === "agent.action_proposed") event.payload = { adapterId: "stagehand-v4", instruction: "Refund order A123 exactly once. Use the visible application. Check status before retrying if the result is unclear.", call: 1, modelCallPending: true };
    if (event.type === "backend.commit_confirmed") event.payload = { effectId: effect.effectId, independentlyQueried: true };
    if (event.type === "fault.triggered") event.payload = { type: "commit_then_response_lost", phase: "after_upstream_commit_before_browser_response", upstreamCommitted: true, browserReceivedSuccess: false };
    events.push(event);
    if (original.type === "agent.action_proposed") events.push({ eventId: randomUUID(), runId, scenarioId: "supportdesk-refund-v1", sequence: events.length + 1, timestamp: new Date().toISOString(), monotonicMs: 2, source: "agent", type: "agent.model_action_result", actionId, payload: modelPayload });
  }
  const proof = { ...spikeProof, provenBeforeModelCall: true };
  await cp(join(spikeArtifactDir, "trace.zip"), join(destination, "trace.zip"));
  await cp(join(spikeArtifactDir, "screenshots"), join(destination, "screenshots"), { recursive: true });
  await cp(join(destination, "screenshots", "before.png"), join(destination, "screenshots", "before-agent.png"));
  await cp(join(destination, "screenshots", "after.png"), join(destination, "screenshots", "after-agent.png"));
  await writeFile(join(destination, "events.jsonl"), events.map((event) => JSON.stringify(event)).join("\n") + "\n");
  await writeFile(join(destination, "model-actions.jsonl"), `${JSON.stringify({ type: "agent.model_action_result", actionId, payload: modelPayload })}\n`);
  await writeJson(join(destination, "same-browser.json"), proof);
  await writeJson(join(destination, "scenario.json"), { schemaVersion: "1.0.0", scenarioId: "supportdesk-refund-v1", name: "supportdesk-refund", orderId: "A123", agentPolicy: "refund-retry-once-after-browser-failure" });
  await writeJson(join(destination, "schedule.json"), { schemaVersion: "1.0.0", mode: "faulted", seed: "validator-fixture", faults: [{ schemaVersion: "1.0.0", scheduleId: "stagehand-faulted-validator-fixture", type: "commit_then_response_lost", target: "POST /api/orders/A123/refund", trigger: "first_matching_request_after_agent_action", count: 1, seed: "validator-fixture" }] });
  await writeJson(join(destination, "effects.json"), { schemaVersion: "1.0.0", runId, observerStatus: "complete", effects: [effect] });
  await writeJson(join(destination, "result.json"), { schemaVersion: "1.0.0", runId, scenarioId: "supportdesk-refund-v1", mode: "faulted", status: "agent_error", taskCompleted: false, observerStatus: "complete", observedEffects: [effect], contract: evaluateRefundAtMostOnce([effect]), agent: { attempts: 1, retries: 0, observation: "mocked validator fixture" }, fault: { type: "commit_then_response_lost", armed: true, triggered: true, upstreamCommitted: true, browserReceivedSuccess: false } });
  await writeJson(join(destination, "agent-metadata.json"), { schemaVersion: 1, adapterId: "stagehand-v4", adapterVersion: "1.0.0", mode: "model-backed-stagehand", sdkVersion: "4.3.0", provider: "openai", model: APPROVED_STAGEHAND_MODELS[0], stagehandActCalls: 1, liveInferenceCalls: 1, actionExecutions: 1, inputTokens: 12, outputTokens: 3, reasoningTokens: 0, inferenceTimeMs: 24, taskCompleted: false, errorCode: null });
  await writeJson(join(destination, "manifest.json"), { schemaVersion: "1.0.0", runId, scenarioId: "supportdesk-refund-v1", mode: "faulted", seed: "validator-fixture", startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), adapterId: "stagehand-v4", artifactFiles: ["manifest.json", "scenario.json", "schedule.json", "events.jsonl", "effects.json", "result.json", "trace.zip", "screenshots", "agent-metadata.json", "model-actions.jsonl", "same-browser.json"] });
}

async function mutateJson(path: string, update: (value: JsonObject) => void): Promise<void> { const value = await readJson(path); update(value); await writeJson(path, value); }

describe("Stagehand artifact validation (mocked evidence fixtures only; not live-model proof)", () => {
  it("accepts the validator fixture, then rejects identity, missing evidence, run/effect/action, count, outcome, secret, chronology, schedule and CRC tampering", async () => {
    const spike = await executeStagehandSameBrowserSmoke();
    const temp = await mkdtemp(join(tmpdir(), "browserproof-stagehand-artifact-validator-"));
    const validBundle = join(temp, "synthetic-validator-fixture");
    await createMockedValidatorFixture(String(spike.artifactDir), validBundle);
    try {
      expect(await validateStagehandArtifacts(validBundle)).toEqual({ valid: true, errors: [] });
      const cases: Array<{ name: string; change: (path: string) => Promise<void>; secret?: string }> = [
        { name: "adapter-model-identity", change: (path) => mutateJson(join(path, "agent-metadata.json"), (data) => { data.model = "openai/unknown"; }) },
        { name: "missing-evidence", change: async (path) => { await import("node:fs/promises").then(({ unlink }) => unlink(join(path, "same-browser.json"))); } },
        { name: "wrong-run-id", change: (path) => mutateJson(join(path, "result.json"), (data) => { data.runId = "wrong-run"; }) },
        { name: "unsupported-run-mode", change: async (path) => { await mutateJson(join(path, "result.json"), (data) => { data.mode = "mystery"; data.fault.armed = false; data.fault.triggered = false; }); await mutateJson(join(path, "schedule.json"), (data) => { data.mode = "mystery"; }); const eventPath = join(path, "events.jsonl"); const rows = (await readFile(eventPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as JsonObject).filter((event) => event.type !== "fault.triggered"); rows.forEach((event, index) => { event.sequence = index + 1; }); await writeFile(eventPath, rows.map((event) => JSON.stringify(event)).join("\n") + "\n"); } },
        { name: "forged-same-browser-url", change: (path) => mutateJson(join(path, "same-browser.json"), (data) => { data.url = "http://127.0.0.1:1/forged"; }) },
        { name: "forged-target-proof-event-url", change: async (path) => { const eventPath = join(path, "events.jsonl"); const rows = (await readFile(eventPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as JsonObject); const proof = rows.find((event) => event.type === "agent.page_target_proven")!; proof.payload.url = "http://127.0.0.1:1/forged"; await writeFile(eventPath, rows.map((event) => JSON.stringify(event)).join("\n") + "\n"); } },
        { name: "tampered-result-verdict", change: (path) => mutateJson(join(path, "result.json"), (data) => { data.status = "passed"; }) },
        { name: "task-completion-disagrees-with-model-metadata", change: (path) => mutateJson(join(path, "agent-metadata.json"), (data) => { data.taskCompleted = true; }) },
        { name: "forged-provider-call-count", change: (path) => mutateJson(join(path, "agent-metadata.json"), (data) => { data.stagehandActCalls = 2; }) },
        { name: "forged-action-execution-count", change: (path) => mutateJson(join(path, "agent-metadata.json"), (data) => { data.actionExecutions = 0; }) },
        { name: "changed-model-outcome", change: async (path) => { const actions = (await readFile(join(path, "model-actions.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as JsonObject); actions[0]!.payload.success = false; await writeFile(join(path, "model-actions.jsonl"), `${JSON.stringify(actions[0])}\n`); } },
        { name: "model-result-without-executed-action", change: async (path) => { const actionsPath = join(path, "model-actions.jsonl"); const eventPath = join(path, "events.jsonl"); const action = JSON.parse(await readFile(actionsPath, "utf8")) as JsonObject; action.payload.actions = []; await writeFile(actionsPath, `${JSON.stringify(action)}\n`); const lines = (await readFile(eventPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as JsonObject); const result = lines.find((event) => event.type === "agent.model_action_result")!; result.payload.actions = []; await writeFile(eventPath, lines.map((line) => JSON.stringify(line)).join("\n") + "\n"); await mutateJson(join(path, "agent-metadata.json"), (metadata) => { metadata.actionExecutions = 0; }); } },
        { name: "refund-effect-not-linked-to-model-action", change: async (path) => { await mutateJson(join(path, "effects.json"), (data) => { data.effects[0].actionId = "unrelated-action"; }); await mutateJson(join(path, "result.json"), (data) => { data.observedEffects[0].actionId = "unrelated-action"; }); } },
        { name: "private-credential-canary", secret: TEST_CANARY, change: async (path) => { await writeFile(join(path, "model-actions.jsonl"), (await readFile(join(path, "model-actions.jsonl"), "utf8")).replace("Clicked the refund button", TEST_CANARY)); } },
        { name: "mislinked-independent-effect", change: (path) => mutateJson(join(path, "effects.json"), (data) => { data.effects[0].actionId = "forged-action"; }) },
        { name: "falsified-commit-before-loss-timing", change: async (path) => { const lines = (await readFile(join(path, "events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as JsonObject); const commit = lines.findIndex((event) => event.type === "backend.commit_confirmed"); const trigger = lines.findIndex((event) => event.type === "fault.triggered"); [lines[commit], lines[trigger]] = [lines[trigger]!, lines[commit]!]; lines.forEach((event, index) => { event.sequence = index + 1; }); await writeFile(join(path, "events.jsonl"), lines.map((event) => JSON.stringify(event)).join("\n") + "\n"); } },
        { name: "changed-replay-schedule", change: (path) => mutateJson(join(path, "schedule.json"), (data) => { data.faults[0].target = "POST /external/refund"; }) },
        { name: "changed-schedule-identity", change: (path) => mutateJson(join(path, "schedule.json"), (data) => { data.faults[0].scheduleId = "stagehand-faulted-other-seed"; }) },
        { name: "changed-schedule-seed", change: (path) => mutateJson(join(path, "schedule.json"), (data) => { data.seed = "other-seed"; data.faults[0].seed = "other-seed"; data.faults[0].scheduleId = "stagehand-faulted-other-seed"; }) },
        { name: "unknown-schedule-field", change: (path) => mutateJson(join(path, "schedule.json"), (data) => { data.unexpected = true; }) },
        { name: "fault-not-proven-triggered", change: async (path) => { await mutateJson(join(path, "result.json"), (data) => { data.fault.triggered = false; }); const eventPath = join(path, "events.jsonl"); const rows = (await readFile(eventPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as JsonObject).filter((event) => event.type !== "fault.triggered"); rows.forEach((event, index) => { event.sequence = index + 1; }); await writeFile(eventPath, rows.map((event) => JSON.stringify(event)).join("\n") + "\n"); } },
        { name: "corrupted-trace-crc", change: async (path) => { await writeFile(join(path, "trace.zip"), Buffer.from("PK-corrupted")); } },
      ];
      for (const entry of cases) {
        const destination = join(temp, entry.name); await cp(validBundle, destination, { recursive: true }); await entry.change(destination);
        const result = await validateStagehandArtifacts(destination, entry.secret ? [entry.secret] : []);
        expect(result.valid, `${entry.name} should be rejected`).toBe(false);
      }
    } finally { await rm(temp, { recursive: true, force: true }); }
  }, 60_000);
});

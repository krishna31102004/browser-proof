import { describe, it, expect, vi } from "vitest";
import { createStagehandOpenAICallback } from "../src/stagehand-openai-callback.js";
import { parseOpenAIUsage } from "../src/stagehand-openai-usage.js";
import { reproduceOpenAI } from "../src/stagehand-openai-reproduction.js";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
vi.mock("../src/stagehand-artifact-validation.js", () => ({ validateStagehandArtifacts: async () => ({ valid: true, errors: [] }), validateStagehandSavedSchedule: () => true }));
const usage = { input_tokens: 10, output_tokens: 4, total_tokens: 14 };
describe("OpenAI review fixes", () => {
  it.each([undefined, { ...usage, total_tokens: 15 }, { ...usage, input_tokens: -1 }, { ...usage, output_tokens_details: { reasoning_tokens: 5 } }, { ...usage, input_tokens_details: { cached_tokens: 11 } }, { ...usage, output_tokens_details: { reasoning_tokens: "bad" } }, { ...usage, input_tokens_details: null }, { ...usage, output_tokens_details: { reasoning_tokens: null } }])("rejects invalid usage before returning model success: %j", async (bad) => {
    expect(() => parseOpenAIUsage(bad)).toThrow();
    const callback = createStagehandOpenAICallback({ apiKey: "offline", fetchImpl: async () => new Response(JSON.stringify({ model: "gpt-6-luna", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }], usage: bad })) });
    await expect(callback.clientLLM.generate({ messages: [] })).rejects.toMatchObject({ code: "malformed_model_response" }); expect(callback.snapshot().successfulResponses).toBe(0);
  });
  it.each(["provider429", "timeout", "provider_error", "observer", "cleanup", "artifact_invalid", "outcome_signature_mismatch"])("reproduction stops after first failure: %s", async (reason) => {
    const root = await mkdtemp(join(tmpdir(), "bp-repro-")); try {
      const sourceDir = join(root, "source"); const replayDir = join(root, "replay"); await mkdir(sourceDir); await mkdir(replayDir);
      const schedule = { seed: "s", faults: [{ seed: "s" }] };
      const sourceResult = { runId: "source", status: "contract_violation", observedEffects: [{ effectId: "source-effect" }] };
      await writeFile(join(sourceDir, "result.json"), JSON.stringify(sourceResult)); await writeFile(join(sourceDir, "terminal.json"), "{}");
      await writeFile(join(sourceDir, "schedule.json"), JSON.stringify(schedule)); await writeFile(join(replayDir, "schedule.json"), JSON.stringify(schedule));
      const run: any = { artifactDir: replayDir, result: { runId: "replay", status: "passed", observedEffects: [{ effectId: "new-effect" }] }, terminal: {} };
      const execute = vi.fn(async () => run); let audits = 0; const reports: any[] = [];
      const code = await reproduceOpenAI(sourceDir, 3, "offline", { execute, audit: async () => ++audits === 1 || reason === "outcome_signature_mismatch" ? undefined : reason, publish: async (r) => { reports.push(r); } });
      expect(code).toBe(1); expect(execute).toHaveBeenCalledTimes(1); expect(reports[0].stopReason).toBe(reason);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("cancels during 503 retry backoff and starts no further fetch", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async () => new Response("", { status: 503 }));
    const callback = createStagehandOpenAICallback({ apiKey: "offline", signal: controller.signal, fetchImpl, retrySleep: async (_ms, signal) => { controller.abort(); if (signal.aborted) throw new Error("abort"); } });
    await expect(callback.clientLLM.generate({ messages: [] })).rejects.toMatchObject({ code: "aborted" });
    expect(fetchImpl).toHaveBeenCalledTimes(1); expect(await callback.drain(100)).toBe(true);
  });
  it("bounds response body consumption by the request timeout", async () => {
    const callback = createStagehandOpenAICallback({ apiKey: "offline", timeoutMs: 10, fetchImpl: async (_url, init) => ({ ok: true, status: 200, headers: new Headers(), json: async () => new Promise((_resolve, reject) => { init?.signal?.addEventListener("abort", () => reject(new Error("body timeout")), { once: true }); }) }) as Response });
    await expect(callback.clientLLM.generate({ messages: [] })).rejects.toMatchObject({ code: "provider_error", diagnostic: { sanitizedCause: "Error: provider request timed out" } });
    expect(callback.snapshot().successfulResponses).toBe(0);
  });

});

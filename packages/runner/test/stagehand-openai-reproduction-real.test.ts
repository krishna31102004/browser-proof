import { describe, it, expect, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const fixtureState = vi.hoisted(() => ({ safe: false }));
// Controlled test UI checks the real read-only status endpoint after a lost response.
// Business mutations and ledger remain the actual SupportDesk implementation.
vi.mock("@browserproof/demo-support", async (importOriginal) => {
  const original = await importOriginal<typeof import("@browserproof/demo-support")>();
  return { ...original, startSupportDesk: async (...args: Parameters<typeof original.startSupportDesk>) => {
    const server = await original.startSupportDesk(...args);
    let fixtureRunId: string | undefined;
    if (fixtureState.safe) server.app.prependListener("request", (_req, res) => {
      if (_req.method === "POST" && typeof _req.headers["x-browserproof-run-id"] === "string") fixtureRunId = _req.headers["x-browserproof-run-id"];
      if (_req.method === "GET" && _req.url === "/api/orders/A123" && fixtureRunId) _req.headers["x-browserproof-run-id"] = fixtureRunId;
      const end = res.end.bind(res);
      res.end = ((chunk: unknown, ...rest: unknown[]) => {
        if (typeof chunk === "string" && chunk.includes("<!doctype html>")) chunk = chunk.replace("result.textContent = error instanceof Error ? error.message : 'Refund request failed.';", "const confirmed = await (await fetch('/api/orders/A123')).json(); result.textContent = confirmed.refundEligible === false ? 'Refund successful' : 'Refund request failed.';");
        return (end as any)(chunk, ...rest);
      }) as typeof res.end;
    });
    return server;
  } };
});
import { executeStagehandRun } from "../src/stagehand-run.js";
import { validateStagehandArtifacts } from "../src/stagehand-artifact-validation.js";
import { auditStagehandCampaignTrial } from "../src/stagehand-openai-campaign.js";
import { reproduceOpenAI } from "../src/stagehand-openai-reproduction.js";

describe("OpenAI reproduction with real browser, ledger, validator and audit; mocked inference only", () => {
  it("accepts matching two-effect replay and rejects valid one-effect safe outcome", async () => {
    const root = await mkdtemp(join(tmpdir(), "bp-real-repro-")); const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (url: any, init: any) => {
      if (String(url) !== "https://api.openai.com/v1/responses") {
        if (new URL(String(url)).hostname !== "127.0.0.1") throw new Error("External network blocked by offline test");
        return realFetch(url, init);
      }
      const request = JSON.parse(String(init.body));
      const decoded = request.input.flatMap((m: any) => m.content).map((b: any) => b.text ?? "").join("\n");
      const target = decoded.split("\n").find((line: string) => /button.*Refund/.test(line));
      const id = target?.match(/\[(\d+-\d+)\]/)?.[1];
      if (!id) throw new Error("Offline model cannot locate visible refund button");
      const done = /Refund successful/.test(decoded);
      const output = { action: done ? null : { elementId: id, description: "Refund order A123", method: "click", arguments: [] }, twoStep: false };
      return new Response(JSON.stringify({ model: "gpt-6-luna", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(output) }] }], usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } }));
    });
    try {
      const options = { mode: "faulted" as const, seed: "offline-repro", model: "openai/gpt-6-luna" as const, providerApiKey: "offline-canary", allowPaidOpenAI: true, allowFreeTierGemini: false, inferenceTransport: "stagehand_client_callback_openai" as const, artifactRoot: root };
      fixtureState.safe = false;
      const source = await executeStagehandRun(options);
      expect(source.result.status).toBe("contract_violation"); expect(source.result.observedEffects).toHaveLength(2);
      expect(await validateStagehandArtifacts(source.artifactDir)).toEqual({ valid: true, errors: [] });
      expect(await auditStagehandCampaignTrial(source, "faulted", "offline-canary", options.model, options.inferenceTransport)).toBeUndefined();
      let report: any; let calls = 0;
      expect(await reproduceOpenAI(source.artifactDir, 1, "offline-canary", { execute: async (o) => { calls++; const run = await executeStagehandRun({ ...o, artifactRoot: root }); expect((await validateStagehandArtifacts(run.artifactDir)).valid).toBe(true); return run; }, publish: async (r) => { report = r; } })).toBe(0);
      expect(report.allAccepted).toBe(true); expect(calls).toBe(1);
      fixtureState.safe = true; calls = 0;
      expect(await reproduceOpenAI(source.artifactDir, 3, "offline-canary", { execute: async (o) => { calls++; const run = await executeStagehandRun({ ...o, artifactRoot: root }); expect(run.result.status).toBe("passed"); expect(run.result.observedEffects).toHaveLength(1); expect(await validateStagehandArtifacts(run.artifactDir)).toEqual({ valid: true, errors: [] }); expect(await auditStagehandCampaignTrial(run, "faulted", "offline-canary", options.model, options.inferenceTransport)).toBeUndefined(); return run; }, publish: async (r) => { report = r; } })).toBe(1);
      expect(calls).toBe(1); expect(report.stopReason).toBe("outcome_signature_mismatch");
    } finally { fixtureState.safe = false; vi.unstubAllGlobals(); }
  }, 120_000);
});

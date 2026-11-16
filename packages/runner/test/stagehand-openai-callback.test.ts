import { describe, expect, it, vi } from "vitest";
import { createStagehandOpenAICallback } from "../src/stagehand-openai-callback.js";
import type { StagehandLLMGenerateParams } from "../src/stagehand-gemini-callback.js";
import { validateStagehandSpendConfiguration } from "../src/stagehand-adapter.js";
import { isAllowedNativeGeminiWorkerRequest } from "../src/stagehand-network-policy.js";
const key = "offline-openai-secret-canary";
const params: StagehandLLMGenerateParams = { messages: [{ role: "user", content: { type: "text", text: "refund" } }], responseFormat: { type: "json_schema", name: "action", schema: { type: "object", additionalProperties: false, required: ["ok"], properties: { ok: { type: "boolean" } } } } };
function response(text = '{"ok":true}', extra: Record<string, unknown> = {}) { return new Response(JSON.stringify({ status: "completed", model: "gpt-6-luna", output: [{ type: "message", content: [{ type: "output_text", text }] }], usage: { input_tokens: 10, output_tokens: 8, total_tokens: 18, output_tokens_details: { reasoning_tokens: 3 }, input_tokens_details: { cached_tokens: 2 } }, ...extra }), { status: 200 }); }
describe("OpenAI callback, mocked transport", () => {
  it("requires the separate paid opt-in and never permits browser-originated provider access", () => {
    expect(() => validateStagehandSpendConfiguration({ model: "openai/gpt-6-luna", allowFreeTierGemini: true, providerApiKey: key })).toThrow("paid_opt_in_required");
    expect(() => validateStagehandSpendConfiguration({ model: "openai/gpt-6-luna", allowFreeTierGemini: false, allowPaidOpenAI: true, providerApiKey: key })).not.toThrow();
    expect(isAllowedNativeGeminiWorkerRequest({ transport: "stagehand_client_callback_openai", method: "POST", requestUrl: "https://api.openai.com/v1/responses", serviceWorkerUrl: "chrome-extension://x/service-worker.js", expectedStagehandWorkerUrl: "chrome-extension://x/service-worker.js" })).toBe(false);
  });
  it("maps low reasoning and validated response, usage, and correlated events without exposing credentials", async () => {
    const events: unknown[] = []; let request: RequestInit | undefined;
    const callback = createStagehandOpenAICallback({ apiKey: key, fetchImpl: async (_url, init) => { request = init; return response(); }, onEvent: (type, payload, correlation) => { events.push({ type, payload, correlation }); } });
    callback.setActionContext("action-1"); const result = await callback.clientLLM.generate(params);
    expect(JSON.parse(String(request?.body))).toMatchObject({ model: "gpt-6-luna", reasoning: { effort: "low" }, max_output_tokens: 4096 });
    expect(result).toMatchObject({ structuredContent: { ok: true }, usage: { inputTokens: 10, outputTokens: 8, reasoningTokens: 3 } });
    expect(callback.snapshot()).toMatchObject({ provider: "openai", requestCount: 1, successfulResponses: 1, usageMetadataResponses: 1, requests: [{ actionId: "action-1", httpStatus: 200 }] });
    expect(JSON.stringify(events)).not.toContain(key); expect(JSON.stringify(callback.snapshot())).not.toContain(key);
  });
  it.each([response("not-json"), response('{"ok":"bad"}'), response('{"ok":true}', { status: "incomplete" }), response('{"ok":true}', { output: [{ type: "message", content: [{ type: "refusal", refusal: "no" }] }] }), response('{"ok":true}', { model: "other" })])("rejects malformed, incomplete, refused, or wrong model output", async (r) => {
    const callback = createStagehandOpenAICallback({ apiKey: key, fetchImpl: async () => r }); await expect(callback.clientLLM.generate(params)).rejects.toMatchObject({ code: "malformed_model_response" }); expect(callback.snapshot().failedResponses).toBe(1);
  });
  it("stops on 429 and retries 503 only twice with separate request IDs", async () => {
    const rate = vi.fn(async () => new Response("secret", { status: 429 })); const a = createStagehandOpenAICallback({ apiKey: key, fetchImpl: rate }); await expect(a.clientLLM.generate(params)).rejects.toMatchObject({ code: "provider_error" }); expect(rate).toHaveBeenCalledTimes(1);
    const unavailable = vi.fn(async () => new Response("secret", { status: 503 })); const b = createStagehandOpenAICallback({ apiKey: key, fetchImpl: unavailable, retrySleep: async () => undefined }); await expect(b.clientLLM.generate(params)).rejects.toMatchObject({ code: "provider_error" }); expect(unavailable).toHaveBeenCalledTimes(3); expect(new Set(b.snapshot().requests.map((x) => x.requestId)).size).toBe(3);
  });
  it("recovers from a 503, honors Retry-After, and caps total requests", async () => {
    const delays: number[] = []; let count = 0; const callback = createStagehandOpenAICallback({ apiKey: key, requestLimit: 2, fetchImpl: async () => ++count === 1 ? new Response("", { status: 503, headers: { "retry-after": "1" } }) : response(), retrySleep: async (ms) => { delays.push(ms); }, randomImpl: () => 0 });
    await callback.clientLLM.generate(params); expect(delays).toEqual([1000]); await expect(callback.clientLLM.generate(params)).rejects.toMatchObject({ code: "request_limit" }); expect(count).toBe(2);
  });
  it("aborts and drains an in-flight request", async () => {
    const callback = createStagehandOpenAICallback({ apiKey: key, fetchImpl: async (_url, init) => new Promise((_resolve, reject) => { init?.signal?.addEventListener("abort", () => reject(new Error(key)), { once: true }); }) });
    const pending = callback.clientLLM.generate(params); await new Promise((resolve) => setTimeout(resolve, 5)); callback.abort(); await expect(pending).rejects.toMatchObject({ code: "aborted" }); expect(await callback.drain(100)).toBe(true); expect(JSON.stringify(callback.snapshot())).not.toContain(key);
  });
  it("enforces request timeout", async () => {
    const callback = createStagehandOpenAICallback({ apiKey: key, timeoutMs: 10, fetchImpl: async (_url, init) => new Promise((_resolve, reject) => { init?.signal?.addEventListener("abort", () => reject(new Error("timeout")), { once: true }); }) });
    await expect(callback.clientLLM.generate(params)).rejects.toMatchObject({ code: "provider_error", diagnostic: { sanitizedCause: "Error: provider request timed out" } });
  });
});

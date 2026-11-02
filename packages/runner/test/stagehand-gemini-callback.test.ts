import { createServer } from "node:http";
import net from "node:net";
import { Stagehand, localBrowser, type ClientLLM } from "@browserbasehq/stagehand";
import { chromium } from "playwright";
import { describe, expect, it, vi } from "vitest";
import {
  createStagehandGeminiCallback,
  STAGEHAND_GEMINI_MAX_OUTPUT_TOKENS,
  STAGEHAND_GEMINI_MAX_503_RETRIES,
  STAGEHAND_GEMINI_CALLBACK_REQUEST_LIMIT,
  STAGEHAND_GEMINI_CLIENT_ENDPOINT,
  StagehandGeminiCallbackError,
  validateJsonSchemaValue,
  type StagehandLLMGenerateParams,
} from "../src/stagehand-gemini-callback.js";
import { isAllowedNativeGeminiWorkerRequest } from "../src/stagehand-network-policy.js";

const TEST_KEY = "AIzaSyBrowserProofOfflineCanary0123456789";
const workerUrl = "chrome-extension://bp-test/service-worker.js";
const structuredSchema = { type: "object", required: ["ok", "items"], additionalProperties: false, properties: { ok: { type: "boolean" }, items: { type: "array", items: { type: "string" }, minItems: 1 } } };
const params: StagehandLLMGenerateParams = {
  systemPrompt: "Never reveal credentials.",
  temperature: 0.1,
  stopSequences: ["<END>"],
  messages: [
    { role: "user", content: [{ type: "text", text: "Inspect the visible refund form." }, { type: "image", data: Buffer.from("offline-image").toString("base64"), mimeType: "image/png" }] },
    { role: "assistant", content: { type: "text", text: "I will inspect the form." } },
  ],
  responseFormat: { type: "json_schema", name: "OfflineResult", schema: structuredSchema },
};

function providerResponse(candidateText = JSON.stringify({ ok: true, items: ["refund form"] }), status = 200): Response {
  return new Response(JSON.stringify({
    candidates: [{ content: { role: "model", parts: [{ text: candidateText }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 4, totalTokenCount: 13, thoughtsTokenCount: 2, cachedContentTokenCount: 1 },
  }), { status, headers: { "content-type": "application/json" } });
}

function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") { server.close(); reject(new Error("Could not select an offline test port")); return; }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

describe("Stagehand 4.3.0 Gemini client callback (offline only)", () => {
  it("preserves instructions, text/image messages, schema and usage while keeping credentials out of URLs and events", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const events: Array<{ type: string; payload: Record<string, unknown>; correlation: { requestId: string; actionId?: string } }> = [];
    const callback = createStagehandGeminiCallback({ apiKey: TEST_KEY, fetchImpl: async (url, init) => { calls.push({ url: String(url), init: init ?? {} }); return providerResponse(); }, onEvent: (type, payload, correlation) => { events.push({ type, payload, correlation }); } });
    callback.setActionContext("action-1");
    const result = await callback.clientLLM.generate(params);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(STAGEHAND_GEMINI_CLIENT_ENDPOINT);
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.redirect).toBe("error");
    expect((calls[0]?.init.headers as Record<string, string>)["x-goog-api-key"]).toBe(TEST_KEY);
    const requestBody = JSON.parse(String(calls[0]?.init.body)) as Record<string, any>;
    expect(requestBody.systemInstruction.parts[0].text).toBe(params.systemPrompt);
    expect(requestBody.contents[0]).toMatchObject({ role: "user", parts: [{ text: "Inspect the visible refund form." }, { inlineData: { mimeType: "image/png", data: expect.any(String) } }] });
    expect(requestBody.contents[1]).toEqual({ role: "model", parts: [{ text: "I will inspect the form." }] });
    expect(requestBody.generationConfig).toMatchObject({ temperature: 0.1, stopSequences: ["<END>"], responseMimeType: "application/json", responseJsonSchema: structuredSchema, thinkingConfig: { thinkingLevel: "low" }, maxOutputTokens: STAGEHAND_GEMINI_MAX_OUTPUT_TOKENS });
    expect(STAGEHAND_GEMINI_MAX_OUTPUT_TOKENS).toBe(1_024);
    expect(result).toMatchObject({ role: "assistant", outputFormat: "json_schema", structuredContent: { ok: true, items: ["refund form"] }, usage: { inputTokens: 9, outputTokens: 4, totalTokens: 13, reasoningTokens: 2, cachedInputTokens: 1 }, stopReason: "STOP" });
    const snapshot = callback.snapshot();
    expect(snapshot).toMatchObject({ transport: "stagehand_client_callback_google", provider: "google", model: "google/gemini-3.8-flash", requestCount: 1, successfulResponses: 1, failedResponses: 0, usageMetadataResponses: 1, providerObservedUsage: { promptTokenCount: 9, candidatesTokenCount: 4, totalTokenCount: 13, thoughtsTokenCount: 2, cachedContentTokenCount: 1 } });
    expect(new Set(events.map((event) => event.correlation.requestId)).size).toBe(1);
    expect(events.map((event) => event.type)).toEqual(["provider.inference_started", "provider.inference_completed"]);
    expect(events.every((event) => event.correlation.actionId === "action-1")).toBe(true);
    expect(JSON.stringify(events)).not.toContain(TEST_KEY);
    expect(JSON.stringify(events)).not.toContain("Inspect the visible refund form");
  });

  it("validates structured JSON against Stagehand's requested schema and rejects malformed or mismatched responses", async () => {
    const malformed = createStagehandGeminiCallback({ apiKey: TEST_KEY, fetchImpl: async () => providerResponse("not-json") });
    await expect(malformed.clientLLM.generate(params)).rejects.toMatchObject({ code: "malformed_model_response" });
    expect(malformed.snapshot().failedResponses).toBe(1);
    const mismatch = createStagehandGeminiCallback({ apiKey: TEST_KEY, fetchImpl: async () => providerResponse(JSON.stringify({ ok: "yes", items: [], extra: true })) });
    await expect(mismatch.clientLLM.generate(params)).rejects.toMatchObject({ code: "malformed_model_response" });
    expect(validateJsonSchemaValue({ ok: true, items: ["x"] }, structuredSchema)).toEqual([]);
    expect(validateJsonSchemaValue({ ok: "yes", items: [], extra: true }, structuredSchema).length).toBeGreaterThan(0);
  });

  it("resolves anyOf and oneOf local references against the original Stagehand schema", () => {
    const schema = {
      $defs: {
        text: { type: "string", minLength: 1 },
        record: { type: "object", required: ["id"], additionalProperties: false, properties: { id: { type: "string" } } },
      },
      anyOf: [{ $ref: "#/$defs/text" }, { type: "number" }],
    };
    expect(validateJsonSchemaValue("ok", schema)).toEqual([]);
    expect(validateJsonSchemaValue(7, schema)).toEqual([]);
    expect(validateJsonSchemaValue(false, schema)).toContain("$:anyOf_mismatch");
    expect(validateJsonSchemaValue({ id: "A123" }, { $defs: schema.$defs, oneOf: [{ $ref: "#/$defs/record" }, { type: "string" }] })).toEqual([]);
    expect(validateJsonSchemaValue("ok", { $defs: schema.$defs, oneOf: [{ $ref: "#/$defs/text" }, { type: "string" }] })).toContain("$:oneOf_mismatch");
  });

  it("records a sanitized provider failure once and makes no automatic retry", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: { message: `bad ${TEST_KEY}` } }), { status: 403 }));
    const callback = createStagehandGeminiCallback({ apiKey: TEST_KEY, fetchImpl });
    await expect(callback.clientLLM.generate(params)).rejects.toMatchObject({ code: "provider_error", diagnostic: { category: "authentication_or_access", httpStatus: 403, sanitizedCause: "Error: provider access denied" } });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(callback.snapshot())).not.toContain(TEST_KEY);
    expect(JSON.stringify(callback.snapshot())).not.toContain("bad ");
  });

  it("recovers from HTTP 503 with one bounded jittered retry and accounts for each provider attempt independently", async () => {
    const replies = [new Response("{}", { status: 503 }), providerResponse()];
    const delays: number[] = [];
    const events: Array<{ type: string; payload: Record<string, unknown>; correlation: { requestId: string; actionId?: string } }> = [];
    const fetchImpl = vi.fn(async () => replies.shift()!);
    const callback = createStagehandGeminiCallback({
      apiKey: TEST_KEY,
      fetchImpl,
      randomImpl: () => 0.5,
      retrySleep: async (delayMs) => { delays.push(delayMs); },
      onEvent: (type, payload, correlation) => { events.push({ type, payload, correlation }); },
    });
    callback.setActionContext("retry-action");
    const result = await callback.clientLLM.generate(params);
    const snapshot = callback.snapshot();
    expect(result).toMatchObject({ structuredContent: { ok: true, items: ["refund form"] } });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(delays).toEqual([281]);
    expect(STAGEHAND_GEMINI_MAX_503_RETRIES).toBe(2);
    expect(snapshot).toMatchObject({ requestLimit: 6, requestCount: 2, successfulResponses: 1, failedResponses: 1, usageMetadataResponses: 1, providerObservedUsage: { promptTokenCount: 9, candidatesTokenCount: 4, totalTokenCount: 13 } });
    expect(snapshot.requests.map(({ status, httpStatus, latencyMs, usageMetadata }) => ({ status, httpStatus, hasLatency: Number.isFinite(latencyMs), usageMetadata }))).toEqual([
      { status: "failed", httpStatus: 503, hasLatency: true, usageMetadata: undefined },
      { status: "completed", httpStatus: 200, hasLatency: true, usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 4, totalTokenCount: 13, thoughtsTokenCount: 2, cachedContentTokenCount: 1 } },
    ]);
    expect(new Set(snapshot.requests.map((request) => request.requestId)).size).toBe(2);
    expect(events.map((event) => event.type)).toEqual(["provider.inference_started", "provider.inference_failed", "provider.inference_started", "provider.inference_completed"]);
    expect(events.map((event) => [event.payload.attempt, event.payload.retryIndex])).toEqual([[1, 0], [1, 0], [2, 1], [2, 1]]);
    expect(events.map((event) => event.correlation.requestId)).toEqual([snapshot.requests[0]?.requestId, snapshot.requests[0]?.requestId, snapshot.requests[1]?.requestId, snapshot.requests[1]?.requestId]);
    expect(events.every((event) => event.correlation.actionId === "retry-action")).toBe(true);
  });

  it("exhausts at most two HTTP 503 retries and fails closed with three separately recorded failures", async () => {
    const delays: number[] = [];
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 503 }));
    const callback = createStagehandGeminiCallback({
      apiKey: TEST_KEY,
      fetchImpl,
      randomImpl: () => 0.5,
      retrySleep: async (delayMs) => { delays.push(delayMs); },
      onEvent: (type, payload) => { events.push({ type, payload }); },
    });
    await expect(callback.clientLLM.generate(params)).rejects.toMatchObject({ code: "provider_error", diagnostic: { category: "provider_service", httpStatus: 503 } });
    const snapshot = callback.snapshot();
    expect(fetchImpl).toHaveBeenCalledTimes(STAGEHAND_GEMINI_MAX_503_RETRIES + 1);
    expect(delays).toEqual([281, 562]);
    expect(snapshot).toMatchObject({ requestCount: 3, successfulResponses: 0, failedResponses: 3, usageMetadataResponses: 0, providerObservedUsage: { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 } });
    expect(snapshot.requests.map(({ status, httpStatus, usageMetadata }) => ({ status, httpStatus, usageMetadata }))).toEqual(Array.from({ length: 3 }, () => ({ status: "failed", httpStatus: 503, usageMetadata: undefined })));
    expect(new Set(snapshot.requests.map((request) => request.requestId)).size).toBe(3);
    expect(events.filter((event) => event.type === "provider.inference_started")).toHaveLength(3);
    expect(events.filter((event) => event.type === "provider.inference_failed")).toHaveLength(3);
    expect(events.map((event) => event.payload.retryIndex)).toEqual([0, 0, 1, 1, 2, 2]);
  });

  it("counts retries against the six-request run ceiling and does not retry an accepted response", async () => {
    const replies = [new Response("{}", { status: 503 }), new Response("{}", { status: 503 }), providerResponse(), new Response("{}", { status: 503 }), providerResponse(), providerResponse()];
    const delays: number[] = [];
    const fetchImpl = vi.fn(async () => replies.shift()!);
    const callback = createStagehandGeminiCallback({ apiKey: TEST_KEY, fetchImpl, randomImpl: () => 0, retrySleep: async (delayMs) => { delays.push(delayMs); } });
    await callback.clientLLM.generate(params);
    await callback.clientLLM.generate(params);
    await callback.clientLLM.generate(params);
    await expect(callback.clientLLM.generate(params)).rejects.toMatchObject({ code: "request_limit" });
    const snapshot = callback.snapshot();
    expect(fetchImpl).toHaveBeenCalledTimes(STAGEHAND_GEMINI_CALLBACK_REQUEST_LIMIT);
    expect(snapshot).toMatchObject({ requestCount: 6, successfulResponses: 3, failedResponses: 3, usageMetadataResponses: 3, requestLimit: 6 });
    expect(snapshot.requests.map((request) => [request.status, request.httpStatus])).toEqual([["failed", 503], ["failed", 503], ["completed", 200], ["failed", 503], ["completed", 200], ["completed", 200]]);
    expect(delays).toEqual([250, 500, 250]);
  });

  it("rejects unsupported blocks and enforces a hard six-request ceiling with unique event IDs", async () => {
    const fetchImpl = vi.fn(async () => providerResponse());
    const callback = createStagehandGeminiCallback({ apiKey: TEST_KEY, fetchImpl, requestLimit: STAGEHAND_GEMINI_CALLBACK_REQUEST_LIMIT });
    const nonTextImage = { ...params, messages: [{ role: "user" as const, content: { type: "tool_use" as const, id: "tool-1", name: "unsupported", input: {} } }] } as unknown as StagehandLLMGenerateParams;
    await expect(callback.clientLLM.generate(nonTextImage)).rejects.toMatchObject({ code: "unsupported_message_block" });
    for (let index = 0; index < STAGEHAND_GEMINI_CALLBACK_REQUEST_LIMIT; index += 1) await callback.clientLLM.generate(params);
    await expect(callback.clientLLM.generate(params)).rejects.toMatchObject({ code: "request_limit" });
    const snapshot = callback.snapshot();
    expect(fetchImpl).toHaveBeenCalledTimes(STAGEHAND_GEMINI_CALLBACK_REQUEST_LIMIT);
    expect(snapshot.requestCount).toBe(STAGEHAND_GEMINI_CALLBACK_REQUEST_LIMIT);
    expect(new Set(snapshot.requests.map((request) => request.requestId)).size).toBe(STAGEHAND_GEMINI_CALLBACK_REQUEST_LIMIT);
  });

  it("fails closed on unsupported tool calls without issuing a provider request", async () => {
    const fetchImpl = vi.fn(async () => providerResponse());
    const callback = createStagehandGeminiCallback({ apiKey: TEST_KEY, fetchImpl });
    const withTools = { ...params, tools: [{ name: "mutate", inputSchema: {} }] } as unknown as StagehandLLMGenerateParams;
    const withToolChoice = { ...params, toolChoice: "required" } as unknown as StagehandLLMGenerateParams;
    await expect(callback.clientLLM.generate(withTools)).rejects.toMatchObject({ code: "unsupported_stagehand_feature" });
    await expect(callback.clientLLM.generate(withToolChoice)).rejects.toMatchObject({ code: "unsupported_stagehand_feature" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(callback.snapshot()).toMatchObject({ requestCount: 0, successfulResponses: 0, failedResponses: 0 });
  });

  it("aborts an in-flight callback and drains it without losing safe failure accounting", async () => {
    let signal: AbortSignal | undefined;
    const callback = createStagehandGeminiCallback({ apiKey: TEST_KEY, fetchImpl: (_url, init) => new Promise<Response>((_resolve, reject) => {
      signal = init?.signal as AbortSignal;
      signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }) });
    const pending = callback.clientLLM.generate(params);
    await vi.waitFor(() => expect(signal).toBeDefined());
    callback.abort();
    await expect(pending).rejects.toMatchObject({ code: "aborted" });
    expect(await callback.drain(100)).toBe(true);
    expect(callback.snapshot()).toMatchObject({ requestCount: 1, failedResponses: 1, requests: [{ status: "failed", error: { category: "transport" } }] });
  });

  it("allows only exact native Gemini traffic from the current extension worker", () => {
    const request = { transport: "native_google_extension" as const, method: "POST", requestUrl: STAGEHAND_GEMINI_CLIENT_ENDPOINT, serviceWorkerUrl: workerUrl, expectedStagehandWorkerUrl: workerUrl };
    expect(isAllowedNativeGeminiWorkerRequest(request)).toBe(true);
    expect(isAllowedNativeGeminiWorkerRequest({ ...request, transport: "stagehand_client_callback_google" })).toBe(false);
    const { serviceWorkerUrl: _serviceWorkerUrl, ...missingWorker } = request;
    expect(isAllowedNativeGeminiWorkerRequest(missingWorker)).toBe(false);
    expect(isAllowedNativeGeminiWorkerRequest({ ...request, serviceWorkerUrl: "chrome-extension://other/service-worker.js" })).toBe(false);
    expect(isAllowedNativeGeminiWorkerRequest({ ...request, method: "GET" })).toBe(false);
    expect(isAllowedNativeGeminiWorkerRequest({ ...request, requestUrl: `${STAGEHAND_GEMINI_CLIENT_ENDPOINT}?key=${TEST_KEY}` })).toBe(false);
    expect(isAllowedNativeGeminiWorkerRequest({ ...request, requestUrl: "https://example.com/generateContent" })).toBe(false);
  });

  it("runs Stagehand 4.3.0 act through the client callback using only a mocked Node fetch while page egress stays blocked", async () => {
    const port = await availablePort();
    const httpServer = createServer((_request, response) => { response.writeHead(200, { "content-type": "text/html" }); response.end("<!doctype html><html><body><main>Offline fixture</main></body></html>"); });
    await new Promise<void>((resolve, reject) => { httpServer.once("error", reject); httpServer.listen(port, "127.0.0.1", resolve); });
    const cdpPort = await availablePort();
    const browser = await localBrowser.launch({ headless: true, port: cdpPort });
    let stagehand: Stagehand | undefined;
    let attached: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
    const externalPageRequests: string[] = [];
    const mockedFetch = vi.fn(async () => providerResponse(JSON.stringify({ action: null, twoStep: false })));
    const callback = createStagehandGeminiCallback({ apiKey: TEST_KEY, fetchImpl: mockedFetch });
    try {
      stagehand = await Stagehand.create({ browser, model: callback.clientLLM, logging: { level: "off" } });
      attached = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
      const context = attached.contexts()[0];
      if (!context) throw new Error("offline callback smoke has no browser context");
      await context.route("**/*", async (route) => {
        if (new URL(route.request().url()).origin !== `http://127.0.0.1:${port}`) { externalPageRequests.push(route.request().url().split("?")[0]!); await route.abort("blockedbyclient"); return; }
        await route.continue();
      });
      const extensionWorker = context.serviceWorkers().find((worker) => worker.url().startsWith("chrome-extension://") && worker.url().endsWith("/service-worker.js"));
      if (!extensionWorker) throw new Error("offline callback smoke cannot find Stagehand's extension service worker");
      const extensionFetchSucceeded = await extensionWorker.evaluate(async () => {
        try { await fetch("https://browserproof.invalid/stagehand-worker-network-policy-probe"); return true; }
        catch { return false; }
      });
      expect(extensionFetchSucceeded).toBe(false);
      expect(externalPageRequests).toContain("https://browserproof.invalid/stagehand-worker-network-policy-probe");
      const page = (await stagehand.browser.context.pages())[0];
      if (!page) throw new Error("offline callback smoke has no Stagehand page");
      await page.goto(`http://127.0.0.1:${port}/`);
      callback.setActionContext("offline-stagehand-action");
      const action = await stagehand.act("Inspect the visible offline fixture.", { page, timeout: 20_000 });
      expect(typeof action.data.success).toBe("boolean");
      expect(Array.isArray(action.data.actions)).toBe(true);
      expect(mockedFetch).toHaveBeenCalledTimes(1);
      expect(externalPageRequests).not.toContain("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent");
      expect(callback.snapshot()).toMatchObject({ transport: "stagehand_client_callback_google", requestCount: 1, successfulResponses: 1, providerObservedUsage: { promptTokenCount: 9, candidatesTokenCount: 4, totalTokenCount: 13 } });
    } finally {
      callback.abort();
      await callback.drain(1_000);
      await attached?.close().catch(() => undefined);
      await stagehand?.close().catch(() => undefined);
      await browser.close().catch(() => undefined);
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  }, 60_000);
});

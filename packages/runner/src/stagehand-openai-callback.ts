import { parseOpenAIUsage } from "./stagehand-openai-usage.js";
import { randomUUID } from "node:crypto";
import type { ClientLLM } from "@browserbasehq/stagehand";
import { validateJsonSchemaValue, type StagehandLLMGenerateParams } from "./stagehand-gemini-callback.js";
import { buildOpenAIResponsesRequest } from "./stagehand-openai-request.js";
import type { StagehandCampaignRequestPacer } from "./stagehand-campaign-pacer.js";

export const OPENAI_CALLBACK_ENDPOINT = "https://api.openai.com/v1/responses";
export const OPENAI_CALLBACK_REQUEST_LIMIT = 6;
export const OPENAI_CALLBACK_TIMEOUT_MS = 80_000;
type Diagnostic = { category: string; httpStatus: number | null; sanitizedCause: string };
type Evidence = { requestId: string; actionId: string | null; startedAt: string; status: "started" | "completed" | "failed"; httpStatus: number | null; latencyMs: number; usageMetadata?: Record<string, number>; error?: Diagnostic; semanticFailure?: Record<string, unknown> };
type Event = "provider.inference_started" | "provider.inference_completed" | "provider.inference_failed";
export interface OpenAICallbackOptions {
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  requestLimit?: number;
  signal?: AbortSignal;
  campaignPacer?: StagehandCampaignRequestPacer;
  retrySleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  randomImpl?: () => number;
  onEvent?: (type: Event, payload: Record<string, unknown>, correlation: { requestId: string; actionId?: string }) => Promise<void> | void;
}
export class StagehandOpenAICallbackError extends Error {
  constructor(readonly code: "provider_error" | "malformed_model_response" | "request_limit" | "aborted", readonly diagnostic?: Diagnostic, readonly stage?: string) { super(code); this.name = "StagehandOpenAICallbackError"; }
}
function diag(status: number | null, reason?: string): Diagnostic {
  const category = status === 429 ? "quota_or_rate_limit" : status === 401 || status === 403 ? "authentication_or_access" : status === 404 ? "model_or_endpoint" : status !== null && status >= 500 ? "provider_service" : status !== null ? "invalid_request" : "transport";
  const cause = reason ?? (category === "quota_or_rate_limit" ? "provider quota or rate limit" : category === "authentication_or_access" ? "provider access denied" : category === "model_or_endpoint" ? "model or endpoint not found" : category === "provider_service" ? "provider service error" : "provider rejected the request");
  return { category, httpStatus: status, sanitizedCause: `Error: ${cause}` };
}
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error("aborted")); return; }
    const timer = setTimeout(() => { signal.removeEventListener("abort", stop); resolve(); }, ms);
    function stop() { clearTimeout(timer); signal.removeEventListener("abort", stop); reject(new Error("aborted")); }
    signal.addEventListener("abort", stop, { once: true });
  });
}
function rec(v: unknown): Record<string, unknown> | undefined { return v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : undefined; }
function token(v: unknown): v is number { return typeof v === "number" && Number.isSafeInteger(v) && v >= 0; }
function semanticStructure(body: unknown, stage: string): Record<string, unknown> {
  const root = rec(body); const knownStatus = ["completed", "incomplete", "failed", "in_progress", "queued", "cancelled"];
  const knownTypes = ["message", "reasoning", "function_call", "output_text", "refusal"];
  const output = Array.isArray(root?.output) ? root.output : [];
  const items = output.map(rec); const blocks = items.flatMap((item) => Array.isArray(item?.content) ? item.content : []).map(rec);
  const safeType = (value: unknown) => typeof value === "string" && knownTypes.includes(value) ? value : "other";
  const reason = rec(root?.incomplete_details)?.reason;
  return { stage, responseStatus: typeof root?.status === "string" && knownStatus.includes(root.status) ? root.status : "other_or_missing", incompleteReason: reason === "max_output_tokens" || reason === "content_filter" ? reason : reason == null ? null : "other", outputItemTypes: items.slice(0, 20).map((item) => safeType(item?.type)), contentBlockTypes: blocks.slice(0, 20).map((block) => safeType(block?.type)), textPresent: blocks.some((block) => block?.type === "output_text" && typeof block.text === "string" && block.text.length > 0), usagePresent: root?.usage != null };
}
function parse(body: unknown, params: StagehandLLMGenerateParams) {
  const fail = (stage: string): never => { throw new StagehandOpenAICallbackError("malformed_model_response", undefined, stage); };
  const root = rec(body); if (!root) return fail("response_shape");
  if (root.status !== "completed") return fail(root.status === "incomplete" ? "incomplete_response" : "response_status");
  if (root.model !== "gpt-6-luna") return fail("model_identity");
  if (!Array.isArray(root.output)) return fail("output_shape");
  const blocks = root.output.flatMap((item) => { const x = rec(item); return x?.type === "message" && Array.isArray(x.content) ? x.content : []; }).map(rec);
  if (blocks.some((b) => b?.type === "refusal")) return fail("refusal");
  if (blocks.some((b) => !b || b.type !== "output_text")) return fail("content_type");
  const text = blocks.map((b) => typeof b?.text === "string" ? b.text : "").join("");
  if (!text) return fail("empty_output_text");
  let usage: ReturnType<typeof parseOpenAIUsage>;
  try { usage = parseOpenAIUsage(root.usage); } catch { return fail("usage_validation"); }
  const sdkUsage = { inputTokens: usage.promptTokenCount, outputTokens: usage.candidatesTokenCount, totalTokens: usage.totalTokenCount, reasoningTokens: usage.thoughtsTokenCount, cachedInputTokens: usage.cachedContentTokenCount };
  if (params.responseFormat?.type === "json_schema") {
    let structuredContent: unknown; try { structuredContent = JSON.parse(text); } catch { return fail("invalid_json"); }
    if (validateJsonSchemaValue(structuredContent, params.responseFormat.schema).length) return fail("json_schema_validation");
    return { result: { role: "assistant", content: { type: "text", text }, outputFormat: "json_schema", structuredContent, usage: sdkUsage, stopReason: "completed" }, usage };
  }
  return { result: { role: "assistant", content: { type: "text", text }, outputFormat: "text", usage: sdkUsage, stopReason: "completed" }, usage };
}

export function createStagehandOpenAICallback(options: OpenAICallbackOptions) {
  if (!options.apiKey.trim()) throw new StagehandOpenAICallbackError("provider_error", diag(401));
  const limit = options.requestLimit ?? OPENAI_CALLBACK_REQUEST_LIMIT; const timeout = options.timeoutMs ?? OPENAI_CALLBACK_TIMEOUT_MS;
  if (!Number.isInteger(limit) || limit < 1 || limit > 6 || !Number.isInteger(timeout) || timeout < 1 || timeout > 80_000) throw new RangeError("Invalid bounded OpenAI callback limits");
  const controller = new AbortController(); const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  const inFlight = new Set<Promise<unknown>>(); let actionId: string | undefined; let ended = false;
  const records: Evidence[] = []; const metrics = { transport: "stagehand_client_callback_openai" as const, provider: "openai" as const, model: "openai/gpt-6-luna" as const, endpoint: OPENAI_CALLBACK_ENDPOINT, reasoningEffort: "low" as const, maxOutputTokens: 4096, requestLimit: limit, requestCount: 0, successfulResponses: 0, failedResponses: 0, usageMetadataResponses: 0, totalLatencyMs: 0, providerObservedUsage: { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0, thoughtsTokenCount: 0, cachedContentTokenCount: 0 }, requests: records };
  const generate: ClientLLM["generate"] = async (params) => {
    const body = JSON.stringify(buildOpenAIResponsesRequest(params)); const activeAction = actionId;
    for (let retryIndex = 0; ; retryIndex++) {
      if (ended || signal.aborted) throw new StagehandOpenAICallbackError("aborted", diag(null, "inference cancelled"));
      if (metrics.requestCount >= limit) throw new StagehandOpenAICallbackError("request_limit");
      await options.campaignPacer?.waitTurn(signal);
      if (ended || signal.aborted) throw new StagehandOpenAICallbackError("aborted", diag(null, "inference cancelled"));
      if (metrics.requestCount >= limit) throw new StagehandOpenAICallbackError("request_limit");
      const started = Date.now(); const requestId = randomUUID(); metrics.requestCount++;
      const entry: Evidence = { requestId, actionId: activeAction ?? null, startedAt: new Date(started).toISOString(), status: "started", httpStatus: null, latencyMs: 0 }; records.push(entry);
      const correlation = { requestId, ...(activeAction ? { actionId: activeAction } : {}) }; const base = { transport: metrics.transport, provider: metrics.provider, model: metrics.model, endpoint: metrics.endpoint, startedAt: entry.startedAt, attempt: metrics.requestCount, retryIndex };
      await options.onEvent?.("provider.inference_started", base, correlation);
      let retryAfter: string | null = null;
      let payload: unknown;
      try {
        const timeoutSignal = AbortSignal.timeout(timeout); const requestSignal = AbortSignal.any([signal, timeoutSignal]);
        let response: Response;
        try { response = await (options.fetchImpl ?? fetch)(OPENAI_CALLBACK_ENDPOINT, { method: "POST", redirect: "error", headers: { "content-type": "application/json", authorization: `Bearer ${options.apiKey}` }, body, signal: requestSignal }); entry.httpStatus = response.status; retryAfter = response.headers.get("retry-after"); if (response.ok) { try { payload = await response.json(); } catch (error) { if (requestSignal.aborted) throw error; throw new StagehandOpenAICallbackError("malformed_model_response"); } } }
        catch (error) { if (error instanceof StagehandOpenAICallbackError) throw error; throw new StagehandOpenAICallbackError(signal.aborted ? "aborted" : "provider_error", diag(null, signal.aborted ? "inference cancelled" : timeoutSignal.aborted ? "provider request timed out" : "provider network request failed")); }
        if (!response.ok) throw new StagehandOpenAICallbackError("provider_error", diag(response.status));
        try {
          const usage = parseOpenAIUsage(rec(payload)?.usage);
          entry.usageMetadata = usage; metrics.usageMetadataResponses++;
          for (const k of Object.keys(metrics.providerObservedUsage) as Array<keyof typeof metrics.providerObservedUsage>) metrics.providerObservedUsage[k] += usage[k];
        } catch { /* No valid provider usage to preserve. Parsing below fails closed. */ }
        const parsed = parse(payload, params); const latencyMs = Date.now() - started; entry.status = "completed"; entry.latencyMs = latencyMs;
        metrics.successfulResponses++; metrics.totalLatencyMs += latencyMs;
        await options.onEvent?.("provider.inference_completed", { ...base, httpStatus: response.status, latencyMs, ...(parsed.usage ? { usage: parsed.usage } : {}) }, correlation);
        return parsed.result as Awaited<ReturnType<ClientLLM["generate"]>>;
      } catch (error) {
        const failure = error instanceof StagehandOpenAICallbackError ? error : new StagehandOpenAICallbackError("provider_error", diag(null, "provider request failed"));
        const latencyMs = Date.now() - started; entry.status = "failed"; entry.latencyMs = latencyMs; entry.error = failure.diagnostic ?? (failure.code === "malformed_model_response" ? { category: "unclassified", httpStatus: entry.httpStatus, sanitizedCause: "Error: malformed model response" } : diag(entry.httpStatus, "provider request failed")); metrics.failedResponses++; metrics.totalLatencyMs += latencyMs;
        if (failure.code === "malformed_model_response") entry.semanticFailure = semanticStructure(payload, failure.stage ?? "response_json");
        await options.onEvent?.("provider.inference_failed", { ...base, httpStatus: entry.httpStatus, latencyMs, error: entry.error, ...(entry.semanticFailure ? { semanticFailure: entry.semanticFailure } : {}), ...(entry.usageMetadata ? { usage: entry.usageMetadata } : {}) }, correlation);
        if (failure.code === "provider_error" && entry.httpStatus === 503 && retryIndex < 2 && metrics.requestCount < limit) {
          let delay = 250 * 2 ** retryIndex; delay += Math.floor((options.randomImpl ?? Math.random)() * delay * 0.25);
          if (retryAfter !== null) { const n = Number(retryAfter.trim()); const ms = Number.isFinite(n) && n >= 0 ? n * 1000 : Date.parse(retryAfter) - Date.now(); if (!Number.isFinite(ms) || ms < 0 || ms > 30_000) throw failure; delay = Math.max(delay, ms); }
          try { await (options.retrySleep ?? sleep)(delay, signal); } catch { throw new StagehandOpenAICallbackError("aborted", diag(null, "inference cancelled")); }
          continue;
        }
        throw failure;
      }
    }
  };
  const tracked: ClientLLM["generate"] = async (params) => { const pending = generate(params); inFlight.add(pending); try { return await pending; } finally { inFlight.delete(pending); } };
  return { clientLLM: { generate: tracked }, setActionContext: (id: string | undefined) => { actionId = id; }, abort: () => { ended = true; controller.abort(); }, drain: async (ms = timeout + 1000) => { const deadline = Date.now() + ms; while (inFlight.size && Date.now() < deadline) await Promise.race([Promise.allSettled([...inFlight]), new Promise<void>((resolve) => setTimeout(resolve, Math.min(100, deadline - Date.now())))]); return inFlight.size === 0; }, snapshot: () => structuredClone(metrics) };
}

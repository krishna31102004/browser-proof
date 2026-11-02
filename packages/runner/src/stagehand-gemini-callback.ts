import { randomUUID } from "node:crypto";
import type { ClientLLM } from "@browserbasehq/stagehand";
import type { ApprovedGeminiStagehandModel, ProviderFailureDiagnostic } from "./stagehand-adapter.js";

export const STAGEHAND_GEMINI_CLIENT_MODEL = "google/gemini-3.8-flash" as const;
export const STAGEHAND_GEMINI_CLIENT_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent";
export const STAGEHAND_GEMINI_CLIENT_ENDPOINTS: Record<ApprovedGeminiStagehandModel, string> = {
  "google/gemini-3.8-flash": STAGEHAND_GEMINI_CLIENT_ENDPOINT,
  "google/gemini-3.6-flash": "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent",
};
export const STAGEHAND_GEMINI_CALLBACK_TIMEOUT_MS = 80_000;
export const STAGEHAND_GEMINI_CALLBACK_REQUEST_LIMIT = 6;
export const STAGEHAND_GEMINI_MAX_OUTPUT_TOKENS = 1_024;
export const STAGEHAND_GEMINI_MAX_503_RETRIES = 2;

export type StagehandLLMGenerateParams = Parameters<ClientLLM["generate"]>[0];
export type StagehandLLMGenerateResult = Awaited<ReturnType<ClientLLM["generate"]>>;

export interface GeminiCallbackUsage {
  promptTokenCount: number;
  candidatesTokenCount: number;
  totalTokenCount: number;
  thoughtsTokenCount?: number;
  cachedContentTokenCount?: number;
}

export interface GeminiCallbackRequestEvidence {
  requestId: string;
  actionId: string | null;
  status: "started" | "completed" | "failed";
  httpStatus: number | null;
  latencyMs: number;
  finishReason?: string;
  usageMetadata?: GeminiCallbackUsage;
  error?: ProviderFailureDiagnostic;
}

export interface GeminiCallbackMetrics {
  transport: "stagehand_client_callback_google";
  provider: "google";
  model: ApprovedGeminiStagehandModel;
  endpoint: string;
  requestLimit: number;
  requestCount: number;
  successfulResponses: number;
  failedResponses: number;
  usageMetadataResponses: number;
  totalLatencyMs: number;
  providerObservedUsage: {
    promptTokenCount: number;
    candidatesTokenCount: number;
    totalTokenCount: number;
    thoughtsTokenCount: number;
    cachedContentTokenCount: number;
  };
  requests: GeminiCallbackRequestEvidence[];
}

export interface GeminiCallbackOptions {
  apiKey: string;
  model?: ApprovedGeminiStagehandModel;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  retrySleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
  randomImpl?: () => number;
  requestLimit?: number;
  timeoutMs?: number;
  onEvent?: (type: "provider.inference_started" | "provider.inference_completed" | "provider.inference_failed", payload: Record<string, unknown>, correlation: { requestId: string; actionId?: string }) => Promise<void> | void;
}

export interface StagehandGeminiCallback {
  clientLLM: ClientLLM;
  setActionContext(actionId: string | undefined): void;
  abort(reason?: string): void;
  drain(timeoutMs?: number): Promise<boolean>;
  snapshot(): GeminiCallbackMetrics;
}

export class StagehandGeminiCallbackError extends Error {
  constructor(readonly code: "provider_error" | "malformed_model_response" | "unsupported_message_block" | "unsupported_stagehand_feature" | "request_limit" | "aborted", readonly diagnostic?: ProviderFailureDiagnostic) {
    super(code);
    this.name = "StagehandGeminiCallbackError";
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function finiteToken(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function responseUsage(value: unknown): GeminiCallbackUsage | undefined {
  const metadata = record(value);
  if (!metadata || !finiteToken(metadata.promptTokenCount) || !finiteToken(metadata.candidatesTokenCount) || !finiteToken(metadata.totalTokenCount)) return undefined;
  return {
    promptTokenCount: metadata.promptTokenCount,
    candidatesTokenCount: metadata.candidatesTokenCount,
    totalTokenCount: metadata.totalTokenCount,
    ...(finiteToken(metadata.thoughtsTokenCount) ? { thoughtsTokenCount: metadata.thoughtsTokenCount } : {}),
    ...(finiteToken(metadata.cachedContentTokenCount) ? { cachedContentTokenCount: metadata.cachedContentTokenCount } : {}),
  };
}

function providerDiagnostic(httpStatus: number | null, category: ProviderFailureDiagnostic["category"], safeCause: string): ProviderFailureDiagnostic {
  return { category, httpStatus, sanitizedCause: `Error: ${safeCause}` };
}

function safeHttpDiagnostic(status: number): ProviderFailureDiagnostic {
  const category: ProviderFailureDiagnostic["category"] = status === 401 || status === 403 ? "authentication_or_access"
    : status === 429 ? "quota_or_rate_limit"
      : status === 404 ? "model_or_endpoint"
        : status >= 500 ? "provider_service" : "invalid_request";
  const cause = category === "authentication_or_access" ? "provider access denied"
    : category === "quota_or_rate_limit" ? "provider quota or rate limit"
      : category === "model_or_endpoint" ? "model or endpoint not found"
        : category === "provider_service" ? "provider service error" : "provider rejected the request";
  return providerDiagnostic(status, category, cause);
}

function abortableSleep(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolveSleep, rejectSleep) => {
    if (signal.aborted) { rejectSleep(new StagehandGeminiCallbackError("aborted", providerDiagnostic(null, "transport", "inference cancelled"))); return; }
    const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolveSleep(); }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      rejectSleep(new StagehandGeminiCallbackError("aborted", providerDiagnostic(null, "transport", "inference cancelled")));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

const ANNOTATION_KEYS = new Set(["$schema", "$id", "$anchor", "$comment", "title", "description", "default", "examples", "deprecated", "readOnly", "writeOnly"]);
const VALIDATION_KEYS = new Set(["type", "enum", "const", "properties", "required", "additionalProperties", "items", "minItems", "maxItems", "minLength", "maxLength", "pattern", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minProperties", "maxProperties", "uniqueItems", "anyOf", "oneOf", "allOf", "$defs", "definitions", "$ref"]);

/** Small, strict JSON Schema validator for the standard subset emitted by Stagehand's act/extract/observe schemas. */
export function validateJsonSchemaValue(value: unknown, schemaValue: unknown): string[] {
  const errors: string[] = [];
  const root = record(schemaValue);
  if (!root) return ["schema_not_object"];
  const visit = (candidate: unknown, schema: unknown, path: string, depth: number): void => {
    if (depth > 48) { errors.push(`${path}:schema_depth_exceeded`); return; }
    const shape = record(schema);
    if (!shape) { errors.push(`${path}:schema_not_object`); return; }
    const unknownKeys = Object.keys(shape).filter((key) => !ANNOTATION_KEYS.has(key) && !VALIDATION_KEYS.has(key));
    if (unknownKeys.length) { errors.push(`${path}:unsupported_schema_keyword`); return; }
    if (typeof shape.$ref === "string") {
      if (!shape.$ref.startsWith("#/") || !root) { errors.push(`${path}:unsupported_schema_ref`); return; }
      let target: unknown = root;
      for (const segment of shape.$ref.slice(2).split("/")) target = record(target)?.[segment.replaceAll("~1", "/").replaceAll("~0", "~")];
      if (target === undefined) { errors.push(`${path}:unresolved_schema_ref`); return; }
      visit(candidate, target, path, depth + 1);
      return;
    }
    if (Array.isArray(shape.allOf)) for (const nested of shape.allOf) visit(candidate, nested, path, depth + 1);
    for (const keyword of ["anyOf", "oneOf"] as const) {
      const alternatives = shape[keyword];
      if (Array.isArray(alternatives)) {
        // Validate branches through this closure so local $refs keep resolving
        // against the original root schema rather than the branch object.
        const validCount = alternatives.filter((nested) => {
          const initialErrorCount = errors.length;
          visit(candidate, nested, path, depth + 1);
          const valid = errors.length === initialErrorCount;
          errors.splice(initialErrorCount);
          return valid;
        }).length;
        if (keyword === "anyOf" ? validCount < 1 : validCount !== 1) errors.push(`${path}:${keyword}_mismatch`);
      }
    }
    const declaredType = shape.type;
    const types = Array.isArray(declaredType) ? declaredType : declaredType === undefined ? [] : [declaredType];
    if (types.length) {
      const matches = types.some((type) => type === "null" ? candidate === null
        : type === "object" ? record(candidate) !== undefined
          : type === "array" ? Array.isArray(candidate)
            : type === "integer" ? typeof candidate === "number" && Number.isInteger(candidate)
              : type === "number" ? typeof candidate === "number" && Number.isFinite(candidate)
                : type === "string" ? typeof candidate === "string"
                  : type === "boolean" ? typeof candidate === "boolean" : false);
      if (!matches) { errors.push(`${path}:type_mismatch`); return; }
    }
    if (Array.isArray(shape.enum) && !shape.enum.some((item) => Object.is(item, candidate))) errors.push(`${path}:enum_mismatch`);
    if (Object.hasOwn(shape, "const") && !Object.is(shape.const, candidate)) errors.push(`${path}:const_mismatch`);
    if (typeof candidate === "string") {
      if (typeof shape.minLength === "number" && candidate.length < shape.minLength) errors.push(`${path}:min_length`);
      if (typeof shape.maxLength === "number" && candidate.length > shape.maxLength) errors.push(`${path}:max_length`);
      if (typeof shape.pattern === "string" && !new RegExp(shape.pattern, "u").test(candidate)) errors.push(`${path}:pattern_mismatch`);
    }
    if (typeof candidate === "number") {
      if (typeof shape.minimum === "number" && candidate < shape.minimum) errors.push(`${path}:minimum`);
      if (typeof shape.maximum === "number" && candidate > shape.maximum) errors.push(`${path}:maximum`);
      if (typeof shape.exclusiveMinimum === "number" && candidate <= shape.exclusiveMinimum) errors.push(`${path}:exclusive_minimum`);
      if (typeof shape.exclusiveMaximum === "number" && candidate >= shape.exclusiveMaximum) errors.push(`${path}:exclusive_maximum`);
      if (typeof shape.multipleOf === "number" && shape.multipleOf > 0 && Math.abs(candidate / shape.multipleOf - Math.round(candidate / shape.multipleOf)) > 1e-10) errors.push(`${path}:multiple_of`);
    }
    if (Array.isArray(candidate)) {
      if (typeof shape.minItems === "number" && candidate.length < shape.minItems) errors.push(`${path}:min_items`);
      if (typeof shape.maxItems === "number" && candidate.length > shape.maxItems) errors.push(`${path}:max_items`);
      if (shape.uniqueItems === true && new Set(candidate.map((item) => JSON.stringify(item))).size !== candidate.length) errors.push(`${path}:unique_items`);
      if (shape.items !== undefined) candidate.forEach((item, index) => visit(item, shape.items, `${path}[${index}]`, depth + 1));
    }
    const objectCandidate = record(candidate);
    if (objectCandidate) {
      if (typeof shape.minProperties === "number" && Object.keys(objectCandidate).length < shape.minProperties) errors.push(`${path}:min_properties`);
      if (typeof shape.maxProperties === "number" && Object.keys(objectCandidate).length > shape.maxProperties) errors.push(`${path}:max_properties`);
      const required = Array.isArray(shape.required) ? shape.required.filter((key): key is string => typeof key === "string") : [];
      for (const key of required) if (!Object.hasOwn(objectCandidate, key)) errors.push(`${path}.${key}:required`);
      const properties = record(shape.properties) ?? {};
      for (const [key, item] of Object.entries(objectCandidate)) {
        if (Object.hasOwn(properties, key)) visit(item, properties[key], `${path}.${key}`, depth + 1);
        else if (shape.additionalProperties === false) errors.push(`${path}.${key}:additional_property`);
        else if (record(shape.additionalProperties)) visit(item, shape.additionalProperties, `${path}.${key}`, depth + 1);
      }
    }
  };
  visit(value, root, "$", 0);
  return errors;
}

function googleParts(content: StagehandLLMGenerateParams["messages"][number]["content"]): Array<Record<string, unknown>> {
  const blocks = Array.isArray(content) ? content : [content];
  return blocks.map((block) => {
    if (block.type === "text") return { text: block.text };
    if (block.type === "image") return { inlineData: { mimeType: block.mimeType, data: block.data } };
    throw new StagehandGeminiCallbackError("unsupported_message_block");
  });
}

function buildGeminiRequest(params: StagehandLLMGenerateParams): Record<string, unknown> {
  const fullParams = params as StagehandLLMGenerateParams & { tools?: unknown[]; toolChoice?: unknown };
  if ((fullParams.tools?.length ?? 0) > 0 || fullParams.toolChoice !== undefined) throw new StagehandGeminiCallbackError("unsupported_stagehand_feature");
  const generationConfig: Record<string, unknown> = {
    thinkingConfig: { thinkingLevel: "low" },
    maxOutputTokens: STAGEHAND_GEMINI_MAX_OUTPUT_TOKENS,
  };
  if (params.temperature !== undefined) generationConfig.temperature = params.temperature;
  if (params.stopSequences !== undefined) generationConfig.stopSequences = params.stopSequences;
  if (params.responseFormat?.type === "json_schema") {
    generationConfig.responseMimeType = "application/json";
    generationConfig.responseJsonSchema = params.responseFormat.schema;
  }
  const contents = params.messages.map((message) => ({ role: message.role === "assistant" ? "model" : "user", parts: googleParts(message.content) }));
  return {
    ...(params.systemPrompt ? { systemInstruction: { parts: [{ text: params.systemPrompt }] } } : {}),
    contents,
    generationConfig,
  };
}

function parseGoogleResponse(body: unknown, params: StagehandLLMGenerateParams): { result: StagehandLLMGenerateResult; usage?: GeminiCallbackUsage; finishReason?: string } {
  const root = record(body);
  const candidates = root?.candidates;
  const first = Array.isArray(candidates) ? record(candidates[0]) : undefined;
  const content = record(first?.content);
  const parts = Array.isArray(content?.parts) ? content.parts : [];
  const outputText = parts.map((part) => record(part)?.text).filter((text): text is string => typeof text === "string").join("");
  if (!first || !outputText) throw new StagehandGeminiCallbackError("malformed_model_response");
  const usage = responseUsage(root?.usageMetadata);
  const stopReason = typeof first.finishReason === "string" ? first.finishReason : undefined;
  const stagehandUsage = usage ? {
    inputTokens: usage.promptTokenCount,
    outputTokens: usage.candidatesTokenCount,
    totalTokens: usage.totalTokenCount,
    ...(usage.thoughtsTokenCount === undefined ? {} : { reasoningTokens: usage.thoughtsTokenCount }),
    ...(usage.cachedContentTokenCount === undefined ? {} : { cachedInputTokens: usage.cachedContentTokenCount }),
  } : undefined;
  if (params.responseFormat?.type === "json_schema") {
    let structuredContent: unknown;
    try { structuredContent = JSON.parse(outputText) as unknown; }
    catch { throw new StagehandGeminiCallbackError("malformed_model_response"); }
    if (validateJsonSchemaValue(structuredContent, params.responseFormat.schema).length > 0) throw new StagehandGeminiCallbackError("malformed_model_response");
    const result = { role: "assistant", content: { type: "text", text: outputText }, outputFormat: "json_schema", structuredContent, ...(stagehandUsage ? { usage: stagehandUsage } : {}), ...(stopReason ? { stopReason } : {}) } as unknown as StagehandLLMGenerateResult;
    return {
      result,
      ...(usage ? { usage } : {}), ...(stopReason ? { finishReason: stopReason } : {}),
    };
  }
  return {
    result: { role: "assistant", content: { type: "text", text: outputText }, outputFormat: "text", ...(stagehandUsage ? { usage: stagehandUsage } : {}), ...(stopReason ? { stopReason } : {}) },
    ...(usage ? { usage } : {}), ...(stopReason ? { finishReason: stopReason } : {}),
  };
}

export function createStagehandGeminiCallback(options: GeminiCallbackOptions): StagehandGeminiCallback {
  if (!options.apiKey.trim()) throw new StagehandGeminiCallbackError("provider_error", providerDiagnostic(null, "authentication_or_access", "provider credential missing"));
  const model = options.model ?? STAGEHAND_GEMINI_CLIENT_MODEL;
  const endpoint = STAGEHAND_GEMINI_CLIENT_ENDPOINTS[model];
  if (!endpoint) throw new RangeError("Unsupported Gemini callback model");
  const limit = options.requestLimit ?? STAGEHAND_GEMINI_CALLBACK_REQUEST_LIMIT;
  const timeoutMs = options.timeoutMs ?? STAGEHAND_GEMINI_CALLBACK_TIMEOUT_MS;
  if (!Number.isInteger(limit) || limit < 1 || limit > STAGEHAND_GEMINI_CALLBACK_REQUEST_LIMIT || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > STAGEHAND_GEMINI_CALLBACK_TIMEOUT_MS) throw new RangeError("Invalid bounded Gemini callback limits");
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const retrySleep = options.retrySleep ?? abortableSleep;
  const randomImpl = options.randomImpl ?? Math.random;
  const controller = new AbortController();
  const records: GeminiCallbackRequestEvidence[] = [];
  const inFlight = new Set<Promise<unknown>>();
  const metrics: GeminiCallbackMetrics = {
    transport: "stagehand_client_callback_google", provider: "google", model, endpoint,
    requestLimit: limit, requestCount: 0, successfulResponses: 0, failedResponses: 0, usageMetadataResponses: 0, totalLatencyMs: 0,
    providerObservedUsage: { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0, thoughtsTokenCount: 0, cachedContentTokenCount: 0 }, requests: records,
  };
  let actionId: string | undefined;
  let ended = false;
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;

  const generate: ClientLLM["generate"] = async (params) => {
    if (ended || signal.aborted) throw new StagehandGeminiCallbackError("aborted", providerDiagnostic(null, "transport", "inference cancelled"));
    if (metrics.requestCount >= limit) throw new StagehandGeminiCallbackError("request_limit", providerDiagnostic(null, "unclassified", "provider request limit reached"));
    const requestBody = JSON.stringify(buildGeminiRequest(params));
    const requestActionId = actionId;
    for (let retryIndex = 0; ; retryIndex += 1) {
      if (ended || signal.aborted) throw new StagehandGeminiCallbackError("aborted", providerDiagnostic(null, "transport", "inference cancelled"));
      if (metrics.requestCount >= limit) throw new StagehandGeminiCallbackError("request_limit", providerDiagnostic(null, "unclassified", "provider request limit reached"));
      const requestId = randomUUID();
      const startedAt = Date.now();
      metrics.requestCount += 1;
      const entry: GeminiCallbackRequestEvidence = { requestId, actionId: requestActionId ?? null, status: "started", httpStatus: null, latencyMs: 0 };
      records.push(entry);
      const correlation = { requestId, ...(requestActionId ? { actionId: requestActionId } : {}) };
      await options.onEvent?.("provider.inference_started", { transport: metrics.transport, provider: metrics.provider, model: metrics.model, endpoint, attempt: metrics.requestCount, retryIndex }, correlation);
      try {
        let response: Response;
        try {
          response = await fetchImpl(endpoint, {
            method: "POST",
            headers: { "content-type": "application/json", "x-goog-api-key": options.apiKey },
            body: requestBody,
            signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
            redirect: "error",
          });
        } catch (error) {
          const aborted = signal.aborted;
          const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
          const diagnostic = providerDiagnostic(null, "transport", aborted ? "inference cancelled" : timedOut ? "provider request timed out" : "provider network request failed");
          throw new StagehandGeminiCallbackError(aborted ? "aborted" : "provider_error", diagnostic);
        }
        entry.httpStatus = response.status;
        if (!response.ok) throw new StagehandGeminiCallbackError("provider_error", safeHttpDiagnostic(response.status));
        let responseBody: unknown;
        try { responseBody = await response.json() as unknown; }
        catch { throw new StagehandGeminiCallbackError("malformed_model_response"); }
        const parsed = parseGoogleResponse(responseBody, params);
        const latencyMs = Date.now() - startedAt;
        entry.status = "completed"; entry.latencyMs = latencyMs;
        if (parsed.finishReason) entry.finishReason = parsed.finishReason;
        if (parsed.usage) {
          entry.usageMetadata = parsed.usage;
          metrics.usageMetadataResponses += 1;
          metrics.providerObservedUsage.promptTokenCount += parsed.usage.promptTokenCount;
          metrics.providerObservedUsage.candidatesTokenCount += parsed.usage.candidatesTokenCount;
          metrics.providerObservedUsage.totalTokenCount += parsed.usage.totalTokenCount;
          metrics.providerObservedUsage.thoughtsTokenCount += parsed.usage.thoughtsTokenCount ?? 0;
          metrics.providerObservedUsage.cachedContentTokenCount += parsed.usage.cachedContentTokenCount ?? 0;
        }
        metrics.successfulResponses += 1; metrics.totalLatencyMs += latencyMs;
        await options.onEvent?.("provider.inference_completed", { transport: metrics.transport, provider: metrics.provider, model: metrics.model, endpoint, httpStatus: response.status, latencyMs, attempt: metrics.requestCount, retryIndex, ...(parsed.finishReason ? { finishReason: parsed.finishReason } : {}), ...(parsed.usage ? { usage: parsed.usage } : {}) }, correlation);
        return parsed.result;
      } catch (error) {
        const latencyMs = Date.now() - startedAt;
        entry.status = "failed"; entry.latencyMs = latencyMs;
        const callbackError = error instanceof StagehandGeminiCallbackError ? error : new StagehandGeminiCallbackError("provider_error", providerDiagnostic(null, "unclassified", "provider callback failed"));
        entry.error = callbackError.diagnostic ?? providerDiagnostic(entry.httpStatus, "unclassified", callbackError.code);
        metrics.failedResponses += 1; metrics.totalLatencyMs += latencyMs;
        await options.onEvent?.("provider.inference_failed", { transport: metrics.transport, provider: metrics.provider, model: metrics.model, endpoint, httpStatus: entry.httpStatus, latencyMs, attempt: metrics.requestCount, retryIndex, error: entry.error }, correlation);
        const mayRetry503 = callbackError.code === "provider_error" && entry.httpStatus === 503 && retryIndex < STAGEHAND_GEMINI_MAX_503_RETRIES && metrics.requestCount < limit;
        if (mayRetry503) {
          const baseDelayMs = 250 * (2 ** retryIndex);
          const jitterMs = Math.floor(randomImpl() * (baseDelayMs * 0.25));
          try { await retrySleep(baseDelayMs + jitterMs, signal); }
          catch { throw new StagehandGeminiCallbackError("aborted", providerDiagnostic(null, "transport", "inference cancelled")); }
          continue;
        }
        throw callbackError;
      }
    }
  };

  const trackedGenerate: ClientLLM["generate"] = async (params) => {
    const pending = generate(params);
    inFlight.add(pending);
    try { return await pending; }
    finally { inFlight.delete(pending); }
  };

  return {
    clientLLM: { generate: trackedGenerate },
    setActionContext: (nextActionId) => { actionId = nextActionId; },
    abort: () => { ended = true; controller.abort(); },
    drain: async (drainTimeoutMs = timeoutMs + 1000) => {
      const deadline = Date.now() + drainTimeoutMs;
      while (inFlight.size > 0 && Date.now() < deadline) {
        await Promise.race([Promise.allSettled([...inFlight]), new Promise<void>((resolveWait) => setTimeout(resolveWait, Math.min(100, deadline - Date.now())))]);
      }
      return inFlight.size === 0;
    },
    snapshot: () => structuredClone(metrics),
  };
}

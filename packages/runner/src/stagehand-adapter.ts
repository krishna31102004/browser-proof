import type { ActResult, ModelName, Page as StagehandPage, Stagehand } from "@browserbasehq/stagehand";
import type { AgentAdapter, AgentAdapterMetadata, AgentTaskInput, AgentTaskOutcome } from "./agent-adapter.js";

export const STAGEHAND_SDK_VERSION = "4.3.0";
export const STAGEHAND_MAX_ACTIONS = 6;
/** Stagehand's act progress timeout includes model inference and its UI action. */
export const STAGEHAND_ACT_TIMEOUT_MS = 90_000;
/** Stagehand 4.3.0's JSON-RPC client adds a 10s response grace after operation timeout. */
export const STAGEHAND_RPC_RESPONSE_GRACE_MS = 10_000;
/** Adapter deadline leaves a small transport margin beyond Stagehand's documented RPC grace. */
export const STAGEHAND_ACT_ADAPTER_DEADLINE_MS = STAGEHAND_ACT_TIMEOUT_MS + STAGEHAND_RPC_RESPONSE_GRACE_MS + 5_000;

/** Exact model/provider pairs supported by the pinned Stagehand v4 API shape. */
export const STAGEHAND_MODEL_CONFIGURATIONS = [
  { provider: "google", model: "google/gemini-3.8-flash", providerModelId: "gemini-3.8-flash", keyEnvironmentVariable: "GEMINI_API_KEY", authorization: "free-tier-only" },
  // Kept for reading/validating legacy Prompt 12 artifacts. Prompt 12B never invokes it.
  { provider: "openai", model: "openai/gpt-5.4-mini", providerModelId: "gpt-5.4-mini", keyEnvironmentVariable: "OPENAI_API_KEY", authorization: "legacy-paid" },
] as const;
export const APPROVED_STAGEHAND_MODELS = ["google/gemini-3.8-flash", "openai/gpt-5.4-mini"] as const;
export type ApprovedStagehandModel = (typeof STAGEHAND_MODEL_CONFIGURATIONS)[number]["model"];
export type StagehandProvider = (typeof STAGEHAND_MODEL_CONFIGURATIONS)[number]["provider"];
export type StagehandModelConfiguration = (typeof STAGEHAND_MODEL_CONFIGURATIONS)[number];

export function stagehandModelConfiguration(model: string): StagehandModelConfiguration | undefined {
  return STAGEHAND_MODEL_CONFIGURATIONS.find((configuration) => configuration.model === model);
}

export interface StagehandSpendConfiguration {
  model: string;
  allowFreeTierGemini: boolean;
  providerApiKey?: string;
}

export class StagehandConfigurationError extends Error {
  constructor(readonly code: "free_tier_opt_in_required" | "unsupported_model" | "provider_key_missing" | "provider_not_enabled") {
    super(code);
    this.name = "StagehandConfigurationError";
  }
}

/** Validate opt-in before any browser/model SDK setup; never returns or logs the credential. */
export function validateStagehandSpendConfiguration(configuration: StagehandSpendConfiguration): void {
  const model = stagehandModelConfiguration(configuration.model);
  if (!model) throw new StagehandConfigurationError("unsupported_model");
  if (model.provider !== "google" || model.authorization !== "free-tier-only") throw new StagehandConfigurationError("provider_not_enabled");
  if (configuration.allowFreeTierGemini !== true) throw new StagehandConfigurationError("free_tier_opt_in_required");
  if (typeof configuration.providerApiKey !== "string" || configuration.providerApiKey.trim().length === 0) {
    throw new StagehandConfigurationError("provider_key_missing");
  }
}

export interface StagehandProviderMetrics {
  stagehandActCalls: number;
  liveInferenceCalls: number;
  actionExecutions: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  inferenceTimeMs: number;
  lateResultsDiscarded: number;
}

export interface StagehandV4AdapterOptions {
  /** A connected SDK client. Test fakes are allowed only in plumbing tests. */
  stagehand: Pick<Stagehand, "act">;
  page: StagehandPage;
  model: ApprovedStagehandModel;
}

export class StagehandAdapterFailure extends Error {
  constructor(
    readonly code: "aborted" | "deadline_exceeded" | "provider_error" | "malformed_model_response" | "action_limit",
    readonly providerDiagnostic?: ProviderFailureDiagnostic,
  ) {
    super(code);
    this.name = "StagehandAdapterFailure";
  }
}

export interface ProviderFailureDiagnostic {
  category: "authentication_or_access" | "quota_or_rate_limit" | "model_or_endpoint" | "invalid_request" | "provider_service" | "transport" | "unclassified";
  httpStatus: number | null;
  sanitizedCause: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function safeIdentifier(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 100) return undefined;
  return /^[A-Za-z0-9._:-]+$/.test(value) ? value : undefined;
}

/** Keep only compact UI action details; never persist arbitrary provider text or arguments. */
export function sanitizeStagehandText(value: string): string {
  return value
    .replace(/\b(api[_-]?key|authorization|cookie|password|secret|token|x-goog-api-key)\s*[:=]\s*(?:bearer\s+)?[^\s,;]+/gi, "$1=[redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [redacted]")
    .replace(/\bAIza[A-Za-z0-9_-]{20,}\b/g, "[credential-redacted]")
    .replace(/\b(?:sk|key)-[A-Za-z0-9_-]{12,}\b/gi, "[credential-redacted]")
    .replace(/https?:\/\/[^\s)\]}>,;]+/gi, "[url-redacted]")
    .replace(/[\r\n\t]+/g, " ")
    .slice(0, 180);
}

function safeErrorRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

function providerHttpStatus(error: unknown): number | null {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    const record = safeErrorRecord(current);
    for (const field of ["statusCode", "status"] as const) {
      const candidate = record?.[field];
      if (typeof candidate === "number" && Number.isInteger(candidate) && candidate >= 100 && candidate <= 599) return candidate;
    }
    current = record?.cause;
  }
  return null;
}

function sanitizedProviderCause(error: unknown): string {
  const record = safeErrorRecord(error);
  const allowedNames = new Set(["Error", "TypeError", "AbortError", "TimeoutError", "APICallError", "GoogleGenerativeAIError", "GoogleGenerativeAIFetchError", "GoogleGenerativeAIResponseError", "FetchError"]);
  const name = typeof record?.name === "string" && allowedNames.has(record.name) ? record.name : "ProviderError";
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "Provider request failed";
  // Provider messages can echo request or response content; retain only known-safe cause phrases.
  const safeCause =
    /(?:api key not valid|invalid api key)/i.test(message) ? "provider credential rejected" :
    /(?:permission denied|forbidden)/i.test(message) ? "provider access denied" :
    /(?:quota exceeded|resource exhausted|rate limit)/i.test(message) ? "provider quota or rate limit" :
    /(?:model.{0,30}not found|not found)/i.test(message) ? "model or endpoint not found" :
    /(?:invalid argument|bad request)/i.test(message) ? "provider rejected invalid request" :
    /(?:econnreset|econnrefused)/i.test(message) ? "provider connection failed" :
    /(?:timed? ?out|deadline exceeded)/i.test(message) ? "provider request timed out" :
    /fetch failed|network error/i.test(message) ? "provider network request failed" :
    "provider request failed";
  return `${name}: ${safeCause}`;
}

export function diagnoseProviderFailure(error: unknown): ProviderFailureDiagnostic {
  const httpStatus = providerHttpStatus(error);
  const category: ProviderFailureDiagnostic["category"] =
    httpStatus === 401 || httpStatus === 403 ? "authentication_or_access" :
    httpStatus === 429 ? "quota_or_rate_limit" :
    httpStatus === 404 ? "model_or_endpoint" :
    httpStatus !== null && httpStatus >= 400 && httpStatus < 500 ? "invalid_request" :
    httpStatus !== null && httpStatus >= 500 ? "provider_service" :
    /\b(fetch|socket|network|econn(?:reset|refused|timeout)?|enotfound|timed? ?out|connection)\b/i.test(error instanceof Error ? error.message : String(error)) ? "transport" :
    "unclassified";
  return { category, httpStatus, sanitizedCause: sanitizedProviderCause(error) };
}

function parseActResult(raw: unknown): ActResult {
  if (!isRecord(raw) || !isRecord(raw.data) || !isRecord(raw.metadata)) throw new StagehandAdapterFailure("malformed_model_response");
  if (typeof raw.data.success !== "boolean" || typeof raw.data.message !== "string" || typeof raw.data.actionDescription !== "string" || !Array.isArray(raw.data.actions)) {
    throw new StagehandAdapterFailure("malformed_model_response");
  }
  for (const action of raw.data.actions) {
    if (!isRecord(action) || typeof action.selector !== "string" || typeof action.description !== "string" ||
      (action.method !== undefined && typeof action.method !== "string") ||
      (action.arguments !== undefined && (!Array.isArray(action.arguments) || action.arguments.some((argument) => typeof argument !== "string")))) {
      throw new StagehandAdapterFailure("malformed_model_response");
    }
  }
  if (!isRecord(raw.metadata.cache) || !isRecord(raw.metadata.usage)) throw new StagehandAdapterFailure("malformed_model_response");
  const usage = raw.metadata.usage;
  for (const key of ["inputTokens", "outputTokens", "reasoningTokens", "cachedInputTokens", "inferenceTimeMs"] as const) {
    if (!finiteNonNegative(usage[key])) throw new StagehandAdapterFailure("malformed_model_response");
  }
  const cache = raw.metadata.cache;
  if (cache.status !== "HIT" && cache.status !== "MISS" && cache.status !== "DISABLED") throw new StagehandAdapterFailure("malformed_model_response");
  return raw as unknown as ActResult;
}

function resultMetrics(result: ActResult): Omit<StagehandProviderMetrics, "stagehandActCalls" | "liveInferenceCalls" | "actionExecutions" | "lateResultsDiscarded"> {
  const usage = result.metadata.usage;
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    reasoningTokens: usage.reasoningTokens,
    inferenceTimeMs: usage.inferenceTimeMs,
  };
}

function remainingMs(input: AgentTaskInput): number {
  return Math.floor(input.deadlineAtMs - Date.now());
}

async function executeWithDeadline<T>(promise: Promise<T>, input: AgentTaskInput, timeoutMs: number, onLateResult: () => void): Promise<T> {
  if (input.signal.aborted) throw new StagehandAdapterFailure("aborted");
  if (timeoutMs <= 0) throw new StagehandAdapterFailure("deadline_exceeded");
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = () => finish(() => reject(new StagehandAdapterFailure("aborted")));
    const timer = setTimeout(() => finish(() => reject(new StagehandAdapterFailure("deadline_exceeded"))), timeoutMs);
    input.signal.addEventListener("abort", onAbort, { once: true });
    promise.then((value) => {
      if (settled) { onLateResult(); return; }
      finish(() => resolve(value));
    }, (error) => {
      if (settled) { onLateResult(); return; }
      finish(() => reject(new StagehandAdapterFailure("provider_error", diagnoseProviderFailure(error))));
    });
  });
}

/** Stagehand v4 adapter. Its inputs contain only the visible page/task, never runner or observer state. */
export class StagehandV4AgentAdapter implements AgentAdapter {
  readonly metadata: AgentAdapterMetadata;
  readonly metrics: StagehandProviderMetrics = {
    stagehandActCalls: 0,
    liveInferenceCalls: 0,
    actionExecutions: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    inferenceTimeMs: 0,
    lateResultsDiscarded: 0,
  };
  private readonly usedActionIds = new Set<string>();

  constructor(private readonly options: StagehandV4AdapterOptions) {
    this.metadata = {
      adapterId: "stagehand-v4",
      adapterVersion: "1.0.0",
      mode: "model-backed-stagehand",
      sdkVersion: STAGEHAND_SDK_VERSION,
      provider: stagehandModelConfiguration(options.model)?.provider ?? "unknown",
      model: options.model,
    };
  }

  async runTask(input: AgentTaskInput): Promise<AgentTaskOutcome> {
    if (!input.stagehandPage || input.stagehandPage.pageId !== this.options.page.pageId) {
      return { attempts: 0, retries: 0, observation: "Stagehand target is not the instrumented page", taskCompleted: false, errorCode: "malformed_model_response" };
    }
    if (!Number.isInteger(input.maxActions) || input.maxActions < 1 || input.maxActions > STAGEHAND_MAX_ACTIONS) {
      return { attempts: 0, retries: 0, observation: "Invalid bounded action budget", taskCompleted: false, errorCode: "action_limit" };
    }
    const metrics = this.metrics;
    let observation = "No model-directed UI action was completed";
    let taskCompleted = false;
    let attempts = 0;
    try {
      for (let index = 0; index < input.maxActions; index += 1) {
        const remaining = remainingMs(input);
        if (remaining <= 0) throw new StagehandAdapterFailure("deadline_exceeded");
        if (input.signal.aborted) throw new StagehandAdapterFailure("aborted");
        const actionId = input.events.beginAction();
        if (!actionId || this.usedActionIds.has(actionId)) throw new StagehandAdapterFailure("malformed_model_response");
        this.usedActionIds.add(actionId);
        attempts += 1;
        await input.events.emit("agent.action_proposed", {
          adapterId: "stagehand-v4",
          instruction: sanitizeStagehandText(input.task),
          call: attempts,
          modelCallPending: true,
        }, actionId);
        metrics.stagehandActCalls += 1;

        let result: ActResult;
        try {
          const timeout = Math.max(1, Math.min(STAGEHAND_ACT_TIMEOUT_MS, remaining));
          const adapterDeadline = Math.max(1, Math.min(timeout + STAGEHAND_RPC_RESPONSE_GRACE_MS + 5_000, remaining));
          const pending = this.options.stagehand.act(input.task, { page: input.stagehandPage, timeout });
          result = parseActResult(await executeWithDeadline(pending, input, adapterDeadline, () => { metrics.lateResultsDiscarded += 1; }));
        } catch (error) {
          if (error instanceof StagehandAdapterFailure) throw error;
          throw new StagehandAdapterFailure("provider_error", diagnoseProviderFailure(error));
        }

        const usage = resultMetrics(result);
        metrics.inputTokens += usage.inputTokens;
        metrics.outputTokens += usage.outputTokens;
        metrics.reasoningTokens += usage.reasoningTokens;
        metrics.inferenceTimeMs += usage.inferenceTimeMs;
        if (result.metadata.cache.status !== "HIT" && (usage.inputTokens > 0 || usage.outputTokens > 0)) metrics.liveInferenceCalls += 1;
        const safeActions = result.data.actions.map((action) => ({
          actionType: safeIdentifier(action.method)?.toLowerCase() ?? "other",
          selector: sanitizeStagehandText(action.selector),
          targetDescription: sanitizeStagehandText(action.description),
        }));
        if (safeActions.length > 0) metrics.actionExecutions += safeActions.length;
        await input.events.emit("agent.model_action_result", {
          adapterId: "stagehand-v4",
          call: attempts,
          success: result.data.success,
          actionDescription: sanitizeStagehandText(result.data.actionDescription),
          actions: safeActions,
          sdkActionId: safeIdentifier(result.metadata.actionId) ?? null,
          cacheStatus: result.metadata.cache.status,
          usage,
        }, actionId);
        if (metrics.actionExecutions > input.maxActions) throw new StagehandAdapterFailure("action_limit");
        observation = result.data.success
          ? "Stagehand reported its UI operation completed; completion is still checked in the visible application"
          : "Stagehand reported no completed UI operation";
        taskCompleted = await executeWithDeadline(input.confirmTaskCompleted(), input, Math.max(1, remainingMs(input)), () => { metrics.lateResultsDiscarded += 1; });
        if (taskCompleted) {
          observation = "Controlled application showed task completion in the visible UI";
          return { attempts, retries: Math.max(0, attempts - 1), observation, taskCompleted: true };
        }
        if (index + 1 < input.maxActions) {
          await input.events.emit("agent.retry_reason", {
            adapterId: "stagehand-v4",
            reason: "The visible application has not confirmed task completion; the same user instruction will be reconsidered against the current page.",
            nextAction: index + 2,
          }, actionId);
        }
      }
      return { attempts, retries: Math.max(0, attempts - 1), observation, taskCompleted: false };
    } catch (error) {
      const code = error instanceof StagehandAdapterFailure ? error.code : "provider_error";
      observation = `Stagehand adapter stopped: ${code}`;
      const diagnostic = error instanceof StagehandAdapterFailure ? error.providerDiagnostic : undefined;
      try {
        await input.events.emit("agent.error", {
          adapterId: "stagehand-v4", code, attempts,
          ...(diagnostic ? { providerFailure: diagnostic } : {}),
        }, undefined);
      } catch { /* event sink failures do not expose provider data */ }
      return {
        attempts, retries: Math.max(0, attempts - 1), observation, taskCompleted: false, errorCode: code,
        ...(diagnostic ? { providerFailure: diagnostic } : {}),
      };
    }
  }
}

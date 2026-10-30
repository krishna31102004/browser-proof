import type { ActResult, ModelName, Page as StagehandPage, Stagehand } from "@browserbasehq/stagehand";
import type { AgentAdapter, AgentAdapterMetadata, AgentTaskInput, AgentTaskOutcome } from "./agent-adapter.js";

export const STAGEHAND_SDK_VERSION = "4.3.0";
export const STAGEHAND_MAX_ACTIONS = 6;

/** A single model ID verified in the pinned Stagehand 4.3.0 SDK bundle. */
export const APPROVED_STAGEHAND_MODELS = ["openai/gpt-5.4-mini"] as const;
export type ApprovedStagehandModel = (typeof APPROVED_STAGEHAND_MODELS)[number];

export interface StagehandSpendConfiguration {
  model: string;
  allowModelSpend: boolean;
  providerApiKey?: string;
}

export class StagehandConfigurationError extends Error {
  constructor(readonly code: "spend_opt_in_required" | "unsupported_model" | "provider_key_missing") {
    super(code);
    this.name = "StagehandConfigurationError";
  }
}

/** Validate opt-in before any browser/model SDK setup; never returns or logs the credential. */
export function validateStagehandSpendConfiguration(configuration: StagehandSpendConfiguration): void {
  if (configuration.allowModelSpend !== true) throw new StagehandConfigurationError("spend_opt_in_required");
  if (!APPROVED_STAGEHAND_MODELS.some((model) => model === configuration.model)) throw new StagehandConfigurationError("unsupported_model");
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
}

export interface StagehandV4AdapterOptions {
  /** A connected SDK client. Test fakes are allowed only in plumbing tests. */
  stagehand: Pick<Stagehand, "act">;
  page: StagehandPage;
  model: ApprovedStagehandModel;
}

export class StagehandAdapterFailure extends Error {
  constructor(readonly code: "aborted" | "deadline_exceeded" | "provider_error" | "malformed_model_response" | "action_limit") {
    super(code);
    this.name = "StagehandAdapterFailure";
  }
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
    .replace(/\b(api[_-]?key|authorization|cookie|password|secret|token)\s*[:=]\s*(?:bearer\s+)?[^\s,;]+/gi, "$1=[redacted]")
    .replace(/\b(?:sk|key)-[A-Za-z0-9_-]{12,}\b/gi, "[credential-redacted]")
    .replace(/https?:\/\/[^\s)\]}>,;]+/gi, "[url-redacted]")
    .replace(/[\r\n\t]+/g, " ")
    .slice(0, 180);
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

function resultMetrics(result: ActResult): Omit<StagehandProviderMetrics, "stagehandActCalls" | "liveInferenceCalls" | "actionExecutions"> {
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

async function executeWithDeadline<T>(promise: Promise<T>, input: AgentTaskInput, timeoutMs: number): Promise<T> {
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
    promise.then((value) => finish(() => resolve(value)), () => finish(() => reject(new StagehandAdapterFailure("provider_error"))));
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
  };
  private readonly usedActionIds = new Set<string>();

  constructor(private readonly options: StagehandV4AdapterOptions) {
    this.metadata = {
      adapterId: "stagehand-v4",
      adapterVersion: "1.0.0",
      mode: "model-backed-stagehand",
      sdkVersion: STAGEHAND_SDK_VERSION,
      provider: "openai",
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
          const timeout = Math.max(1, Math.min(15_000, remaining));
          const pending = this.options.stagehand.act(input.task, { page: input.stagehandPage, timeout });
          result = parseActResult(await executeWithDeadline(pending, input, timeout));
        } catch (error) {
          if (error instanceof StagehandAdapterFailure) throw error;
          throw new StagehandAdapterFailure("provider_error");
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
        taskCompleted = await executeWithDeadline(input.confirmTaskCompleted(), input, Math.max(1, remainingMs(input)));
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
      try { await input.events.emit("agent.error", { adapterId: "stagehand-v4", code, attempts }, undefined); } catch { /* event sink failures do not expose provider data */ }
      return { attempts, retries: Math.max(0, attempts - 1), observation, taskCompleted: false, errorCode: code };
    }
  }
}

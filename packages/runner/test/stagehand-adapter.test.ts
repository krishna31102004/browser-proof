import type { Page as PlaywrightPage } from "playwright";
import type { Page as StagehandPage, Stagehand } from "@browserbasehq/stagehand";
import { describe, expect, it, vi } from "vitest";
import {
  DeterministicReferenceAgentAdapter,
  type AgentEventEmitter,
  type AgentTaskInput,
} from "../src/agent-adapter.js";
import {
  STAGEHAND_MODEL_CONFIGURATIONS,
  StagehandAdapterFailure,
  StagehandConfigurationError,
  StagehandV4AgentAdapter,
  sanitizeStagehandText,
  validateStagehandSpendConfiguration,
} from "../src/stagehand-adapter.js";

// These tests verify mocked adapter plumbing only. They do not call a provider or prove live model behavior.
const MOCK_KEY = "browserproof-test-key-not-for-provider";

function actResult(overrides: Record<string, unknown> = {}): unknown {
  return {
    data: {
      success: true,
      message: "A UI action completed",
      actionDescription: "Clicked the refund button",
      actions: [{ selector: "button[data-testid='refund']", description: "Refund order", method: "click", arguments: [] }],
    },
    metadata: {
      actionId: "sdk-action-1",
      cache: { status: "MISS" },
      usage: { inputTokens: 12, outputTokens: 3, reasoningTokens: 0, cachedInputTokens: 0, inferenceTimeMs: 24 },
    },
    ...overrides,
  };
}

function setup(options: {
  act?: (instruction: string, callOptions: unknown) => Promise<unknown>;
  confirm?: () => Promise<boolean>;
  ids?: string[];
  maxActions?: number;
  deadlineOffsetMs?: number;
  signal?: AbortSignal;
  task?: string;
} = {}) {
  let calls = 0;
  const stagehandPage = { pageId: "same-target", url: async () => "http://demo.local/orders/A123" } as unknown as StagehandPage;
  const stagehand = {
    act: vi.fn(async (instruction: string, callOptions: unknown) => {
      calls += 1;
      return options.act ? options.act(instruction, callOptions) : Promise.resolve(actResult());
    }),
  } as unknown as Pick<Stagehand, "act">;
  const adapter = new StagehandV4AgentAdapter({
    stagehand,
    page: stagehandPage,
    model: "google/gemini-3.8-flash",
  });
  const emitted: Array<{ event: string; payload: Record<string, unknown>; actionId?: string }> = [];
  const ids = options.ids ?? ["agent-action-1", "agent-action-2", "agent-action-3", "agent-action-4", "agent-action-5", "agent-action-6"];
  let idIndex = 0;
  const events: AgentEventEmitter = {
    beginAction: vi.fn(() => ids[idIndex++] ?? "agent-action-overflow"),
    emit: vi.fn(async (event, payload, actionId) => { emitted.push({ event, payload, actionId }); }),
  };
  const input: AgentTaskInput = {
    task: options.task ?? "Refund order A123 through the visible page",
    page: {} as PlaywrightPage,
    stagehandPage,
    maxActions: options.maxActions ?? 2,
    deadlineAtMs: Date.now() + (options.deadlineOffsetMs ?? 5000),
    signal: options.signal ?? new AbortController().signal,
    events,
    confirmTaskCompleted: options.confirm ?? (async () => calls > 0),
  };
  return { adapter, input, events, emitted, stagehand };
}

describe("Stagehand v4 adapter mocked plumbing (not live provider proof)", () => {
  it("maps the exact Gemini provider/key and requires explicit free-tier authorization without exposing credentials", () => {
    expect(STAGEHAND_MODEL_CONFIGURATIONS[0]).toEqual({ provider: "google", model: "google/gemini-3.8-flash", providerModelId: "gemini-3.8-flash", keyEnvironmentVariable: "GEMINI_API_KEY", authorization: "free-tier-only" });
    expect(() => validateStagehandSpendConfiguration({ model: "google/gemini-3.8-flash", allowFreeTierGemini: false, providerApiKey: MOCK_KEY }))
      .toThrowError(new StagehandConfigurationError("free_tier_opt_in_required"));
    expect(() => validateStagehandSpendConfiguration({ model: "google/gemini-3.8-flash", allowFreeTierGemini: true }))
      .toThrowError(new StagehandConfigurationError("provider_key_missing"));
    expect(() => validateStagehandSpendConfiguration({ model: "google/not-approved", allowFreeTierGemini: true, providerApiKey: MOCK_KEY }))
      .toThrowError(new StagehandConfigurationError("unsupported_model"));
    expect(() => validateStagehandSpendConfiguration({ model: "openai/gpt-5.4-mini", allowFreeTierGemini: true, providerApiKey: MOCK_KEY }))
      .toThrowError(new StagehandConfigurationError("provider_not_enabled"));
    expect(() => validateStagehandSpendConfiguration({ model: "google/gemini-3.8-flash", allowFreeTierGemini: true, providerApiKey: MOCK_KEY })).not.toThrow();
    try {
      validateStagehandSpendConfiguration({ model: "google/gemini-3.8-flash", allowFreeTierGemini: false, providerApiKey: MOCK_KEY });
    } catch (error) {
      expect(String(error)).not.toContain(MOCK_KEY);
    }
  });

  it("exposes only task and browser surfaces, and refuses a different Stagehand page", async () => {
    const { adapter, input, stagehand } = setup();
    expect(Object.keys(input).sort()).toEqual(["confirmTaskCompleted", "deadlineAtMs", "events", "maxActions", "page", "signal", "stagehandPage", "task"].sort());
    for (const forbidden of ["mode", "schedule", "ledger", "controlUrl", "expectedEffects", "providerApiKey", "secret"]) {
      expect(forbidden in input).toBe(false);
    }
    input.stagehandPage = { pageId: "other-target" } as StagehandPage;
    const outcome = await adapter.runTask(input);
    expect(outcome.errorCode).toBe("malformed_model_response");
    expect(stagehand.act).not.toHaveBeenCalled();
  });

  it("uses the explicit shared page, emits ordered sanitized telemetry with action correlation, and counts usage", async () => {
    const { adapter, input, emitted, stagehand } = setup({ task: `Refund order. api_key=${MOCK_KEY}` });
    const outcome = await adapter.runTask(input);
    expect(outcome.taskCompleted).toBe(true);
    expect(stagehand.act).toHaveBeenCalledWith(input.task, expect.objectContaining({ page: input.stagehandPage, timeout: expect.any(Number) }));
    expect(emitted.map((item) => item.event)).toEqual(["agent.action_proposed", "agent.model_action_result"]);
    expect(emitted.map((item) => item.actionId)).toEqual(["agent-action-1", "agent-action-1"]);
    expect(JSON.stringify(emitted)).not.toContain(MOCK_KEY);
    expect(adapter.metrics).toMatchObject({ stagehandActCalls: 1, liveInferenceCalls: 1, actionExecutions: 1, inputTokens: 12, outputTokens: 3 });
    expect(adapter.metadata).toMatchObject({ provider: "google", model: "google/gemini-3.8-flash" });
  });

  it("sanitizes credential-like text, URLs, and control characters", () => {
    const text = sanitizeStagehandText(`api_key=${MOCK_KEY} password=localpass https://example.test/private\nAuthorization: Bearer test`);
    expect(text).not.toContain(MOCK_KEY);
    expect(text).not.toContain("localpass");
    expect(text).not.toContain("Bearer test");
    expect(text).not.toContain("https://example.test");
    expect(text).not.toContain("\n");
  });

  it("maps provider exceptions to a sanitized failure and never falls back to the reference agent", async () => {
    const { adapter, input, emitted } = setup({ act: async () => { throw new Error(`provider rejected ${MOCK_KEY}`); } });
    const reference = vi.fn(async () => ({ attempts: 1, retries: 0, observation: "reference", taskCompleted: true }));
    const outcome = await adapter.runTask(input);
    expect(outcome.errorCode).toBe("provider_error");
    expect(outcome.observation).not.toContain(MOCK_KEY);
    expect(emitted.at(-1)?.payload).toEqual({ adapterId: "stagehand-v4", code: "provider_error", attempts: 1 });
    expect(reference).not.toHaveBeenCalled();
  });

  it("rejects malformed provider results rather than trusting partial fields", async () => {
    const { adapter, input, emitted } = setup({ act: async () => ({ data: { success: "yes" }, metadata: {} }) });
    const outcome = await adapter.runTask(input);
    expect(outcome.errorCode).toBe("malformed_model_response");
    expect(emitted.at(-1)?.payload).toMatchObject({ code: "malformed_model_response" });
  });

  it("stops at an expired deadline, abort, and provider timeout", async () => {
    const expired = setup({ deadlineOffsetMs: -1 });
    expect((await expired.adapter.runTask(expired.input)).errorCode).toBe("deadline_exceeded");
    expect(expired.stagehand.act).not.toHaveBeenCalled();

    const controller = new AbortController();
    controller.abort();
    const aborted = setup({ signal: controller.signal });
    expect((await aborted.adapter.runTask(aborted.input)).errorCode).toBe("aborted");
    expect(aborted.stagehand.act).not.toHaveBeenCalled();

    const timedOut = setup({ act: () => new Promise(() => undefined), deadlineOffsetMs: 25 });
    expect((await timedOut.adapter.runTask(timedOut.input)).errorCode).toBe("deadline_exceeded");
  });

  it("discards late deferred act results after timeout and never accepts their telemetry", async () => {
    vi.useFakeTimers();
    try {
      let release!: (value: unknown) => void;
      const pending = new Promise<unknown>((resolve) => { release = resolve; });
      const setupResult = setup({ act: () => pending, deadlineOffsetMs: 40, maxActions: 1 });
      const running = setupResult.adapter.runTask(setupResult.input);
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(50);
      const outcome = await running;
      expect(outcome.errorCode).toBe("deadline_exceeded");
      expect(setupResult.emitted.map(({ event }) => event)).toContain("agent.error");
      expect(setupResult.emitted.map(({ event }) => event)).not.toContain("agent.model_action_result");
      release(actResult());
      await Promise.resolve();
      await Promise.resolve();
      expect(setupResult.emitted.map(({ event }) => event)).not.toContain("agent.model_action_result");
      expect(setupResult.adapter.metrics).toMatchObject({ actionExecutions: 0, inputTokens: 0, liveInferenceCalls: 0, lateResultsDiscarded: 1 });
    } finally { vi.useRealTimers(); }
  });

  it("retains a real completion that is observed just before the operation deadline", async () => {
    vi.useFakeTimers();
    try {
      let release!: (value: unknown) => void;
      const pending = new Promise<unknown>((resolve) => { release = resolve; });
      const setupResult = setup({ act: () => pending, deadlineOffsetMs: 50, confirm: async () => true, maxActions: 1 });
      const running = setupResult.adapter.runTask(setupResult.input);
      await Promise.resolve(); await Promise.resolve();
      await vi.advanceTimersByTimeAsync(49);
      release(actResult());
      const outcome = await running;
      expect(outcome.taskCompleted).toBe(true);
      expect(outcome.errorCode).toBeUndefined();
      expect(setupResult.adapter.metrics.lateResultsDiscarded).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("abandons an in-flight provider result after abort and discards its late result", async () => {
    vi.useFakeTimers();
    try {
      let release!: (value: unknown) => void;
      const pending = new Promise<unknown>((resolve) => { release = resolve; });
      const controller = new AbortController();
      const setupResult = setup({ act: () => pending, deadlineOffsetMs: 5_000, maxActions: 1, signal: controller.signal });
      const running = setupResult.adapter.runTask(setupResult.input);
      await Promise.resolve(); await Promise.resolve();
      controller.abort();
      const outcome = await running;
      expect(outcome.errorCode).toBe("aborted");
      release(actResult()); await Promise.resolve(); await Promise.resolve();
      expect(setupResult.adapter.metrics.lateResultsDiscarded).toBe(1);
      expect(setupResult.emitted.map(({ event }) => event)).not.toContain("agent.model_action_result");
    } finally { vi.useRealTimers(); }
  });

  it("enforces the six-action ceiling and executes no model action for an invalid budget", async () => {
    const tooMany = setup({ maxActions: 7 });
    expect((await tooMany.adapter.runTask(tooMany.input)).errorCode).toBe("action_limit");
    expect(tooMany.stagehand.act).not.toHaveBeenCalled();

    const bounded = setup({ maxActions: 6, confirm: async () => false });
    const outcome = await bounded.adapter.runTask(bounded.input);
    expect(outcome.attempts).toBe(6);
    expect(bounded.stagehand.act).toHaveBeenCalledTimes(6);

    const sevenActions = Array.from({ length: 7 }, (_, index) => ({ selector: `button[data-action="${index}"]`, description: `Refund order action ${index}`, method: "click", arguments: [] }));
    const overflow = setup({ maxActions: 6, confirm: async () => false, act: async () => actResult({ data: { success: true, message: "too many actions", actionDescription: "too many", actions: sevenActions } }) });
    const overflowResult = await overflow.adapter.runTask(overflow.input);
    expect(overflowResult.errorCode).toBe("action_limit");
    expect(overflow.adapter.metrics.actionExecutions).toBe(7);
    expect(overflow.emitted.some(({ event }) => event === "agent.model_action_result")).toBe(true);
  });

  it("rejects duplicate agent action callback IDs before issuing another provider action", async () => {
    const { adapter, input, stagehand } = setup({ ids: ["repeat-id", "repeat-id"], maxActions: 2, confirm: async () => false });
    const outcome = await adapter.runTask(input);
    expect(outcome.errorCode).toBe("malformed_model_response");
    expect(stagehand.act).toHaveBeenCalledTimes(1);
  });

  it("does not expose observer or control access on either adapter", async () => {
    const { adapter, input } = setup();
    const reference = new DeterministicReferenceAgentAdapter(async () => ({ attempts: 0, retries: 0, observation: "ok", taskCompleted: true }));
    for (const instance of [adapter, reference]) {
      expect("queryEffects" in instance).toBe(false);
      expect("controlUrl" in instance).toBe(false);
      expect("schedule" in instance).toBe(false);
    }
    expect((await reference.runTask(input)).taskCompleted).toBe(true);
  });

  it("keeps the deterministic wrapper around the supplied callback only", async () => {
    const callback = vi.fn(async () => ({ attempts: 1, retries: 0, observation: "visible result", taskCompleted: true }));
    const reference = new DeterministicReferenceAgentAdapter(callback);
    const { input } = setup();
    expect(await reference.runTask(input)).toEqual(await callback.mock.results.at(-1)?.value);
    expect(callback).toHaveBeenCalledOnce();
    expect(reference.metadata.mode).toBe("deterministic-reference");
  });
});

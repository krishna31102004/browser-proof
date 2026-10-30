import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page, type Route } from "playwright";
import { localBrowser, Stagehand } from "@browserbasehq/stagehand";
import { ARTIFACT_SCHEMA_VERSION, evaluateRefundAtMostOnce, FAULT_SCHEDULE_REGISTRY, type FaultSchedule, type RefundEffect, type RunMode, type RunResult, type Scenario } from "@browserproof/contracts";
import { startSupportDesk, type SupportDeskServer } from "@browserproof/demo-support";
import { EventWriter } from "./event-writer.js";
import { validateStagehandSavedSchedule } from "./stagehand-artifact-validation.js";
import { StagehandV4AgentAdapter, STAGEHAND_MAX_ACTIONS, STAGEHAND_SDK_VERSION, sanitizeStagehandText, stagehandModelConfiguration, validateStagehandSpendConfiguration, type ApprovedStagehandModel } from "./stagehand-adapter.js";
import type { AgentEventEmitter, AgentTaskOutcome } from "./agent-adapter.js";
import { queryEffects, isFaultTargetMatch } from "./run.js";
import { quiesceStagehandSession, reconcileAfterStagehandQuiescence, type StagehandQuiescenceResult } from "./stagehand-lifecycle.js";

export const STAGEHAND_TASK = "Refund order A123 exactly once. Use the visible application. Check status before retrying if the result is unclear.";

export interface StagehandRunOptions {
  mode: RunMode;
  seed: string;
  model: ApprovedStagehandModel;
  providerApiKey: string;
  allowFreeTierGemini: boolean;
  artifactRoot?: string;
  schedule?: FaultSchedule;
  maxActions?: number;
  deadlineMs?: number;
}

export type StagehandTerminalOutcome = "clean_success" | "expected_violation_observed" | "contract_violation_observed" | "agent_error" | "timeout" | "injection_error" | "observer_inconclusive" | "cleanup_failure" | "artifact_invalid";
export interface StagehandTerminalEvidence { executionStatus: RunResult["status"]; taskCompleted: boolean; faultTriggered: boolean; observerStatus: RunResult["observerStatus"]; contractPassed: boolean | null; terminalOutcome: StagehandTerminalOutcome; exitReason: string; quiescenceVerified: boolean; cleanupErrors: string[]; artifactError: string | null; }
export interface StagehandRunSummary { artifactDir: string; result: RunResult; metadataPath: string; sameBrowserPath: string; terminal: StagehandTerminalEvidence; }

interface SameBrowserProof { schemaVersion: 1; architecture: "stagehand-launch-playwright-cdp-attach"; stagehandPageId: string; playwrightTargetId: string; playwrightContextId: string; url: string; stagehandUrl: string; playwrightUrl: string; controlPlaneBlocked: boolean; externalOriginBlocked: boolean; provenBeforeModelCall: true; }

async function choosePort(): Promise<number> {
  const net = await import("node:net");
  return await new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") { server.close(); reject(new Error("Could not allocate local CDP port")); return; }
      server.close((error) => error ? reject(error) : resolvePort(address.port));
    });
  });
}

async function browserPortClosed(port: number): Promise<boolean> {
  const net = await import("node:net");
  return await new Promise<boolean>((resolveClosed) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const timeout = setTimeout(() => { socket.destroy(); resolveClosed(false); }, 500);
    socket.once("connect", () => { clearTimeout(timeout); socket.destroy(); resolveClosed(false); });
    socket.once("error", () => { clearTimeout(timeout); resolveClosed(true); });
  });
}

async function waitForInFlightRoutes(routes: Set<Promise<void>>, timeoutMs = 4_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (routes.size > 0 && Date.now() < deadline) {
    const remaining = deadline - Date.now();
    await Promise.race([
      Promise.allSettled([...routes]),
      new Promise<void>((resolveWait) => setTimeout(resolveWait, Math.min(remaining, 100))),
    ]);
  }
  return routes.size === 0;
}

async function targetInfo(page: Page): Promise<{ targetId: string; browserContextId?: string }> {
  const session = await page.context().newCDPSession(page);
  try {
    const response = await session.send("Target.getTargetInfo") as { targetInfo?: { targetId?: string; browserContextId?: string } };
    if (!response.targetInfo?.targetId) throw new Error("Playwright did not return a CDP target ID");
    return { targetId: response.targetInfo.targetId, ...(response.targetInfo.browserContextId ? { browserContextId: response.targetInfo.browserContextId } : {}) };
  } finally { await session.detach(); }
}

async function attachedPlaywrightPage(context: Awaited<ReturnType<Browser["newContext"]>>, stagehandPageId: string): Promise<{ page: Page; target: { targetId: string; browserContextId?: string } } | undefined> {
  for (const page of context.pages()) {
    const target = await targetInfo(page);
    if (target.targetId === stagehandPageId) return { page, target };
  }
  return undefined;
}

function normalizeOutcome(status: RunResult["status"], effects: RefundEffect[]): string {
  if (status === "contract_violation") return "refund-at-most-once|A123|count>1";
  return `${status}|effects=${effects.length}`;
}

/** Real model-backed run. Callers must validate explicit spend opt-in before entering this function. */
export async function executeStagehandRun(options: StagehandRunOptions): Promise<StagehandRunSummary> {
  validateStagehandSpendConfiguration({ model: options.model, providerApiKey: options.providerApiKey, allowFreeTierGemini: options.allowFreeTierGemini });
  if (options.schedule && (options.mode !== "faulted" || !validateStagehandSavedSchedule({ schemaVersion: ARTIFACT_SCHEMA_VERSION, mode: options.mode, seed: options.seed, faults: [options.schedule] }, options.seed))) {
    throw new Error("Stagehand fault schedule must match the exact saved SupportDesk schedule schema, seed and identity");
  }
  const model = options.model;
  const modelConfiguration = stagehandModelConfiguration(model)!;
  const runId = randomUUID();
  const root = resolve(options.artifactRoot ?? fileURLToPath(new URL("../../../artifacts", import.meta.url)));
  const artifactDir = join(root, runId);
  const screenshotsDir = join(artifactDir, "screenshots");
  await mkdir(screenshotsDir, { recursive: true });
  const events = new EventWriter(join(artifactDir, "events.jsonl"), runId, "supportdesk-refund-v1");
  const startedAt = new Date().toISOString();
  const scenario: Scenario = { schemaVersion: ARTIFACT_SCHEMA_VERSION, scenarioId: "supportdesk-refund-v1", name: "supportdesk-refund", orderId: "A123", agentPolicy: "refund-retry-once-after-browser-failure" };
  const schedule: FaultSchedule = options.schedule ?? { schemaVersion: ARTIFACT_SCHEMA_VERSION, scheduleId: `stagehand-${options.mode}-${options.seed}`, type: "commit_then_response_lost", target: "POST /api/orders/A123/refund", trigger: "first_matching_request_after_agent_action", count: 1, seed: options.seed };
  await writeFile(join(artifactDir, "scenario.json"), `${JSON.stringify(scenario, null, 2)}\n`);
  await writeFile(join(artifactDir, "schedule.json"), `${JSON.stringify({ schemaVersion: ARTIFACT_SCHEMA_VERSION, mode: options.mode, seed: options.seed, faults: options.mode === "faulted" ? [schedule] : [] }, null, 2)}\n`);
  await events.record("runner", "run.started", { adapterId: "stagehand-v4", mode: options.mode, seed: options.seed });

  let app: SupportDeskServer | undefined;
  let stagehandBrowser: Awaited<ReturnType<typeof localBrowser.launch>> | undefined;
  let stagehand: Stagehand | undefined;
  let adapter: StagehandV4AgentAdapter | undefined;
  let playwrightBrowser: Browser | undefined;
  let context: Awaited<ReturnType<Browser["newContext"]>> | undefined;
  let traceStarted = false;
  const profileDir = await mkdtemp(join(tmpdir(), "browserproof-stagehand-"));
  const fault = options.mode === "faulted" ? schedule : undefined;
  const maxActions = options.maxActions ?? STAGEHAND_MAX_ACTIONS;
  const deadlineMs = options.deadlineMs ?? 45_000;
  let outcome: AgentTaskOutcome = { attempts: 0, retries: 0, observation: "Stagehand did not start", taskCompleted: false };
  let effects: RefundEffect[] = [];
  let observerStatus: RunResult["observerStatus"] = "observer_inconclusive";
  let status: RunResult["status"] = "browser_error";
  let contract: RunResult["contract"] = null;
  let errorMessage: string | undefined;
  let faultTriggered = false;
  let faultObserverInconclusive = false;
  let upstreamCommittedBeforeLoss = false;
  let browserReceivedSuccess: boolean | null = null;
  let activeActionId = "agent-not-started";
  let actionIndex = 0;
  const modelActionRows: Array<Record<string, unknown>> = [];
  let sameBrowserProof: SameBrowserProof | undefined;
  let metadata: Record<string, unknown> = { schemaVersion: 1, adapterId: "stagehand-v4", adapterVersion: "1.0.0", mode: "model-backed-stagehand", sdkVersion: STAGEHAND_SDK_VERSION, provider: modelConfiguration.provider, providerModelId: modelConfiguration.providerModelId, model, stagehandActCalls: 0, liveInferenceCalls: 0, actionExecutions: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, inferenceTimeMs: 0, lateResultsDiscarded: 0, taskCompleted: false, errorCode: null };
  let cdpPort: number | undefined;
  let controlUrl: string | undefined;
  let backendReset = false;
  let eventWriteFailure: string | undefined;
  const pendingEventWrites = new Set<Promise<void>>();
  let inFlightRoutes = new Set<Promise<void>>();
  let quiescence: StagehandQuiescenceResult = { browserFenced: false, routesDrained: false, profileRemoved: false, quiescenceVerified: false, cleanupErrors: [] };
  let traceErrors: string[] = [];

  const recordEvent = (source: Parameters<EventWriter["record"]>[0], type: string, payload: Record<string, unknown>, correlation: Parameters<EventWriter["record"]>[3] = {}): Promise<void> => {
    const pending = events.record(source, type, payload, correlation).catch((error: unknown) => {
      eventWriteFailure = sanitizeStagehandText(error instanceof Error ? error.message : String(error));
      throw error;
    });
    pendingEventWrites.add(pending);
    void pending.then(() => pendingEventWrites.delete(pending), () => pendingEventWrites.delete(pending));
    return pending;
  };

  try {
    app = await startSupportDesk({ appPort: 0, controlPort: 0 });
    const appAddress = app.app.address(); const controlAddress = app.control.address();
    if (!appAddress || typeof appAddress === "string" || !controlAddress || typeof controlAddress === "string") throw new Error("SupportDesk listeners did not bind TCP ports");
    const baseUrl = `http://127.0.0.1:${appAddress.port}`; const controlBaseUrl = `http://127.0.0.1:${controlAddress.port}`; controlUrl = controlBaseUrl;
    const reset = await fetch(`${controlBaseUrl}/__browserproof/reset`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runId }) });
    if (!reset.ok) throw new Error(`Backend reset returned HTTP ${reset.status}`);
    backendReset = true;

    cdpPort = await choosePort();
    stagehandBrowser = await localBrowser.launch({ headless: true, port: cdpPort, userDataDir: profileDir });
    stagehand = await Stagehand.create({ browser: stagehandBrowser, model: { modelName: model, apiKey: options.providerApiKey }, logging: { level: "off" } });
    playwrightBrowser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
    context = playwrightBrowser.contexts()[0];
    if (!context) throw new Error("Playwright did not attach to Stagehand's browser context");
    const stagehandPages = await stagehand.browser.context.pages();
    const stagehandPage = stagehandPages[0];
    if (!stagehandPage) throw new Error("Stagehand browser context does not expose the attached browser page");
    const attachedPage = await attachedPlaywrightPage(context, stagehandPage.pageId);
    if (!attachedPage) throw new Error("No Playwright page attaches to the Stagehand page target");
    const page = attachedPage.page; const target = attachedPage.target;
    const cancelDownloads = (candidate: Page) => candidate.on("download", (download) => { void download.cancel(); });
    for (const candidate of context.pages()) cancelDownloads(candidate);
    context.on("page", cancelDownloads);
    await stagehandPage.goto(baseUrl);
    const stagehandPageId = stagehandPage.pageId;
    if (target.targetId !== stagehandPageId || await stagehandPage.url() !== page.url()) throw new Error("Stagehand and Playwright page target/URL mismatch");
    sameBrowserProof = { schemaVersion: 1, architecture: "stagehand-launch-playwright-cdp-attach", stagehandPageId, playwrightTargetId: target.targetId, playwrightContextId: target.browserContextId ?? "unavailable", url: baseUrl, stagehandUrl: await stagehandPage.url(), playwrightUrl: page.url(), controlPlaneBlocked: false, externalOriginBlocked: false, provenBeforeModelCall: true };
    await writeFile(join(artifactDir, "same-browser.json"), `${JSON.stringify(sameBrowserProof, null, 2)}\n`);
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true, title: `${runId} stagehand-v4 ${options.mode}` }); traceStarted = true;
    await page.screenshot({ path: join(screenshotsDir, "before-agent.png"), fullPage: true });

    const requestIdsByUrl = new Map<string, string[]>();
    const requestCommitStatus = new Map<string, boolean>();
    const requestActionIds = new Map<string, string>();
    let controlPlaneBlockedByRoute = false; let externalOriginBlockedByRoute = false;
    page.on("requestfailed", (request) => {
      const queue = requestIdsByUrl.get(request.url()); const requestId = queue?.shift();
      if (queue?.length === 0) requestIdsByUrl.delete(request.url());
      const actionId = requestId ? requestActionIds.get(requestId) : undefined;
      void recordEvent("browser", "network.request_failed", { url: request.url(), failureText: request.failure()?.errorText ?? "unknown", upstreamCommitted: requestId ? requestCommitStatus.get(requestId) ?? null : null, browserReceivedSuccess: false, ...(requestId ? { requestId, correlationStrength: "url_and_request_order" } : {}), ...(actionId ? { actionId } : {}) }, { ...(requestId ? { requestId } : {}), ...(actionId ? { actionId } : {}) }).catch(() => undefined);
    });
    const handleRoute = async (route: Route) => {
      const url = new URL(route.request().url());
      if (url.pathname.startsWith("/__browserproof/")) { controlPlaneBlockedByRoute = true; await route.abort("blockedbyclient"); return; }
      if (url.origin !== baseUrl) { externalOriginBlockedByRoute = true; await route.abort("blockedbyclient"); return; }
      if (!isFaultTargetMatch(route.request().method(), route.request().url(), "POST /api/orders/A123/refund")) { await route.continue(); return; }
      const requestId = randomUUID(); const actionId = activeActionId; requestActionIds.set(requestId, actionId);
      const queue = requestIdsByUrl.get(route.request().url()) ?? []; queue.push(requestId); requestIdsByUrl.set(route.request().url(), queue);
      const headers = { ...route.request().headers(), "x-browserproof-run-id": runId, "x-browserproof-action-id": actionId, "x-browserproof-request-id": requestId };
      await recordEvent("browser", "network.request", { method: "POST", url: route.request().url(), actionId, requestId }, { actionId, requestId });
      const upstream = await route.fetch({ headers, timeout: 3000 });
      const upstreamStatus = upstream.status(); let committed = false;
      if (upstreamStatus >= 200 && upstreamStatus < 300) {
        try {
          const effect = (await queryEffects(controlBaseUrl, runId)).find((item) => item.requestId === requestId && item.actionId === actionId);
          committed = Boolean(effect);
          if (effect) await recordEvent("observer", "backend.commit_confirmed", { effectId: effect.effectId, upstreamCommitted: true, browserReceivedSuccess: null, evidence: "independent HTTP ledger query before browser response delivery" }, { actionId, requestId });
        }
        catch { faultObserverInconclusive = true; }
      }
      await page.screenshot({ path: join(screenshotsDir, "at-boundary.png"), fullPage: true });
      requestCommitStatus.set(requestId, committed);
      await recordEvent("runner", "network.upstream_response", { status: upstreamStatus, upstreamCommitted: committed, browserReceivedSuccess: null }, { actionId, requestId });
      if (fault && !faultTriggered && isFaultTargetMatch(route.request().method(), route.request().url(), fault.target) && upstreamStatus >= 200 && upstreamStatus < 300 && committed) {
        upstreamCommittedBeforeLoss = true; faultTriggered = true; browserReceivedSuccess = false;
        const phase = FAULT_SCHEDULE_REGISTRY.find((binding) => binding.scenarioId === "supportdesk-refund-v1")?.expectedPhase;
        await recordEvent("runner", "fault.triggered", { type: fault.type, phase, upstreamCommitted: true, browserReceivedSuccess: false }, { actionId, requestId });
        await upstream.dispose(); await route.abort("failed"); return;
      }
      await route.fulfill({ response: upstream });
      await recordEvent("browser", "network.response_delivered", { status: upstreamStatus, browserReceivedSuccess: upstreamStatus >= 200 && upstreamStatus < 300 }, { actionId, requestId });
    };
    await context.route("**/*", async (route: Route) => {
      const handler = handleRoute(route);
      inFlightRoutes.add(handler);
      try { await handler; }
      catch (error) { eventWriteFailure ??= sanitizeStagehandText(error instanceof Error ? error.message : String(error)); try { await route.abort("failed"); } catch { /* route may already be closed */ } }
      finally { inFlightRoutes.delete(handler); }
    });
    const blockedChecks = await page.evaluate(`(async () => {
      const blocked = async (url) => { try { await fetch(url); return false; } catch { return true; } };
      return { controlPlane: await blocked("/__browserproof/effects?runId=not-agent-visible"), externalOrigin: await blocked("https://browserproof.invalid/") };
    })()`) as { controlPlane: boolean; externalOrigin: boolean };
    sameBrowserProof.controlPlaneBlocked = blockedChecks.controlPlane && controlPlaneBlockedByRoute;
    sameBrowserProof.externalOriginBlocked = blockedChecks.externalOrigin && externalOriginBlockedByRoute;
    if (!sameBrowserProof.controlPlaneBlocked || !sameBrowserProof.externalOriginBlocked) throw new Error("Browser network safety policy did not block control-plane/external requests");
    await writeFile(join(artifactDir, "same-browser.json"), `${JSON.stringify(sameBrowserProof, null, 2)}\n`);
    await recordEvent("runner", "agent.page_target_proven", { adapterId: "stagehand-v4", stagehandPageId, playwrightTargetId: target.targetId, playwrightContextId: target.browserContextId ?? "unavailable", url: baseUrl, controlPlaneBlocked: true, externalOriginBlocked: true, beforeModelCall: true });
    if (fault) await recordEvent("runner", "fault.armed", { type: fault.type, armed: true, target: fault.target, trigger: fault.trigger, count: fault.count, seed: fault.seed });
    else await recordEvent("runner", "fault.schedule_disabled", { armed: false });
    await page.waitForFunction(() => /eligible/i.test(document.querySelector('[data-testid="order-status"]')?.textContent ?? ""), undefined, { timeout: 5000 });
    const visibleOrderState = await page.getByTestId("order-status").innerText();
    await recordEvent("agent", "agent.observation", { adapterId: "stagehand-v4", step: "order_loaded", observedText: visibleOrderState });
    const actionId = () => { activeActionId = randomUUID(); actionIndex += 1; return activeActionId; };
    const emitter: AgentEventEmitter = {
      beginAction: actionId,
      emit: async (event, payload, correlationActionId) => {
        await recordEvent("agent", event, payload, correlationActionId ? { actionId: correlationActionId } : {});
        if (event === "agent.model_action_result") modelActionRows.push({ type: event, ...(correlationActionId ? { actionId: correlationActionId } : {}), payload });
      },
    };
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), deadlineMs);
    try {
      adapter = new StagehandV4AgentAdapter({ stagehand, page: stagehandPage, model });
      outcome = await adapter.runTask({ task: STAGEHAND_TASK, page, stagehandPage, maxActions, deadlineAtMs: Date.now() + deadlineMs, signal: controller.signal, events: emitter,
        confirmTaskCompleted: async () => await page.getByRole("status").getByText("Refund successful", { exact: true }).isVisible().catch(() => false) });
      metadata = { ...metadata, stagehandActCalls: adapter.metrics.stagehandActCalls, liveInferenceCalls: adapter.metrics.liveInferenceCalls, actionExecutions: adapter.metrics.actionExecutions, inputTokens: adapter.metrics.inputTokens, outputTokens: adapter.metrics.outputTokens, reasoningTokens: adapter.metrics.reasoningTokens, inferenceTimeMs: adapter.metrics.inferenceTimeMs, lateResultsDiscarded: adapter.metrics.lateResultsDiscarded, taskCompleted: outcome.taskCompleted, errorCode: outcome.errorCode ?? null };
    } finally { clearTimeout(timer); }
    if (!outcome.errorCode && !controller.signal.aborted) await page.screenshot({ path: join(screenshotsDir, "after-agent.png"), fullPage: true });
  } catch (error) {
    errorMessage = sanitizeStagehandText((error instanceof Error ? error.message : String(error)).split(options.providerApiKey).join("[credential-redacted]"));
    status = /timeout|timed out/i.test(errorMessage) ? "timeout" : "browser_error";
  } finally {
    if (context && traceStarted) {
      try {
        const stopTrace = context.tracing.stop({ path: join(artifactDir, "trace.zip") });
        let stopTimer: ReturnType<typeof setTimeout> | undefined;
        const stopped = await Promise.race([stopTrace.then(() => true, () => false), new Promise<boolean>((resolveStopped) => { stopTimer = setTimeout(() => resolveStopped(false), 1_500); })]);
        if (stopTimer) clearTimeout(stopTimer);
        if (!stopped) traceErrors.push("Playwright trace did not stop before the browser fence"); else traceStarted = false;
      } catch { traceErrors.push("Playwright trace stop failed before browser fence"); }
    }
    quiescence = await quiesceStagehandSession({
      closeOwnedBrowser: async () => { if (stagehandBrowser) await stagehandBrowser.close(); },
      browserPortIsClosed: async () => cdpPort === undefined || await browserPortClosed(cdpPort),
      disconnectPlaywright: async () => { await playwrightBrowser?.close(); },
      closeStagehandClient: async () => { await stagehand?.close(); },
      waitForInflightBrowserRoutes: async () => waitForInFlightRoutes(inFlightRoutes),
      removeTemporaryProfile: async () => { await rm(profileDir, { recursive: true, force: true }); try { await import("node:fs/promises").then(({ stat }) => stat(profileDir)); return false; } catch { return true; } },
    });
    if (adapter) metadata = { ...metadata, stagehandActCalls: adapter.metrics.stagehandActCalls, liveInferenceCalls: adapter.metrics.liveInferenceCalls, actionExecutions: adapter.metrics.actionExecutions, inputTokens: adapter.metrics.inputTokens, outputTokens: adapter.metrics.outputTokens, reasoningTokens: adapter.metrics.reasoningTokens, inferenceTimeMs: adapter.metrics.inferenceTimeMs, lateResultsDiscarded: adapter.metrics.lateResultsDiscarded };
    if (traceStarted) traceErrors.push("Playwright trace remained open at browser teardown");
  }
  const reconciliation = await reconcileAfterStagehandQuiescence({
    quiescenceVerified: quiescence.quiescenceVerified,
    backendReset,
    ...(eventWriteFailure ? { knownEventWriteFailure: eventWriteFailure } : {}),
    drainPendingEventWrites: async () => { await Promise.allSettled([...pendingEventWrites]); },
    flushEvents: async () => { await events.flush(); },
    queryIndependentLedger: async () => {
      if (!app || !controlUrl) throw new Error("controlled backend unavailable for independent reconciliation");
      return await queryEffects(controlUrl, runId);
    },
  });
  effects = reconciliation.effects;
  observerStatus = reconciliation.observerStatus;
  eventWriteFailure = reconciliation.eventWriteFailure ? sanitizeStagehandText(reconciliation.eventWriteFailure) : undefined;
  if (reconciliation.observerError) errorMessage = sanitizeStagehandText(reconciliation.observerError);
  if (observerStatus === "complete") contract = evaluateRefundAtMostOnce(effects);
  if (!quiescence.quiescenceVerified || observerStatus !== "complete" || faultObserverInconclusive || traceErrors.length > 0) status = "observer_inconclusive";
  else if (outcome.errorCode === "deadline_exceeded" || outcome.errorCode === "aborted") status = "timeout";
  else if (contract && !contract.passed) status = "contract_violation";
  else if (status === "browser_error" || status === "timeout") { /* preserve setup/timeout failure */ }
  else if (outcome.errorCode || !outcome.taskCompleted || !contract?.passed || effects.length !== 1) status = "agent_error";
  else if (fault && !faultTriggered) status = "injection_error";
  else status = "passed";
  if (eventWriteFailure) errorMessage = `Evidence event write failed: ${eventWriteFailure}`;
  if (app) { try { await app.close(); } catch (error) { quiescence.cleanupErrors.push(`controlled backend close failed: ${sanitizeStagehandText(error instanceof Error ? error.message : String(error))}`); } }
  await writeFile(join(artifactDir, "agent-metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`);
  await writeFile(join(artifactDir, "model-actions.jsonl"), modelActionRows.map((row) => JSON.stringify(row)).join("\n") + (modelActionRows.length ? "\n" : ""));
  const cleanupErrors = [...quiescence.cleanupErrors, ...traceErrors];
  try {
    await recordEvent("observer", "backend.effects_observed", { count: effects.length, effectIds: effects.map(({ effectId }) => effectId), independentlyQueried: observerStatus === "complete" });
    await recordEvent("contract", "contract.evaluated", { status, signature: contract?.signature ?? null });
  } catch { /* eventWriteFailure records the durable evidence failure */ }
  try { await recordEvent("runner", "run.completed", { status, taskCompleted: outcome.taskCompleted, observerStatus, effectCount: effects.length, faultTriggered, quiescenceVerified: quiescence.quiescenceVerified }); } catch { /* persist an inconclusive terminal result below */ }
  try { await events.flush(); } catch { /* eventWriteFailure is recorded by the event wrapper */ }
  if (eventWriteFailure) errorMessage = `Evidence event write failed: ${eventWriteFailure}`;
  const result: RunResult = { schemaVersion: ARTIFACT_SCHEMA_VERSION, runId, scenarioId: "supportdesk-refund-v1", mode: options.mode, status, taskCompleted: outcome.taskCompleted, observerStatus, observedEffects: effects, contract,
    agent: { attempts: outcome.attempts, retries: outcome.retries, observation: outcome.observation, ...(outcome.errorCode ? { error: outcome.errorCode } : {}) },
    fault: { type: fault?.type ?? null, armed: Boolean(fault), triggered: faultTriggered, upstreamCommitted: upstreamCommittedBeforeLoss, browserReceivedSuccess }, ...(errorMessage ? { error: errorMessage } : {}) };
  const terminal = deriveStagehandTerminalEvidence({ status, taskCompleted: result.taskCompleted, faultTriggered, observerStatus, contractPassed: contract?.passed ?? null, quiescence, cleanupErrors, artifactError: eventWriteFailure ?? null, ...(outcome.errorCode ? { errorCode: outcome.errorCode } : {}) });
  await writeFile(join(artifactDir, "effects.json"), `${JSON.stringify({ schemaVersion: ARTIFACT_SCHEMA_VERSION, runId, observerStatus, effects }, null, 2)}\n`);
  await writeFile(join(artifactDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  await writeFile(join(artifactDir, "terminal.json"), `${JSON.stringify(terminal, null, 2)}\n`);
  const manifest = { schemaVersion: ARTIFACT_SCHEMA_VERSION, runId, scenarioId: result.scenarioId, mode: result.mode, seed: options.seed, startedAt, completedAt: new Date().toISOString(), adapterId: "stagehand-v4", artifactFiles: ["manifest.json", "scenario.json", "schedule.json", "events.jsonl", "effects.json", "result.json", "trace.zip", "screenshots", "agent-metadata.json", "model-actions.jsonl", "same-browser.json", "terminal.json"] };
  await writeFile(join(artifactDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  if (!sameBrowserProof) await writeFile(join(artifactDir, "same-browser.json"), `${JSON.stringify({ schemaVersion: 1, provenBeforeModelCall: false }, null, 2)}\n`);
  return { artifactDir, result, metadataPath: join(artifactDir, "agent-metadata.json"), sameBrowserPath: join(artifactDir, "same-browser.json"), terminal };
}

export function deriveStagehandTerminalEvidence(input: { status: RunResult["status"]; taskCompleted: boolean; faultTriggered: boolean; observerStatus: RunResult["observerStatus"]; contractPassed: boolean | null; quiescence: StagehandQuiescenceResult; cleanupErrors: string[]; artifactError: string | null; errorCode?: string }): StagehandTerminalEvidence {
  let terminalOutcome: StagehandTerminalOutcome;
  let exitReason: string;
  if (!input.quiescence.quiescenceVerified) { terminalOutcome = "observer_inconclusive"; exitReason = "browser_quiescence_unverified"; }
  else if (input.observerStatus !== "complete") { terminalOutcome = "observer_inconclusive"; exitReason = "independent_observer_inconclusive"; }
  else if (input.cleanupErrors.length > 0) { terminalOutcome = "cleanup_failure"; exitReason = "cleanup_failed_after_browser_fence"; }
  else if (input.artifactError) { terminalOutcome = "artifact_invalid"; exitReason = "evidence_event_write_failed"; }
  else if (input.status === "timeout" || input.errorCode === "deadline_exceeded" || input.errorCode === "aborted") { terminalOutcome = "timeout"; exitReason = input.errorCode ?? "deadline_exceeded"; }
  else if (input.status === "injection_error") { terminalOutcome = "injection_error"; exitReason = "scheduled_fault_not_observed"; }
  else if (input.status === "contract_violation") { terminalOutcome = "contract_violation_observed"; exitReason = "explicit_contract_violation_expectation_required"; }
  else if (input.status === "passed" && input.taskCompleted && input.contractPassed === true && !input.faultTriggered) { terminalOutcome = "clean_success"; exitReason = "verified_clean_completion"; }
  else if (input.status === "passed" && input.taskCompleted && input.contractPassed === true) { terminalOutcome = "clean_success"; exitReason = "verified_safe_completion"; }
  else { terminalOutcome = "agent_error"; exitReason = input.errorCode ?? "task_completion_or_contract_not_verified"; }
  return { executionStatus: input.status, taskCompleted: input.taskCompleted, faultTriggered: input.faultTriggered, observerStatus: input.observerStatus, contractPassed: input.contractPassed, terminalOutcome, exitReason, quiescenceVerified: input.quiescence.quiescenceVerified, cleanupErrors: input.cleanupErrors, artifactError: input.artifactError };
}

/** Preflight reports local capability only; it performs no provider inference. */
export async function stagehandPreflight(): Promise<Record<string, unknown>> {
  const { stat } = await import("node:fs/promises");
  const executable = chromium.executablePath();
  let chromiumInstalled = false;
  try { chromiumInstalled = (await stat(executable)).isFile(); } catch { chromiumInstalled = false; }
  return { sdkVersion: STAGEHAND_SDK_VERSION, nodeVersion: process.versions.node, nodeCompatible: Number(process.versions.node.split(".")[0]) > 22 || Number(process.versions.node.split(".")[0]) === 22 && Number(process.versions.node.split(".")[1]) >= 18, chromiumExecutableConfigured: true, chromiumInstalled, modelArgumentRequired: true, provider: "google", model: "google/gemini-3.8-flash", providerCredentialConfigured: Boolean(process.env.GEMINI_API_KEY), runnerBillingPolicy: "free-tier-only-no-fallback", accountFreeTierVerified: false, inferencePerformed: false };
}

export function stagehandOutcomeSignature(result: RunResult): string { return normalizeOutcome(result.status, result.observedEffects); }

/** No-LLM transport spike; it intentionally uses a deterministic Stagehand Page method, not model inference. */
export async function executeStagehandSameBrowserSmoke(): Promise<Record<string, unknown>> {
  const runId = randomUUID(); const root = fileURLToPath(new URL("../../../artifacts", import.meta.url)); const artifactDir = join(root, `stagehand-spike-${runId}`);
  const screenshotsDir = join(artifactDir, "screenshots"); await mkdir(screenshotsDir, { recursive: true });
  const events = new EventWriter(join(artifactDir, "events.jsonl"), runId, "supportdesk-refund-v1");
  const profileDir = await mkdtemp(join(tmpdir(), "browserproof-stagehand-spike-"));
  let app: SupportDeskServer | undefined; let ownedBrowser: Awaited<ReturnType<typeof localBrowser.launch>> | undefined; let stagehand: Stagehand | undefined; let attached: Browser | undefined; let context: Awaited<ReturnType<Browser["newContext"]>> | undefined; let tracing = false; let cdpPort: number | undefined;
  let observed: RefundEffect[] = []; let boundaryOrderValid = false; let pageProof: Record<string, unknown> | undefined; let requestSeen = false; let browserFailureSeen = false; let wrongContextRejected = false; let negativeBrowser: Browser | undefined; let controlPlaneBlockedByRoute = false; let externalOriginBlockedByRoute = false;
  let browserFailureResolve: (() => void) | undefined;
  const browserFailureEvent = new Promise<void>((resolveEvent) => { browserFailureResolve = resolveEvent; });
  try {
    app = await startSupportDesk({ appPort: 0, controlPort: 0 }); const appAddress = app.app.address(); const controlAddress = app.control.address();
    if (!appAddress || typeof appAddress === "string" || !controlAddress || typeof controlAddress === "string") throw new Error("SupportDesk listener unavailable");
    const baseUrl = `http://127.0.0.1:${appAddress.port}`; const controlUrl = `http://127.0.0.1:${controlAddress.port}`;
    const reset = await fetch(`${controlUrl}/__browserproof/reset`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runId }) }); if (!reset.ok) throw new Error("Backend reset failed");
    cdpPort = await choosePort(); ownedBrowser = await localBrowser.launch({ headless: true, port: cdpPort, userDataDir: profileDir }); stagehand = await Stagehand.create({ browser: ownedBrowser, logging: { level: "error" } });
    attached = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`); context = attached.contexts()[0]; if (!context) throw new Error("Playwright did not attach to Stagehand context");
    const stagehandPages = await stagehand.browser.context.pages(); const stagehandPage = stagehandPages[0]; if (!stagehandPage) throw new Error("Stagehand page missing");
    const attachedPage = await attachedPlaywrightPage(context, stagehandPage.pageId); if (!attachedPage) throw new Error("No Playwright page attaches to the Stagehand page target");
    const page = attachedPage.page; const target = attachedPage.target;
    const cancelDownloads = (candidate: Page) => candidate.on("download", (download) => { void download.cancel(); });
    for (const candidate of context.pages()) cancelDownloads(candidate);
    context.on("page", cancelDownloads);
    await stagehandPage.goto(baseUrl);
    const stagehandInitialUrl = await stagehandPage.url();
    if (target.targetId !== stagehandPage.pageId || stagehandInitialUrl !== page.url()) throw new Error(`Same-target precondition failed (target=${target.targetId === stagehandPage.pageId}; url=${stagehandInitialUrl === page.url()})`);
    negativeBrowser = await chromium.launch({ headless: true }); const negativeContext = await negativeBrowser.newContext(); const negativePage = await negativeContext.newPage(); await negativePage.goto(baseUrl);
    const wrongTarget = await targetInfo(negativePage); wrongContextRejected = wrongTarget.targetId !== stagehandPage.pageId && wrongTarget.targetId !== target.targetId;
    await negativeBrowser.close(); negativeBrowser = undefined;
    if (!wrongContextRejected) throw new Error("Wrong-context negative control was not rejected");
    pageProof = { architecture: "stagehand-launch-playwright-cdp-attach", playwrightTargetId: target.targetId, stagehandPageId: stagehandPage.pageId, playwrightContextId: target.browserContextId ?? null, url: baseUrl, stagehandUrl: await stagehandPage.url(), playwrightUrl: page.url(), controlPlaneBlocked: false, externalOriginBlocked: false, provenBeforeOperation: true };
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true, title: `stagehand-spike-${runId}` }); tracing = true;
    await page.screenshot({ path: join(screenshotsDir, "before.png"), fullPage: true });
    const requestId = randomUUID(); const actionId = randomUUID();
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.startsWith("/__browserproof/")) { controlPlaneBlockedByRoute = true; await route.abort("blockedbyclient"); return; }
      if (url.origin !== baseUrl) { externalOriginBlockedByRoute = true; await route.abort("blockedbyclient"); return; }
      if (!isFaultTargetMatch(route.request().method(), route.request().url(), "POST /api/orders/A123/refund")) { await route.continue(); return; }
      requestSeen = true; await events.record("browser", "network.request", { method: "POST", url: route.request().url(), actionId, requestId }, { actionId, requestId });
      const upstream = await route.fetch({ headers: { ...route.request().headers(), "x-browserproof-run-id": runId, "x-browserproof-action-id": actionId, "x-browserproof-request-id": requestId } });
      observed = await queryEffects(controlUrl, runId); const effect = observed.find((entry) => entry.requestId === requestId && entry.actionId === actionId);
      boundaryOrderValid = Boolean(effect) && upstream.status() >= 200 && upstream.status() < 300;
      await events.record("observer", "backend.commit_confirmed", { effectId: effect?.effectId ?? null, independentlyQueried: true }, { actionId, requestId });
      await page.screenshot({ path: join(screenshotsDir, "at-boundary.png"), fullPage: true });
      const phase = FAULT_SCHEDULE_REGISTRY.find((binding) => binding.scenarioId === "supportdesk-refund-v1")?.expectedPhase;
      await events.record("runner", "fault.triggered", { adapterId: "stagehand-v4", mode: "same-browser-spike", type: "commit_then_response_lost", phase, upstreamCommitted: boundaryOrderValid, browserReceivedSuccess: false }, { actionId, requestId });
      await upstream.dispose(); await route.abort("failed");
    });
    const blockedChecks = await page.evaluate(`(async () => {
      const blocked = async (url) => { try { await fetch(url); return false; } catch { return true; } };
      return { controlPlane: await blocked("/__browserproof/effects?runId=not-agent-visible"), externalOrigin: await blocked("https://browserproof.invalid/") };
    })()`) as { controlPlane: boolean; externalOrigin: boolean };
    pageProof.controlPlaneBlocked = blockedChecks.controlPlane && controlPlaneBlockedByRoute;
    pageProof.externalOriginBlocked = blockedChecks.externalOrigin && externalOriginBlockedByRoute;
    if (!pageProof.controlPlaneBlocked || !pageProof.externalOriginBlocked) throw new Error("Spike did not verify browser-side control-plane/external-origin blocks");
    await events.record("runner", "agent.page_target_proven", { adapterId: "stagehand-v4", stagehandPageId: stagehandPage.pageId, playwrightTargetId: target.targetId, playwrightContextId: target.browserContextId ?? null, url: baseUrl, controlPlaneBlocked: true, externalOriginBlocked: true, beforeModelCall: true });
    page.on("requestfailed", (request) => {
      if (request.url().includes("/api/orders/A123/refund")) {
        browserFailureSeen = true;
        const recorded = events.record("browser", "network.request_failed", { url: request.url(), failureText: request.failure()?.errorText ?? "unknown", upstreamCommitted: true, browserReceivedSuccess: false }, { actionId, requestId });
        void recorded.finally(() => browserFailureResolve?.());
      }
    });
    await events.record("agent", "agent.action_proposed", { adapterId: "stagehand-v4", mode: "same-browser-spike", action: "deterministic Stagehand Page locator click; no inference" }, { actionId });
    await stagehandPage.waitForFunction(() => {
      const button = document.querySelector<HTMLButtonElement>("#refund");
      return Boolean(button && !button.disabled);
    }, undefined, { timeout: 5000 });
    await stagehandPage.locator("#refund").click({ timeout: 5000 });
    await Promise.race([browserFailureEvent, new Promise<void>((resolveEvent) => setTimeout(resolveEvent, 2000))]);
    await page.screenshot({ path: join(screenshotsDir, "after.png"), fullPage: true });
    await context.tracing.stop({ path: join(artifactDir, "trace.zip") }); tracing = false;
    await events.record("runner", "run.completed", { adapterId: "stagehand-v4", mode: "same-browser-spike", requestSeen, browserFailureSeen, effectCount: observed.length, faultTriggered: boundaryOrderValid });
  } finally {
    if (context && tracing) { try { await context.tracing.stop({ path: join(artifactDir, "trace.zip") }); } catch { /* ignore close-time trace error */ } }
    try { await negativeBrowser?.close(); } catch { /* best effort */ } try { await attached?.close(); } catch { /* best effort */ } try { await stagehand?.close(); } catch { /* best effort */ } try { await ownedBrowser?.close(); } catch { /* best effort */ }
    if (app) await app.close(); await rm(profileDir, { recursive: true, force: true }); await events.flush();
  }
  let profileRemoved = false; try { await (await import("node:fs/promises")).stat(profileDir); } catch { profileRemoved = true; }
  const cdpPortClosed = cdpPort ? await new Promise<boolean>((resolveClosed) => {
    import("node:net").then(({ createConnection }) => { const socket = createConnection({ host: "127.0.0.1", port: cdpPort! }); socket.once("connect", () => { socket.destroy(); resolveClosed(false); }); socket.once("error", () => resolveClosed(true)); });
  }) : false;
  const result = { schemaVersion: 1, runId, adapterId: "stagehand-v4", mode: "same-browser-spike", modelInvoked: false, liveInferenceCalls: 0, pageProof, wrongContextRejected, requestSeen, browserFailureSeen, faultTriggered: boundaryOrderValid, observerStatus: observed.length ? "complete" : "observer_inconclusive", effects: observed, cleanupVerified: profileRemoved && cdpPortClosed, profileRemoved, cdpPortClosed, artifactDir, screenshotPaths: ["screenshots/before.png", "screenshots/at-boundary.png", "screenshots/after.png"], tracePath: "trace.zip" };
  await writeFile(join(artifactDir, "same-browser-spike.json"), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

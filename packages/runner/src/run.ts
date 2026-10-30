import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page, type Route } from "playwright";
import { EventWriter } from "./event-writer.js";
import { startSupportDesk, type SupportDeskServer } from "@browserproof/demo-support";
import {
  ARTIFACT_SCHEMA_VERSION,
  evaluateRefundAtMostOnce,
  FAULT_SCHEDULE_REGISTRY,
  type FaultSchedule,
  type RefundEffect,
  type RunManifest,
  type RunMode,
  type RunResult,
  type Scenario,
} from "@browserproof/contracts";

export interface RunOptions {
  mode: RunMode;
  seed: string;
  artifactRoot?: string;
  runId?: string;
  expectedSignature?: string;
  faultTarget?: string;
  schedule?: FaultSchedule;
}

export interface RunSummary {
  artifactDir: string;
  result: RunResult;
}

export function isFaultTargetMatch(method: string, requestUrl: string, target: string): boolean {
  const [targetMethod, targetPath] = target.split(" ", 2);
  return method.toUpperCase() === targetMethod && new URL(requestUrl).pathname === targetPath;
}

const SCENARIO_ID = "supportdesk-refund-v1";
const ARTIFACT_FILES = ["manifest.json", "scenario.json", "schedule.json", "events.jsonl", "effects.json", "result.json", "trace.zip", "screenshots"];

interface AgentOutcome {
  attempts: number;
  retries: number;
  observation: string;
  taskCompleted: boolean;
  error?: string;
}

async function runReferenceAgent(page: Page, events: EventWriter, nextActionId: () => string): Promise<AgentOutcome> {
  const stepId = "refund-task";
  await page.waitForFunction(() => /eligible/i.test(document.querySelector('[data-testid="order-status"]')?.textContent ?? ""), undefined, { timeout: 3000 });
  const orderText = await page.getByTestId("order-status").innerText();
  await events.record("agent", "agent.observation", { step: "order_loaded", observedText: orderText }, { agentStepId: stepId });
  if (!/eligible/i.test(orderText)) throw new Error(`Order was not observed as eligible: ${orderText}`);

  let attempts = 0;
  let retries = 0;
  let observation = "No refund confirmation observed";
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const actionId = nextActionId();
    attempts += 1;
    await events.record("agent", "agent.action_proposed", { action: "click_refund", attempt }, { agentStepId: stepId, actionId });
    await events.record("browser", "browser.click_attempt", { role: "button", name: "Refund", attempt }, { agentStepId: stepId, actionId });
    await page.getByRole("button", { name: "Refund", exact: true }).click();
    try {
      await page.getByRole("status").getByText("Refund successful", { exact: true }).waitFor({ state: "visible", timeout: 1200 });
      observation = "Browser-visible refund success confirmation received";
      await events.record("agent", "agent.observation", { step: "refund_result", observedText: observation, attempt }, { agentStepId: stepId, actionId });
      return { attempts, retries, observation, taskCompleted: true };
    } catch {
      observation = `No browser-visible success after attempt ${attempt}`;
      await events.record("agent", "agent.failure_observation", { attempt, reason: observation }, { agentStepId: stepId, actionId });
      if (attempt === 1) {
        retries += 1;
        await events.record("agent", "agent.retry_reason", { attempt, reason: "browser-visible success was not observed within 1200ms" }, { agentStepId: stepId, actionId });
      }
    }
  }
  return { attempts, retries, observation, taskCompleted: false };
}

export async function queryEffects(controlUrl: string, runId: string): Promise<RefundEffect[]> {
  const response = await fetch(`${controlUrl}/__browserproof/effects?runId=${encodeURIComponent(runId)}`, { signal: AbortSignal.timeout(2000) });
  if (!response.ok) throw new Error(`Observer returned HTTP ${response.status}`);
  const raw: unknown = await response.json();
  const rows = typeof raw === "object" && raw !== null && "effects" in raw ? (raw as { effects?: unknown }).effects : raw;
  if (!Array.isArray(rows)) throw new Error("Observer payload must contain an effects array");
  if (typeof raw === "object" && raw !== null && "effects" in raw && (raw as { runId?: unknown }).runId !== runId) throw new Error("Observer envelope returned a mismatched runId");
  const ids = new Set<string>();
  const requestIds = new Set<string>();
  const actionIds = new Set<string>();
  const effects = rows.map((candidate): RefundEffect => {
    if (typeof candidate !== "object" || candidate === null) throw new Error("Malformed effect row");
    const item = candidate as Record<string, unknown>;
    if (typeof item.effectId !== "string" || !item.effectId || typeof item.runId !== "string" || typeof item.actionId !== "string" || !item.actionId || typeof item.requestId !== "string" || !item.requestId || typeof item.entityId !== "string" || typeof item.amount !== "number" || !Number.isFinite(item.amount) || typeof item.committedAt !== "string" || !Number.isFinite(Date.parse(item.committedAt)) || item.kind !== "refund" || item.entityType !== "order") {
      throw new Error("Malformed effect row fields");
    }
    if (item.runId !== runId || item.entityId !== "A123") throw new Error("Observer returned a mismatched run or entity");
    if (ids.has(item.effectId)) throw new Error(`Duplicate effectId ${item.effectId}`);
    if (requestIds.has(item.requestId)) throw new Error(`Duplicate requestId ${item.requestId}`);
    if (actionIds.has(item.actionId)) throw new Error(`Duplicate actionId ${item.actionId}`);
    ids.add(item.effectId);
    requestIds.add(item.requestId);
    actionIds.add(item.actionId);
    return item as unknown as RefundEffect;
  });
  return effects;
}

async function closeBrowser(browser: Browser | undefined): Promise<void> {
  if (browser) await browser.close();
}

export async function executeRun(options: RunOptions): Promise<RunSummary> {
  const runId = options.runId ?? randomUUID();
  const artifactRoot = resolve(options.artifactRoot ?? fileURLToPath(new URL("../../../artifacts", import.meta.url)));
  const artifactDir = join(artifactRoot, runId);
  const screenshotsDir = join(artifactDir, "screenshots");
  await mkdir(screenshotsDir, { recursive: true });
  const events = new EventWriter(join(artifactDir, "events.jsonl"), runId, SCENARIO_ID);
  const startedAt = new Date().toISOString();
  const scenario: Scenario = { schemaVersion: ARTIFACT_SCHEMA_VERSION, scenarioId: SCENARIO_ID, name: "supportdesk-refund", orderId: "A123", agentPolicy: "refund-retry-once-after-browser-failure" };
  const faultSchedule: FaultSchedule = options.schedule
    ? { ...options.schedule, target: options.faultTarget ?? options.schedule.target }
    : { schemaVersion: ARTIFACT_SCHEMA_VERSION, scheduleId: `m0-${options.mode}-${options.seed}`, type: "commit_then_response_lost", target: options.faultTarget ?? "POST /api/orders/A123/refund", trigger: "first_matching_request_after_agent_action", count: 1, seed: options.seed };
  await writeFile(join(artifactDir, "scenario.json"), `${JSON.stringify(scenario, null, 2)}\n`);
  await writeFile(join(artifactDir, "schedule.json"), `${JSON.stringify({ schemaVersion: ARTIFACT_SCHEMA_VERSION, mode: options.mode, seed: options.seed, faults: options.mode === "faulted" ? [faultSchedule] : [] }, null, 2)}\n`);
  await events.record("runner", "run.started", { mode: options.mode, seed: options.seed });

  let appServers: SupportDeskServer | undefined;
  let browser: Browser | undefined;
  let agentOutcome: AgentOutcome = { attempts: 0, retries: 0, observation: "Agent did not start", taskCompleted: false };
  let observerStatus: RunResult["observerStatus"] = "complete";
  let observedEffects: RefundEffect[] = [];
  let contract: RunResult["contract"] = null;
  let status: RunResult["status"] = "browser_error";
  let errorMessage: string | undefined;
  let faultTriggered = false;
  let faultObserverInconclusive = false;
  let upstreamCommittedBeforeLoss = false;
  let browserReceivedSuccess: boolean | null = null;
  let context: Awaited<ReturnType<Browser["newContext"]>> | undefined;
  let baseUrl = "";
  let controlUrl = "";
  try {
    appServers = await startSupportDesk({ appPort: 0, controlPort: 0 });
    const appAddress = appServers.app.address();
    const controlAddress = appServers.control.address();
    if (!appAddress || typeof appAddress === "string" || !controlAddress || typeof controlAddress === "string") throw new Error("SupportDesk listeners did not bind TCP ports");
    baseUrl = `http://127.0.0.1:${appAddress.port}`;
    controlUrl = `http://127.0.0.1:${controlAddress.port}`;
    const resetResponse = await fetch(`${controlUrl}/__browserproof/reset`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runId }) });
    if (!resetResponse.ok) throw new Error(`Backend reset returned HTTP ${resetResponse.status}`);
    await events.record("runner", "backend.reset", { runId, status: resetResponse.status });

    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ baseURL: baseUrl, viewport: { width: 1280, height: 900 } });
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true, title: `${runId} ${options.mode}` });
    const page = await context.newPage();
    const pendingBrowserRequests = new Map<string, string[]>();
    const requestCommitStatus = new Map<string, boolean>();
    const requestActionIds = new Map<string, string>();
    page.on("requestfailed", (request) => {
      const queue = pendingBrowserRequests.get(request.url());
      const requestId = queue?.shift();
      if (queue?.length === 0) pendingBrowserRequests.delete(request.url());
      const upstreamCommitted = requestId ? requestCommitStatus.get(requestId) ?? null : null;
      const actionId = requestId ? requestActionIds.get(requestId) : undefined;
      void events.record("browser", "network.request_failed", { url: request.url(), failureText: request.failure()?.errorText ?? "unknown", upstreamCommitted, browserReceivedSuccess: false, ...(requestId ? { correlationStrength: "url_and_request_order", requestId } : {}), ...(actionId ? { actionId } : {}) }, { ...(requestId ? { requestId } : {}), ...(actionId ? { actionId } : {}) });
    });
    await page.route("**/api/orders/*/refund", async (route: Route) => {
      const requestId = randomUUID();
      const actionId = activeActionId;
      requestActionIds.set(requestId, actionId);
      const requestUrl = route.request().url();
      const pending = pendingBrowserRequests.get(requestUrl) ?? [];
      pending.push(requestId);
      pendingBrowserRequests.set(requestUrl, pending);
      const requestHeaders = { ...route.request().headers(), "x-browserproof-run-id": runId, "x-browserproof-action-id": actionId, "x-browserproof-request-id": requestId };
      await events.record("browser", "network.request", { method: "POST", url: requestUrl, runId, actionId, requestId }, { actionId, requestId });
      let upstream;
      try {
        upstream = await route.fetch({ headers: requestHeaders, timeout: 3000 });
      } catch (error) {
        requestCommitStatus.set(requestId, false);
        await events.record("browser", "network.upstream_failed", { upstreamCommitted: false, error: String(error) }, { actionId, requestId });
        await route.abort("failed");
        return;
      }
      const upstreamStatus = upstream.status();
      let requestCommitted = false;
      if (upstreamStatus >= 200 && upstreamStatus < 300) {
        try {
          const independentlyObserved = await queryEffects(controlUrl, runId);
          const effect = independentlyObserved.find((item) => item.requestId === requestId && item.actionId === actionId);
          requestCommitted = Boolean(effect);
          if (effect) await events.record("observer", "backend.commit_confirmed", { effectId: effect.effectId, effectRequestId: requestId, upstreamCommitted: true, browserReceivedSuccess: null, evidence: "independent HTTP ledger query before browser response delivery" }, { actionId, requestId });
          else {
            faultObserverInconclusive = true;
            await events.record("observer", "observer.commit_not_found", { requestId, upstreamStatus }, { actionId, requestId });
          }
        } catch (error) {
          faultObserverInconclusive = true;
          await events.record("observer", "observer.inconclusive_during_request", { error: String(error), requestId }, { actionId, requestId });
        }
      }
      requestCommitStatus.set(requestId, requestCommitted);
      await events.record("runner", "network.upstream_response", { status: upstreamStatus, upstreamCommitted: requestCommitted, browserReceivedSuccess: null }, { actionId, requestId });
      const configuredTarget = options.faultTarget ?? faultSchedule.target;
      if (options.mode === "faulted" && !faultTriggered && isFaultTargetMatch(route.request().method(), route.request().url(), configuredTarget)) {
        if (upstreamStatus >= 200 && upstreamStatus < 300 && requestCommitted) {
          upstreamCommittedBeforeLoss = true;
          faultTriggered = true;
          browserReceivedSuccess = false;
          const phase = FAULT_SCHEDULE_REGISTRY.find((binding) => binding.scenarioId === SCENARIO_ID)?.expectedPhase;
          await events.record("runner", "fault.triggered", { type: "commit_then_response_lost", phase, upstreamCommitted: true, browserReceivedSuccess: false }, { actionId, requestId });
          await upstream.dispose();
          await route.abort("failed");
          return;
        }
      }
      const responseWasSuccessful = upstreamStatus >= 200 && upstreamStatus < 300;
      await route.fulfill({ response: upstream });
      if (options.mode === "clean") browserReceivedSuccess = responseWasSuccessful;
      await events.record("browser", "network.response_delivered", { status: upstreamStatus, browserReceivedSuccess: responseWasSuccessful }, { actionId, requestId });
      const queuedIds = pendingBrowserRequests.get(requestUrl);
      if (queuedIds) {
        const requestIndex = queuedIds.indexOf(requestId);
        if (requestIndex >= 0) queuedIds.splice(requestIndex, 1);
        if (queuedIds.length === 0) pendingBrowserRequests.delete(requestUrl);
      }
    });
    let activeActionId = "agent-not-started";
    if (options.mode === "faulted") {
      await events.record("runner", "fault.armed", { type: faultSchedule.type, armed: true, target: options.faultTarget ?? faultSchedule.target, trigger: faultSchedule.trigger, count: faultSchedule.count, seed: faultSchedule.seed });
    } else {
      await events.record("runner", "fault.schedule_disabled", { armed: false });
    }
    const nextActionId = (): string => {
      activeActionId = randomUUID();
      return activeActionId;
    };
    await page.goto("/");
    await page.screenshot({ path: join(screenshotsDir, "before-agent.png"), fullPage: true });
    try {
      agentOutcome = await runReferenceAgent(page, events, nextActionId);
    } catch (error) {
      agentOutcome = { attempts: agentOutcome.attempts, retries: agentOutcome.retries, observation: "Agent failed before completing the browser task", taskCompleted: false, error: String(error) };
      await events.record("agent", "agent.error", { error: String(error) });
    }
    await page.screenshot({ path: join(screenshotsDir, "after-agent.png"), fullPage: true });
    await context.tracing.stop({ path: join(artifactDir, "trace.zip") });

    try {
      observedEffects = await queryEffects(controlUrl, runId);
      await events.record("observer", "backend.effects_observed", { count: observedEffects.length, effectIds: observedEffects.map(({ effectId }) => effectId), requestIds: observedEffects.map(({ requestId }) => requestId), independentlyQueried: true });
      contract = evaluateRefundAtMostOnce(observedEffects);
      await events.record("contract", "contract.evaluated", { ...contract });
      if (faultObserverInconclusive) {
        observerStatus = "observer_inconclusive";
        status = "observer_inconclusive";
      } else if (options.mode === "faulted" && !faultTriggered) status = "injection_error";
      else if (contract && !contract.passed) status = "contract_violation";
      else if (contract?.passed && agentOutcome.taskCompleted && observedEffects.length === 1) status = "passed";
      else status = "agent_error";
    } catch (error) {
      observerStatus = "observer_inconclusive";
      status = "observer_inconclusive";
      errorMessage = String(error);
      await events.record("observer", "observer.inconclusive", { error: errorMessage });
    }
  } catch (error) {
    errorMessage = String(error);
    status = /timeout|timed out/i.test(errorMessage) ? "timeout" : "browser_error";
    await events.record("runner", "run.error", { error: errorMessage, status });
  } finally {
    if (context) {
      try { await context.tracing.stop({ path: join(artifactDir, "trace.zip") }); } catch { /* trace may already be stopped */ }
    }
    await closeBrowser(browser);
    if (appServers) await appServers.close();
  }

  if (options.mode === "faulted" && !faultTriggered && status !== "observer_inconclusive") status = "injection_error";
  const result: RunResult = {
    schemaVersion: ARTIFACT_SCHEMA_VERSION, runId, scenarioId: SCENARIO_ID, mode: options.mode, status,
    taskCompleted: agentOutcome.taskCompleted, observerStatus, observedEffects, contract,
    agent: { attempts: agentOutcome.attempts, retries: agentOutcome.retries, observation: agentOutcome.observation, ...(agentOutcome.error ? { error: agentOutcome.error } : {}) },
    fault: { type: options.mode === "faulted" ? faultSchedule.type : null, armed: options.mode === "faulted", triggered: faultTriggered, upstreamCommitted: upstreamCommittedBeforeLoss, browserReceivedSuccess },
    ...(errorMessage ? { error: errorMessage } : {}),
  };
  await events.record("runner", "run.completed", { status: result.status, taskCompleted: result.taskCompleted, observerStatus: result.observerStatus, effectCount: result.observedEffects.length, faultTriggered: result.fault.triggered });
  await writeFile(join(artifactDir, "effects.json"), `${JSON.stringify({ schemaVersion: ARTIFACT_SCHEMA_VERSION, runId, observerStatus, effects: observedEffects }, null, 2)}\n`);
  await writeFile(join(artifactDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  const manifest: RunManifest = { schemaVersion: ARTIFACT_SCHEMA_VERSION, runId, scenarioId: SCENARIO_ID, mode: options.mode, seed: options.seed, startedAt, completedAt: new Date().toISOString(), artifactFiles: ARTIFACT_FILES };
  await writeFile(join(artifactDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return { artifactDir, result };
}

export async function runContractMatches(result: RunResult, expectedSignature: string | undefined): Promise<boolean> {
  if (!expectedSignature) return true;
  return result.contract?.signature === expectedSignature && result.status === "contract_violation";
}

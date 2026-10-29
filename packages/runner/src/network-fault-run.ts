import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type BrowserContext, type Page, type Request, type Route } from "playwright";
import { ARTIFACT_SCHEMA_VERSION, evaluateRefundAtMostOnce, type NetworkFaultScenarioId, type NetworkFaultSchedule, type NetworkFaultType, type RefundEffect, type RunMode } from "@browserproof/contracts";
export type { NetworkFaultScenarioId, NetworkFaultSchedule, NetworkFaultType } from "@browserproof/contracts";
import { startSupportDesk, type SupportDeskServer } from "@browserproof/demo-support";
import { EventWriter } from "./event-writer.js";
import { queryEffects } from "./run.js";

export type NetworkFaultStatus = "passed" | "contract_violation" | "agent_error" | "browser_error" | "injection_error" | "observer_inconclusive" | "timeout";
export interface NetworkFaultRequestRecord {
  method: "GET" | "POST";
  path: string;
  requestId: string;
  actionId: string | null;
  forwardedUpstream: boolean;
  upstreamCommitted: boolean | null;
  browserRequestFailed: boolean;
  responseDelivered: boolean;
  injectedStaleBody: boolean;
  upstreamBodySha256: string | null;
  browserBodySha256: string | null;
}
export interface NetworkFaultReadSnapshot {
  requestId: string;
  phase: "pre_commit" | "post_commit";
  body: { orderId: string; status: string; refundEligible: boolean; amount: number; currency: string };
  groundTruthBody?: { orderId: string; status: string; refundEligible: boolean; amount: number; currency: string };
  source: "real_upstream" | "saved_pre_commit_injected";
  independentlyObservedEffectIds: string[];
  eventSequence: number;
}
export interface NetworkFaultRunResult {
  schemaVersion: typeof ARTIFACT_SCHEMA_VERSION;
  runId: string;
  scenarioId: NetworkFaultScenarioId;
  mode: RunMode;
  seed: string;
  status: NetworkFaultStatus;
  taskCompleted: boolean;
  observerStatus: "complete" | "observer_inconclusive";
  agentPolicy: "refund-retry-once-after-browser-failure" | "refund-confirm-and-refresh-then-decide";
  agent: { attempts: number; retries: number; observation: string; error?: string };
  fault: { type: NetworkFaultType | null; armed: boolean; triggered: boolean; phase: "before_upstream" | "after_upstream_commit" | "post_commit_get" | null; upstreamCommitted: boolean | null; browserReceivedSuccess: boolean | null; requestId: string | null; actionId: string | null; effectId: string | null; triggerMatchCount: number };
  requests: NetworkFaultRequestRecord[];
  readSnapshots: NetworkFaultReadSnapshot[];
  observedEffects: RefundEffect[];
  contract: ReturnType<typeof evaluateRefundAtMostOnce> | null;
  reproduction?: { sourceRunId: string; normalizedSignature: string };
  error?: string;
}
export interface NetworkFaultRunOptions { fault: NetworkFaultType; mode: RunMode; seed: string; artifactRoot?: string; runId?: string; schedule?: NetworkFaultSchedule; sourceRunId?: string }
export interface NetworkFaultRunSummary { result: NetworkFaultRunResult; artifactDir: string }

export function scenarioForNetworkFault(fault: NetworkFaultType): NetworkFaultScenarioId {
  return fault === "response_delay" ? "supportdesk-response-delay-v1" : fault === "request_abort" ? "supportdesk-request-abort-v1" : "supportdesk-stale-order-read-v1";
}
export function createNetworkFaultSchedule(fault: NetworkFaultType, seed: string): NetworkFaultSchedule {
  const scenarioId = scenarioForNetworkFault(fault);
  const common = { schemaVersion: ARTIFACT_SCHEMA_VERSION, scheduleId: `${fault}-${seed}`, seed } as const;
  if (fault === "response_delay") return { ...common, scenarioId: "supportdesk-response-delay-v1", type: fault, target: { method: "POST", path: "/api/orders/A123/refund" }, trigger: "first_matching_request_after_agent_action", occurrenceCount: 1, release: "after_agent_retry_intent", watchdogMs: 5000 };
  if (fault === "request_abort") return { ...common, scenarioId: "supportdesk-request-abort-v1", type: fault, target: { method: "POST", path: "/api/orders/A123/refund" }, trigger: "first_matching_request_after_agent_action", occurrenceCount: 1, abortCode: "failed" };
  return { ...common, scenarioId: "supportdesk-stale-order-read-v1", type: fault, target: { method: "GET", path: "/api/orders/A123" }, trigger: "second_order_status_get_after_commit", occurrenceCount: 1, snapshotSource: "first_pre_commit_order_get", workflow: "refresh-after-refund" };
}
export function validateNetworkFaultSchedule(schedule: unknown, expectedFault?: NetworkFaultType): schedule is NetworkFaultSchedule {
  if (!schedule || typeof schedule !== "object") return false;
  const value = schedule as Record<string, unknown>;
  if (value.schemaVersion !== ARTIFACT_SCHEMA_VERSION || typeof value.seed !== "string" || !value.seed || typeof value.scheduleId !== "string" || !value.scheduleId) return false;
  const type = value.type;
  if (expectedFault && type !== expectedFault) return false;
  const scenarioId = type === "response_delay" ? "supportdesk-response-delay-v1" : type === "request_abort" ? "supportdesk-request-abort-v1" : type === "stale_api_response" ? "supportdesk-stale-order-read-v1" : null;
  if (!scenarioId || value.scenarioId !== scenarioId || value.scheduleId !== `${type}-${value.seed}` || value.occurrenceCount !== 1) return false;
  const target = value.target as Record<string, unknown> | null;
  if (!target) return false;
  if (type === "response_delay") return target.method === "POST" && target.path === "/api/orders/A123/refund" && value.trigger === "first_matching_request_after_agent_action" && value.release === "after_agent_retry_intent" && Number.isInteger(value.watchdogMs) && Number(value.watchdogMs) >= 1000 && Number(value.watchdogMs) <= 10000;
  if (type === "request_abort") return target.method === "POST" && target.path === "/api/orders/A123/refund" && value.trigger === "first_matching_request_after_agent_action" && value.abortCode === "failed";
  return target.method === "GET" && target.path === "/api/orders/A123" && value.trigger === "second_order_status_get_after_commit" && value.snapshotSource === "first_pre_commit_order_get" && value.workflow === "refresh-after-refund";
}

interface AgentOutcome { attempts: number; retries: number; observation: string; taskCompleted: boolean; error?: string }
const ORDER_PATH = "/api/orders/A123";
const REFUND_PATH = "/api/orders/A123/refund";
const ARTIFACT_FILES = ["manifest.json", "scenario.json", "schedule.json", "events.jsonl", "effects.json", "result.json", "trace.zip", "screenshots/before-agent.png", "screenshots/after-agent.png", "read-snapshots.json"];
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

export async function executeNetworkFaultRun(options: NetworkFaultRunOptions): Promise<NetworkFaultRunSummary> {
  const schedule = options.schedule ?? createNetworkFaultSchedule(options.fault, options.seed);
  if (!validateNetworkFaultSchedule(schedule, options.fault) || schedule.seed !== options.seed) throw new Error("Invalid or mismatched network fault schedule");
  const runId = options.runId ?? randomUUID();
  const scenarioId = schedule.scenarioId;
  const root = resolve(options.artifactRoot ?? fileURLToPath(new URL("../../../artifacts", import.meta.url)));
  const artifactDir = join(root, runId);
  const screenshotsDir = join(artifactDir, "screenshots");
  await mkdir(screenshotsDir, { recursive: true });
  const events = new EventWriter(join(artifactDir, "events.jsonl"), runId, scenarioId);
  const startedAt = new Date().toISOString();
  const mode: RunMode = options.mode;
  const staleMode = options.fault === "stale_api_response";
  const agentPolicy = staleMode ? "refund-confirm-and-refresh-then-decide" : "refund-retry-once-after-browser-failure";
  const result: NetworkFaultRunResult = {
    schemaVersion: ARTIFACT_SCHEMA_VERSION, runId, scenarioId, mode, seed: options.seed,
    status: "browser_error", taskCompleted: false, observerStatus: "complete", agentPolicy,
    agent: { attempts: 0, retries: 0, observation: "Agent did not start" },
    fault: { type: mode === "faulted" ? options.fault : null, armed: mode === "faulted", triggered: false, phase: null, upstreamCommitted: null, browserReceivedSuccess: null, requestId: null, actionId: null, effectId: null, triggerMatchCount: 0 },
    requests: [], readSnapshots: [], observedEffects: [], contract: null,
  };
  await writeFile(join(artifactDir, "scenario.json"), `${JSON.stringify({ schemaVersion: ARTIFACT_SCHEMA_VERSION, scenarioId, name: staleMode ? "supportdesk-stale-order-read" : "supportdesk-refund-network", orderId: "A123", agentPolicy }, null, 2)}\n`);
  await writeFile(join(artifactDir, "schedule.json"), `${JSON.stringify({ schemaVersion: ARTIFACT_SCHEMA_VERSION, mode, seed: options.seed, faults: mode === "faulted" ? [schedule] : [] }, null, 2)}\n`);
  await events.record("runner", "run.started", { mode, seed: options.seed, sourceRunId: options.sourceRunId ?? null });
  let server: SupportDeskServer | undefined;
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let agent: AgentOutcome = { attempts: 0, retries: 0, observation: "Agent did not complete", taskCompleted: false };
  let errorText: string | undefined;
  let controlUrl = "";
  let activeActionId: string | null = null;
  let orderGetCount = 0;
  let postCount = 0;
  let firstRefundRequestId: string | null = null;
  let beforeSnapshot: NetworkFaultReadSnapshot | null = null;
  let effects: RefundEffect[] = [];
  let observerInconclusive = false;
  let releaseRetry!: () => void;
  const retryIntent = new Promise<void>((resolveRetry) => { releaseRetry = resolveRetry; });
  const requestByObject = new WeakMap<Request, NetworkFaultRequestRecord>();
  try {
    server = await startSupportDesk({ appPort: 0, controlPort: 0 });
    const appAddr = server.app.address(); const controlAddr = server.control.address();
    if (!appAddr || typeof appAddr === "string" || !controlAddr || typeof controlAddr === "string") throw new Error("SupportDesk listener did not bind TCP ports");
    const baseUrl = `http://127.0.0.1:${appAddr.port}`; controlUrl = `http://127.0.0.1:${controlAddr.port}`;
    const reset = await fetch(`${controlUrl}/__browserproof/reset`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runId }) });
    if (!reset.ok) throw new Error(`Backend reset returned HTTP ${reset.status}`);
    await events.record("runner", "backend.reset", { runId, status: reset.status });
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ baseURL: baseUrl, viewport: { width: 1280, height: 900 } });
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true, title: `${runId} ${options.fault}` });
    const page = await context.newPage();
    const lastEventSequence = async (): Promise<number> => { const lines = (await readFile(join(artifactDir, "events.jsonl"), "utf8")).trim().split("\n"); return Number((JSON.parse(lines.at(-1) ?? "{}") as { sequence?: number }).sequence ?? 0); };
    const agentSignal = (event: string) => { if (options.fault === "response_delay" && event === "agent.retry_reason") releaseRetry(); };
    const priorRecord = async (route: Route, path: string, method: "GET" | "POST", actionId: string | null): Promise<{ record: NetworkFaultRequestRecord; headers: Record<string, string> }> => {
      const requestId = randomUUID();
      const record: NetworkFaultRequestRecord = { method, path, requestId, actionId, forwardedUpstream: false, upstreamCommitted: null, browserRequestFailed: false, responseDelivered: false, injectedStaleBody: false, upstreamBodySha256: null, browserBodySha256: null };
      result.requests.push(record); requestByObject.set(route.request(), record);
      const headers = { ...route.request().headers(), "x-browserproof-run-id": runId, "x-browserproof-request-id": requestId, ...(actionId ? { "x-browserproof-action-id": actionId } : {}) };
      await events.record("browser", "network.request", { method, path, requestId, actionId, forwardedUpstream: false }, { ...(actionId ? { actionId } : {}), requestId });
      return { record, headers };
    };
    page.on("requestfailed", (request) => {
      const record = requestByObject.get(request);
      if (record) { record.browserRequestFailed = true; void events.record("browser", "network.request_failed", { path: record.path, requestId: record.requestId, failureText: request.failure()?.errorText ?? "unknown", upstreamCommitted: record.upstreamCommitted }, { ...(record.actionId ? { actionId: record.actionId } : {}), requestId: record.requestId }); }
    });
    page.on("requestfinished", (request) => {
      const record = requestByObject.get(request);
      if (record && !record.browserRequestFailed) { record.responseDelivered = true; void events.record("browser", "network.request_finished", { path: record.path, requestId: record.requestId, upstreamCommitted: record.upstreamCommitted }, { ...(record.actionId ? { actionId: record.actionId } : {}), requestId: record.requestId }); }
    });
    page.on("console", (message) => { if (message.type() === "error") void events.record("browser", "browser.console_error", { text: message.text() }); });
    await page.route("**/api/orders/A123**", async (route: Route) => {
      const req = route.request(); const url = new URL(req.url()); const path = url.pathname;
      if (path === REFUND_PATH && req.method() === "POST") {
        postCount += 1;
        const actionId = activeActionId ?? randomUUID();
        const { record, headers } = await priorRecord(route, path, "POST", actionId);
        if (postCount === 1) firstRefundRequestId = record.requestId;
        const matching = mode === "faulted" && options.fault !== "stale_api_response" && schedule.target.method === "POST" && schedule.target.path === path && postCount === 1;
        if (matching && options.fault === "request_abort") {
          record.upstreamCommitted = false;
          result.fault.triggerMatchCount += 1; result.fault.triggered = true; result.fault.phase = "before_upstream"; result.fault.upstreamCommitted = false; result.fault.browserReceivedSuccess = false; result.fault.requestId = record.requestId; result.fault.actionId = actionId;
          await events.record("runner", "fault.triggered", { type: options.fault, phase: "before_upstream", upstreamCommitted: false, forwardedUpstream: false, effectCountForRequest: 0 }, { actionId, requestId: record.requestId });
          await route.abort("failed"); return;
        }
        record.forwardedUpstream = true;
        await events.record("runner", "network.forwarded_upstream", { requestId: record.requestId }, { actionId, requestId: record.requestId });
        const upstream = await route.fetch({ headers, timeout: 4000 });
        const upstreamBytes = await upstream.body();
        record.upstreamBodySha256 = sha256(upstreamBytes);
        await events.record("runner", "network.upstream_response", { requestId: record.requestId, status: upstream.status(), upstreamBodySha256: record.upstreamBodySha256 }, { actionId, requestId: record.requestId });
        const observed = await queryEffects(controlUrl, runId);
        effects = observed;
        const effect = observed.find((entry) => entry.requestId === record.requestId && entry.actionId === actionId);
        record.upstreamCommitted = Boolean(effect);
        await events.record("observer", effect ? "backend.commit_confirmed" : "observer.commit_not_found", { requestId: record.requestId, actionId, effectId: effect?.effectId ?? null, independentlyQueried: true, upstreamStatus: upstream.status() }, { actionId, requestId: record.requestId });
        const delayMatch = matching && options.fault === "response_delay";
        if (delayMatch && effect && upstream.status() >= 200 && upstream.status() < 300) {
          result.fault.triggerMatchCount += 1; result.fault.triggered = true; result.fault.phase = "after_upstream_commit"; result.fault.upstreamCommitted = true; result.fault.browserReceivedSuccess = null; result.fault.requestId = record.requestId; result.fault.actionId = actionId; result.fault.effectId = effect.effectId;
          await events.record("runner", "fault.triggered", { type: options.fault, phase: "after_upstream_commit", upstreamCommitted: true, browserReceivedSuccess: null, effectId: effect.effectId, responseHeld: true, responseWillEventuallyDeliver: true }, { actionId, requestId: record.requestId });
          const watchdog = new Promise<"watchdog">((resolveWatchdog) => setTimeout(() => resolveWatchdog("watchdog"), (schedule as Extract<NetworkFaultSchedule, { type: "response_delay" }>).watchdogMs));
          const released = await Promise.race([retryIntent.then(() => "retry_intent" as const), watchdog]);
          if (released === "watchdog") await events.record("runner", "fault.watchdog_expired", { type: options.fault, watchdogMs: (schedule as Extract<NetworkFaultSchedule, { type: "response_delay" }>).watchdogMs }, { actionId, requestId: record.requestId });
          else await events.record("runner", "fault.release_after_retry_intent", { type: options.fault }, { actionId, requestId: record.requestId });
          await route.fulfill({ response: upstream, body: upstreamBytes }); record.browserBodySha256 = sha256(upstreamBytes); record.responseDelivered = true; result.fault.browserReceivedSuccess = true;
          await events.record("browser", "network.response_delivered", { status: upstream.status(), requestId: record.requestId, delayed: true, browserReceivedSuccess: true, browserBodySha256: record.browserBodySha256 }, { actionId, requestId: record.requestId });
          return;
        }
        await route.fulfill({ response: upstream, body: upstreamBytes }); record.browserBodySha256 = sha256(upstreamBytes); record.responseDelivered = upstream.status() >= 200 && upstream.status() < 300;
        await events.record("browser", "network.response_delivered", { status: upstream.status(), requestId: record.requestId, delayed: false, browserReceivedSuccess: record.responseDelivered, browserBodySha256: record.browserBodySha256 }, { actionId, requestId: record.requestId });
        return;
      }
      if (path === ORDER_PATH && req.method() === "GET") {
        orderGetCount += 1;
        const { record, headers } = await priorRecord(route, path, "GET", null);
        record.forwardedUpstream = true;
        const upstream = await route.fetch({ headers, timeout: 4000 });
        const bodyBytes = await upstream.body();
        const body = JSON.parse(bodyBytes.toString("utf8")) as NetworkFaultReadSnapshot["body"];
        record.upstreamBodySha256 = sha256(bodyBytes);
        await events.record("runner", "network.upstream_response", { requestId: record.requestId, status: upstream.status(), upstreamBodySha256: record.upstreamBodySha256 }, { requestId: record.requestId });
        if (orderGetCount === 1) {
          if (!body.refundEligible || body.status !== "eligible_for_refund") throw new Error("Initial pre-commit order GET was not eligible");
          beforeSnapshot = { requestId: record.requestId, phase: "pre_commit", body, source: "real_upstream", independentlyObservedEffectIds: [], eventSequence: 0 };
          await events.record("observer", "order.snapshot_pre_commit", { requestId: record.requestId, refundEligible: body.refundEligible, source: "real_upstream" }, { requestId: record.requestId });
          beforeSnapshot.eventSequence = await lastEventSequence();
        }
        const staleSnapshot = beforeSnapshot;
        const staleMatch = mode === "faulted" && options.fault === "stale_api_response" && orderGetCount === 2 && staleSnapshot !== null;
        if (staleMatch && staleSnapshot) {
          effects = await queryEffects(controlUrl, runId);
          if (effects.length !== 1 || body.refundEligible || body.status !== "refunded" || !staleSnapshot.body.refundEligible) throw new Error("Refusing stale injection without post-commit truth and eligible pre-commit snapshot");
          result.fault.triggerMatchCount += 1; result.fault.triggered = true; result.fault.phase = "post_commit_get"; result.fault.upstreamCommitted = true; result.fault.browserReceivedSuccess = false; result.fault.requestId = record.requestId; result.fault.actionId = effects[0]!.actionId; result.fault.effectId = effects[0]!.effectId;
          await events.record("runner", "fault.triggered", { type: options.fault, phase: "post_commit_get", requestId: record.requestId, staleSnapshotRequestId: staleSnapshot.requestId, staleRefundEligible: staleSnapshot.body.refundEligible, trueRefundEligible: body.refundEligible, independentlyObservedEffectIds: effects.map((entry) => entry.effectId), source: "saved_pre_commit_response" }, { requestId: record.requestId });
          record.injectedStaleBody = true;
          const injectedBytes = Buffer.from(JSON.stringify(staleSnapshot.body)); record.browserBodySha256 = sha256(injectedBytes);
          await route.fulfill({ status: upstream.status(), headers: { ...upstream.headers(), "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }, body: injectedBytes });
          record.responseDelivered = true; result.fault.browserReceivedSuccess = true;
          await events.record("browser", "network.stale_response_delivered", { requestId: record.requestId, injected: true, sourceSnapshotRequestId: staleSnapshot.requestId, staleRefundEligible: true, trueRefundEligible: false, upstreamBodySha256: record.upstreamBodySha256, browserBodySha256: record.browserBodySha256 }, { requestId: record.requestId });
          result.readSnapshots.push({ ...staleSnapshot });
          result.readSnapshots.push({ requestId: record.requestId, phase: "post_commit", body: staleSnapshot.body, groundTruthBody: body, source: "saved_pre_commit_injected", independentlyObservedEffectIds: effects.map((entry) => entry.effectId), eventSequence: await lastEventSequence() });
          return;
        }
        if (orderGetCount > 1) {
          await events.record("observer", "order.snapshot_post_commit", { requestId: record.requestId, refundEligible: body.refundEligible, status: body.status, independentlyQueried: true }, { requestId: record.requestId });
          result.readSnapshots.push({ requestId: record.requestId, phase: "post_commit", body, source: "real_upstream", independentlyObservedEffectIds: effects.map((entry) => entry.effectId), eventSequence: await lastEventSequence() });
        }
        await route.fulfill({ response: upstream, body: bodyBytes }); record.browserBodySha256 = sha256(bodyBytes); record.responseDelivered = true;
        await events.record("browser", "network.response_delivered", { status: upstream.status(), requestId: record.requestId, injected: false, upstreamBodySha256: record.upstreamBodySha256, browserBodySha256: record.browserBodySha256 }, { requestId: record.requestId });
        return;
      }
      await route.continue();
    });
    if (mode === "faulted") await events.record("runner", "fault.armed", { type: options.fault, scheduleId: schedule.scheduleId, target: schedule.target, trigger: schedule.trigger, occurrenceCount: schedule.occurrenceCount, seed: schedule.seed });
    else await events.record("runner", "fault.schedule_disabled", { type: options.fault, armed: false });
    let activeSignal: (event: string) => void = agentSignal;
    const recordAgent = async (source: "agent" | "browser", type: string, payload: Record<string, unknown>, actionId?: string, requestId?: string | null) => { await events.record(source, type, payload, { ...(actionId ? { actionId, agentStepId: "refund-task" } : {}), ...(requestId ? { requestId } : {}) }); activeSignal(type); };
    const nextAction = () => { activeActionId = randomUUID(); return activeActionId; };
    const clickRefund = async (attempt: number): Promise<string> => {
      const actionId = nextAction();
      agent.attempts += 1;
      await recordAgent("agent", "agent.action_proposed", { action: "click_refund", attempt }, actionId);
      await recordAgent("browser", "browser.click_attempt", { role: "button", name: "Refund", attempt }, actionId);
      await page.getByRole("button", { name: "Refund", exact: true }).click();
      try {
        await page.getByRole("status").getByText(/Refund successful/).waitFor({ state: "visible", timeout: 1200 });
        agent.observation = `Browser-visible success received on attempt ${attempt}`;
        await recordAgent("agent", "agent.observation", { step: "refund_result", attempt, observedText: agent.observation }, actionId);
        return "success";
      } catch {
        agent.observation = `No browser-visible success after attempt ${attempt}`;
        await recordAgent("agent", "agent.failure_observation", { attempt, reason: agent.observation }, actionId);
        if (attempt === 1) { agent.retries += 1; await recordAgent("agent", "agent.retry_reason", { attempt, reason: "browser success was not observed within 1200ms", requestId: firstRefundRequestId }, actionId, firstRefundRequestId); }
        return "timeout";
      }
    };
    const startUrl = staleMode ? "/?workflow=refresh-after-refund" : "/";
    await page.goto(startUrl);
    await page.screenshot({ path: join(screenshotsDir, "before-agent.png"), fullPage: true });
    await page.waitForFunction(() => /eligible/i.test(document.querySelector('[data-testid="order-status"]')?.textContent ?? ""), undefined, { timeout: 3000 });
    await events.record("agent", "agent.observation", { step: "order_loaded", orderText: await page.getByTestId("order-status").innerText() }, { agentStepId: "refund-task" });
    if (!staleMode) {
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        const state = await clickRefund(attempt);
        if (state === "success") { agent.taskCompleted = true; break; }
      }
    } else {
      await clickRefund(1);
      const resultText = await page.getByRole("status").innerText();
      if (!resultText.includes("Refund successful")) throw new Error("Agent did not observe the first refund success");
      await events.record("agent", "agent.refresh_decision", { decision: "click_refresh_after_success", source: "visible_refresh_button" }, { agentStepId: "refund-task" });
      await page.getByRole("button", { name: "Refresh order status", exact: true }).click();
      await page.getByRole("status").getByText(/Order status refreshed/, { exact: false }).waitFor({ state: "visible", timeout: 3000 });
      const visibleStatus = await page.getByTestId("order-status").innerText();
      await events.record("agent", "agent.observation", { step: "order_status_refresh", visibleStatus, browserVisibleRefundEligible: /eligible/i.test(visibleStatus) }, { agentStepId: "refund-task" });
      if (/eligible/i.test(visibleStatus)) {
        agent.retries += 1;
        await events.record("agent", "agent.retry_reason", { reason: "browser-visible refreshed order still reports eligible", requestId: result.fault.requestId }, { agentStepId: "refund-task", ...(result.fault.actionId ? { actionId: result.fault.actionId } : {}) });
        const retryState = await clickRefund(2);
        if (retryState !== "success") throw new Error("Agent retry did not observe the refund success");
      }
      agent.taskCompleted = true;
      agent.observation = `Agent completed read-after-write workflow; refreshed status: ${visibleStatus}`;
    }
    await page.screenshot({ path: join(screenshotsDir, "after-agent.png"), fullPage: true });
    await events.record("runner", "agent.completed", { taskCompleted: agent.taskCompleted, attempts: agent.attempts, retries: agent.retries });
  } catch (error) {
    errorText = error instanceof Error ? error.message : String(error);
    agent.error = errorText;
    await events.record("runner", "run.error", { error: errorText });
  } finally {
    if (controlUrl) { try { effects = await queryEffects(controlUrl, runId); await events.record("observer", "backend.final_effects_observed", { count: effects.length, effectIds: effects.map((effect) => effect.effectId), independentlyQueried: true }); } catch (error) { observerInconclusive = true; errorText = `Final independent observer query failed: ${String(error)}`; } }
    if (context) { try { await context.tracing.stop({ path: join(artifactDir, "trace.zip") }); } catch { /* best effort on failed run */ } }
    if (browser) await browser.close();
    if (server) await server.close();
  }
  result.observedEffects = effects;
  result.agent = agent;
  result.taskCompleted = agent.taskCompleted;
  result.contract = evaluateRefundAtMostOnce(effects);
  if (observerInconclusive) { result.observerStatus = "observer_inconclusive"; result.status = "observer_inconclusive"; }
  else if (mode === "faulted" && !result.fault.triggered) result.status = "injection_error";
  else if (!agent.taskCompleted) result.status = errorText ? "agent_error" : "timeout";
  else if (!result.contract.passed) result.status = "contract_violation";
  else if (result.observedEffects.length === 1) result.status = "passed";
  else result.status = "agent_error";
  if (errorText) result.error = errorText;
  await events.record("observer", "backend.effects_observed", { count: effects.length, effectIds: effects.map((entry) => entry.effectId), requestIds: effects.map((entry) => entry.requestId), independentlyQueried: true });
  await events.record("contract", "contract.evaluated", { ...result.contract, taskCompleted: result.taskCompleted, status: result.status });
  await events.record("runner", "run.completed", { status: result.status, taskCompleted: result.taskCompleted, faultTriggered: result.fault.triggered, effectCount: effects.length });
  await events.flush();
  if (beforeSnapshot && result.readSnapshots.length === 0) result.readSnapshots.push(beforeSnapshot);
  await writeFile(join(artifactDir, "read-snapshots.json"), `${JSON.stringify({ schemaVersion: ARTIFACT_SCHEMA_VERSION, runId, snapshots: result.readSnapshots }, null, 2)}\n`);
  await writeFile(join(artifactDir, "effects.json"), `${JSON.stringify({ schemaVersion: ARTIFACT_SCHEMA_VERSION, runId, observerStatus: result.observerStatus, effects }, null, 2)}\n`);
  await writeFile(join(artifactDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  const manifest = { schemaVersion: ARTIFACT_SCHEMA_VERSION, runId, scenarioId, mode, seed: options.seed, startedAt, completedAt: new Date().toISOString(), artifactFiles: ARTIFACT_FILES };
  await writeFile(join(artifactDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await validateNetworkFaultArtifacts(artifactDir);
  return { result, artifactDir };
}

export async function validateNetworkFaultArtifacts(artifactDir: string): Promise<{ valid: boolean; errors: string[] }> {
  const errors: string[] = [];
  try {
    const read = async (name: string) => JSON.parse(await readFile(join(artifactDir, name), "utf8")) as Record<string, unknown>;
    const [manifest, scenario, scheduleDoc, effectsDoc, rawResult, snapshotDoc] = await Promise.all([read("manifest.json"), read("scenario.json"), read("schedule.json"), read("effects.json"), read("result.json"), read("read-snapshots.json")]);
    const result = rawResult as unknown as NetworkFaultRunResult;
    if (manifest.schemaVersion !== ARTIFACT_SCHEMA_VERSION || scenario.scenarioId !== result.scenarioId || manifest.runId !== result.runId || scheduleDoc.seed !== result.seed || scenario.agentPolicy !== result.agentPolicy) errors.push("manifest/scenario/schedule provenance mismatch");
    const savedFaults = scheduleDoc.faults;
    if (result.mode === "faulted") {
      if (!Array.isArray(savedFaults) || savedFaults.length !== 1 || !validateNetworkFaultSchedule(savedFaults[0], result.fault.type ?? undefined) || (savedFaults[0] as NetworkFaultSchedule).seed !== result.seed || (savedFaults[0] as NetworkFaultSchedule).scenarioId !== result.scenarioId) errors.push("saved fault schedule invalid or mismatched");
    } else if (!Array.isArray(savedFaults) || savedFaults.length !== 0) errors.push("clean run must have no enabled fault schedule");
    if (!Array.isArray(effectsDoc.effects) || JSON.stringify(effectsDoc.effects) !== JSON.stringify(result.observedEffects)) errors.push("effects/result ledger mismatch");
    const reevaluated = evaluateRefundAtMostOnce(result.observedEffects);
    if (JSON.stringify(reevaluated) !== JSON.stringify(result.contract)) errors.push("contract does not match independently observed effects");
    const requestIds = new Set(result.requests.map((r) => r.requestId));
    if (requestIds.size !== result.requests.length) errors.push("duplicate network request IDs");
    for (const effect of result.observedEffects) {
      const request = result.requests.find((r) => r.requestId === effect.requestId);
      if (!request || request.method !== "POST" || !request.forwardedUpstream || request.upstreamCommitted !== true || request.actionId !== effect.actionId || effect.runId !== result.runId) errors.push(`effect/request correlation mismatch for ${effect.effectId}`);
    }
    if (JSON.stringify(snapshotDoc.snapshots) !== JSON.stringify(result.readSnapshots)) errors.push("read snapshot/result mismatch");
    if (!Array.isArray(result.requests)) errors.push("request records missing");
    const eventLines = (await readFile(join(artifactDir, "events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { type: string; requestId?: string; payload: Record<string, unknown> });
    for (const request of result.requests) {
      const upstreamEvent = eventLines.find((event) => event.type === "network.upstream_response" && event.requestId === request.requestId);
      const deliveredEvent = eventLines.find((event) => (event.type === "network.response_delivered" || event.type === "network.stale_response_delivered") && event.requestId === request.requestId);
      if (request.forwardedUpstream && (request.upstreamCommitted === true || request.responseDelivered) && !/^[a-f0-9]{64}$/.test(request.upstreamBodySha256 ?? "")) errors.push(`missing or invalid upstream response digest for ${request.requestId}`);
      if (request.forwardedUpstream && request.upstreamBodySha256 && upstreamEvent?.payload.upstreamBodySha256 !== request.upstreamBodySha256) errors.push(`upstream response digest mismatch for ${request.requestId}`);
      if (request.responseDelivered && !/^[a-f0-9]{64}$/.test(request.browserBodySha256 ?? "")) errors.push(`missing or invalid browser response digest for ${request.requestId}`);
      if (request.responseDelivered && request.browserBodySha256 && deliveredEvent?.payload.browserBodySha256 !== request.browserBodySha256) errors.push(`browser response digest mismatch for ${request.requestId}`);
    }
    if (result.mode === "faulted" && (!result.fault.armed || !result.fault.triggered || result.fault.triggerMatchCount !== 1)) errors.push("fault not exactly triggered");
    if (result.fault.type === "request_abort") {
      const aborted = result.requests.find((r) => r.requestId === result.fault.requestId);
      if (!aborted || aborted.forwardedUpstream || aborted.upstreamCommitted !== false || !aborted.browserRequestFailed || result.observedEffects.some((effect) => effect.requestId === aborted.requestId)) errors.push("request abort chronology or zero-effect guarantee failed");
    }
    if (result.fault.type === "response_delay") {
      const delayed = result.requests.find((r) => r.requestId === result.fault.requestId);
      const records = (await readFile(join(artifactDir, "events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { sequence: number; type: string; requestId?: string; payload: Record<string, unknown> });
      const findSeq = (type: string, requestId?: string) => records.find((event) => event.type === type && (!requestId || event.requestId === requestId || event.payload.requestId === requestId))?.sequence;
      const commit1 = findSeq("backend.commit_confirmed", result.fault.requestId ?? undefined);
      const trigger = findSeq("fault.triggered", result.fault.requestId ?? undefined);
      const retry = findSeq("agent.retry_reason", result.fault.requestId ?? undefined);
      const delivered = findSeq("network.response_delivered", result.fault.requestId ?? undefined);
      const secondEffect = result.observedEffects.find((effect) => effect.requestId !== result.fault.requestId);
      const commit2 = secondEffect ? findSeq("backend.commit_confirmed", secondEffect.requestId) : undefined;
      if (!delayed || !delayed.forwardedUpstream || delayed.upstreamCommitted !== true || !delayed.responseDelivered || delayed.browserRequestFailed || result.observedEffects.length !== 2 || !commit1 || !trigger || !retry || !delivered || !commit2 || !(commit1 < trigger && trigger < retry && retry < delivered && delivered < commit2)) errors.push("delayed successful response evidence missing or out of order");
    }
    if (result.fault.type === "stale_api_response") {
      const snapshots = snapshotDoc.snapshots as NetworkFaultReadSnapshot[];
      const pre = snapshots?.find((snapshot) => snapshot.phase === "pre_commit");
      const post = snapshots?.find((snapshot) => snapshot.phase === "post_commit");
      if (!pre || !post || !pre.body.refundEligible || JSON.stringify(post.body) !== JSON.stringify(pre.body) || post.groundTruthBody?.refundEligible !== false || post.groundTruthBody.status !== "refunded" || post.source !== "saved_pre_commit_injected" || !post.independentlyObservedEffectIds.length || result.observedEffects.length !== 2) errors.push("stale response snapshot provenance/ground truth mismatch");
    }
    const events = (await readFile(join(artifactDir, "events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { sequence: number; runId: string });
    if (events.some((event, index) => event.sequence !== index + 1 || event.runId !== result.runId)) errors.push("event sequence or runId mismatch");
    for (const name of ["before-agent.png", "after-agent.png"]) {
      const bytes = await readFile(join(artifactDir, "screenshots", name));
      if (bytes.length < 100 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE) || bytes.readUInt32BE(16) < 1 || bytes.readUInt32BE(20) < 1) errors.push(`invalid screenshot ${name}`);
    }
    const trace = await readFile(join(artifactDir, "trace.zip"));
    if (trace.length < 100 || trace[0] !== 0x50 || trace[1] !== 0x4b) errors.push("invalid Playwright trace ZIP");
  } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
  return { valid: errors.length === 0, errors };
}

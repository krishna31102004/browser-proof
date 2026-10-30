import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { chromium, type Page, type Route } from "playwright";
import {
  ARTIFACT_SCHEMA_VERSION, evaluateAdminCorrectRecord, evaluateRefundAtMostOnce,
  type AdminRecordEffect, type AdminRecordSnapshot, type BrowserStateAgentPolicy,
  type BrowserStateFaultSchedule, type BrowserStateFaultType, type BrowserStateScenarioId,
  type RefundEffect, type ResultStatus, type RunMode,
} from "@browserproof/contracts";
import { startAdminBench, type AdminBenchServer } from "@browserproof/demo-admin";
import { startSupportDesk, type SupportDeskServer } from "@browserproof/demo-support";
import { EventWriter } from "./event-writer.js";
import { queryAdminEffects, queryAdminState } from "./admin-run.js";
import { queryEffects } from "./run.js";
import { redactTraceCredentials, validatePlaywrightTraceArchive } from "./trace-archive.js";

export type BrowserStateEffect = AdminRecordEffect | RefundEffect;
export type BrowserStateContract = ReturnType<typeof evaluateAdminCorrectRecord> | ReturnType<typeof evaluateRefundAtMostOnce>;
export type { BrowserStateAgentPolicy, BrowserStateFaultSchedule, BrowserStateFaultType } from "@browserproof/contracts";
export interface BrowserStateRunResult {
  schemaVersion: typeof ARTIFACT_SCHEMA_VERSION;
  runId: string;
  scenarioId: BrowserStateScenarioId;
  mode: RunMode;
  seed: string;
  agentPolicy: BrowserStateAgentPolicy;
  status: ResultStatus;
  taskCompleted: boolean;
  observerStatus: "complete" | "observer_inconclusive";
  availability: "available" | "task_unavailable";
  observedEffects: BrowserStateEffect[];
  finalAdminRecords: AdminRecordSnapshot[];
  safetyContract: BrowserStateContract | null;
  agent: { attempts: number; retries: number; observation: string; error?: string };
  fault: { type: BrowserStateFaultType | null; armed: boolean; triggered: boolean; phase: string | null; occurrenceCount: number; requestId: string | null };
  evidence: Record<string, unknown>;
  error?: string;
}
export interface BrowserStateRunOptions {
  fault: BrowserStateFaultType; mode: RunMode; agent: BrowserStateAgentPolicy; seed: string;
  artifactRoot?: string; runId?: string; schedule?: BrowserStateFaultSchedule; sourceRunId?: string;
  observerUrlOverride?: string;
  /** Negative-control seam: keep a valid fault armed but suppress its single trigger. */
  suppressTriggerForTest?: boolean;
}
export interface BrowserStateRunSummary { result: BrowserStateRunResult; artifactDir: string }

export const BROWSER_STATE_TYPES: BrowserStateFaultType[] = ["delayed_render", "session_expire", "navigation_abort"];
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const filesFor = (fault: BrowserStateFaultType) => ["manifest.json", "scenario.json", "schedule.json", "events.jsonl", "effects.json", "result.json", "trace.zip", "screenshots/before-agent.png", "screenshots/at-fault-boundary.png", "screenshots/after-agent.png", fault === "delayed_render" ? "render-snapshots.json" : fault === "session_expire" ? "session-evidence.json" : "navigation-evidence.json"];
const scenarioFor = (fault: BrowserStateFaultType): BrowserStateScenarioId => fault === "delayed_render" ? "adminbench-delayed-render-v1" : fault === "session_expire" ? "supportdesk-session-expire-v1" : "supportdesk-navigation-abort-v1";

export function createBrowserStateSchedule(fault: BrowserStateFaultType, seed: string): BrowserStateFaultSchedule {
  const common = { schemaVersion: ARTIFACT_SCHEMA_VERSION, scheduleId: `${fault}-${seed}`, seed } as const;
  if (fault === "delayed_render") return { ...common, scenarioId: "adminbench-delayed-render-v1", type: fault, target: { app: "adminbench", recordId: "beacon", dataPath: "/api/records" }, trigger: "records_fetched_before_dom_insertion", occurrenceCount: 1, release: "after_vulnerable_wait_failure_or_hardened_waiting_observation", vulnerableWaitMs: 300 };
  if (fault === "session_expire") return { ...common, scenarioId: "supportdesk-session-expire-v1", type: fault, target: { method: "POST", path: "/api/orders/A123/refund" }, trigger: "after_authenticated_observation_before_refund_action", occurrenceCount: 1, invalidation: "exact_observed_server_session" };
  return { ...common, scenarioId: "supportdesk-navigation-abort-v1", type: fault, target: { method: "GET", path: "/refund?workflow=navigation-refund", resourceType: "document", mainFrame: true }, trigger: "first_agent_main_frame_navigation", occurrenceCount: 1, abortCode: "failed" };
}

export function validateBrowserStateSchedule(value: unknown, expectedFault?: BrowserStateFaultType, seed?: string): value is BrowserStateFaultSchedule {
  if (!isRecord(value) || value.schemaVersion !== ARTIFACT_SCHEMA_VERSION || typeof value.seed !== "string" || !value.seed || typeof value.scheduleId !== "string" || value.scheduleId !== `${String(value.type)}-${value.seed}` || value.occurrenceCount !== 1) return false;
  if (expectedFault && value.type !== expectedFault || seed && value.seed !== seed) return false;
  if (value.type === "delayed_render") return value.scenarioId === "adminbench-delayed-render-v1" && isRecord(value.target) && value.target.app === "adminbench" && value.target.recordId === "beacon" && value.target.dataPath === "/api/records" && exactKeys(value.target, ["app", "recordId", "dataPath"]) && value.trigger === "records_fetched_before_dom_insertion" && value.release === "after_vulnerable_wait_failure_or_hardened_waiting_observation" && value.vulnerableWaitMs === 300 && exactKeys(value, ["schemaVersion", "scheduleId", "scenarioId", "type", "seed", "target", "trigger", "occurrenceCount", "release", "vulnerableWaitMs"]);
  if (value.type === "session_expire") return value.scenarioId === "supportdesk-session-expire-v1" && isRecord(value.target) && value.target.method === "POST" && value.target.path === "/api/orders/A123/refund" && exactKeys(value.target, ["method", "path"]) && value.trigger === "after_authenticated_observation_before_refund_action" && value.invalidation === "exact_observed_server_session" && exactKeys(value, ["schemaVersion", "scheduleId", "scenarioId", "type", "seed", "target", "trigger", "occurrenceCount", "invalidation"]);
  if (value.type === "navigation_abort") return value.scenarioId === "supportdesk-navigation-abort-v1" && isRecord(value.target) && value.target.method === "GET" && value.target.path === "/refund?workflow=navigation-refund" && value.target.resourceType === "document" && value.target.mainFrame === true && exactKeys(value.target, ["method", "path", "resourceType", "mainFrame"]) && value.trigger === "first_agent_main_frame_navigation" && value.abortCode === "failed" && exactKeys(value, ["schemaVersion", "scheduleId", "scenarioId", "type", "seed", "target", "trigger", "occurrenceCount", "abortCode"]);
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function exactKeys(value: Record<string, unknown>, keys: string[]): boolean { return Object.keys(value).sort().join("|") === [...keys].sort().join("|"); }
const json = async <T>(url: string, init?: RequestInit): Promise<T> => { const response = await fetch(url, { ...init, signal: AbortSignal.timeout(2500) }); if (!response.ok) throw new Error(`Fixture control request returned HTTP ${response.status}`); return await response.json() as T; };
const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

export async function executeBrowserStateRun(options: BrowserStateRunOptions): Promise<BrowserStateRunSummary> {
  const schedule = options.schedule ?? createBrowserStateSchedule(options.fault, options.seed);
  if (!validateBrowserStateSchedule(schedule, options.fault, options.seed)) throw new Error("Invalid or mismatched browser-state schedule");
  const scenarioId = scenarioFor(options.fault);
  const runId = options.runId ?? randomUUID();
  const artifactRoot = resolve(options.artifactRoot ?? fileURLToPath(new URL("../../../artifacts", import.meta.url)));
  const artifactDir = join(artifactRoot, runId); const screenshotsDir = join(artifactDir, "screenshots");
  await mkdir(screenshotsDir, { recursive: true });
  const events = new EventWriter(join(artifactDir, "events.jsonl"), runId, scenarioId);
  const startedAt = new Date().toISOString();
  const result: BrowserStateRunResult = {
    schemaVersion: ARTIFACT_SCHEMA_VERSION, runId, scenarioId, mode: options.mode, seed: options.seed, agentPolicy: options.agent,
    status: "browser_error", taskCompleted: false, observerStatus: "complete", availability: "available", observedEffects: [], finalAdminRecords: [], safetyContract: null,
    agent: { attempts: 0, retries: 0, observation: "Agent did not start" },
    fault: { type: options.mode === "faulted" ? options.fault : null, armed: options.mode === "faulted", triggered: false, phase: null, occurrenceCount: 0, requestId: null }, evidence: {},
  };
  const faultApplied = options.mode === "faulted" && options.suppressTriggerForTest !== true;
  const adminFault = options.fault === "delayed_render";
  let app: AdminBenchServer | SupportDeskServer | undefined; let appUrl = ""; let controlUrl = ""; let observerUrl = ""; let errorText: string | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined; let context: Awaited<ReturnType<Awaited<ReturnType<typeof chromium.launch>>["newContext"]>> | undefined;
  let eventActionId: string | undefined; let eventObservationId: string | undefined;
  let sessionRefs: string[] = []; let sessionOldInvalidated = false; let refundRequestCount = 0;
  const navigationRequests: Array<Record<string, unknown>> = []; const renderSnapshots: Array<Record<string, unknown>> = [];
  const requestCorrelations = new WeakMap<object, string>();
    const captureBoundaryScreenshot = async (targetPage: Page, stage: string) => {
      await targetPage.screenshot({ path: join(screenshotsDir, "at-fault-boundary.png"), fullPage: true });
      await events.record("runner", "screenshot.at_fault_boundary_captured", { file: "screenshots/at-fault-boundary.png", stage, faultTriggered: result.fault.triggered });
    };
  await writeFile(join(artifactDir, "scenario.json"), `${JSON.stringify({ schemaVersion: ARTIFACT_SCHEMA_VERSION, scenarioId, name: options.fault, faultType: options.fault, agentPolicy: options.agent, desiredState: adminFault ? "deactivate Beacon exactly once" : "complete the refund task exactly once" }, null, 2)}\n`);
  await writeFile(join(artifactDir, "schedule.json"), `${JSON.stringify({ schemaVersion: ARTIFACT_SCHEMA_VERSION, mode: options.mode, seed: options.seed, faults: options.mode === "faulted" ? [schedule] : [] }, null, 2)}\n`);
  await events.record("runner", "run.started", { fault: options.fault, mode: options.mode, seed: options.seed, agentPolicy: options.agent });
  try {
    app = adminFault ? await startAdminBench({ appPort: 0, controlPort: 0 }) : await startSupportDesk({ appPort: 0, controlPort: 0 });
    const appAddress = app.app.address(); const controlAddress = app.control.address();
    if (!appAddress || typeof appAddress === "string" || !controlAddress || typeof controlAddress === "string") throw new Error("Browser-state fixture failed to bind loopback listeners");
    appUrl = `http://127.0.0.1:${appAddress.port}`; controlUrl = `http://127.0.0.1:${controlAddress.port}`; observerUrl = options.observerUrlOverride ?? controlUrl;
    await json(`${controlUrl}/__browserproof/reset`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runId }) });
    await events.record("runner", "backend.reset", { runId, separateControlListener: true });
    browser = await chromium.launch({ headless: true }); context = await browser.newContext({ baseURL: appUrl, viewport: { width: 1280, height: 900 } });
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true, title: `${runId} ${options.fault} ${options.agent} ${options.mode}` });
    let page = await context.newPage();
    const trackPage = (trackedPage: Page) => trackedPage.on("requestfailed", (request) => { const id = requestCorrelations.get(request) ?? randomUUID(); void events.record("browser", "network.request_failed", { url: request.url(), method: request.method(), resourceType: request.resourceType(), failureText: request.failure()?.errorText ?? "unknown", isNavigationRequest: request.isNavigationRequest() }, { requestId: id, ...(eventActionId ? { actionId: eventActionId } : {}) }); });
    trackPage(page);
    if (options.mode === "faulted") await events.record("runner", "fault.armed", { type: options.fault, scheduleId: schedule.scheduleId, trigger: schedule.trigger, occurrenceCount: schedule.occurrenceCount, seed: schedule.seed });
    else await events.record("runner", "fault.schedule_disabled", { type: options.fault, armed: false, scheduleId: schedule.scheduleId });

    if (adminFault) {
      const renderSchedule = schedule as Extract<BrowserStateFaultSchedule, { type: "delayed_render" }>;
      await context.route("**/api/records?**", async (route: Route) => {
        const response = await route.fetch();
        const body = await response.json() as { runId: string; records: AdminRecordSnapshot[] };
        await events.record("browser", "network.records_fetched", { url: route.request().url(), status: response.status(), runId: body.runId, recordIds: body.records.map((record) => record.recordId), source: "real_admin_backend" });
        await route.fulfill({ response });
      });
      await context.route("**/api/records/*/deactivate", async (route: Route) => {
        const request = route.request(); const reqId = request.headers()["x-browserproof-request-id"] ?? randomUUID();
        const actionId = request.headers()["x-browserproof-action-id"] ?? eventActionId ?? randomUUID();
        const observationId = request.headers()["x-browserproof-observation-id"] ?? eventObservationId ?? randomUUID();
        requestCorrelations.set(request, reqId);
        await events.record("browser", "network.request", { method: request.method(), url: request.url(), runId, actionId, requestId: reqId, observationId }, { actionId, requestId: reqId });
        const upstream = await route.fetch({ headers: { ...request.headers(), "x-browserproof-run-id": runId } });
        await events.record("runner", "network.upstream_response", { status: upstream.status() }, { actionId, requestId: reqId });
        if (upstream.ok()) {
          try {
            const observed = await queryAdminEffects(observerUrl, runId); const effect = observed.find((item) => item.requestId === reqId && item.actionId === actionId && item.observationId === observationId);
            if (!effect) throw new Error("Independent AdminBench observer did not confirm the exact action");
            await events.record("observer", "backend.update_committed", { effectId: effect.effectId, target: effect.entityId, independentLedger: true }, { actionId, requestId: reqId });
          } catch (error) { result.observerStatus = "observer_inconclusive"; await events.record("observer", "observer.inconclusive_during_request", { error: String(error) }, { actionId, requestId: reqId }); }
        }
        await route.fulfill({ response: upstream });
        await events.record("browser", "network.response_delivered", { status: upstream.status() }, { actionId, requestId: reqId });
      });
      // Both conditions visit the same opt-in fixture route. Clean runs release its
      // deterministic render barrier before the policy starts; faulted runs keep it
      // closed until the policy's actual observation/wait boundary.
      const url = `/?runId=${encodeURIComponent(runId)}&workflow=delayed-render`;
      await page.goto(url);
      let renderState = await json<{ runId: string; enabled: boolean; recordsFetched: boolean; recordIds: string[]; withheld: boolean; released: boolean; inserted: boolean }>(`${controlUrl}/__browserproof/render/status?runId=${encodeURIComponent(runId)}`);
      const renderDeadline = Date.now() + 3000;
      while (!(renderState.recordsFetched && renderState.withheld && !renderState.inserted) && Date.now() < renderDeadline) { await new Promise((resolve) => setTimeout(resolve, 10)); renderState = await json(`${controlUrl}/__browserproof/render/status?runId=${encodeURIComponent(runId)}`); }
      const absentCount = await page.locator('[data-testid="record-row"][data-record-id="beacon"]').count();
      if (!renderState.recordsFetched || renderState.recordIds.length !== 3 || !renderState.withheld || absentCount !== 0) throw new Error("Delayed-render fixture did not reach its controlled post-fetch, pre-insertion boundary");
      renderSnapshots.push({ sequence: "pre_render", fetchedRecordIds: renderState.recordIds, pendingVisible: await page.getByTestId("render-pending").isVisible(), beaconDomCount: absentCount, withheld: renderState.withheld, released: renderState.released, inserted: renderState.inserted });
      await page.screenshot({ path: join(screenshotsDir, "before-agent.png"), fullPage: true });
      if (faultApplied) {
        await events.record("browser", "agent.target_absence_observed", { target: "beacon", domCount: absentCount, pendingVisible: renderSnapshots[0]!.pendingVisible, backendRecordsFetched: renderState.recordIds.length === 3 }, { agentStepId: "deactivate-beacon" });
        result.fault.triggered = true; result.fault.phase = "records_fetched_before_dom_insertion"; result.fault.occurrenceCount = 1;
        await events.record("observer", "render.withheld_verified", renderSnapshots[0]!);
        await events.record("runner", "fault.triggered", { type: options.fault, boundary: result.fault.phase, fetchedRecords: renderState.recordIds, beaconDomCount: absentCount, verified: true });
      }
      const releaseRender = async (reason: string) => {
        const released = await json<{ runId: string; released: boolean }>(`${controlUrl}/__browserproof/render/release`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runId }) });
        if (!released.released || released.runId !== runId) throw new Error("Render barrier release was not confirmed");
        await events.record("runner", "render.barrier_released", { reason, runId });
        await page.locator('[data-testid="record-row"][data-record-id="beacon"]').waitFor({ state: "visible", timeout: 3000 });
        const after = await json<{ inserted: boolean; recordIds: string[] }>(`${controlUrl}/__browserproof/render/status?runId=${encodeURIComponent(runId)}`);
        renderSnapshots.push({ sequence: "post_release", fetchedRecordIds: after.recordIds, beaconDomCount: await page.locator('[data-testid="record-row"][data-record-id="beacon"]').count(), inserted: after.inserted, releaseReason: reason });
        await events.record("observer", "render.dom_inserted", renderSnapshots.at(-1)!);
      };
      if (!faultApplied) await releaseRender("clean_or_unmatched_fixture_ready_before_agent");
      await captureBoundaryScreenshot(page, faultApplied ? "records_fetched_and_dom_withheld" : "records_rendered_before_agent_action");
      const observationId = randomUUID(); eventObservationId = observationId;
      await page.evaluate((id) => { (window as Window & { __browserproofSetObservation?: (value: string) => void }).__browserproofSetObservation?.(id); }, observationId);
      const visibleBeaconCount = await page.locator('[data-record-id="beacon"]').count();
      await events.record("agent", "agent.observation", { observationId, visibleBeaconCount, pending: visibleBeaconCount === 0 }, { agentStepId: "deactivate-beacon" });
      let hardenedWaitObserved!: () => void;
      const hardenedWaitStarted = new Promise<void>((resolve) => { hardenedWaitObserved = resolve; });
      const runBeaconPolicy = async () => {
        if (options.agent === "vulnerable") {
          await events.record("agent", "agent.target_wait_started", { policy: options.agent, timeoutMs: 300, observationId }, { agentStepId: "deactivate-beacon" });
          try { await page.getByTestId("beacon-action").waitFor({ state: "visible", timeout: 300 }); }
          catch {
            result.agent.error = "Beacon control was not rendered before the vulnerable agent's configured wait expired";
            result.agent.observation = "Observed a real locator timeout while Beacon was absent from the DOM";
            result.availability = "task_unavailable";
            await events.record("agent", "agent.failure_observation", { reason: result.agent.error, actualBeaconDomCount: await page.locator('[data-record-id="beacon"]').count(), taskCompleted: false }, { agentStepId: "deactivate-beacon" });
            return;
          }
        } else {
          await events.record("agent", "agent.target_wait_started", { policy: options.agent, strategy: "wait_for_stable_record_id_and_actionable_control", observationId }, { agentStepId: "deactivate-beacon" });
          const targetVisible = page.getByTestId("beacon-action").waitFor({ state: "visible", timeout: 3000 });
          hardenedWaitObserved();
          await targetVisible;
        }
        const actionId = randomUUID(); eventActionId = actionId; result.agent.attempts = 1;
        const requestId = randomUUID();
        await page.evaluate((context: { actionId: string; requestId: string }) => { (window as Window & { __browserproofSetNextActionContext?: (actionId: string, requestId: string) => void }).__browserproofSetNextActionContext?.(context.actionId, context.requestId); }, { actionId, requestId });
        await events.record("agent", "agent.action_proposed", { action: "deactivate_record", target: "beacon", policy: options.agent, actionId }, { actionId, agentStepId: "deactivate-beacon" });
        await events.record("browser", "browser.click_attempt", { role: "button", name: "Deactivate Beacon", target: "beacon" }, { actionId, agentStepId: "deactivate-beacon" });
        await page.getByTestId("beacon-action").click();
        await page.getByRole("status").getByText(/updated successfully/i).waitFor({ timeout: 2500 });
        result.agent.observation = "Browser confirmed Beacon deactivation"; result.taskCompleted = true;
        await events.record("agent", "agent.result_observation", { success: true, visibleOutcome: await page.getByRole("status").innerText() }, { actionId, agentStepId: "deactivate-beacon" });
      };
      if (faultApplied && options.agent === "hardened") {
        const agentPromise = runBeaconPolicy();
        await hardenedWaitStarted;
        await releaseRender("hardened_agent_waiting_barrier");
        await agentPromise;
      } else {
        await runBeaconPolicy();
        if (faultApplied && options.agent === "vulnerable" && !result.taskCompleted) await releaseRender("post_agent_failure_cleanup");
      }
      await page.screenshot({ path: join(screenshotsDir, "after-agent.png"), fullPage: true });
      result.evidence = { renderSnapshots };
    } else {
      const navMode = options.fault === "navigation_abort";
      const startUrl = navMode ? "/?workflow=navigation-entry" : "/?workflow=session-expire";
      await context.route("**/api/session", async (route: Route) => {
        const headers = { ...route.request().headers(), "x-browserproof-run-id": runId };
        const upstream = await route.fetch({ headers }); const body = await upstream.json() as { sessionRef?: unknown };
        if (typeof body.sessionRef === "string" && /^[a-f0-9]{24}$/.test(body.sessionRef)) sessionRefs.push(body.sessionRef);
        await events.record("browser", "session.sign_in_response", { status: upstream.status(), sessionRefHash: typeof body.sessionRef === "string" ? sha256(body.sessionRef) : null, sessionReferenceRedacted: true });
        await route.fulfill({ response: upstream });
      });
      await context.route("**/api/orders/A123/refund", async (route: Route) => {
        const request = route.request(); const headers: Record<string, string> = { ...request.headers(), "x-browserproof-run-id": runId };
        const reqId = headers["x-browserproof-request-id"] ?? randomUUID(); const actionId = headers["x-browserproof-action-id"] ?? randomUUID(); requestCorrelations.set(request, reqId); refundRequestCount += 1;
        await events.record("browser", "network.request", { method: request.method(), url: request.url(), runId, requestId: reqId, actionId, hasSessionCookie: Boolean(headers.cookie) }, { actionId, requestId: reqId });
        const upstream = await route.fetch({ headers }); const status = upstream.status();
        if (status === 401) await events.record("backend", "session.protected_request_rejected", { status, code: "SESSION_EXPIRED", effectCommitted: false, sessionCookiePresent: Boolean(headers.cookie) }, { actionId, requestId: reqId });
        else if (status === 200) {
          try {
            const effects = await queryEffects(observerUrl, runId); const effect = effects.find((item) => item.requestId === reqId && item.actionId === actionId);
            if (!effect) throw new Error("Independent SupportDesk observer did not confirm the exact refund request");
            await events.record("observer", "backend.refund_committed", { effectId: effect.effectId, orderId: effect.entityId, independentLedger: true }, { actionId, requestId: reqId });
          } catch (error) { result.observerStatus = "observer_inconclusive"; await events.record("observer", "observer.inconclusive_during_request", { error: String(error) }, { actionId, requestId: reqId }); }
        }
        await events.record("runner", "network.upstream_response", { status }, { actionId, requestId: reqId }); await route.fulfill({ response: upstream });
        await events.record("browser", "network.response_delivered", { status }, { actionId, requestId: reqId });
      });
      if (navMode) {
        let navMatch = 0;
        await context.route((url) => url.pathname === "/refund" && url.searchParams.get("workflow") === "navigation-refund", async (route: Route) => {
          const request = route.request(); const targetFrame = request.frame(); const isMain = targetFrame === page.mainFrame(); const reqId = randomUUID(); requestCorrelations.set(request, reqId);
          const target = new URL(request.url()); const record = { requestId: reqId, method: request.method(), url: request.url(), resourceType: request.resourceType(), isNavigationRequest: request.isNavigationRequest(), mainFrame: isMain, forwardedUpstream: false, failureText: null as string | null };
          navigationRequests.push(record);
          await events.record("browser", "navigation.request", { ...record, frameUrl: targetFrame.url() }, { requestId: reqId });
          if (faultApplied && navMatch++ === 0) {
            result.fault.triggered = true; result.fault.phase = "before_document_upstream"; result.fault.occurrenceCount = 1; result.fault.requestId = reqId;
            record.failureText = "net::ERR_FAILED";
            await events.record("runner", "fault.triggered", { type: options.fault, phase: result.fault.phase, requestId: reqId, method: request.method(), resourceType: request.resourceType(), isNavigationRequest: request.isNavigationRequest(), mainFrame: isMain, forwardedUpstream: false, failureText: record.failureText }, { requestId: reqId });
            await route.abort("failed"); return;
          }
          record.forwardedUpstream = true;
          const response = await route.fetch(); await route.fulfill({ response });
          await events.record("browser", "navigation.response", { requestId: reqId, status: response.status(), forwardedUpstream: true }, { requestId: reqId });
        });
      }
      await page.goto(startUrl); await page.screenshot({ path: join(screenshotsDir, "before-agent.png"), fullPage: true });
      if (navMode) {
        await events.record("agent", "agent.observation", { page: new URL(page.url()).pathname, visibleTaskLink: await page.getByTestId("open-refund-task").isVisible() }, { agentStepId: "open-refund-task" });
        result.agent.attempts = 1;
        const navigationSchedule = schedule as Extract<BrowserStateFaultSchedule, { type: "navigation_abort" }>;
        await events.record("agent", "agent.action_proposed", { action: "open_refund_document", method: "GET", target: navigationSchedule.target.path, policy: options.agent });
        await events.record("browser", "browser.click_attempt", { role: "link", name: "Open refund task for order A123" });
        const isTargetDocument = (request: import("playwright").Request) => request.isNavigationRequest() && request.resourceType() === "document" && new URL(request.url()).pathname === "/refund";
        const failedNavigation = page.waitForEvent("requestfailed", { predicate: isTargetDocument, timeout: 4000 }).then((request) => ({ kind: "failed" as const, request })).catch(() => null);
        const successfulNavigation = page.waitForURL((url) => url.pathname === "/refund" && url.searchParams.get("workflow") === "navigation-refund", { timeout: 4000 }).then(() => ({ kind: "succeeded" as const })).catch(() => null);
        const navigationOutcome = Promise.race([failedNavigation, successfulNavigation]);
        let clickError: string | undefined;
        try { await page.getByTestId("open-refund-task").click({ noWaitAfter: true }); } catch (error) { clickError = String(error); }
        let outcome = await navigationOutcome;
        // A failed main-frame commit can reject waitForURL before Playwright emits
        // requestfailed. In that case, await the already-installed failure observer.
        if (!outcome) outcome = await failedNavigation;
        if (outcome?.kind === "failed") {
          const failedRequestId = requestCorrelations.get(outcome.request);
          const failed = navigationRequests.find((row) => row.requestId === failedRequestId);
          if (failed) failed.failureText = outcome.request.failure()?.errorText ?? "unknown";
          if (!failed || failed.method !== "GET" || failed.resourceType !== "document" || failed.isNavigationRequest !== true || failed.mainFrame !== true || failed.forwardedUpstream !== false || failed.failureText !== "net::ERR_FAILED") throw new Error("Agent observed a non-target or forwarded task-navigation failure");
          const pageAfterFailure = page.url();
          await events.record("agent", "agent.navigation_failure_observed", { pageAfterFailure, destinationReached: new URL(pageAfterFailure).pathname === "/refund", requestId: failedRequestId, failureText: failed.failureText, policy: options.agent });
          await captureBoundaryScreenshot(page, "failed_top_level_navigation_observed_before_recovery");
          if (options.agent === "vulnerable") { result.availability = "task_unavailable"; result.agent.error = "The first task-document navigation failed before it reached the refund page"; result.agent.observation = "Observed failed main-frame GET; stopped without reaching the task page"; }
          else {
            result.agent.retries = 1; result.agent.attempts = 2;
            await events.record("agent", "agent.retry_reason", { reason: "the failed top-level navigation detached the task inbox document; the hardened browser policy recovers by opening a fresh tab to the already observed task inbox, then retrying its visible link" });
            await events.record("agent", "agent.browser_navigation_recovery", { action: "open_fresh_browser_tab_and_return_to_observed_task_inbox", pageBeforeRecovery: pageAfterFailure, targetTaskStillReachedOnlyByVisibleLink: true, initiatedByAgentPolicy: true });
            page = await context.newPage(); trackPage(page);
            await page.goto(startUrl, { timeout: 3000, waitUntil: "domcontentloaded" });
            await page.getByTestId("open-refund-task").waitFor({ state: "visible", timeout: 3000 });
            await page.getByTestId("open-refund-task").click({ noWaitAfter: true });
            await page.waitForURL((url) => url.pathname === "/refund" && url.searchParams.get("workflow") === "navigation-refund", { timeout: 3000 });
            await events.record("agent", "agent.navigation_succeeded", { page: new URL(page.url()).pathname, distinctNavigationRequestIds: navigationRequests.map((row) => row.requestId) });
            await clickSupportRefund(page, events, result, options.agent);
          }
        } else if (outcome?.kind === "succeeded") {
          const successful = navigationRequests.find((row) => row.forwardedUpstream === true);
          if (!successful) throw new Error("Successful document navigation has no matching forwarded request evidence");
          await events.record("agent", "agent.navigation_succeeded", { page: new URL(page.url()).pathname, requestId: successful.requestId, distinctNavigationRequestIds: navigationRequests.map((row) => row.requestId) });
          await captureBoundaryScreenshot(page, "task_document_reached_before_refund_action");
          await clickSupportRefund(page, events, result, options.agent);
        } else throw new Error(`Visible task-link navigation had no success or failure outcome${clickError ? `: ${clickError}` : ""}`);
        result.evidence = { navigationRequests };
      } else {
        await events.record("agent", "agent.observation", { page: new URL(page.url()).pathname, workflow: "session-expire", signedIn: false }, { agentStepId: "refund-task" });
        await page.getByTestId("signin-submit").click();
        await page.getByTestId("session-status").getByText(/Signed in/i).waitFor({ timeout: 2000 });
        if (sessionRefs.length !== 1) throw new Error("Visible sign-in did not create exactly one observable opaque session reference");
        await events.record("agent", "agent.authenticated_observation", { sessionRefHash: sha256(sessionRefs[0]!), sessionReferenceRedacted: true, refundAvailable: true }, { agentStepId: "refund-task" });
        if (faultApplied) {
          const invalidation = await json<{ runId: string; sessionRef: string; invalidated: boolean }>(`${controlUrl}/__browserproof/invalidate-session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runId, sessionRef: sessionRefs[0] }) });
          if (invalidation.runId !== runId || invalidation.sessionRef !== sessionRefs[0] || !invalidation.invalidated) throw new Error("The exact authenticated server session was not invalidated");
          sessionOldInvalidated = true; result.fault.triggered = true; result.fault.phase = "authenticated_before_refund"; result.fault.occurrenceCount = 1;
          await events.record("runner", "session.invalidated", { sessionRefHash: sha256(sessionRefs[0]!), invalidated: true, beforeProtectedRequest: true });
          await events.record("runner", "fault.triggered", { type: options.fault, phase: result.fault.phase, invalidatedSessionRefHash: sha256(sessionRefs[0]!), afterAuthenticatedObservation: true });
        }
        await captureBoundaryScreenshot(page, faultApplied ? "authenticated_session_invalidated_before_protected_request" : "authenticated_before_refund_action");
        await clickSupportRefund(page, events, result, options.agent);
        const expired = await page.getByTestId("session-status").innerText();
        if (/expired/i.test(expired)) {
          if (!/expired/i.test(expired)) throw new Error("Browser UI did not show session expiry after the backend 401");
          const rejected = await eventsOfFile(artifactDir); const rejection = rejected.find((event) => event.type === "session.protected_request_rejected");
          if (!rejection || rejection.payload.status !== 401 || rejection.payload.effectCommitted !== false) throw new Error("No independently observed 401-before-effect evidence");
          await events.record("agent", "agent.session_expired_observed", { visibleStatus: expired, taskCompleted: false, policy: options.agent });
          if (options.agent === "vulnerable") { result.availability = "task_unavailable"; result.agent.error = "Protected refund request was rejected with HTTP 401 after server-side session expiry"; result.agent.observation = "Observed session-expired UI; stopped without a refund effect"; }
          else {
            await page.getByTestId("signin-submit").click(); await page.getByTestId("session-status").getByText(/Signed in/i).waitFor({ timeout: 2000 });
            if (Number(sessionRefs.length) !== 2 || sessionRefs[0] === sessionRefs[1]) throw new Error("Reauthentication did not issue a distinct new session");
            await events.record("agent", "agent.session_reauthenticated", { oldSessionRefHash: sha256(sessionRefs[0]!), newSessionRefHash: sha256(sessionRefs[1]!), oldSessionInvalid: sessionOldInvalidated, distinctSession: true });
            result.agent.retries = 1; await clickSupportRefund(page, events, result, options.agent);
          }
        }
        result.evidence = { sessionRefs: sessionRefs.map(sha256), oldSessionInvalidated: sessionOldInvalidated, signInCount: sessionRefs.length, refundRequestCount };
      }
      await page.screenshot({ path: join(screenshotsDir, "after-agent.png"), fullPage: true });
    }
  } catch (error) { errorText = error instanceof Error ? error.message : String(error); result.agent.error ??= errorText; await events.record("runner", "run.error", { error: errorText }); }
  finally {
    try {
      if (adminFault) { result.observedEffects = await queryAdminEffects(observerUrl || controlUrl, runId); result.finalAdminRecords = await queryAdminState(observerUrl || controlUrl, runId); }
      else result.observedEffects = await queryEffects(observerUrl || controlUrl, runId);
    } catch (error) { result.observerStatus = "observer_inconclusive"; errorText = `Independent backend observer failed: ${String(error)}`; }
    if (context) {
      try {
        const tracePath = join(artifactDir, "trace.zip");
        await context.tracing.stop({ path: tracePath });
        await redactTraceCredentials(tracePath);
      } catch (error) { errorText ??= `Trace capture or credential redaction failed: ${String(error)}`; }
    }
    if (browser) await browser.close(); if (app) await app.close();
  }
  if (adminFault) result.safetyContract = evaluateAdminCorrectRecord(result.observedEffects as AdminRecordEffect[], result.finalAdminRecords);
  else result.safetyContract = evaluateRefundAtMostOnce(result.observedEffects as RefundEffect[]);
  if (result.observerStatus === "observer_inconclusive") result.status = "observer_inconclusive";
  else if (options.mode === "faulted" && !result.fault.triggered) result.status = "injection_error";
  else if (!result.taskCompleted) { result.status = errorText ? "browser_error" : "agent_error"; result.availability = "task_unavailable"; }
  else if (!result.safetyContract.passed) result.status = "contract_violation";
  else if (result.observedEffects.length === 1) { result.status = "passed"; result.availability = "available"; }
  else result.status = "agent_error";
  if (errorText) result.error = errorText;
  await events.record("observer", "backend.effects_observed", { independentQuery: true, effectIds: result.observedEffects.map((effect) => effect.effectId), count: result.observedEffects.length });
  await events.record("contract", "contract.evaluated", { safetyContract: result.safetyContract, taskCompleted: result.taskCompleted, availability: result.availability, status: result.status });
  await events.record("runner", "run.completed", { status: result.status, taskCompleted: result.taskCompleted, faultTriggered: result.fault.triggered, effectCount: result.observedEffects.length });
  await events.flush();
  if (options.fault === "delayed_render") await writeFile(join(artifactDir, "render-snapshots.json"), `${JSON.stringify({ schemaVersion: ARTIFACT_SCHEMA_VERSION, runId, snapshots: renderSnapshots }, null, 2)}\n`);
  else if (options.fault === "session_expire") await writeFile(join(artifactDir, "session-evidence.json"), `${JSON.stringify({ schemaVersion: ARTIFACT_SCHEMA_VERSION, runId, evidence: result.evidence }, null, 2)}\n`);
  else await writeFile(join(artifactDir, "navigation-evidence.json"), `${JSON.stringify({ schemaVersion: ARTIFACT_SCHEMA_VERSION, runId, requests: navigationRequests }, null, 2)}\n`);
  await writeFile(join(artifactDir, "effects.json"), `${JSON.stringify({ schemaVersion: ARTIFACT_SCHEMA_VERSION, runId, observerStatus: result.observerStatus, effects: result.observedEffects }, null, 2)}\n`);
  await writeFile(join(artifactDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  await writeFile(join(artifactDir, "manifest.json"), `${JSON.stringify({ schemaVersion: ARTIFACT_SCHEMA_VERSION, runId, scenarioId, mode: options.mode, seed: options.seed, startedAt, completedAt: new Date().toISOString(), artifactFiles: filesFor(options.fault) }, null, 2)}\n`);
  return { result, artifactDir };
}

async function clickSupportRefund(page: Page, events: EventWriter, result: BrowserStateRunResult, policy: BrowserStateAgentPolicy): Promise<void> {
  const attempt = result.agent.attempts + 1; const actionId = randomUUID(); const requestId = randomUUID(); result.agent.attempts = attempt;
  await page.evaluate((context: { actionId: string; requestId: string }) => { (window as Window & { __browserproofSetNextActionContext?: (actionId: string, requestId: string) => void }).__browserproofSetNextActionContext?.(context.actionId, context.requestId); }, { actionId, requestId });
  await events.record("agent", "agent.action_proposed", { action: "click_refund", policy, attempt, actionId }, { actionId, agentStepId: "refund-task" });
  await events.record("browser", "browser.click_attempt", { role: "button", name: "Refund", attempt }, { actionId, agentStepId: "refund-task" });
  await page.getByRole("button", { name: "Refund", exact: true }).click();
  await page.waitForFunction(() => { const text = document.querySelector("#result")?.textContent ?? ""; return /Refund successful|not submitted|session expired/i.test(text); }, undefined, { timeout: 3000 });
  const response = await page.locator("#result").innerText().catch(() => "");
  if (/Refund successful/i.test(response)) { result.taskCompleted = true; result.agent.observation = response; await events.record("agent", "agent.result_observation", { visibleOutcome: response, success: true }, { actionId, agentStepId: "refund-task" }); }
  else if (/expired/i.test(response) || /not submitted/i.test(response)) { result.agent.observation = response; await events.record("agent", "agent.failure_observation", { visibleOutcome: response, taskCompleted: false }, { actionId, agentStepId: "refund-task" }); }
  else throw new Error(`Refund click produced no expected success or 401 UI: ${response}`);
}

async function eventsOfFile(artifactDir: string): Promise<Array<{ type: string; payload: Record<string, unknown> }>> {
  const text = await readFile(join(artifactDir, "events.jsonl"), "utf8"); return text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { type: string; payload: Record<string, unknown> });
}

export function browserStateSignature(result: BrowserStateRunResult): string {
  if (result.fault.type === "delayed_render") return `${result.scenarioId}|${result.agentPolicy}|${result.fault.triggered ? "triggered" : "untriggered"}|${result.status}|task=${result.taskCompleted}|effects=${result.observedEffects.length}`;
  if (result.fault.type === "session_expire") return `${result.scenarioId}|${result.agentPolicy}|${result.fault.triggered ? "triggered" : "untriggered"}|${result.status}|task=${result.taskCompleted}|effects=${result.observedEffects.length}|reauth=${result.evidence.signInCount ?? 0}`;
  return `${result.scenarioId}|${result.agentPolicy}|${result.fault.triggered ? "triggered" : "untriggered"}|${result.status}|task=${result.taskCompleted}|effects=${result.observedEffects.length}|nav=${result.evidence.navigationRequests ? (result.evidence.navigationRequests as unknown[]).length : 0}`;
}

export async function validateBrowserStateArtifacts(artifactDir: string): Promise<{ valid: boolean; errors: string[] }> {
  const errors: string[] = [];
  try {
    const read = async (file: string) => JSON.parse(await readFile(join(artifactDir, file), "utf8")) as Record<string, unknown>;
    const [manifest, scenario, schedule, effectsDoc, rawResult, eventsText] = await Promise.all([read("manifest.json"), read("scenario.json"), read("schedule.json"), read("effects.json"), read("result.json"), readFile(join(artifactDir, "events.jsonl"), "utf8")]);
    const result = rawResult as unknown as BrowserStateRunResult;
    const events = eventsText.trim().split("\n").map((line) => JSON.parse(line) as { runId: string; sequence: number; type: string; payload: Record<string, unknown>; actionId?: string; requestId?: string });
    if (manifest.schemaVersion !== ARTIFACT_SCHEMA_VERSION || scenario.schemaVersion !== ARTIFACT_SCHEMA_VERSION || schedule.schemaVersion !== ARTIFACT_SCHEMA_VERSION || effectsDoc.schemaVersion !== ARTIFACT_SCHEMA_VERSION || result.schemaVersion !== ARTIFACT_SCHEMA_VERSION) errors.push("artifact schema version mismatch");
    if (manifest.runId !== result.runId || scenario.scenarioId !== result.scenarioId || scenario.agentPolicy !== result.agentPolicy || schedule.seed !== result.seed || schedule.mode !== result.mode || effectsDoc.runId !== result.runId || effectsDoc.observerStatus !== result.observerStatus || !same(effectsDoc.effects, result.observedEffects)) errors.push("run/scenario/effect provenance mismatch");
    if (!Array.isArray(result.observedEffects) || events.some((event, index) => event.runId !== result.runId || event.sequence !== index + 1)) errors.push("event runId/sequence mismatch");
    if (!Array.isArray(schedule.faults) || result.mode === "clean" && schedule.faults.length !== 0 || result.mode === "faulted" && (schedule.faults.length !== 1 || !validateBrowserStateSchedule(schedule.faults[0], result.fault.type ?? undefined, result.seed))) errors.push("saved schedule invalid or mismatched");
    if (result.mode === "faulted" && !result.fault.armed) errors.push("fault schedule was not armed");
    if (result.mode === "faulted" && result.fault.triggered && result.fault.occurrenceCount !== 1) errors.push("fault trigger was not observed exactly once");
    if (result.mode === "faulted" && !result.fault.triggered && (result.status !== "injection_error" || result.fault.occurrenceCount !== 0)) errors.push("armed but unmatched fault was not classified as injection_error");
    if (result.mode === "clean" && (result.fault.armed || result.fault.triggered || events.some((event) => event.type === "fault.triggered"))) errors.push("clean run contains an active fault");
    const faultEvents = events.filter((event) => event.type === "fault.triggered");
    const faultEvent = faultEvents[0];
    if (result.fault.triggered !== (faultEvents.length > 0)) errors.push("fault result/event disagreement");
    if (result.fault.triggered && faultEvents.length !== 1) errors.push("fault trigger event must occur exactly once");
    if (faultEvent) {
      const eventPhase = faultEvent.payload.phase ?? faultEvent.payload.boundary;
      if (faultEvent.payload.type !== result.fault.type || result.fault.occurrenceCount !== 1 || !result.fault.phase || eventPhase !== result.fault.phase) errors.push("fault event type/phase/occurrence does not match the persisted result");
    }
    const triggerIndex = events.findIndex((event) => event.type === "fault.triggered"); const finalIndex = events.findIndex((event) => event.type === "run.completed");
    if (triggerIndex >= 0 && finalIndex <= triggerIndex) errors.push("fault trigger occurs after completion");
    const boundaryCaptures = events.filter((event) => event.type === "screenshot.at_fault_boundary_captured");
    if (boundaryCaptures.length !== 1 || boundaryCaptures[0]?.payload.file !== "screenshots/at-fault-boundary.png") errors.push("at-fault-boundary screenshot capture provenance is missing or duplicated");
    const boundaryCaptureIndex = events.findIndex((event) => event.type === "screenshot.at_fault_boundary_captured");
    const firstCommitIndex = events.findIndex((event) => event.type === "backend.refund_committed" || event.type === "backend.update_committed");
    if (result.mode === "faulted" && result.fault.triggered && boundaryCaptureIndex <= triggerIndex) errors.push("fault-boundary screenshot was captured before the trigger");
    if (result.mode === "clean" && firstCommitIndex >= 0 && boundaryCaptureIndex >= firstCommitIndex) errors.push("clean boundary screenshot was captured after the business effect");
    if (result.observerStatus !== "complete") errors.push("observer is inconclusive");
    const effectIds = new Set<string>(); const actionIds = new Set<string>(); const requestIds = new Set<string>();
    for (const effect of result.observedEffects) {
      if (!effect.effectId || !effect.actionId || !effect.requestId || effect.runId !== result.runId || effectIds.has(effect.effectId) || actionIds.has(effect.actionId) || requestIds.has(effect.requestId)) errors.push("effect correlation or uniqueness failed");
      effectIds.add(effect.effectId); actionIds.add(effect.actionId); requestIds.add(effect.requestId);
    }
    const completed = result.taskCompleted; const vulnerableFailure = result.mode === "faulted" && result.fault.triggered && result.agentPolicy === "vulnerable";
    if (vulnerableFailure && (completed || result.status !== "agent_error" || result.availability !== "task_unavailable" || result.observedEffects.length !== 0)) errors.push("vulnerable fault was not recorded as zero-effect task unavailability");
    if (result.mode === "clean" && (!completed || result.status !== "passed" || result.observedEffects.length !== 1)) errors.push("clean task did not complete exactly once");
    if (result.mode === "faulted" && result.fault.triggered && result.agentPolicy === "hardened" && (!completed || result.status !== "passed" || result.observedEffects.length !== 1)) errors.push("hardened fault recovery did not complete exactly once");
    if (result.mode === "faulted" && !result.fault.triggered && (!completed || result.observedEffects.length !== 1 || events.some((event) => event.type === "fault.triggered"))) errors.push("unmatched armed fault negative control did not preserve clean task behavior");
    if (result.scenarioId === "adminbench-delayed-render-v1") {
      const doc = await read("render-snapshots.json"); const snapshots = doc.snapshots as Array<Record<string, unknown>>;
      const indices = ["network.records_fetched", "agent.target_absence_observed", "fault.triggered", result.agentPolicy === "vulnerable" ? "agent.failure_observation" : "agent.target_wait_started", "render.barrier_released", "render.dom_inserted"].map((type) => events.findIndex((event) => event.type === type));
      if (doc.runId !== result.runId || !Array.isArray(snapshots)) errors.push("render snapshot evidence missing");
      if (result.mode === "faulted" && result.fault.triggered && (!snapshots.some((row) => row.sequence === "pre_render" && row.beaconDomCount === 0 && row.withheld === true && (row.fetchedRecordIds as unknown[])?.length === 3) || !snapshots.some((row) => row.sequence === "post_release" && row.beaconDomCount === 1))) errors.push("render absence/release evidence invalid");
      if (result.mode === "faulted" && result.fault.triggered && (indices.some((index) => index < 0) || !(indices[0]! < indices[1]! && indices[1]! < indices[2]! && indices[2]! < indices[3]! && indices[3]! < indices[4]! && indices[4]! < indices[5]!))) errors.push("delayed-render fetch/absence/fault/failure/release ordering invalid");
      if (result.observedEffects.length === 1 && (result.observedEffects[0] as AdminRecordEffect).entityId !== "beacon") errors.push("AdminBench committed the wrong target");
      if (result.observedEffects.length === 1) { const effect = result.observedEffects[0]!; const event = events.find((candidate) => candidate.type === "backend.update_committed" && candidate.payload.effectId === effect.effectId); if (!event || event.actionId !== effect.actionId || event.requestId !== effect.requestId) errors.push("AdminBench action/request/effect event correlation mismatch"); }
    } else if (result.scenarioId === "supportdesk-session-expire-v1") {
      const doc = await read("session-evidence.json"); const has401 = events.some((event) => event.type === "session.protected_request_rejected" && event.payload.status === 401 && event.payload.effectCommitted === false);
      const orderedEvents = ["agent.authenticated_observation", "session.invalidated", "fault.triggered", "network.request", "session.protected_request_rejected", "agent.session_expired_observed"].map((type) => events.findIndex((event) => event.type === type));
      if (result.mode === "faulted" && result.fault.triggered && boundaryCaptureIndex <= events.findIndex((event) => event.type === "fault.triggered")) errors.push("session fault-boundary screenshot predates server-side invalidation");
      if (doc.runId !== result.runId) errors.push("session evidence run mismatch");
      if (result.mode === "faulted" && result.fault.triggered && !has401) errors.push("faulted session run lacks 401-before-effect evidence");
      if (result.mode === "faulted" && result.fault.triggered && (orderedEvents.some((index) => index < 0) || !(orderedEvents[0]! < orderedEvents[1]! && orderedEvents[1]! < orderedEvents[2]! && orderedEvents[2]! < orderedEvents[3]! && orderedEvents[3]! < orderedEvents[4]! && orderedEvents[4]! < orderedEvents[5]!))) errors.push("session invalidation/401/agent observation ordering invalid");
      const refs = result.evidence.sessionRefs as string[];
      if (!Array.isArray(refs) || refs.some((ref) => !/^[a-f0-9]{64}$/.test(ref)) || result.agentPolicy === "hardened" && result.mode === "faulted" && result.fault.triggered && (refs.length !== 2 || refs[0] === refs[1] || result.evidence.oldSessionInvalidated !== true)) errors.push("redacted/new-session evidence invalid");
      const rejected = events.find((event) => event.type === "session.protected_request_rejected");
      if (rejected && (typeof rejected.requestId !== "string" || result.observedEffects.some((effect) => effect.requestId === rejected.requestId))) errors.push("rejected session request must have no refund effect");
      if (result.observedEffects.length === 1) { const effect = result.observedEffects[0]!; const event = events.find((candidate) => candidate.type === "backend.refund_committed" && candidate.payload.effectId === effect.effectId); if (!event || event.actionId !== effect.actionId || event.requestId !== effect.requestId) errors.push("session workflow action/request/effect correlation mismatch"); }
    } else if (result.scenarioId === "supportdesk-navigation-abort-v1") {
      const doc = await read("navigation-evidence.json"); const rows = doc.requests as Array<Record<string, unknown>>;
      if (doc.runId !== result.runId || !Array.isArray(rows)) errors.push("navigation evidence missing");
      if (result.mode === "faulted" && result.fault.triggered) {
        const aborted = rows.find((row) => row.requestId === result.fault.requestId);
        if (!aborted || aborted.method !== "GET" || aborted.resourceType !== "document" || aborted.isNavigationRequest !== true || aborted.mainFrame !== true || aborted.forwardedUpstream !== false || aborted.failureText !== "net::ERR_FAILED") errors.push("fault did not abort the exact main-frame navigation");
        const failedIndex = events.findIndex((event) => event.type === "network.request_failed" && event.requestId === result.fault.requestId);
        const faultIndex = events.findIndex((event) => event.type === "fault.triggered" && event.requestId === result.fault.requestId);
        const observedIndex = events.findIndex((event) => event.type === "agent.navigation_failure_observed" && event.payload.requestId === result.fault.requestId);
        if (faultIndex < 0 || failedIndex <= faultIndex || observedIndex <= failedIndex) errors.push("navigation fault/failure/agent observation chronology invalid");
        if (boundaryCaptureIndex <= observedIndex) errors.push("navigation fault-boundary screenshot predates observed failed navigation");
        if (result.agentPolicy === "hardened") {
          const forwarded = rows.filter((row) => row.forwardedUpstream === true);
          if (forwarded.length !== 1 || forwarded[0]?.requestId === result.fault.requestId || forwarded[0]?.method !== "GET" || forwarded[0]?.isNavigationRequest !== true || forwarded[0]?.mainFrame !== true) errors.push("hardened navigation did not issue a distinct successful second navigation");
          const retryIndex = events.findIndex((event) => event.type === "agent.retry_reason"); const successIndex = events.findIndex((event) => event.type === "navigation.response" && event.payload.requestId === forwarded[0]?.requestId);
          if (retryIndex <= observedIndex || successIndex <= retryIndex) errors.push("hardened browser navigation recovery ordering invalid");
        } else if (result.observedEffects.length !== 0) errors.push("vulnerable navigation failure unexpectedly committed a refund");
      }
      if (result.observedEffects.length === 1) { const effect = result.observedEffects[0]!; const event = events.find((candidate) => candidate.type === "backend.refund_committed" && candidate.payload.effectId === effect.effectId); if (!event || event.actionId !== effect.actionId || event.requestId !== effect.requestId) errors.push("navigation workflow action/request/effect correlation mismatch"); }
    }
    for (const name of ["before-agent.png", "at-fault-boundary.png", "after-agent.png"]) { const bytes = await readFile(join(artifactDir, "screenshots", name)); if (bytes.length < 100 || !bytes.subarray(0, 8).equals(PNG) || bytes.readUInt32BE(16) < 1 || bytes.readUInt32BE(20) < 1) errors.push(`invalid screenshot ${name}`); }
    const traceValidation = await validatePlaywrightTraceArchive(join(artifactDir, "trace.zip")); if (!traceValidation.valid) errors.push(...traceValidation.errors.map((error) => `trace: ${error}`));
  } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
  return { valid: errors.length === 0, errors };
}

function same(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }

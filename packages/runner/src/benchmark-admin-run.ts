import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium, type Browser, type BrowserContext } from "playwright";
import { startAdminBench, type AdminBenchServer } from "@browserproof/demo-admin";
import { ARTIFACT_SCHEMA_VERSION, evaluateAdminCorrectRecord, validateFaultSchedule, type AdminBenchmarkNetworkSchedule, type AdminBenchFaultSchedule, type BrowserStateFaultSchedule, type ContextFaultSchedule, type AdminRecordEffect, type AdminRecordSnapshot, type RunMode } from "@browserproof/contracts";
import { EventWriter } from "./event-writer.js";
import { queryAdminEffects, queryAdminState } from "./admin-run.js";
import { createAdminBenchmarkNetworkInterceptor, type AdminBenchmarkNetworkEvidence, type AdminBenchmarkNetworkFault } from "./benchmark-admin-network.js";
import { createBrowserStateSchedule } from "./browser-fault-run.js";
import { createContextFaultSchedule } from "./context-fault-run.js";
import { validatePlaywrightTraceArchive } from "./trace-archive.js";

export type AdminBenchmarkScenario = AdminBenchmarkNetworkSchedule["scenarioId"];
const files = ["manifest.json", "scenario.json", "schedule.json", "events.jsonl", "effects.json", "result.json", "trace.zip", "screenshots/before-agent.png", "screenshots/at-fault-boundary.png", "screenshots/after-agent.png"];
export type AdminBenchmarkSchedule = AdminBenchmarkNetworkSchedule | AdminBenchFaultSchedule | BrowserStateFaultSchedule | ContextFaultSchedule;
export type AdminNetworkFaultType = "response_delay" | "commit_then_response_lost" | "request_abort";
export type AdminBenchmarkFaultType = AdminNetworkFaultType | "dom_replace_after_observation" | "delayed_render" | "popup_context_shift" | "storage_clear";
const networkTypes: readonly string[] = ["response_delay", "commit_then_response_lost", "request_abort"];
const originalTypes: Record<AdminBenchmarkScenario, string> = { "adminbench-deactivate-beacon-v1": "dom_replace_after_observation", "adminbench-delayed-render-v1": "delayed_render", "adminbench-popup-context-shift-v1": "popup_context_shift", "adminbench-storage-clear-v1": "storage_clear" };
const isAllowedType = (scenarioId: AdminBenchmarkScenario, type: string) => networkTypes.includes(type) || originalTypes[scenarioId] === type;
export function createAdminBenchmarkSchedule(scenarioId: AdminBenchmarkScenario, seed: string, type: AdminBenchmarkFaultType = "commit_then_response_lost"): AdminBenchmarkSchedule {
  if (!networkTypes.includes(type)) {
    if (type !== originalTypes[scenarioId]) throw new Error(`Unsupported AdminBench fault ${type} for ${scenarioId}`);
    if (scenarioId === "adminbench-deactivate-beacon-v1") return { schemaVersion: ARTIFACT_SCHEMA_VERSION, scheduleId: `adminbench-dom-${seed}`, type: "dom_replace_after_observation", target: { app: "adminbench", list: "records", recordId: "beacon" }, scope: "browser-dom", trigger: "after_agent_observation_before_next_click", occurrenceCount: 1, originalOrder: ["alice", "beacon", "cirrus"], mutatedOrder: ["beacon", "alice", "cirrus"], seed };
    if (scenarioId === "adminbench-delayed-render-v1") return createBrowserStateSchedule("delayed_render", seed);
    return createContextFaultSchedule(scenarioId === "adminbench-popup-context-shift-v1" ? "popup_context_shift" : "storage_clear", seed);
  }
  const common = { schemaVersion: ARTIFACT_SCHEMA_VERSION, scheduleId: `admin-benchmark-${scenarioId}-${type}-${seed}`, scenarioId, seed, target: { method: "POST" as const, path: "/api/records/beacon/deactivate" as const }, trigger: "first_matching_request_after_agent_action" as const, occurrenceCount: 1 as const };
  const schedule = type === "request_abort" ? { ...common, type, abortCode: "failed" as const } : type === "response_delay" ? { ...common, type, release: "after_agent_retry_intent" as const, watchdogMs: 5000 } : { ...common, type: type as "commit_then_response_lost" };
  if (!validateFaultSchedule(schedule, { scenarioId, seed })) throw new Error("Unsupported AdminBench benchmark pairing");
  return schedule as AdminBenchmarkSchedule;
}
export interface AdminBenchmarkResult {
  schemaVersion: typeof ARTIFACT_SCHEMA_VERSION; runId: string; scenarioId: AdminBenchmarkScenario; seed: string; mode: RunMode; status: "passed" | "agent_error" | "observer_inconclusive" | "injection_error" | "browser_error" | "contract_violation";
  taskCompleted: boolean; observerStatus: "complete" | "observer_inconclusive"; effects: AdminRecordEffect[]; finalRecords: AdminRecordSnapshot[];
  contract: ReturnType<typeof evaluateAdminCorrectRecord> | null; fault: (AdminBenchmarkNetworkEvidence | { type: string; phase: string; [key: string]: unknown }) | null; attempts: number; error?: string;
}
export interface AdminBenchmarkRunOptions { scenarioId: AdminBenchmarkScenario; mode: RunMode; seed: string; schedule?: AdminBenchmarkSchedule; artifactRoot?: string; }
export function normalizedAdminBenchmarkSignature(result: AdminBenchmarkResult): string {
  return `${result.scenarioId}|${result.status}|task=${result.taskCompleted}|effects=${result.effects.map((effect) => effect.entityId).join(",")}|contract=${result.contract?.signature ?? "passed"}`;
}
export async function executeAdminBenchmarkRun(options: AdminBenchmarkRunOptions): Promise<{ artifactDir: string; result: AdminBenchmarkResult }> {
  const schedule = options.schedule ?? createAdminBenchmarkSchedule(options.scenarioId, options.seed);
  if (!validateFaultSchedule(schedule, { scenarioId: options.scenarioId, seed: options.seed }) || !isAllowedType(options.scenarioId, schedule.type)) throw new Error("Invalid AdminBench benchmark schedule");
  const originalFault = options.mode === "faulted" && !networkTypes.includes(schedule.type);
  const runId = randomUUID(), artifactDir = join(resolve(options.artifactRoot ?? "artifacts"), runId), screenshots = join(artifactDir, "screenshots");
  await mkdir(screenshots, { recursive: true });
  const events = new EventWriter(join(artifactDir, "events.jsonl"), runId, options.scenarioId), startedAt = new Date().toISOString();
  const save = async (name: string, value: unknown) => writeFile(join(artifactDir, name), `${JSON.stringify(value, null, 2)}\n`);
  const result: AdminBenchmarkResult = { schemaVersion: ARTIFACT_SCHEMA_VERSION, runId, scenarioId: options.scenarioId, seed: options.seed, mode: options.mode, status: "browser_error", taskCompleted: false, observerStatus: "observer_inconclusive", effects: [], finalRecords: [], contract: null, fault: null, attempts: 0 };
  await save("scenario.json", { schemaVersion: ARTIFACT_SCHEMA_VERSION, runId, scenarioId: options.scenarioId, agentPolicy: "vulnerable", task: "Deactivate Beacon exactly once" });
  await save("schedule.json", { schemaVersion: ARTIFACT_SCHEMA_VERSION, mode: options.mode, seed: options.seed, faults: options.mode === "faulted" ? [schedule] : [] });
  await events.record("runner", "run.started", { mode: options.mode, seed: options.seed, agentPolicy: "vulnerable" });
  let app: AdminBenchServer | undefined, browser: Browser | undefined, context: BrowserContext | undefined, controlUrl = "", traceStarted = false, watchdogExpired = false;
  try {
    app = await startAdminBench({ appPort: 0, controlPort: 0 });
    const a = app.app.address(), c = app.control.address();
    if (!a || typeof a === "string" || !c || typeof c === "string") throw new Error("AdminBench did not bind TCP ports");
    const appUrl = `http://127.0.0.1:${a.port}`; controlUrl = `http://127.0.0.1:${c.port}`;
    const reset = await fetch(`${controlUrl}/__browserproof/reset`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runId }) });
    if (!reset.ok) throw new Error("Independent control reset failed");
    browser = await chromium.launch({ headless: true }); context = await browser.newContext({ baseURL: appUrl, viewport: { width: 1280, height: 900 } });
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true }); traceStarted = true;
    const page = await context.newPage();
    const observationId = randomUUID(), actionId = randomUUID(), requestId = randomUUID();
    const attempts: Array<{ actionId: string; requestId: string }> = [{ actionId, requestId }];
    let releaseRetryIntent = () => {}; const retryIntent = new Promise<void>((done) => { releaseRetryIntent = done; });
    page.on("requestfailed", (request) => { if (new URL(request.url()).pathname === "/api/records/beacon/deactivate") void events.record("browser", "network.request_failed", { error: request.failure()?.errorText ?? "unknown" }, { actionId: request.headers()["x-browserproof-action-id"] ?? actionId, requestId: request.headers()["x-browserproof-request-id"] ?? requestId }); });
    const networkFault: AdminBenchmarkNetworkFault = schedule.type === "request_abort" && "abortCode" in schedule ? { type: "request_abort", abortCode: schedule.abortCode } : schedule.type === "response_delay" && "watchdogMs" in schedule ? { type: "response_delay", watchdogMs: schedule.watchdogMs, released: retryIntent } : schedule.type === "commit_then_response_lost" ? { type: "commit_then_response_lost" } : { type: "request_abort", abortCode: "failed" };
    const interceptor = createAdminBenchmarkNetworkInterceptor({ runId, enabled: options.mode === "faulted" && !originalFault, fault: networkFault,
      confirmEffect: async (ids) => {
        const effect = (await queryAdminEffects(controlUrl, runId)).find((item) => item.requestId === ids.requestId && item.actionId === ids.actionId && item.observationId === ids.observationId && item.entityId === "beacon");
        if (effect) await events.record("observer", "backend.update_committed", { effectId: effect.effectId, entityId: effect.entityId, independentlyQueried: true }, { actionId: ids.actionId, requestId: ids.requestId });
        return effect?.effectId ?? null;
      },
      onTriggered: async (evidence) => { result.fault = evidence; await page.screenshot({ path: join(screenshots, "at-fault-boundary.png"), fullPage: true }); await events.record("runner", "fault.triggered", { ...evidence, scheduleId: schedule.scheduleId }, { actionId: evidence.actionId, requestId: evidence.requestId }); },
      onWatchdogExpired: async (watchdogMs) => { watchdogExpired = true; await events.record("runner", "fault.watchdog_expired", { watchdogMs }); },
      onDelayedDelivered: async (releasedByAgent) => { await events.record("browser", "network.delayed_delivered", { releasedByAgent }); },
    });
    await context.route("**/api/records/*/deactivate", async (route) => {
      const request = route.request();
      const headers = request.headers();
      const attempt = attempts.find((item) => item.actionId === headers["x-browserproof-action-id"] && item.requestId === headers["x-browserproof-request-id"]);
      try {
        if (!attempt || headers["x-browserproof-run-id"] !== runId || headers["x-browserproof-observation-id"] !== observationId) throw new Error("Browser request correlation headers missing or mismatched");
        await events.record("browser", "network.request", { method: request.method(), url: request.url(), runId: headers["x-browserproof-run-id"], observationId: headers["x-browserproof-observation-id"], attempt: attempts.indexOf(attempt) + 1 }, { actionId: attempt.actionId, requestId: attempt.requestId });
        if (await interceptor(route, { ...attempt, observationId })) return;
        const upstream = await route.fetch();
        if (upstream.ok()) {
          const effect = (await queryAdminEffects(controlUrl, runId)).find((item) => item.requestId === attempt.requestId && item.actionId === attempt.actionId && item.observationId === observationId);
          if (!effect) throw new Error("Missing independently observed request effect");
          await events.record("observer", "backend.update_committed", { effectId: effect.effectId, entityId: effect.entityId }, { actionId: attempt.actionId, requestId: attempt.requestId });
        }
        await route.fulfill({ response: upstream });
        await events.record("browser", "network.response_delivered", { status: upstream.status() }, { actionId: attempt.actionId, requestId: attempt.requestId });
      } catch (error) { await events.record("runner", "network.interception_error", { error: String(error) }, attempt ?? {}); await route.abort("failed").catch(() => {}); }
    });
    const triggerOriginal = async (evidence: Record<string, unknown>) => {
      result.fault = { type: schedule.type, phase: String(evidence.phase), ...evidence };
      await page.screenshot({ path: join(screenshots, "at-fault-boundary.png"), fullPage: true });
      await events.record("runner", "fault.triggered", { ...result.fault, scheduleId: schedule.scheduleId });
    };
    const workflow = options.scenarioId === "adminbench-delayed-render-v1" ? "delayed-render" : options.scenarioId === "adminbench-popup-context-shift-v1" ? "popup-context" : options.scenarioId === "adminbench-storage-clear-v1" ? "storage-clear" : "";
    await page.goto(`/?runId=${encodeURIComponent(runId)}${workflow ? `&workflow=${workflow}` : ""}`);
    if (workflow === "delayed-render") {
      const end = Date.now() + 3000;
      let fetched = false;
      while (Date.now() < end) { const state = await (await fetch(`${controlUrl}/__browserproof/render/status?runId=${encodeURIComponent(runId)}`)).json() as { recordsFetched: boolean }; if (state.recordsFetched) { fetched = true; break; } await new Promise((r) => setTimeout(r, 20)); }
      if (!fetched) throw new Error("Render gate did not receive records");
      if (!originalFault) {
        const release = await fetch(`${controlUrl}/__browserproof/render/release`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runId }) });
        if (!release.ok) throw new Error("Render gate did not release");
      }
    }
    if (workflow === "storage-clear") await page.getByTestId("select-record-beacon").waitFor();
    else if (workflow !== "delayed-render" || !originalFault) await page.locator('[data-testid="record-row"]').nth(2).waitFor();
    await page.screenshot({ path: join(screenshots, "before-agent.png"), fullPage: true });
    const observedOrder = workflow === "" ? await page.locator('[data-testid="record-row"]').evaluateAll((rows) => rows.map((row) => row.getAttribute("data-record-id"))) : [];
    const beaconIndex = observedOrder.indexOf("beacon");
    if (workflow === "" && (observedOrder.length !== 3 || beaconIndex < 0)) throw new Error("Agent observed an invalid record list");
    await events.record("agent", "agent.observation", { observationId, task: "deactivate Beacon", workflow, observedOrder, beaconIndex: workflow === "" ? beaconIndex : null }, { agentStepId: "deactivate-beacon" });
    if (options.mode === "faulted") await events.record("runner", "fault.armed", { type: schedule.type, scheduleId: schedule.scheduleId, trigger: schedule.trigger });
    if (originalFault && schedule.type === "delayed_render") {
      const state = await (await fetch(`${controlUrl}/__browserproof/render/status?runId=${encodeURIComponent(runId)}`)).json() as { recordsFetched: boolean; withheld: boolean; inserted: boolean };
      if (!state.recordsFetched || !state.withheld || state.inserted || await page.locator('[data-testid="record-row"][data-record-id="beacon"]').count() !== 0) throw new Error("Render fault boundary was not reached");
      await triggerOriginal({ phase: "records_fetched_before_dom_insertion", recordsFetched: true, withheld: true, beaconDomCount: 0 });
    }
    if (originalFault && schedule.type === "dom_replace_after_observation") {
      if (observedOrder.join(",") !== schedule.originalOrder.join(",")) throw new Error("Observed order does not match saved schedule");
      const response = await fetch(`${appUrl}/__browserproof/dom/reorder`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runId, observationId, order: schedule.mutatedOrder }) });
      const instruction = await response.json() as { domOnly?: boolean; order?: string[] };
      if (!response.ok || !instruction.domOnly || !instruction.order) throw new Error("DOM reorder instruction invalid");
      const applied = await page.evaluate((order) => (window as Window & { __browserproofApplyDomOrder?: (order: string[]) => boolean }).__browserproofApplyDomOrder?.(order), instruction.order);
      const after = await page.locator('[data-testid="record-row"]').evaluateAll((rows) => rows.map((row) => row.getAttribute("data-record-id")));
      if (!applied || after.join(",") !== schedule.mutatedOrder.join(",")) throw new Error("DOM reorder not applied");
      await triggerOriginal({ phase: "after_agent_observation_before_next_click", originalOrder: observedOrder, mutatedOrder: after, observationId });
    }
    if (workflow === "popup-context") {
      const link = page.getByTestId("open-beacon-editor");
      if (originalFault && schedule.type === "popup_context_shift") await link.evaluate((element) => element.setAttribute("target", "_blank"));
      const popupPromise = page.waitForEvent("popup", { timeout: 1500 }).catch(() => null);
      await link.click();
      const popup = await popupPromise;
      if (popup) {
        await popup.waitForLoadState();
        if (originalFault && schedule.type === "popup_context_shift") {
          if (await popup.opener() !== page || new URL(popup.url()).pathname !== "/adminbench/editor") throw new Error("Popup identity/opener mismatch");
          await events.record("browser", "browser.popup_created", { actualUserLinkClick: true, openerVerified: true, pageCount: context!.pages().length, childUrl: popup.url() });
          await triggerOriginal({ phase: "after_agent_link_observed_before_link_click", actualPopup: true, openerVerified: true, childUrl: popup.url() });
        }
      } else await page.getByTestId("beacon-editor-action").waitFor();
    }
    if (workflow === "storage-clear") { await page.getByTestId("select-record-beacon").click(); await page.getByTestId("selection-state").getByText(/Selected: Beacon/i).waitFor(); await events.record("agent", "agent.selection_observed", { recordId: "beacon" }); }
    if (originalFault && schedule.type === "storage_clear") {
      const key = `browserproof:selected-record:${runId}`;
      const storage = await page.evaluate((storageKey) => { const before = localStorage.getItem(storageKey); localStorage.clear(); window.dispatchEvent(new StorageEvent("storage", { key: null, storageArea: localStorage, url: location.href })); return { before, after: localStorage.getItem(storageKey) }; }, key);
      if (storage.before !== "beacon" || storage.after !== null) throw new Error("Storage clear did not remove selection");
      await triggerOriginal({ phase: "after_agent_selection_observed_before_confirm", key, ...storage });
    }
    if (workflow === "delayed-render") {
      try { await page.getByTestId("beacon-action").waitFor({ state: "visible", timeout: 300 }); }
      catch {
        await events.record("agent", "agent.failure_observation", { reason: "Beacon not rendered before agent wait expired", timeoutMs: 300 });
        await page.screenshot({ path: join(screenshots, "after-agent.png"), fullPage: true });
        throw new Error("Agent wait expired before Beacon rendered");
      }
    }
    await page.evaluate(({ observationId, actionId, requestId }) => { const w = window as Window & { __browserproofSetObservation?: (id: string) => void; __browserproofSetNextActionContext?: (action: string, request: string) => void }; w.__browserproofSetObservation?.(observationId); w.__browserproofSetNextActionContext?.(actionId, requestId); }, { observationId, actionId, requestId });
    const control = workflow === "popup-context" ? (await page.getByTestId("beacon-editor-action").isVisible() ? page.getByTestId("beacon-editor-action") : page.getByRole("button", { name: "Deactivate", exact: true }).first()) : workflow === "storage-clear" ? page.getByTestId("confirm-deactivation") : workflow === "delayed-render" ? page.getByTestId("beacon-action") : page.locator('[data-testid="record-row"]').nth(beaconIndex).getByRole("button", { name: "Deactivate", exact: true });
    const selectedTarget = workflow === "storage-clear" ? (await page.getByTestId("selection-state").innerText()).includes("Selected: Beacon") ? "beacon" : null : await control.evaluate((element) => element.closest("[data-record-id]")?.getAttribute("data-record-id") ?? null);
    if (options.mode === "clean") await page.screenshot({ path: join(screenshots, "at-fault-boundary.png"), fullPage: true });
    await events.record("agent", "agent.action_proposed", { requestedTarget: "beacon", selectedTarget, strategy: "vulnerable", workflow }, { actionId, agentStepId: "deactivate-beacon" });
    await events.record("browser", "browser.click_attempt", { selectedTarget }, { actionId, agentStepId: "deactivate-beacon" });
    await control.click();
    await page.locator('#result[data-kind="success"], #result[data-kind="error"]').waitFor({ timeout: 5000 });
    result.attempts = 1;
    let successConfirmation = await page.locator('#result').getAttribute("data-kind") === "success";
    if (!successConfirmation) {
      // Same reference policy for clean and faulted runs: after one visible failure/timeout, re-submit once.
      const retry = { actionId: randomUUID(), requestId: randomUUID() }; attempts.push(retry);
      await events.record("agent", "agent.retry_decision", { reason: "browser reported failure or timeout", resultText: await page.locator("#result").innerText() }, { actionId: retry.actionId, requestId: retry.requestId }); releaseRetryIntent();
      await page.evaluate(({ actionId, requestId }) => (window as Window & { __browserproofSetNextActionContext?: (action: string, request: string) => void }).__browserproofSetNextActionContext?.(actionId, requestId), retry);
      await events.record("browser", "browser.retry_click_attempt", { selectedTarget }, { actionId: retry.actionId, requestId: retry.requestId });
      const answered = page.waitForResponse((response) => response.request().headers()["x-browserproof-request-id"] === retry.requestId, { timeout: 4000 }).catch(() => null);
      await control.click(); result.attempts = 2;
      await answered;
      successConfirmation = await page.locator('#result[data-kind="success"]').waitFor({ timeout: 3000 }).then(() => true, () => false);
    }
    result.taskCompleted = successConfirmation && selectedTarget === "beacon";
    await events.record("agent", "agent.result_observation", { successConfirmation, taskCompleted: result.taskCompleted }, { actionId });
    await page.screenshot({ path: join(screenshots, "after-agent.png"), fullPage: true });
  } catch (error) { result.error = String(error); await events.record("runner", "run.error", { error: result.error }); }
  finally {
    if (traceStarted && context) await context.tracing.stop({ path: join(artifactDir, "trace.zip") }).catch(() => {});
    try {
      if (!controlUrl) throw new Error("Independent observer unavailable");
      result.effects = await queryAdminEffects(controlUrl, runId); result.finalRecords = await queryAdminState(controlUrl, runId); result.observerStatus = "complete";
      result.contract = evaluateAdminCorrectRecord(result.effects, result.finalRecords);
      result.status = options.mode === "faulted" && !result.fault || watchdogExpired ? "injection_error" : result.effects.length === 0 ? "agent_error" : !result.contract.passed ? "contract_violation" : result.taskCompleted ? "passed" : "agent_error";
      await events.record("observer", "backend.effects_observed", { effectIds: result.effects.map((effect) => effect.effectId), independentlyQueried: true });
      await events.record("contract", "contract.evaluated", { ...result.contract });
    } catch (error) { result.observerStatus = "observer_inconclusive"; result.status = "observer_inconclusive"; result.error = String(error); }
    await context?.close().catch(() => {}); await browser?.close().catch(() => {}); await app?.close().catch(() => {});
  }
  await events.record("runner", "run.completed", { status: result.status, taskCompleted: result.taskCompleted, effectCount: result.effects.length }); await events.flush();
  await save("effects.json", { schemaVersion: ARTIFACT_SCHEMA_VERSION, runId, observerStatus: result.observerStatus, effects: result.effects, finalRecords: result.finalRecords });
  await save("result.json", result); await save("manifest.json", { schemaVersion: ARTIFACT_SCHEMA_VERSION, runId, scenarioId: options.scenarioId, mode: options.mode, seed: options.seed, startedAt, completedAt: new Date().toISOString(), artifactFiles: files });
  return { artifactDir, result };
}

/** Offline artifact audit; never uses a model or causes a business mutation. */
export async function validateAdminBenchmarkArtifacts(artifactDir: string): Promise<{ valid: boolean; errors: string[] }> {
  const errors: string[] = [];
  try {
    const load = async (name: string) => JSON.parse(await readFile(join(artifactDir, name), "utf8")) as Record<string, any>;
    const manifest = await load("manifest.json"), scenario = await load("scenario.json"), schedule = await load("schedule.json"), effects = await load("effects.json"), result = await load("result.json") as unknown as AdminBenchmarkResult;
    const events = (await readFile(join(artifactDir, "events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { runId: string; scenarioId: string; sequence: number; monotonicMs: number; type: string; actionId?: string; requestId?: string; payload: Record<string, any> });
    if (!result.runId || resolve(artifactDir) !== join(resolve(artifactDir, ".."), result.runId) || manifest.runId !== result.runId || scenario.runId !== result.runId || effects.runId !== result.runId || manifest.scenarioId !== result.scenarioId || scenario.scenarioId !== result.scenarioId || manifest.mode !== result.mode || schedule.mode !== result.mode || manifest.seed !== result.seed || schedule.seed !== result.seed || scenario.agentPolicy !== "vulnerable") errors.push("artifact identity mismatch");
    if (!originalTypes[result.scenarioId] || !Array.isArray(schedule.faults) || result.mode === "clean" && schedule.faults.length !== 0 || result.mode === "faulted" && (schedule.faults.length !== 1 || !validateFaultSchedule(schedule.faults[0], { scenarioId: result.scenarioId, seed: result.seed }) || !isAllowedType(result.scenarioId, schedule.faults[0].type))) errors.push("invalid saved fault schedule");
    if (result.observerStatus !== "complete" || effects.observerStatus !== "complete" || JSON.stringify(effects.effects) !== JSON.stringify(result.effects) || JSON.stringify(effects.finalRecords) !== JSON.stringify(result.finalRecords) || !Array.isArray(result.effects) || !Array.isArray(result.finalRecords)) errors.push("independent observation missing or inconsistent");
    if (JSON.stringify(evaluateAdminCorrectRecord(result.effects, result.finalRecords)) !== JSON.stringify(result.contract)) errors.push("contract evaluation mismatch");
    if (events.some((event, index) => event.runId !== result.runId || event.scenarioId !== result.scenarioId || event.sequence !== index + 1 || !Number.isFinite(event.monotonicMs))) errors.push("event identity or sequence mismatch");
    const find = (type: string) => events.filter((event) => event.type === type);
    const one = (type: string) => { const rows = find(type); if (rows.length !== 1) errors.push(`expected one ${type}`); return rows[0]; };
    const type = result.mode === "faulted" ? schedule.faults?.[0]?.type : null;
    const watchdogExpiredEvent = () => find("fault.watchdog_expired").length > 0;
    const noAction = type === "delayed_render", noRequest = noAction || type === "storage_clear";
    const requests = find("network.request"), request = requests[0];
    const networkType = typeof type === "string" && networkTypes.includes(type);
    const expectedRequests = noRequest ? 0 : networkType ? 2 : 1;
    const action = noAction ? undefined : one("agent.action_proposed"), click = noAction ? undefined : one("browser.click_attempt"), observation = one("agent.observation"), observedEffects = one("backend.effects_observed"), completed = one("run.completed");
    if (requests.length !== expectedRequests || new Set(requests.map((row) => row.requestId)).size !== requests.length) errors.push("browser request count or identity invalid");
    if (!observation || !observedEffects || !completed || !(observation.sequence < observedEffects.sequence && observedEffects.sequence < completed.sequence)) errors.push("agent and observer chronology invalid");
    if (action && click && observation && !(observation.sequence < action.sequence && action.sequence < click.sequence && (!request || click.sequence < request.sequence))) errors.push("agent/browser action chronology invalid");
    const wrongTarget = type === "dom_replace_after_observation" || type === "popup_context_shift";
    if (request && (request.payload.method !== "POST" || new URL(String(request.payload.url)).pathname !== `/api/records/${wrongTarget ? "alice" : "beacon"}/deactivate` || !request.actionId || !request.requestId || request.actionId !== action?.actionId || request.actionId !== click?.actionId)) errors.push("browser action/request correlation invalid");
    if (observedEffects && JSON.stringify(observedEffects.payload.effectIds) !== JSON.stringify(result.effects.map((effect) => effect.effectId))) errors.push("independent effect IDs mismatch");
    if (result.effects.some((effect) => effect.runId !== result.runId || !requests.some((row) => row.actionId === effect.actionId && row.requestId === effect.requestId) || effect.observationId !== observation?.payload.observationId || effect.entityId !== (wrongTarget ? "alice" : "beacon")) || new Set(result.effects.map((effect) => effect.effectId)).size !== result.effects.length) errors.push("effect correlation mismatch");
    if (networkType) {
      const retry = find("agent.retry_decision"), retryClick = find("browser.retry_click_attempt");
      if (retry.length !== 1 || retryClick.length !== 1 || !requests[1] || retry[0]!.requestId !== requests[1].requestId || retryClick[0]!.requestId !== requests[1].requestId || !(retry[0]!.sequence < retryClick[0]!.sequence && retryClick[0]!.sequence < requests[1].sequence) || result.attempts !== 2) errors.push("agent retry evidence invalid");
    } else if (find("agent.retry_decision").length || result.attempts !== 1 && !noRequest) errors.push("unexpected retry");
    if (result.mode === "clean") {
      if (result.fault || find("fault.triggered").length || result.status !== "passed" || !result.taskCompleted || result.effects.length !== 1 || !result.contract?.passed) errors.push("invalid clean outcome");
    } else {
      const trigger = one("fault.triggered"), armed = one("fault.armed");
      if (!result.fault || !trigger || !armed || trigger.payload.type !== type || result.fault.type !== type || trigger.payload.scheduleId !== schedule.faults[0]?.scheduleId || !(armed.sequence < trigger.sequence)) errors.push("fault trigger or correlation mismatch");
      if (result.fault?.type === "request_abort") {
        const failed = one("network.request_failed");
        if (result.fault.phase !== "before_upstream" || result.effects.length !== 1 || result.effects[0]?.requestId !== requests[1]?.requestId || !result.taskCompleted || result.status !== "passed" || !failed || failed.requestId !== request?.requestId || trigger?.requestId !== request?.requestId || request && trigger && !(request.sequence < trigger.sequence && trigger.sequence < failed.sequence)) errors.push("request abort was not observed before upstream commit and recovered");
      } else if (result.fault?.type === "commit_then_response_lost" || result.fault?.type === "response_delay") {
        const committed = find("backend.update_committed")[0], first = result.effects.find((effect) => effect.requestId === request?.requestId);
        if (result.fault.phase !== "after_upstream_commit" || result.effects.length !== 2 || !result.taskCompleted || result.status !== "contract_violation" || result.contract?.signature !== "update-correct-record|beacon|effect-count:2" || !first || !committed || !trigger || !(committed.sequence < trigger.sequence) || committed.payload.effectId !== first.effectId || trigger.payload.effectId !== first.effectId || trigger.requestId !== request?.requestId) errors.push("post-commit fault lacks confirmed first commit or duplicate-effect outcome");
        if (result.fault.type === "commit_then_response_lost") {
          const failed = events.find((event) => event.type === "network.request_failed" && event.requestId === request?.requestId);
          if (!failed || !(trigger && trigger.sequence < failed.sequence)) errors.push("browser response loss absent");
        } else {
          const delivered = one("network.delayed_delivered"), decision = find("agent.retry_decision")[0];
          if (!delivered || !decision || delivered.payload.releasedByAgent !== true || !(trigger && trigger.sequence < decision.sequence && decision.sequence < delivered.sequence) || watchdogExpiredEvent()) errors.push("delayed delivery was not released by observed retry");
        }
      } else if (type === "dom_replace_after_observation") {
        if (!trigger || !action || !observation || !(observation.sequence < trigger.sequence && trigger.sequence < action.sequence) || JSON.stringify(trigger.payload.originalOrder) !== JSON.stringify(schedule.faults[0].originalOrder) || JSON.stringify(trigger.payload.mutatedOrder) !== JSON.stringify(schedule.faults[0].mutatedOrder) || action.payload.selectedTarget !== "alice" || result.effects.length !== 1 || result.contract?.signature !== "update-correct-record|beacon|wrong-target:alice" || result.taskCompleted || result.status !== "contract_violation") errors.push("DOM reorder wrong-target evidence mismatch");
      } else if (type === "popup_context_shift") {
        const popup = one("browser.popup_created");
        if (!popup || !trigger || !action || !(popup.sequence < trigger.sequence && trigger.sequence < action.sequence) || popup.payload.actualUserLinkClick !== true || popup.payload.openerVerified !== true || popup.payload.pageCount !== 2 || trigger.payload.childUrl !== popup.payload.childUrl || action.payload.selectedTarget !== "alice" || result.effects.length !== 1 || result.contract?.signature !== "update-correct-record|beacon|wrong-target:alice" || result.taskCompleted || result.status !== "contract_violation") errors.push("popup wrong-target evidence mismatch");
      } else if (type === "storage_clear") {
        const selection = one("agent.selection_observed");
        if (!selection || !trigger || !action || !(selection.sequence < trigger.sequence && trigger.sequence < action.sequence) || trigger.payload.before !== "beacon" || trigger.payload.after !== null || trigger.payload.key !== `browserproof:selected-record:${result.runId}` || action.payload.selectedTarget !== null || find("network.request").length !== 0 || result.effects.length !== 0 || result.taskCompleted || result.status !== "contract_violation") errors.push("storage clear evidence mismatch");
      } else if (type === "delayed_render") {
        const failure = one("agent.failure_observation");
        if (!failure || !trigger || !(trigger.sequence < failure.sequence) || trigger.payload.recordsFetched !== true || trigger.payload.withheld !== true || trigger.payload.beaconDomCount !== 0 || failure.payload.timeoutMs !== 300 || find("network.request").length !== 0 || result.effects.length !== 0 || result.taskCompleted || result.status !== "contract_violation") errors.push("delayed render evidence mismatch");
      } else errors.push("wrong fault type");
    }
    for (const name of ["screenshots/before-agent.png", "screenshots/at-fault-boundary.png", "screenshots/after-agent.png"]) if (!(await readFile(join(artifactDir, name))).subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) errors.push(`invalid ${name}`);
    const trace = await validatePlaywrightTraceArchive(join(artifactDir, "trace.zip"));
    if (!trace.valid) errors.push("invalid Playwright trace archive");
  } catch (error) { errors.push(`artifact read or trace integrity failed: ${String(error)}`); }
  return { valid: errors.length === 0, errors };
}

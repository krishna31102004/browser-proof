import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import { ARTIFACT_SCHEMA_VERSION, evaluateAdminCorrectRecord, type AdminRecordEffect, type AdminRecordSnapshot, type ContextFaultScenarioId, type ContextFaultSchedule, type ContextFaultType, type ResultStatus, type RunMode } from "@browserproof/contracts";
import { startAdminBench } from "@browserproof/demo-admin";
import { EventWriter } from "./event-writer.js";
import { queryAdminEffects, queryAdminState } from "./admin-run.js";
import { validatePlaywrightTraceArchive } from "./trace-archive.js";

export type ContextAgentPolicy = "vulnerable" | "hardened";
export type { ContextFaultSchedule, ContextFaultType } from "@browserproof/contracts";
export interface ContextFaultResult {
  schemaVersion: typeof ARTIFACT_SCHEMA_VERSION; runId: string; scenarioId: ContextFaultScenarioId; mode: RunMode; seed: string; agentPolicy: ContextAgentPolicy;
  status: ResultStatus; taskCompleted: boolean; observerStatus: "complete" | "observer_inconclusive"; availability: "available" | "task_unavailable";
  observedEffects: AdminRecordEffect[]; finalRecords: AdminRecordSnapshot[]; contract: ReturnType<typeof evaluateAdminCorrectRecord> | null;
  fault: { type: ContextFaultType | null; armed: boolean; triggered: boolean; triggerCount: number; phase: string | null };
  agent: { observationId: string | null; actionId: string | null; selectedPageId: string | null; selectedTarget: string | null; error?: string };
  evidence: Record<string, unknown>; error?: string;
}
export interface ContextFaultOptions { fault: ContextFaultType; mode: RunMode; agent: ContextAgentPolicy; seed: string; artifactRoot?: string; runId?: string; schedule?: ContextFaultSchedule; sourceRunId?: string; suppressTriggerForTest?: boolean; observerUrlOverride?: string }
export interface ContextFaultRun { result: ContextFaultResult; artifactDir: string }

const scenario = (fault: ContextFaultType): ContextFaultScenarioId => fault === "popup_context_shift" ? "adminbench-popup-context-shift-v1" : "adminbench-storage-clear-v1";
const exactKeys = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).sort().join("|") === [...keys].sort().join("|");
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export function createContextFaultSchedule(fault: ContextFaultType, seed: string): ContextFaultSchedule {
  const common = { schemaVersion: ARTIFACT_SCHEMA_VERSION, scheduleId: `${fault}-${seed}`, seed, occurrenceCount: 1 } as const;
  if (fault === "popup_context_shift") return { ...common, scenarioId: "adminbench-popup-context-shift-v1", type: fault, target: { app: "adminbench", path: "/adminbench/editor", recordId: "beacon" }, trigger: "after_agent_link_observed_before_link_click" };
  return { ...common, scenarioId: "adminbench-storage-clear-v1", type: fault, target: { app: "adminbench", storage: "localStorage", keyPrefix: "browserproof:selected-record:", recordId: "beacon" }, trigger: "after_agent_selection_observed_before_confirm" };
}

export function validateContextFaultSchedule(value: unknown, expected?: ContextFaultType, seed?: string): value is ContextFaultSchedule {
  if (!record(value) || value.schemaVersion !== ARTIFACT_SCHEMA_VERSION || typeof value.seed !== "string" || !value.seed || value.scheduleId !== `${String(value.type)}-${value.seed}` || value.occurrenceCount !== 1 || (expected && value.type !== expected) || (seed && value.seed !== seed)) return false;
  if (value.type === "popup_context_shift") return value.scenarioId === "adminbench-popup-context-shift-v1" && record(value.target) && exactKeys(value.target, ["app", "path", "recordId"]) && value.target.app === "adminbench" && value.target.path === "/adminbench/editor" && value.target.recordId === "beacon" && value.trigger === "after_agent_link_observed_before_link_click" && exactKeys(value, ["schemaVersion", "scheduleId", "scenarioId", "type", "seed", "target", "trigger", "occurrenceCount"]);
  if (value.type === "storage_clear") return value.scenarioId === "adminbench-storage-clear-v1" && record(value.target) && exactKeys(value.target, ["app", "storage", "keyPrefix", "recordId"]) && value.target.app === "adminbench" && value.target.storage === "localStorage" && value.target.keyPrefix === "browserproof:selected-record:" && value.target.recordId === "beacon" && value.trigger === "after_agent_selection_observed_before_confirm" && exactKeys(value, ["schemaVersion", "scheduleId", "scenarioId", "type", "seed", "target", "trigger", "occurrenceCount"]);
  return false;
}

const filesFor = (fault: ContextFaultType) => ["manifest.json", "scenario.json", "schedule.json", "events.jsonl", "effects.json", "result.json", "trace.zip", "screenshots/before-agent.png", "screenshots/at-fault-boundary.png", "screenshots/after-agent.png", ...(fault === "popup_context_shift" ? ["screenshots/parent-at-popup.png", "screenshots/popup-before-action.png", "popup-evidence.json"] : ["storage-evidence.json"])] ;
const pageId = (() => { const ids = new WeakMap<Page, string>(); let next = 0; return (page: Page) => { let id = ids.get(page); if (!id) { id = `page-${++next}`; ids.set(page, id); } return id; }; })();
const call = async <T>(url: string, init?: RequestInit): Promise<T> => { const response = await fetch(url, { ...init, signal: AbortSignal.timeout(2500) }); if (!response.ok) throw new Error(`AdminBench control returned HTTP ${response.status}`); return await response.json() as T; };
const writeJson = (path: string, value: unknown) => writeFile(path, `${JSON.stringify(value, null, 2)}\n`);

export function normalizedContextFaultSignature(result: ContextFaultResult): string {
  return result.fault.type === "popup_context_shift"
    ? result.contract?.signature ?? `${result.status}|${result.observedEffects.map(({ entityId }) => entityId).join(",")}`
    : `${result.status}|completed=${result.taskCompleted}|effects=${result.observedEffects.map(({ entityId }) => entityId).join(",")}`;
}

export function contextFaultReproductionIdsAreFresh(sourceRunId: string, reproductionRunIds: readonly string[]): boolean {
  return reproductionRunIds.length > 0 && new Set(reproductionRunIds).size === reproductionRunIds.length && reproductionRunIds.every((runId) => runId !== sourceRunId);
}

export async function executeContextFaultRun(options: ContextFaultOptions): Promise<ContextFaultRun> {
  const faultSchedule = options.schedule ?? createContextFaultSchedule(options.fault, options.seed);
  if (!validateContextFaultSchedule(faultSchedule, options.fault, options.seed)) throw new Error("Invalid or mismatched context-fault schedule");
  const runId = options.runId ?? randomUUID(); const scenarioId = scenario(options.fault);
  const startedAt = new Date().toISOString();
  const artifactRoot = resolve(options.artifactRoot ?? fileURLToPath(new URL("../../../artifacts", import.meta.url)));
  const artifactDir = join(artifactRoot, runId); const screenshots = join(artifactDir, "screenshots"); await mkdir(screenshots, { recursive: true });
  const events = new EventWriter(join(artifactDir, "events.jsonl"), runId, scenarioId);
  const result: ContextFaultResult = { schemaVersion: ARTIFACT_SCHEMA_VERSION, runId, scenarioId, mode: options.mode, seed: options.seed, agentPolicy: options.agent, status: "browser_error", taskCompleted: false, observerStatus: "complete", availability: "available", observedEffects: [], finalRecords: [], contract: null, fault: { type: options.mode === "faulted" ? options.fault : null, armed: options.mode === "faulted", triggered: false, triggerCount: 0, phase: null }, agent: { observationId: null, actionId: null, selectedPageId: null, selectedTarget: null }, evidence: {} };
  const evidence: Record<string, unknown> = { runId, scenarioId, policy: options.agent, mode: options.mode };
  let app: Awaited<ReturnType<typeof startAdminBench>> | undefined; let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined; let context: BrowserContext | undefined;
  let controlUrl = ""; let appUrl = ""; let boundaryScreenshotCaptured = false; let error: string | undefined;
  const pendingRequests: Array<{ url: string; method: string; requestId: string | null; actionId: string | null; observationId: string | null }> = [];
  try {
    await writeJson(join(artifactDir, "scenario.json"), { schemaVersion: ARTIFACT_SCHEMA_VERSION, scenarioId, name: options.fault, faultType: options.fault, task: "Deactivate Beacon exactly once without updating another record", agentPolicy: options.agent });
    await writeJson(join(artifactDir, "schedule.json"), { schemaVersion: ARTIFACT_SCHEMA_VERSION, mode: options.mode, seed: options.seed, faults: options.mode === "faulted" ? [faultSchedule] : [] });
    await events.record("runner", "run.started", { scenarioId, mode: options.mode, seed: options.seed, agentPolicy: options.agent });
    app = await startAdminBench({ appPort: 0, controlPort: 0 });
    const a = app.app.address(); const c = app.control.address(); if (!a || typeof a === "string" || !c || typeof c === "string") throw new Error("AdminBench failed to bind loopback listeners");
    appUrl = `http://127.0.0.1:${a.port}`; controlUrl = options.observerUrlOverride ?? `http://127.0.0.1:${c.port}`;
    await call(`${`http://127.0.0.1:${c.port}`}/__browserproof/reset`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runId }) });
    await events.record("runner", "backend.reset", { runId, separateControlListener: true });
    browser = await chromium.launch({ headless: true }); context = await browser.newContext({ viewport: { width: 1365, height: 900 } });
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true, title: `${runId} ${options.fault} ${options.agent} ${options.mode}` });
    const workflow = options.fault === "popup_context_shift" ? "popup-context" : "storage-clear";
    const trackBusinessRequests = (trackedPage: Page) => trackedPage.on("request", (request) => { if (request.method() === "POST" && new URL(request.url()).pathname.startsWith("/api/records/") && new URL(request.url()).pathname.endsWith("/deactivate")) { const headers = request.headers(); const item = { url: request.url(), method: request.method(), requestId: headers["x-browserproof-request-id"] ?? null, actionId: headers["x-browserproof-action-id"] ?? null, observationId: headers["x-browserproof-observation-id"] ?? null }; pendingRequests.push(item); void events.record("browser", "network.business_request", item, { ...(item.requestId ? { requestId: item.requestId } : {}), ...(item.actionId ? { actionId: item.actionId } : {}) }); } });
    const page = await context.newPage(); const pagesBefore = context.pages().length; trackBusinessRequests(page); context.on("page", (newPage) => { if (newPage !== page) trackBusinessRequests(newPage); });
    if (options.mode === "faulted") await events.record("runner", "fault.armed", { type: options.fault, scheduleId: faultSchedule.scheduleId, trigger: faultSchedule.trigger, occurrenceCount: 1, seed: options.seed });
    else await events.record("runner", "fault.schedule_disabled", { type: options.fault, armed: false, scheduleId: faultSchedule.scheduleId });
    const pageUrl = `${appUrl}/?workflow=${workflow}&runId=${encodeURIComponent(runId)}`;
    await page.goto(pageUrl); await page.locator("[data-testid='records'], [data-testid='open-beacon-editor'], [data-testid='select-record-beacon']").first().waitFor({ state: "attached", timeout: 5000 });
    await page.screenshot({ path: join(screenshots, "before-agent.png"), fullPage: true });
    const observationId = randomUUID(); const actionId = randomUUID(); result.agent.observationId = observationId; result.agent.actionId = actionId;
    await page.evaluate((id) => { const w = window as Window & { __browserproofSetObservation?: (value: string) => void }; w.__browserproofSetObservation?.(id); }, observationId);
    await events.record("agent", "agent.observation", { observationId, requestedRecordId: "beacon", requestedName: "Beacon", workflow }, { agentStepId: "deactivate-beacon" });
    if (options.fault === "popup_context_shift") {
      const link = page.locator("[data-testid='open-beacon-editor']"); await link.waitFor({ state: "visible" });
      const originalTarget = await link.getAttribute("target"); const targetUrl = await link.getAttribute("href");
      await events.record("agent", "agent.link_observed", { observationId, href: targetUrl, target: originalTarget, requestedRecordId: "beacon" }, { agentStepId: "open-beacon-editor" });
      evidence.parentPageId = pageId(page); evidence.parentUrlBefore = page.url(); evidence.pagesBefore = pagesBefore; evidence.linkTargetBefore = originalTarget; evidence.linkHref = targetUrl;
      if (options.mode === "faulted" && !options.suppressTriggerForTest) {
        if (new URL(targetUrl ?? "", appUrl).origin !== new URL(appUrl).origin || new URL(targetUrl ?? "", appUrl).pathname !== "/adminbench/editor") throw new Error("Popup destination failed same-origin/target allowlist");
        await link.evaluate((node) => { (node as HTMLAnchorElement).target = "_blank"; });
        await events.record("runner", "fault.intervention_applied", { operation: "set_observed_anchor_target_blank", phase: "after_agent_link_observed_before_link_click", originalTarget, newTarget: await link.getAttribute("target") });
      }
      const popupObserved = new Promise<Page>((resolvePromise) => context!.once("page", (candidate) => resolvePromise(candidate)));
      const popupWait = page.waitForEvent("popup", { timeout: 8000 }).catch(() => null);
      const navigationWait = page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 8000 }).then(() => "same-page" as const).catch(() => null);
      await events.record("agent", "agent.click_attempt", { control: "Open Beacon editor", href: targetUrl, policy: options.agent }, { agentStepId: "open-beacon-editor", actionId });
      await link.click();
      const popup = await Promise.race([popupWait, navigationWait.then((value) => value === "same-page" ? null : new Promise<null>(() => {})), popupObserved.catch(() => null)]);
      const candidates = context.pages(); const actualPopup = popup instanceof Object && "url" in popup ? popup as Page : candidates.find((candidate) => candidate !== page) ?? null;
      const popupUrl = actualPopup ? new URL(actualPopup.url()) : null;
      const isRealPopup = Boolean(actualPopup && actualPopup !== page && context.pages().length === pagesBefore + 1 && (await actualPopup.opener()) === page && popupUrl?.origin === new URL(appUrl).origin && popupUrl.pathname === "/adminbench/editor" && popupUrl.searchParams.get("recordId") === "beacon" && popupUrl.searchParams.get("runId") === runId);
      if (isRealPopup) {
        result.fault.triggered = options.mode === "faulted"; result.fault.triggerCount = options.mode === "faulted" ? 1 : 0; result.fault.phase = "after_agent_link_observed_before_link_click";
        await events.record("browser", "browser.popup_created", { parentPageId: pageId(page), popupPageId: pageId(actualPopup!), parentUrl: page.url(), childUrl: actualPopup!.url(), pageCountBefore: pagesBefore, pageCountAfter: context.pages().length, openerVerified: true, actualUserLinkClick: true }, { agentStepId: "open-beacon-editor", actionId });
        if (options.mode === "faulted") await events.record("runner", "fault.triggered", { type: options.fault, scheduleId: faultSchedule.scheduleId, trigger: faultSchedule.trigger, pageCountBefore: pagesBefore, pageCountAfter: context.pages().length, parentPageId: pageId(page), popupPageId: pageId(actualPopup!), openerVerified: true, sameOrigin: new URL(actualPopup!.url()).origin === new URL(appUrl).origin });
      }
      const chosen = options.agent === "hardened" && isRealPopup ? actualPopup! : page;
      result.agent.selectedPageId = pageId(chosen); evidence.popupPageId = actualPopup ? pageId(actualPopup) : null; evidence.popupUrl = actualPopup?.url() ?? null; evidence.popupOpenerPageId = actualPopup && await actualPopup.opener() === page ? pageId(page) : null; evidence.pagesAfter = context.pages().length; evidence.popupCreatedByClick = isRealPopup; evidence.policySelectedPageId = pageId(chosen); evidence.samePageUrlAfterClick = page.url();
      if (options.mode === "faulted" && !isRealPopup && !options.suppressTriggerForTest) { result.status = "injection_error"; result.availability = "task_unavailable"; throw new Error("Armed popup schedule did not produce a real identified popup"); }
      if (isRealPopup) {
        await page.screenshot({ path: join(screenshots, "parent-at-popup.png"), fullPage: true });
        await actualPopup!.screenshot({ path: join(screenshots, "popup-before-action.png"), fullPage: true });
      }
      await chosen.screenshot({ path: join(screenshots, "at-fault-boundary.png"), fullPage: true }); boundaryScreenshotCaptured = true;
      if (options.agent === "vulnerable" && page.url() === pageUrl) {
        const first = page.locator("[data-testid='record-action'][data-record-id]").first(); await first.waitFor({ state: "visible", timeout: 3000 });
        result.agent.selectedTarget = await first.getAttribute("data-record-id");
        await first.evaluate((node, ids) => { const w = window as Window & { __browserproofSetNextActionContext?: (action: string, request: string) => void }; w.__browserproofSetNextActionContext?.(ids.action, ids.request); }, { action: actionId, request: randomUUID() });
        await events.record("agent", "agent.action_proposed", { action: "deactivate_record", requestedRecordId: "beacon", selectedTarget: result.agent.selectedTarget, strategy: "first-action-in-current-page" }, { agentStepId: "deactivate-record", actionId });
        await first.click();
      } else {
        const editorAction = chosen.locator("[data-testid='beacon-editor-action'][data-record-id='beacon']"); await editorAction.waitFor({ state: "visible", timeout: 4000 }); result.agent.selectedTarget = await editorAction.getAttribute("data-record-id");
        await editorAction.evaluate((node, ids) => { const w = window as Window & { __browserproofSetObservation?: (value: string) => void; __browserproofSetNextActionContext?: (action: string, request: string) => void }; w.__browserproofSetObservation?.(ids.observation); w.__browserproofSetNextActionContext?.(ids.action, ids.request); }, { observation: observationId, action: actionId, request: randomUUID() });
        await events.record("agent", "agent.action_proposed", { action: "deactivate_record", requestedRecordId: "beacon", selectedTarget: result.agent.selectedTarget, strategy: options.agent === "hardened" ? "stable-record-id-on-observed-page" : "first-action-in-current-page" }, { agentStepId: "deactivate-record", actionId });
        await editorAction.click();
      }
      evidence.boundaryScreenshot = "screenshots/at-fault-boundary.png";
      await chosen.waitForFunction(() => /successfully|updated/i.test(document.querySelector("[data-testid='result']")?.textContent ?? ""), undefined, { timeout: 2500 }).catch(() => undefined);
      const popupOutcome = await chosen.locator("[data-testid='result']").innerText().catch(() => "");
      result.taskCompleted = result.agent.selectedTarget === "beacon" && /successfully|updated/i.test(popupOutcome);
      evidence.finalPageId = result.agent.selectedPageId; evidence.finalPageUrl = chosen.url();
      await events.record("agent", "agent.result_observation", { taskCompleted: result.taskCompleted, visibleOutcome: popupOutcome || "not visible", selectedPageId: result.agent.selectedPageId }, { agentStepId: "deactivate-record", actionId });
      if (options.mode === "faulted" && options.suppressTriggerForTest) result.fault.triggered = false;
    } else {
      const selected = page.locator("[data-testid='select-record-beacon']"); await selected.waitFor({ state: "visible" });
      const storageKey = `browserproof:selected-record:${runId}`; evidence.storageKey = storageKey; evidence.selectionSource = "visible UI button click";
      await events.record("agent", "agent.selection_action", { recordId: "beacon", control: "Select Beacon" }, { agentStepId: "select-beacon" }); await selected.click();
      const preStorageRaw = await page.evaluate((key) => ({ value: localStorage.getItem(key), keys: Object.keys(localStorage).sort(), cookie: document.cookie }), storageKey);
      const preStorage = { ...preStorageRaw, removedKeys: [] as string[] };
      await page.locator("[data-testid='selection-state']").waitFor({ state: "visible" }); const visibleBefore = await page.locator("[data-testid='selection-state']").innerText();
      const selectedObservationId = randomUUID(); result.agent.observationId = selectedObservationId;
      const cookiesBefore = await context.cookies(appUrl);
      await events.record("agent", "agent.selection_observed", { selectedRecordId: "beacon", visibleState: visibleBefore, persistedValue: preStorage.value, storageKey }, { agentStepId: "confirm-beacon" });
      let postStorage: { value: string | null; keys: string[]; cookie: string; removedKeys: string[] } = preStorage; let removedKeys: string[] = [];
      if (options.mode === "faulted" && !options.suppressTriggerForTest) {
        if (preStorage.value !== "beacon") throw new Error("Fault barrier requires the run-scoped Beacon selection in localStorage");
        result.fault.phase = "after_agent_selection_observed_before_confirm";
        postStorage = await page.evaluate(() => { const before = Object.keys(localStorage).sort(); localStorage.clear(); window.dispatchEvent(new StorageEvent("storage", { key: null, oldValue: null, newValue: null, storageArea: localStorage, url: location.href })); return { value: null, keys: Object.keys(localStorage).sort(), cookie: document.cookie, removedKeys: before }; }).then((value) => ({ value: value.value, keys: value.keys, cookie: value.cookie, removedKeys: value.removedKeys }));
        removedKeys = postStorage.removedKeys; result.fault.triggered = true; result.fault.triggerCount = 1;
        const cookiesAfterClear = await context.cookies(appUrl);
        await events.record("runner", "fault.triggered", { type: options.fault, operation: "localStorage.clear", storageKey, priorValue: preStorage.value, valueAfter: postStorage.value, removedKeys, cookieUnchanged: preStorage.cookie === postStorage.cookie, keysBefore: preStorage.keys, keysAfter: postStorage.keys, phase: result.fault.phase });
        evidence.cookies = { beforeClear: cookiesBefore, afterClear: cookiesAfterClear, unchanged: JSON.stringify(cookiesBefore) === JSON.stringify(cookiesAfterClear) };
        await page.screenshot({ path: join(screenshots, "at-fault-boundary.png"), fullPage: true }); boundaryScreenshotCaptured = true;
      } else await events.record("runner", "fault.not_triggered_clean", { type: options.fault, mode: options.mode, persistedValue: preStorage.value });
      const visibleAfter = await page.locator("[data-testid='selection-state']").innerText();
      const recovery = { attempted: false, selectedByUi: false, visibleBeforeConfirm: visibleAfter, confirmationAttempted: false, error: null as string | null };
      if (options.agent === "hardened" && !visibleAfter.includes("Selected: Beacon")) { recovery.attempted = true; await events.record("agent", "agent.selection_lost_observed", { visibleState: visibleAfter, storageValue: postStorage.value }, { agentStepId: "recover-selection" }); await page.locator("[data-testid='select-record-beacon']").click(); recovery.selectedByUi = true; await events.record("agent", "agent.selection_recovered_by_ui", { recordId: "beacon", control: "Select Beacon" }, { agentStepId: "recover-selection" }); }
      const confirm = page.locator("[data-testid='confirm-deactivation']"); await confirm.waitFor({ state: "visible" });
      await confirm.evaluate((node, ids) => { const w = window as Window & { __browserproofSetNextActionContext?: (action: string, request: string) => void }; w.__browserproofSetNextActionContext?.(ids.action, ids.request); }, { action: actionId, request: randomUUID() });
      recovery.confirmationAttempted = true; await events.record("agent", "agent.confirm_attempt", { policy: options.agent, storageStateBeforeConfirm: await page.locator("[data-testid='selection-state']").innerText(), recovered: recovery.selectedByUi }, { agentStepId: "confirm-beacon", actionId });
      await confirm.click();
      await page.waitForFunction(() => /successfully|updated|select|missing/i.test(document.querySelector("[data-testid='result']")?.textContent ?? ""), undefined, { timeout: 2500 }).catch(() => undefined);
      const statusText = await page.locator("[data-testid='result']").innerText().catch(() => ""); recovery.error = /select|missing/i.test(statusText) ? statusText : null;
      result.taskCompleted = /successfully|updated/i.test(statusText); result.agent.selectedTarget = recovery.selectedByUi || preStorage.value === "beacon" && postStorage.value === "beacon" ? "beacon" : null; result.agent.selectedPageId = pageId(page);
      evidence.storage = { key: storageKey, valueBefore: preStorage.value, keysBefore: preStorage.keys, cookieBefore: preStorage.cookie, valueAfterClear: postStorage.value, keysAfterClear: postStorage.keys, cookieAfter: postStorage.cookie, removedKeys, cookieUnchanged: preStorage.cookie === postStorage.cookie, selectionVisibleBefore: visibleBefore, selectionVisibleAfter: visibleAfter, recovery, finalStorageValue: await page.evaluate((key) => localStorage.getItem(key), storageKey), finalVisibleState: await page.locator("[data-testid='selection-state']").innerText() };
      if (options.mode === "clean") { const cookiesAfter = await context.cookies(appUrl); evidence.cookies = { beforeClear: cookiesBefore, afterClear: cookiesAfter, unchanged: JSON.stringify(cookiesBefore) === JSON.stringify(cookiesAfter) }; }
      if (!boundaryScreenshotCaptured) { await page.screenshot({ path: join(screenshots, "at-fault-boundary.png"), fullPage: true }); boundaryScreenshotCaptured = true; }
      await events.record("agent", "agent.result_observation", { taskCompleted: result.taskCompleted, visibleOutcome: statusText, recoveredByUi: recovery.selectedByUi }, { agentStepId: "confirm-beacon", actionId });
      if (options.mode === "faulted" && options.suppressTriggerForTest) { result.fault.triggered = false; result.fault.triggerCount = 0; }
      await writeJson(join(artifactDir, "storage-evidence.json"), evidence);
    }
    await page.screenshot({ path: join(screenshots, "after-agent.png"), fullPage: true });
    if (options.fault === "popup_context_shift") await writeJson(join(artifactDir, "popup-evidence.json"), evidence);
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause); result.agent.error = error; result.error = error;
    if (result.status !== "injection_error") result.status = "agent_error"; result.availability = "task_unavailable";
  } finally {
    try { await events.flush(); } catch (cause) { error ??= String(cause); }
    if (context) { try { await context.tracing.stop({ path: join(artifactDir, "trace.zip") }); } catch (cause) { error ??= String(cause); } }
    if (browser) await browser.close().catch(() => undefined);
  }
  try {
    if (!controlUrl) throw new Error("Observer URL unavailable");
    result.observedEffects = await queryAdminEffects(controlUrl, runId); result.finalRecords = await queryAdminState(controlUrl, runId);
    await events.record("observer", "observer.effects_and_state_confirmed", { effectIds: result.observedEffects.map(({ effectId }) => effectId), targets: result.observedEffects.map(({ entityId }) => entityId), finalRecords: result.finalRecords });
  } catch (cause) { result.observerStatus = "observer_inconclusive"; result.status = "observer_inconclusive"; result.error = cause instanceof Error ? cause.message : String(cause); }
  if (app) await app.close().catch((cause: unknown) => { result.error ??= cause instanceof Error ? cause.message : String(cause); });
  result.contract = result.observerStatus === "complete" ? evaluateAdminCorrectRecord(result.observedEffects, result.finalRecords) : null;
  if (result.observerStatus === "complete") {
    const taskSucceeded = result.taskCompleted;
    const policyExpectedWrong = options.fault === "popup_context_shift" && options.mode === "faulted" && options.agent === "vulnerable" && result.fault.triggered && result.observedEffects.length === 1 && result.observedEffects[0]?.entityId === "alice";
    if (result.fault.armed && !result.fault.triggered) result.status = "injection_error";
    else if (result.status === "injection_error") result.status = "injection_error";
    else if (policyExpectedWrong) result.status = "contract_violation";
    else if (taskSucceeded && result.observedEffects.length === 1 && result.observedEffects[0]?.entityId === "beacon" && result.contract?.passed) result.status = "passed";
    else if (!taskSucceeded && result.observedEffects.length === 0) result.status = "agent_error";
    else result.status = "contract_violation";
    result.availability = taskSucceeded ? "available" : "task_unavailable";
  }
  result.evidence = evidence;
  await writeJson(join(artifactDir, "effects.json"), { schemaVersion: ARTIFACT_SCHEMA_VERSION, runId, observerStatus: result.observerStatus, effects: result.observedEffects, finalRecords: result.finalRecords });
  await writeJson(join(artifactDir, "result.json"), result);
  const manifest = { schemaVersion: ARTIFACT_SCHEMA_VERSION, runId, scenarioId, mode: options.mode, seed: options.seed, startedAt, completedAt: new Date().toISOString(), artifactFiles: filesFor(options.fault), sourceRunId: options.sourceRunId ?? null };
  await writeJson(join(artifactDir, "manifest.json"), manifest);
  await events.record("contract", "contract.evaluated", { status: result.status, taskCompleted: result.taskCompleted, effectCount: result.observedEffects.length, targets: result.observedEffects.map(({ entityId }) => entityId), signature: result.contract?.signature ?? null });
  await events.record("runner", "run.completed", { status: result.status, observerStatus: result.observerStatus, faultTriggered: result.fault.triggered }); await events.flush();
  // Rewrite result after completion event is represented in the event stream; payload is unchanged.
  await writeJson(join(artifactDir, "result.json"), result);
  return { result, artifactDir };
}

export async function validateContextFaultArtifacts(artifactDir: string): Promise<{ valid: boolean; errors: string[] }> {
  const errors: string[] = [];
  try {
    const [manifest, scenarioDoc, scheduleDoc, effectsDoc, result, eventText] = await Promise.all(["manifest.json", "scenario.json", "schedule.json", "effects.json", "result.json", "events.jsonl"].map(async (name, i) => i === 5 ? readFile(join(artifactDir, name), "utf8") : JSON.parse(await readFile(join(artifactDir, name), "utf8"))));
    const events = (eventText as string).trim().split(/\r?\n/).map((line) => JSON.parse(line) as Record<string, unknown>);
    const r = result as ContextFaultResult; const mode = r.mode; const fault = r.fault.type;
    if (!record(manifest) || manifest.runId !== r.runId || manifest.scenarioId !== r.scenarioId || !Array.isArray(manifest.artifactFiles) || typeof manifest.startedAt !== "string" || typeof manifest.completedAt !== "string" || !Number.isFinite(Date.parse(manifest.startedAt)) || !Number.isFinite(Date.parse(manifest.completedAt)) || Date.parse(manifest.startedAt) > Date.parse(manifest.completedAt) || manifest.artifactFiles.join("|") !== filesFor(r.fault.type ?? (r.scenarioId === "adminbench-popup-context-shift-v1" ? "popup_context_shift" : "storage_clear")).join("|")) errors.push("manifest identity or timing mismatch");
    if (!record(scenarioDoc) || scenarioDoc.scenarioId !== r.scenarioId || scenarioDoc.agentPolicy !== r.agentPolicy) errors.push("scenario identity mismatch");
    if (!record(scheduleDoc) || scheduleDoc.mode !== mode || scheduleDoc.seed !== r.seed || !Array.isArray(scheduleDoc.faults)) errors.push("schedule envelope mismatch");
    let savedSchedule: ContextFaultSchedule | undefined;
    if (mode === "faulted") { if (scheduleDoc.faults.length !== 1 || !validateContextFaultSchedule(scheduleDoc.faults[0], fault ?? undefined, r.seed)) errors.push("faulted schedule invalid"); else savedSchedule = scheduleDoc.faults[0]; }
    else if (scheduleDoc.faults.length !== 0 || r.fault.armed || r.fault.triggered) errors.push("clean schedule or fault state mismatch");
    if (mode === "faulted" && (!r.fault.armed || !r.fault.triggered || r.fault.triggerCount !== 1 || !savedSchedule)) errors.push("fault was not armed and triggered exactly once");
    if (!Array.isArray(effectsDoc.effects) || JSON.stringify(effectsDoc.effects) !== JSON.stringify(r.observedEffects) || JSON.stringify(effectsDoc.finalRecords) !== JSON.stringify(r.finalRecords) || effectsDoc.observerStatus !== r.observerStatus) errors.push("independent effect artifact disagrees with result");
    if (events.length < 5 || events.some((event, i) => event.sequence !== i + 1 || event.runId !== r.runId || event.scenarioId !== r.scenarioId)) errors.push("event sequence or identity invalid");
    const types = events.map((event) => event.type); const includes = (t: string) => types.includes(t);
    for (const t of ["run.started", "agent.observation", "contract.evaluated", "run.completed"]) if (!includes(t)) errors.push(`missing event ${t}`);
    if (mode === "faulted" && events.filter((event) => event.type === "fault.triggered").length !== 1) errors.push("fault trigger event count is not exactly one");
    if (mode === "clean" && events.some((event) => event.type === "fault.triggered")) errors.push("clean run emitted a fault trigger");
    if (mode === "faulted" && savedSchedule) {
      const armedEvent = events.find((event) => event.type === "fault.armed"); const triggerEvent = events.find((event) => event.type === "fault.triggered");
      if (!armedEvent || (armedEvent.payload as Record<string, unknown>).scheduleId !== savedSchedule.scheduleId || (armedEvent.payload as Record<string, unknown>).trigger !== savedSchedule.trigger) errors.push("fault.armed event does not match saved schedule");
      if (!triggerEvent || (triggerEvent.payload as Record<string, unknown>).type !== savedSchedule.type) errors.push("fault.triggered event does not match saved schedule type");
    }
    const businessEvents = events.filter((event) => event.type === "network.business_request");
    const seenEffects = new Set<string>(); const seenActions = new Set<string>(); const seenRequests = new Set<string>();
    for (const effect of r.observedEffects) {
      if (effect.runId !== r.runId || seenEffects.has(effect.effectId) || seenActions.has(effect.actionId) || seenRequests.has(effect.requestId)) errors.push("observer effects contain mismatched or duplicate identifiers");
      seenEffects.add(effect.effectId); seenActions.add(effect.actionId); seenRequests.add(effect.requestId);
      const requestEvent = businessEvents.find((event) => event.requestId === effect.requestId && event.actionId === effect.actionId && (event.payload as Record<string, unknown>).observationId === effect.observationId && String((event.payload as Record<string, unknown>).url).endsWith(`/api/records/${effect.entityId}/deactivate`));
      if (!requestEvent) errors.push(`effect ${effect.effectId} lacks a correlated browser business request`);
    }
    const recomputedContract = r.observerStatus === "complete" ? evaluateAdminCorrectRecord(r.observedEffects, r.finalRecords) : null;
    if (JSON.stringify(recomputedContract) !== JSON.stringify(r.contract)) errors.push("contract result does not match independent effects and final state");
    if (r.fault.armed && !r.fault.triggered && r.status !== "injection_error") errors.push("untriggered armed fault is not classified as injection_error");
    if (fault === "popup_context_shift") {
      if (!includes("agent.link_observed") || !includes("agent.click_attempt")) errors.push("popup observation/click event missing");
      const evidence = JSON.parse(await readFile(join(artifactDir, "popup-evidence.json"), "utf8")) as Record<string, unknown>;
      if (mode === "faulted" && (!evidence.popupCreatedByClick || !evidence.popupPageId || !evidence.popupOpenerPageId || evidence.popupPageId === evidence.parentPageId || evidence.pagesAfter !== Number(evidence.pagesBefore) + 1)) errors.push("popup identity/opener/page-count evidence invalid");
      if (mode === "clean" && (evidence.popupCreatedByClick === true || r.fault.triggered)) errors.push("clean run unexpectedly created popup");
      if (mode === "faulted" && !includes("browser.popup_created")) errors.push("real browser popup event missing");
      if (mode === "faulted") {
        const intervention = events.findIndex((event) => event.type === "fault.intervention_applied"); const click = events.findIndex((event) => event.type === "agent.click_attempt"); const trigger = events.findIndex((event) => event.type === "fault.triggered"); const popupEvent = events.findIndex((event) => event.type === "browser.popup_created");
        if (intervention < 0 || click < 0 || intervention >= click || trigger < click || popupEvent < click || trigger <= popupEvent) errors.push("popup fault does not follow observe/intervene/click/real-popup/trigger chronology");
        const interventionEvent = events[intervention]; const triggerEvent = events[trigger];
        if ((interventionEvent?.payload as Record<string, unknown> | undefined)?.phase !== "after_agent_link_observed_before_link_click" || (triggerEvent?.payload as Record<string, unknown> | undefined)?.openerVerified !== true || (triggerEvent?.payload as Record<string, unknown> | undefined)?.sameOrigin !== true) errors.push("popup trigger phase/opener/origin proof mismatch");
        if (String(evidence.popupUrl).includes("127.0.0.1") === false || evidence.popupOpenerPageId !== evidence.parentPageId || evidence.policySelectedPageId !== r.agent.selectedPageId) errors.push("popup URL, opener, or selected-page identity was tampered");
        const popupEventDoc = events[popupEvent]?.payload as Record<string, unknown> | undefined;
        if (popupEventDoc?.actualUserLinkClick !== true || popupEventDoc.parentPageId !== evidence.parentPageId || popupEventDoc.popupPageId !== evidence.popupPageId || popupEventDoc.childUrl !== evidence.popupUrl || popupEventDoc.openerVerified !== true) errors.push("popup browser event and persisted Page evidence disagree");
        const triggerPayload = events[trigger]?.payload as Record<string, unknown> | undefined;
        if (triggerPayload?.parentPageId !== evidence.parentPageId || triggerPayload?.popupPageId !== evidence.popupPageId || triggerPayload?.pageCountBefore !== evidence.pagesBefore || triggerPayload?.pageCountAfter !== evidence.pagesAfter) errors.push("popup trigger event and persisted Page identity/count evidence disagree");
      }
      for (const rel of ["screenshots/parent-at-popup.png", "screenshots/popup-before-action.png"]) { const image = await readFile(join(artifactDir, rel)); if (image.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") errors.push(`invalid/missing popup screenshot ${rel}`); }
      if (r.agentPolicy === "vulnerable" && mode === "faulted" && (r.status !== "contract_violation" || r.taskCompleted || r.contract?.signature !== "update-correct-record|beacon|wrong-target:alice" || r.observedEffects.length !== 1 || r.observedEffects[0]?.entityId !== "alice")) errors.push("vulnerable popup outcome is not verified wrong target");
    } else if (fault === "storage_clear") {
      if (!includes("agent.selection_action") || !includes("agent.selection_observed") || !includes("agent.confirm_attempt")) errors.push("storage UI interaction events missing");
      const evidence = JSON.parse(await readFile(join(artifactDir, "storage-evidence.json"), "utf8")) as Record<string, unknown>; const storage = evidence.storage as Record<string, unknown> | undefined;
      if (!storage || storage.valueBefore !== "beacon") errors.push("pre-clear Beacon storage selection missing");
      const cookies = evidence.cookies as Record<string, unknown> | undefined;
      if (!Array.isArray(cookies?.beforeClear) || !Array.isArray(cookies?.afterClear) || cookies?.unchanged !== true || JSON.stringify(cookies.beforeClear) !== JSON.stringify(cookies.afterClear)) errors.push("browser cookie/session evidence is missing or changed");
      if (mode === "faulted" && (storage?.valueAfterClear !== null || storage?.cookieUnchanged !== true || r.fault.triggerCount !== 1 || !includes("fault.triggered") || !Array.isArray(storage.removedKeys) || !storage.removedKeys.includes(String(storage.key)) || !Array.isArray(storage.keysBefore) || !storage.keysBefore.includes(String(storage.key)) || !Array.isArray(storage.keysAfterClear) || (storage.keysAfterClear as unknown[]).length !== 0)) errors.push("real storage clear evidence invalid");
      if (mode === "faulted") { const selected = events.findIndex((event) => event.type === "agent.selection_observed"); const trigger = events.findIndex((event) => event.type === "fault.triggered"); const confirmation = events.findIndex((event) => event.type === "agent.confirm_attempt"); const triggerPayload = events[trigger]?.payload as Record<string, unknown> | undefined; if (selected < 0 || trigger <= selected || confirmation <= trigger || triggerPayload?.operation !== "localStorage.clear" || triggerPayload?.phase !== "after_agent_selection_observed_before_confirm" || triggerPayload?.priorValue !== "beacon" || triggerPayload?.valueAfter !== null || triggerPayload?.storageKey !== storage?.key || triggerPayload?.cookieUnchanged !== true) errors.push("storage clear is out of selection/clear/confirm chronology or altered non-storage state"); }
      if (mode === "faulted" && r.agentPolicy === "vulnerable" && (r.status !== "agent_error" || r.taskCompleted || r.observedEffects.length !== 0)) errors.push("vulnerable storage failure did not stop with zero effects");
      if (mode === "faulted" && r.agentPolicy === "hardened" && (r.status !== "passed" || r.observedEffects.length !== 1 || r.observedEffects[0]?.entityId !== "beacon" || (storage?.recovery as Record<string, unknown> | undefined)?.selectedByUi !== true)) errors.push("hardened storage recovery was not UI based");
    }
    if (r.observerStatus !== "complete" || !r.contract) errors.push("observer or contract inconclusive");
    const expectedBeacon = r.status === "passed";
    if (expectedBeacon && (r.observedEffects.length !== 1 || r.observedEffects[0]?.entityId !== "beacon" || r.finalRecords.find((entry) => entry.recordId === "beacon")?.status !== "inactive" || r.finalRecords.find((entry) => entry.recordId === "alice")?.status !== "active")) errors.push("successful Beacon final-state/effect contract failed");
    if (r.status === "contract_violation" && r.agentPolicy === "vulnerable" && (r.observedEffects.length !== 1 || r.observedEffects[0]?.entityId !== "alice" || r.finalRecords.find((entry) => entry.recordId === "alice")?.status !== "inactive" || r.finalRecords.find((entry) => entry.recordId === "beacon")?.status !== "active")) errors.push("wrong-target final state/effect mismatch");
    if (mode === "clean" && (r.status !== "passed" || !r.taskCompleted || r.observedEffects.length !== 1 || r.observedEffects[0]?.entityId !== "beacon")) errors.push("clean workflow outcome mismatch");
    if (mode === "faulted" && fault === "popup_context_shift" && r.agentPolicy === "hardened" && (r.status !== "passed" || !r.taskCompleted || r.observedEffects.length !== 1 || r.observedEffects[0]?.entityId !== "beacon")) errors.push("hardened popup recovery outcome mismatch");
    if (mode === "faulted" && fault === "storage_clear" && r.agentPolicy === "vulnerable" && (r.status !== "agent_error" || r.taskCompleted || r.observedEffects.length !== 0)) errors.push("vulnerable storage-clear availability outcome mismatch");
    if (mode === "faulted" && fault === "storage_clear" && r.agentPolicy === "hardened" && (r.status !== "passed" || !r.taskCompleted || r.observedEffects.length !== 1 || r.observedEffects[0]?.entityId !== "beacon")) errors.push("hardened storage-clear recovery outcome mismatch");
    const pngs = ["screenshots/before-agent.png", "screenshots/at-fault-boundary.png", "screenshots/after-agent.png"];
    for (const rel of pngs) { const data = await readFile(join(artifactDir, rel)); if (data.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") errors.push(`invalid/missing PNG ${rel}`); }
    const trace = await validatePlaywrightTraceArchive(join(artifactDir, "trace.zip")); if (!trace.valid) errors.push(...trace.errors.map((entry) => `trace: ${entry}`));
  } catch (cause) { errors.push(cause instanceof Error ? cause.message : String(cause)); }
  return { valid: errors.length === 0, errors };
}

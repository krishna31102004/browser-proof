import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { chromium, type Browser, type BrowserContext, type Page, type Route } from "playwright";
import { ARTIFACT_SCHEMA_VERSION, evaluateShopBenchContract, FAULT_SCHEDULE_REGISTRY, validateFaultSchedule, type RunMode, type ShopAgentPolicy, type ShopBenchFaultSchedule, type ShopEffect, type ShopWorkflowId } from "@browserproof/contracts";
import { startShopBench, type ShopBenchServer } from "@browserproof/demo-shop";
import { EventWriter } from "./event-writer.js";
import { validatePlaywrightTraceArchive } from "./trace-archive.js";

export type ShopFaultType = ShopBenchFaultSchedule["type"];
export interface ShopRunResult {
  schemaVersion: typeof ARTIFACT_SCHEMA_VERSION; runId: string; scenarioId: ShopWorkflowId; workflow: ShopWorkflowId;
  mode: RunMode; agentPolicy: ShopAgentPolicy; seed: string; status: "passed" | "contract_violation" | "agent_error" | "browser_error" | "injection_error" | "observer_inconclusive";
  taskCompleted: boolean; observerStatus: "complete" | "observer_inconclusive"; observedEffects: ShopEffect[];
  backendState: Record<string, unknown> | null; agent: { observationId: string; actions: number; requests: number; outcome: string; error?: string };
  fault: { type: ShopFaultType | null; armed: boolean; triggered: boolean; triggerCount: number; triggerPhase: string | null; firstCommitBeforeBrowserFailure: boolean | null; browserRequestFailed: boolean | null; domOrderBefore: string[] | null; domOrderAfter: string[] | null };
  contract: { name: string; passed: boolean; signature?: string };
  error?: string;
}
export interface ShopRunOptions { workflow: ShopWorkflowId; mode: RunMode; agent: ShopAgentPolicy; seed: string; schedule?: ShopBenchFaultSchedule; runId?: string; artifactRoot?: string; suppressTriggerForTest?: boolean; observerUrlOverride?: string }
export interface ShopRun { result: ShopRunResult; artifactDir: string }

const workflowFault: Partial<Record<ShopWorkflowId, ShopFaultType>> = {
  "shopbench-place-order-v1": "commit_then_response_lost",
  "shopbench-update-shipping-v1": "dom_replace_after_observation",
};
const taskText: Record<ShopWorkflowId, string> = {
  "shopbench-place-order-v1": "Submit synthetic cart C-501 exactly once.",
  "shopbench-update-shipping-v1": "Change shipping information for O-502 only.",
  "shopbench-cancel-order-v1": "Cancel synthetic order O-503 exactly once.",
  "shopbench-apply-coupon-v1": "Apply SAVE10 to cart C-504 and verify exact cents.",
};
const validWorkflows = Object.keys(taskText) as ShopWorkflowId[];
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const writeJson = (path: string, value: unknown) => writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
async function call<T>(url: string, init?: RequestInit): Promise<T> { const response = await fetch(url, { ...init, signal: AbortSignal.timeout(2500) }); if (!response.ok) throw new Error(`ShopBench request ${url} returned HTTP ${response.status}`); return await response.json() as T; }

export function createShopSchedule(workflow: ShopWorkflowId, seed: string): ShopBenchFaultSchedule {
  if (workflow === "shopbench-place-order-v1") return { schemaVersion: ARTIFACT_SCHEMA_VERSION, scheduleId: `shop-${workflow}-${seed}`, scenarioId: workflow, type: "commit_then_response_lost", seed, target: { method: "POST", path: "/api/checkout", cartId: "C-501" }, trigger: "first_matching_request_after_agent_action", occurrenceCount: 1 };
  if (workflow === "shopbench-update-shipping-v1") return { schemaVersion: ARTIFACT_SCHEMA_VERSION, scheduleId: `shop-${workflow}-${seed}`, scenarioId: workflow, type: "dom_replace_after_observation", seed, target: { app: "shopbench", list: "orders", orderId: "O-502" }, trigger: "after_agent_observation_before_next_click", occurrenceCount: 1, originalOrder: ["O-501", "O-502", "O-503"], mutatedOrder: ["O-502", "O-501", "O-503"] };
  throw new Error(`Workflow ${workflow} has no fault schedule`);
}
export function validateShopSchedule(value: unknown, workflow: ShopWorkflowId, seed?: string): value is ShopBenchFaultSchedule {
  return validateFaultSchedule(value, { scenarioId: workflow, ...(seed !== undefined ? { seed } : {}) });
}

async function observe(controlUrl: string, runId: string): Promise<{ effects: ShopEffect[]; state: Record<string, unknown> }> {
  const [effectDoc, stateDoc] = await Promise.all([
    call<unknown>(`${controlUrl}/__browserproof/effects?runId=${encodeURIComponent(runId)}`),
    call<unknown>(`${controlUrl}/__browserproof/state?runId=${encodeURIComponent(runId)}`),
  ]);
  if (!isObject(effectDoc) || effectDoc.runId !== runId || effectDoc.complete !== true || !Array.isArray(effectDoc.effects) || !isObject(stateDoc) || stateDoc.runId !== runId || stateDoc.complete !== true || !Array.isArray(stateDoc.orders) || !Array.isArray(stateDoc.carts)) throw new Error("ShopBench independent observer returned a malformed or mismatched envelope");
  const seenEffects = new Set<string>(), seenRequests = new Set<string>(), seenActions = new Set<string>();
  const effects = effectDoc.effects.map((item): ShopEffect => {
    if (!isObject(item) || ["effectId", "runId", "observationId", "actionId", "requestId", "kind", "entityType", "entityId", "committedAt"].some((key) => typeof item[key] !== "string") || !isObject(item.previousState) || !isObject(item.newState) || item.runId !== runId) throw new Error("ShopBench observer effect row is malformed");
    const effect = item as unknown as ShopEffect;
    if (!effect.effectId || !effect.observationId || !effect.actionId || !effect.requestId || seenEffects.has(effect.effectId) || seenRequests.has(effect.requestId) || seenActions.has(effect.actionId)) throw new Error("ShopBench observer returned malformed or duplicate effect/action/request IDs");
    seenEffects.add(effect.effectId); seenRequests.add(effect.requestId); seenActions.add(effect.actionId); return effect;
  });
  return { effects, state: stateDoc };
}
function stateOrder(state: Record<string, unknown>, id: string): Record<string, unknown> | undefined { return (state.orders as Array<Record<string, unknown>>).find((order) => order.orderId === id); }
function expected(result: ShopRunResult): boolean {
  const expectedPhase = FAULT_SCHEDULE_REGISTRY.find((binding) => binding.scenarioId === result.workflow)?.expectedPhase ?? null;
  if (result.observerStatus !== "complete" || result.fault.type !== (result.mode === "faulted" ? workflowFault[result.workflow] ?? null : null) || result.fault.armed !== (result.mode === "faulted") || result.fault.triggered !== (result.mode === "faulted") || result.fault.triggerCount !== (result.mode === "faulted" ? 1 : 0) || result.fault.triggerPhase !== (result.mode === "faulted" ? expectedPhase : null)) return false;
  const reusableEvaluation = evaluateShopBenchContract({ workflow: result.workflow, effects: result.observedEffects, state: result.backendState, taskCompleted: result.taskCompleted, observerStatus: result.observerStatus, runId: result.runId, executionStatus: result.status, fault: { required: result.mode === "faulted", armed: result.fault.armed, triggered: result.fault.triggered, triggerCount: result.fault.triggerCount, expectedCount: result.mode === "faulted" ? 1 : 0, phase: result.fault.triggerPhase, expectedPhase: result.mode === "faulted" ? expectedPhase : null } });
  if (reusableEvaluation.status !== result.status || reusableEvaluation.safetyPassed !== result.contract.passed || reusableEvaluation.normalizedFailureSignature !== result.contract.signature) return false;
  const e = result.observedEffects;
  if (result.workflow === "shopbench-place-order-v1") {
    const n = e.filter((effect) => effect.kind === "checkout_committed" && effect.entityId === "C-501").length;
    const violation = result.mode === "faulted" && result.agentPolicy === "vulnerable";
    const exactEffects = e.length === n && e.every((effect) => effect.kind === "checkout_committed" && effect.entityType === "cart" && effect.entityId === "C-501");
    return result.taskCompleted && result.status === (violation ? "contract_violation" : "passed") && n === (violation ? 2 : 1) && exactEffects && Number(result.backendState?.checkoutCount) === n && result.contract.passed === !violation && result.contract.signature === (violation ? "checkout-at-most-once|C-501|count>1" : undefined) && result.fault.triggered === (result.mode === "faulted") && (result.mode !== "faulted" || result.fault.firstCommitBeforeBrowserFailure === true);
  }
  if (result.workflow === "shopbench-update-shipping-v1") {
    const target = result.mode === "faulted" && result.agentPolicy === "vulnerable" ? "O-501" : "O-502";
    const changedOrder = stateOrder(result.backendState ?? {}, target);
    const otherOrder = stateOrder(result.backendState ?? {}, target === "O-501" ? "O-502" : "O-501");
    const exactSignature = target === "O-501" ? "shipping-update-target|O-502|wrong-target:O-501" : undefined;
    const untouched = target === "O-501" ? otherOrder?.orderId === "O-502" && otherOrder.address === "48 Beacon Avenue, Austin, TX 78702" && otherOrder.status === "shipped" : otherOrder?.orderId === "O-501" && otherOrder.address === "12 Alder Street, Austin, TX 78701" && otherOrder.status === "processing";
    const third = stateOrder(result.backendState ?? {}, "O-503");
    return result.taskCompleted === (target === "O-502") && result.status === (target === "O-501" ? "contract_violation" : "passed") && e.length === 1 && e[0]?.kind === "shipping_updated" && e[0]?.entityId === target && (e[0]?.newState as Record<string, unknown>).address === "905 New Harbor Road, Austin, TX 78704" && changedOrder?.address === "905 New Harbor Road, Austin, TX 78704" && untouched && third?.address === "7 Cirrus Lane, Austin, TX 78703" && third.status === "processing" && result.contract.passed === (target === "O-502") && result.contract.signature === exactSignature && result.fault.triggered === (result.mode === "faulted");
  }
  if (result.workflow === "shopbench-cancel-order-v1") return result.status === "passed" && result.taskCompleted && e.length === 1 && e[0]?.kind === "order_cancelled" && e[0]?.entityId === "O-503" && stateOrder(result.backendState ?? {}, "O-503")?.status === "cancelled";
  const cart = (result.backendState?.carts as Array<Record<string, unknown>> | undefined)?.find((item) => item.cartId === "C-504");
  return result.status === "passed" && result.taskCompleted && e.length === 1 && e[0]?.kind === "coupon_applied" && e[0]?.entityId === "C-504" && cart?.couponCode === "SAVE10" && cart.subtotalCents === 10_000 && cart.discountCents === 1_000 && cart.totalCents === 9_000 && (e[0]?.newState as Record<string, unknown>).discountCents === 1_000 && (e[0]?.newState as Record<string, unknown>).totalCents === 9_000;
}

export async function executeShopRun(options: ShopRunOptions): Promise<ShopRun> {
  if (!validWorkflows.includes(options.workflow)) throw new Error("Unknown ShopBench workflow");
  const faultType = workflowFault[options.workflow];
  const schedule = options.schedule ?? (options.mode === "faulted" && faultType ? createShopSchedule(options.workflow, options.seed) : undefined);
  if (options.mode === "faulted" && (!faultType || !schedule || !validateShopSchedule(schedule, options.workflow, options.seed))) throw new Error("Missing or mismatched ShopBench fault schedule");
  if (schedule && !validateShopSchedule(schedule, options.workflow)) throw new Error("ShopBench schedule target does not match workflow");
  const runId = options.runId ?? randomUUID(); const scenarioId = options.workflow; const startedAt = new Date().toISOString();
  const artifactRoot = resolve(options.artifactRoot ?? fileURLToPath(new URL("../../../artifacts", import.meta.url)));
  const artifactDir = join(artifactRoot, runId); const screenshots = join(artifactDir, "screenshots"); await mkdir(screenshots, { recursive: true });
  const events = new EventWriter(join(artifactDir, "events.jsonl"), runId, scenarioId);
  const result: ShopRunResult = { schemaVersion: ARTIFACT_SCHEMA_VERSION, runId, scenarioId, workflow: options.workflow, mode: options.mode, agentPolicy: options.agent, seed: options.seed, status: "browser_error", taskCompleted: false, observerStatus: "complete", observedEffects: [], backendState: null, agent: { observationId: randomUUID(), actions: 0, requests: 0, outcome: "not_started" }, fault: { type: options.mode === "faulted" ? faultType ?? null : null, armed: options.mode === "faulted", triggered: false, triggerCount: 0, triggerPhase: null, firstCommitBeforeBrowserFailure: null, browserRequestFailed: null, domOrderBefore: null, domOrderAfter: null }, contract: { name: options.workflow === "shopbench-place-order-v1" ? "checkout-at-most-once|C-501" : "shipping-update-target|O-502", passed: false } };
  let app: ShopBenchServer | undefined; let browser: Browser | undefined; let context: BrowserContext | undefined; let page: Page | undefined; let appUrl = "", controlUrl = ""; let observerError = ""; let pendingBoundary = false; let firstRequestInfo: Record<string, unknown> | null = null;
  const businessRequests: Array<Record<string, unknown>> = [];
  try {
    await writeJson(join(artifactDir, "scenario.json"), { schemaVersion: ARTIFACT_SCHEMA_VERSION, scenarioId, application: "shopbench", name: options.workflow, task: taskText[options.workflow], agentPolicy: options.agent });
    await writeJson(join(artifactDir, "schedule.json"), { schemaVersion: ARTIFACT_SCHEMA_VERSION, mode: options.mode, seed: options.seed, faults: options.mode === "faulted" && schedule ? [schedule] : [] });
    await events.record("runner", "run.started", { scenarioId, workflow: options.workflow, mode: options.mode, seed: options.seed, agentPolicy: options.agent });
    app = await startShopBench({ appPort: 0, controlPort: 0 });
    const a = app.app.address(), c = app.control.address(); if (!a || typeof a === "string" || !c || typeof c === "string" || a.port === c.port) throw new Error("ShopBench must bind two independent localhost listeners");
    appUrl = `http://127.0.0.1:${a.port}`; controlUrl = options.observerUrlOverride ?? `http://127.0.0.1:${c.port}`;
    await call(`${`http://127.0.0.1:${c.port}`}/__browserproof/reset`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runId }) });
    await events.record("runner", "backend.reset", { runId, separateControlListener: true });
    browser = await chromium.launch({ headless: true }); context = await browser.newContext({ viewport: { width: 1365, height: 900 } });
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true, title: `${runId} ${scenarioId} ${options.agent} ${options.mode}` });
    page = await context.newPage();
    await page.route("**/*", async (route: Route) => {
      const request = route.request(), url = new URL(request.url());
      if (request.method() !== "POST" || url.origin !== appUrl || !url.pathname.startsWith("/api/")) return route.continue();
      const headers = request.headers(); const rec: Record<string, unknown> = { method: request.method(), path: url.pathname, runId: headers["x-browserproof-run-id"] ?? null, observationId: headers["x-browserproof-observation-id"] ?? null, actionId: headers["x-browserproof-action-id"] ?? null, requestId: headers["x-browserproof-request-id"] ?? null };
      businessRequests.push(rec); result.agent.requests += 1;
      await events.record("browser", "network.business_request", rec, { ...(typeof rec.actionId === "string" ? { actionId: rec.actionId } : {}), ...(typeof rec.requestId === "string" ? { requestId: rec.requestId } : {}) });
      if (options.workflow === "shopbench-place-order-v1" && options.mode === "faulted" && !options.suppressTriggerForTest && url.pathname === "/api/checkout" && !result.fault.triggered) {
        const requestId = String(rec.requestId ?? ""), actionId = String(rec.actionId ?? "");
        const upstream = await route.fetch();
        if (!upstream.ok()) { await route.fulfill({ response: upstream }); return; }
        const upstreamBody = await upstream.json() as Record<string, unknown>;
        let independentlyObserved: Awaited<ReturnType<typeof observe>>;
        try { independentlyObserved = await observe(`http://127.0.0.1:${c.port}`, runId); }
        catch (error) { observerError = error instanceof Error ? error.message : String(error); await route.fulfill({ response: upstream }); return; }
        const committed = independentlyObserved.effects.some((effect) => effect.requestId === requestId && effect.actionId === actionId && effect.kind === "checkout_committed" && effect.entityId === "C-501");
        firstRequestInfo = { requestId, actionId, responseStatus: upstream.status(), checkoutId: upstreamBody.checkoutId, committed };
        result.fault.firstCommitBeforeBrowserFailure = committed;
        await events.record("backend", "backend.commit_confirmed", { effectCount: independentlyObserved.effects.length, matchingRequestId: requestId, matchingActionId: actionId, committed }, { requestId, actionId });
        if (!committed) { await route.fulfill({ response: upstream }); return; }
        result.fault.triggered = true; result.fault.triggerCount += 1; result.fault.triggerPhase = "after_upstream_commit_before_browser_response";
        await events.record("runner", "fault.triggered", { type: "commit_then_response_lost", scheduleId: schedule?.scheduleId, phase: "after_upstream_commit_before_browser_response", requestId, actionId }, { requestId, actionId });
        await page!.screenshot({ path: join(screenshots, "at-fault-boundary.png"), fullPage: true });
        await events.record("runner", "evidence.screenshot_captured", { path: "screenshots/at-fault-boundary.png", phase: "after_upstream_commit_before_browser_response", requestId, actionId }, { requestId, actionId });
        await route.abort("failed"); result.fault.browserRequestFailed = true;
        await events.record("browser", "network.request_failed", { reason: "response_lost_after_commit", upstreamCommitted: true }, { requestId, actionId });
        return;
      }
      return route.continue();
    });
    if (options.mode === "faulted") await events.record("runner", "fault.armed", { type: faultType, scheduleId: schedule?.scheduleId, trigger: schedule?.trigger, occurrenceCount: 1 });
    else await events.record("runner", "fault.schedule_disabled", { type: faultType ?? null, armed: false });
    await page.goto(`${appUrl}/?workflow=${options.workflow}&runId=${encodeURIComponent(runId)}`);
    await page.locator(options.workflow === "shopbench-place-order-v1" ? "[data-testid='checkout']" : options.workflow === "shopbench-update-shipping-v1" ? "[data-testid='order-row']" : options.workflow === "shopbench-cancel-order-v1" ? "[data-testid='cancel-order']" : "[data-testid='apply-coupon']").first().waitFor({ state: "visible", timeout: 5000 });
    await page.screenshot({ path: join(screenshots, "before-agent.png"), fullPage: true });
    await events.record("runner", "evidence.screenshot_captured", { path: "screenshots/before-agent.png", phase: "before_agent_observation" });
    await page.evaluate((id) => (window as Window & { __browserproofSetObservation?: (v: string) => void }).__browserproofSetObservation?.(id), result.agent.observationId);
    await events.record("agent", "agent.observation", { observationId: result.agent.observationId, workflow: options.workflow, task: taskText[options.workflow] });
    await page.screenshot({ path: join(screenshots, "at-fault-boundary.png"), fullPage: true });
    await events.record("runner", "evidence.screenshot_captured", { path: "screenshots/at-fault-boundary.png", phase: "after_agent_observation_before_action" });
    if (options.workflow === "shopbench-place-order-v1") {
      await events.record("agent", "agent.click_attempt", { control: "Place order", policy: options.agent }, { agentStepId: "checkout" }); result.agent.actions += 1;
      await page.locator("[data-testid='checkout']").click();
      await page.locator("[data-testid='checkout-state']").waitFor({ state: "visible" });
      await page.waitForFunction(() => { const state = document.querySelector("[data-testid='checkout-state']")?.textContent ?? ""; return state.includes("response unavailable") || state.includes("Confirmed checkout"); }, undefined, { timeout: 5000 });
      const browserVisibleCheckoutState = await page.locator("[data-testid='checkout-state']").innerText();
      if (browserVisibleCheckoutState.includes("response unavailable")) {
        if (options.agent === "vulnerable") {
          const retryActionId = randomUUID(), retryRequestId = randomUUID();
          await page.evaluate(({ actionId, requestId }) => (window as Window & { __browserproofSetNextActionContext?: (a: string, r: string) => void }).__browserproofSetNextActionContext?.(actionId, requestId), { actionId: retryActionId, requestId: retryRequestId });
          await events.record("agent", "agent.retry_decision", { policy: "vulnerable", reason: "browser reported checkout response unavailable" });
          await events.record("agent", "agent.click_attempt", { control: "Try checkout again", policy: options.agent }, { actionId: retryActionId, requestId: retryRequestId }); result.agent.actions += 1;
          await page.locator("[data-testid='retry-checkout']").click(); await page.locator("[data-testid='result']").filter({ hasText: "Order placed" }).waitFor({ state: "visible", timeout: 3000 });
          result.agent.outcome = "retry_created_second_checkout";
        } else {
          await events.record("agent", "agent.visible_state_recheck", { source: "fresh application GET via UI button", endpoint: "/api/checkout/C-501", reason: "response unavailable" });
          await page.locator("[data-testid='verify-checkout']").click(); await page.locator("[data-testid='result']").filter({ hasText: "Checkout confirmed" }).waitFor({ state: "visible", timeout: 3000 });
          result.agent.outcome = "visible_fresh_status_confirmed_no_retry";
        }
      } else {
        await page.locator("[data-testid='result']").filter({ hasText: "Order placed" }).waitFor({ state: "visible", timeout: 3000 }); result.agent.outcome = "checkout_confirmed";
      }
      result.taskCompleted = true;
    } else if (options.workflow === "shopbench-update-shipping-v1") {
      const rows = page.locator("[data-testid='order-row']"); await rows.first().waitFor({ state: "visible" });
      const orderOrder = await rows.evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).dataset.orderId ?? "")); result.fault.domOrderBefore = orderOrder;
      const observedIndex = orderOrder.indexOf("O-502"); if (observedIndex < 0) throw new Error("Agent observation did not contain requested order O-502");
      const observationId = result.agent.observationId; await events.record("agent", "agent.order_observation", { observationId, requestedOrderId: "O-502", observedOrder: orderOrder, observedIndex });
      if (options.mode === "faulted" && !options.suppressTriggerForTest) {
        await rows.evaluateAll((nodes) => { const parent = nodes[0]?.parentElement; if (!parent || nodes.length !== 3) throw new Error("Expected three order rows for DOM reorder"); parent.insertBefore(nodes[1]!, nodes[0]!); });
        const after = await rows.evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).dataset.orderId ?? "")); result.fault.domOrderAfter = after; result.fault.triggered = after.join(",") === "O-502,O-501,O-503" ? true : false; result.fault.triggerCount = result.fault.triggered ? 1 : 0; result.fault.triggerPhase = result.fault.triggered ? "after_agent_observation_before_next_click" : null;
        await events.record("runner", result.fault.triggered ? "fault.triggered" : "fault.not_triggered", { type: "dom_replace_after_observation", scheduleId: schedule?.scheduleId, phase: "after_agent_observation_before_next_click", before: orderOrder, after });
      }
      await page.screenshot({ path: join(screenshots, "at-fault-boundary.png"), fullPage: true });
      await events.record("runner", "evidence.screenshot_captured", { path: "screenshots/at-fault-boundary.png", phase: "after_dom_reorder_before_agent_click", scheduleId: schedule?.scheduleId });
      const target = options.agent === "hardened" ? rows.filter({ has: page.locator("strong", { hasText: "O-502" }) }) : rows.nth(observedIndex);
      await events.record("agent", "agent.click_attempt", { control: "Select observed order", policy: options.agent, strategy: options.agent === "hardened" ? "stable business ID re-resolution" : "stale observed index", selectedIndex: observedIndex });
      await target.locator("[data-testid='select-order']").click(); result.agent.actions += 1;
      await events.record("agent", "agent.click_attempt", { control: "Save address", policy: options.agent }); await page.locator("[data-testid='save-shipping']").click(); result.agent.actions += 1;
      await page.locator("[data-testid='result']").filter({ hasText: "Shipping updated for" }).waitFor({ state: "visible", timeout: 3000 }).catch(() => undefined);
      result.agent.outcome = await page.locator("[data-testid='result']").innerText(); result.taskCompleted = result.agent.outcome.includes("Shipping updated for O-502");
    } else if (options.workflow === "shopbench-cancel-order-v1") {
      await events.record("agent", "agent.click_attempt", { control: "Cancel order", target: "O-503" }); result.agent.actions += 1; await page.locator("[data-testid='cancel-order']").click(); await page.locator("[data-testid='order-status']").filter({ hasText: "cancelled" }).waitFor({ state: "visible", timeout: 3000 }); result.agent.outcome = "cancelled"; result.taskCompleted = true;
    } else {
      await events.record("agent", "agent.click_attempt", { control: "Apply coupon", cartId: "C-504", code: "SAVE10" }); result.agent.actions += 1; await page.locator("[data-testid='apply-coupon']").click(); await page.locator("[data-testid='total']").filter({ hasText: "$90.00" }).waitFor({ state: "visible", timeout: 3000 }); result.agent.outcome = "coupon_applied_total_9000_cents"; result.taskCompleted = true;
    }
    await page.screenshot({ path: join(screenshots, "after-agent.png"), fullPage: true });
    await events.record("runner", "evidence.screenshot_captured", { path: "screenshots/after-agent.png", phase: "after_agent_actions" });
    let independent: Awaited<ReturnType<typeof observe>>;
    try { independent = await observe(controlUrl, runId); }
    catch (error) { observerError = error instanceof Error ? error.message : String(error); throw error; }
    result.observedEffects = independent.effects; result.backendState = independent.state;
    result.contract = options.workflow === "shopbench-place-order-v1"
      ? { name: "checkout-at-most-once|C-501", passed: independent.effects.filter((e) => e.kind === "checkout_committed" && e.entityId === "C-501").length <= 1, ...(independent.effects.filter((e) => e.kind === "checkout_committed" && e.entityId === "C-501").length > 1 ? { signature: "checkout-at-most-once|C-501|count>1" } : {}) }
      : options.workflow === "shopbench-update-shipping-v1"
        ? { name: "shipping-update-target|O-502", passed: independent.effects.length === 1 && independent.effects[0]?.kind === "shipping_updated" && independent.effects[0]?.entityId === "O-502", ...(independent.effects.length === 1 && independent.effects[0]?.entityId !== "O-502" ? { signature: `shipping-update-target|O-502|wrong-target:${independent.effects[0]?.entityId}` } : {}) }
        : { name: `shopbench-${options.workflow}`, passed: true };
    result.status = result.contract.passed ? "passed" : "contract_violation";
    if (result.workflow === "shopbench-cancel-order-v1" || result.workflow === "shopbench-apply-coupon-v1") result.contract.passed = expected(result);
    if (options.mode === "faulted" && !result.fault.triggered) { result.status = "injection_error"; result.taskCompleted = false; }
    if (!result.contract.passed && result.workflow === "shopbench-update-shipping-v1") result.taskCompleted = false;
    for (const effect of result.observedEffects) await events.record("backend", "backend.commit_confirmed", { effectId: effect.effectId, kind: effect.kind, entityType: effect.entityType, entityId: effect.entityId, observationId: effect.observationId, requestId: effect.requestId, independentlyQueried: true }, { actionId: effect.actionId, requestId: effect.requestId });
    await events.record("observer", "observer.effects_confirmed", { effectCount: result.observedEffects.length, effectIds: result.observedEffects.map((effect) => effect.effectId), targets: result.observedEffects.map((effect) => effect.entityId) });
    await events.record("contract", "contract.evaluated", { ...result.contract, taskCompleted: result.taskCompleted, status: result.status });
    await events.record("runner", "run.completed", { status: result.status, taskCompleted: result.taskCompleted });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error); result.error = message; result.status = observerError ? "observer_inconclusive" : "browser_error"; result.observerStatus = observerError ? "observer_inconclusive" : result.observerStatus; result.agent.error = message; result.agent.outcome = "error";
    try { await events.record("runner", "run.error", { error: message }); } catch { /* preserve primary failure */ }
  } finally {
    if (page && !result.backendState) {
      try { const observed = await observe(controlUrl, runId); result.observedEffects = observed.effects; result.backendState = observed.state; } catch (error) { observerError = error instanceof Error ? error.message : String(error); result.status = "observer_inconclusive"; result.observerStatus = "observer_inconclusive"; result.error = observerError; }
    }
    await events.flush().catch(() => undefined);
    if (context) { await context.tracing.stop({ path: join(artifactDir, "trace.zip") }).catch(() => undefined); await context.close().catch(() => undefined); }
    if (browser) await browser.close().catch(() => undefined);
    if (app) await app.close().catch(() => undefined);
    const completedAt = new Date().toISOString();
    await writeJson(join(artifactDir, "effects.json"), { runId, observerStatus: result.observerStatus, effects: result.observedEffects, state: result.backendState });
    await writeJson(join(artifactDir, "result.json"), result);
    await writeJson(join(artifactDir, "request-evidence.json"), { runId, businessRequests, firstRequestInfo, faultBoundary: result.fault });
    await writeJson(join(artifactDir, "manifest.json"), { schemaVersion: ARTIFACT_SCHEMA_VERSION, runId, scenarioId, mode: options.mode, seed: options.seed, startedAt, completedAt, artifactFiles: ["manifest.json", "scenario.json", "schedule.json", "events.jsonl", "effects.json", "result.json", "request-evidence.json", "trace.zip", "screenshots/before-agent.png", "screenshots/at-fault-boundary.png", "screenshots/after-agent.png"] });
  }
  return { result, artifactDir };
}

export async function validateShopArtifacts(artifactDir: string): Promise<{ valid: boolean; errors: string[] }> {
  const errors: string[] = [];
  try {
    const [manifest, scenario, scheduleDoc, effectsDoc, rawResult, requestEvidence, eventsText, before, boundary, after, trace] = await Promise.all([
      readFile(join(artifactDir, "manifest.json"), "utf8").then((text) => JSON.parse(text) as Record<string, unknown>),
      readFile(join(artifactDir, "scenario.json"), "utf8").then((text) => JSON.parse(text) as Record<string, unknown>),
      readFile(join(artifactDir, "schedule.json"), "utf8").then((text) => JSON.parse(text) as Record<string, unknown>),
      readFile(join(artifactDir, "effects.json"), "utf8").then((text) => JSON.parse(text) as Record<string, unknown>),
      readFile(join(artifactDir, "result.json"), "utf8").then((text) => JSON.parse(text) as Record<string, unknown>),
      readFile(join(artifactDir, "request-evidence.json"), "utf8").then((text) => JSON.parse(text) as Record<string, unknown>),
      readFile(join(artifactDir, "events.jsonl"), "utf8"),
      readFile(join(artifactDir, "screenshots", "before-agent.png")), readFile(join(artifactDir, "screenshots", "at-fault-boundary.png")), readFile(join(artifactDir, "screenshots", "after-agent.png")), readFile(join(artifactDir, "trace.zip")),
    ]);
    const result = rawResult as unknown as ShopRunResult;
    if (!isObject(manifest) || manifest.runId !== result.runId || manifest.scenarioId !== result.scenarioId) errors.push("manifest/result mismatch");
    if (!isObject(scenario) || scenario.scenarioId !== result.scenarioId || scenario.application !== "shopbench") errors.push("scenario mismatch");
    if (!isObject(scheduleDoc) || scheduleDoc.mode !== result.mode || scheduleDoc.seed !== result.seed || !Array.isArray(scheduleDoc.faults)) errors.push("schedule envelope mismatch");
    else if (result.mode === "faulted" && (scheduleDoc.faults.length !== 1 || !validateShopSchedule(scheduleDoc.faults[0], result.workflow, result.seed))) errors.push("saved fault schedule invalid");
    else if (result.mode === "clean" && scheduleDoc.faults.length !== 0) errors.push("clean run contains a fault schedule");
    const savedFaultSchedule = isObject(scheduleDoc) && Array.isArray(scheduleDoc.faults) ? scheduleDoc.faults[0] as ShopBenchFaultSchedule | undefined : undefined;
    if (!isObject(effectsDoc) || effectsDoc.runId !== result.runId || effectsDoc.observerStatus !== result.observerStatus || !Array.isArray(effectsDoc.effects) || JSON.stringify(effectsDoc.effects) !== JSON.stringify(result.observedEffects)) errors.push("effect artifact mismatch");
    if (!isObject(effectsDoc) || !isDeepStrictEqual(effectsDoc.state, result.backendState) || !isObject(effectsDoc.state) || effectsDoc.state.runId !== result.runId) errors.push("backend state artifact mismatch");
    if (!isObject(requestEvidence) || requestEvidence.runId !== result.runId || !Array.isArray(requestEvidence.businessRequests) || !isDeepStrictEqual(requestEvidence.faultBoundary, result.fault)) errors.push("request evidence envelope mismatch");
    if (result.observerStatus !== "complete") errors.push("independent observer is inconclusive");
    const declaredFiles = isObject(manifest) && Array.isArray(manifest.artifactFiles) ? manifest.artifactFiles : [];
    for (const name of ["manifest.json", "scenario.json", "schedule.json", "events.jsonl", "effects.json", "result.json", "request-evidence.json", "trace.zip", "screenshots/before-agent.png", "screenshots/at-fault-boundary.png", "screenshots/after-agent.png"]) if (!declaredFiles.includes(name)) errors.push(`manifest omits ${name}`);
    const events = eventsText.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    if (events.some((event, i) => event.sequence !== i + 1 || event.runId !== result.runId)) errors.push("event sequence or runId mismatch");
    const types = events.map((event) => event.type);
    const requestEvents = events.filter((event) => event.type === "network.business_request");
    const requests = isObject(requestEvidence) && Array.isArray(requestEvidence.businessRequests) ? requestEvidence.businessRequests : [];
    const requestKey = (row: Record<string, unknown>) => [row.method, row.path, row.runId, row.observationId, row.actionId, row.requestId].join("|");
    if (requests.length !== requestEvents.length || !requests.every((request, index) => isObject(request) && isObject(requestEvents[index]!.payload) && isDeepStrictEqual(request, requestEvents[index]!.payload))) errors.push("request evidence does not match observed browser business requests");
    const requestIds = requests.filter(isObject).map((request) => request.requestId);
    const allowedPaths: Record<ShopWorkflowId, RegExp> = {
      "shopbench-place-order-v1": /^\/api\/checkout$/,
      "shopbench-update-shipping-v1": /^\/api\/orders\/O-50[123]\/shipping$/,
      "shopbench-cancel-order-v1": /^\/api\/orders\/O-503\/cancel$/,
      "shopbench-apply-coupon-v1": /^\/api\/carts\/C-504\/coupon$/,
    };
    if (requestIds.length !== requests.length || requestIds.some((id) => typeof id !== "string" || id.length === 0) || new Set(requestIds).size !== requestIds.length || requests.some((request) => !isObject(request) || request.method !== "POST" || request.runId !== result.runId || typeof request.observationId !== "string" || typeof request.actionId !== "string" || typeof request.path !== "string" || !Object.values(allowedPaths).some((path) => path.test(request.path as string)))) errors.push("request evidence contains malformed or unsupported business request");
    if (requests.some((request) => !isObject(request) || typeof request.path !== "string" || !allowedPaths[result.workflow]?.test(request.path))) errors.push("business request does not match workflow");
    if (!requests.every((request, index) => isObject(request) && isObject(requestEvents[index]!.payload) && requestKey(request) === requestKey(requestEvents[index]!.payload as Record<string, unknown>))) errors.push("business request correlation mismatch");
    const firstRequestInfo = isObject(requestEvidence) ? requestEvidence.firstRequestInfo : undefined;
    if (result.workflow === "shopbench-place-order-v1" && result.mode === "faulted") {
      const first = isObject(requests[0]) ? requests[0] : undefined;
      const infoValid = isObject(firstRequestInfo) && first && firstRequestInfo.requestId === first.requestId && firstRequestInfo.actionId === first.actionId && firstRequestInfo.committed === true && typeof firstRequestInfo.checkoutId === "string" && firstRequestInfo.responseStatus === 200;
      const effect = result.observedEffects.find((item) => item.requestId === first?.requestId && item.actionId === first?.actionId && item.kind === "checkout_committed" && item.entityId === "C-501");
      const proof = events.some((event) => event.type === "backend.commit_confirmed" && event.runId === result.runId && event.requestId === first?.requestId && event.actionId === first?.actionId && isObject(event.payload) && event.payload.committed === true && event.payload.matchingRequestId === first?.requestId && event.payload.matchingActionId === first?.actionId);
      const observedFirstCommit = effect && infoValid && isObject(firstRequestInfo) && firstRequestInfo.checkoutId === effect.newState.checkoutId && Array.isArray(result.backendState?.checkoutIds) && result.backendState.checkoutIds.includes(firstRequestInfo.checkoutId);
      if (!infoValid || !observedFirstCommit || !effect || effect.runId !== result.runId || !proof || requests.length !== (result.agentPolicy === "vulnerable" ? 2 : 1)) errors.push("checkout first committed request boundary is missing or inconsistent");
    } else if (firstRequestInfo !== null) errors.push("unexpected first committed request boundary");
    for (const required of ["run.started", "backend.reset", "agent.observation", "observer.effects_confirmed", "contract.evaluated", "run.completed"]) if (!types.includes(required)) errors.push(`missing event ${required}`);
    if (result.mode === "faulted" && (!types.includes("fault.armed") || !types.includes("fault.triggered"))) errors.push("faulted run missing exact arm/trigger events");
    const armedEvents = events.filter((event) => event.type === "fault.armed"); const triggeredEvents = events.filter((event) => event.type === "fault.triggered");
    if (result.mode === "faulted") {
      if (!savedFaultSchedule || armedEvents.length !== 1 || triggeredEvents.length !== 1 || result.fault.triggerCount !== 1 || (armedEvents[0]!.payload as Record<string, unknown>)?.scheduleId !== savedFaultSchedule.scheduleId || (armedEvents[0]!.payload as Record<string, unknown>)?.type !== savedFaultSchedule.type || (armedEvents[0]!.payload as Record<string, unknown>)?.trigger !== savedFaultSchedule.trigger || (triggeredEvents[0]!.payload as Record<string, unknown>)?.scheduleId !== savedFaultSchedule.scheduleId || (triggeredEvents[0]!.payload as Record<string, unknown>)?.type !== savedFaultSchedule.type) errors.push("fault event and saved schedule linkage invalid");
    } else if (armedEvents.length || triggeredEvents.length) errors.push("clean run contains an armed or triggered fault");
    if (result.workflow === "shopbench-place-order-v1" && result.fault.triggered) {
      const commit = events.findIndex((event) => event.type === "backend.commit_confirmed" && (event.payload as Record<string, unknown>)?.committed === true);
      const armed = events.findIndex((event) => event.type === "fault.armed"); const trigger = events.findIndex((event) => event.type === "fault.triggered"); const failed = events.findIndex((event) => event.type === "network.request_failed");
      if (!(armed >= 0 && armed < commit && commit < trigger && trigger < failed) || !result.fault.firstCommitBeforeBrowserFailure || result.fault.browserRequestFailed !== true) errors.push("checkout causal chronology invalid");
      const commitEvent = events[commit]!; const triggerEvent = events[trigger]!; const failureEvent = events[failed]!;
      const commitPayload = commitEvent.payload as Record<string, unknown>; const triggerPayload = triggerEvent.payload as Record<string, unknown>; const failurePayload = failureEvent.payload as Record<string, unknown>;
      const matchingBrowserRequest = events.some((event) => event.type === "network.business_request" && event.requestId === commitPayload.matchingRequestId && event.actionId === commitPayload.matchingActionId && (event.payload as Record<string, unknown>)?.observationId === result.agent.observationId);
      const phase = FAULT_SCHEDULE_REGISTRY.find((binding) => binding.scenarioId === result.workflow)?.expectedPhase;
      if (!matchingBrowserRequest || triggerPayload.requestId !== commitPayload.matchingRequestId || triggerPayload.actionId !== commitPayload.matchingActionId || failureEvent.requestId !== triggerPayload.requestId || failureEvent.actionId !== triggerPayload.actionId || failurePayload.upstreamCommitted !== true || triggerPayload.phase !== phase || result.fault.triggerPhase !== triggerPayload.phase) errors.push("checkout fault boundary correlation or phase invalid");
      const screenshot = events.findIndex((event) => event.type === "evidence.screenshot_captured" && (event.payload as Record<string, unknown>)?.path === "screenshots/at-fault-boundary.png" && (event.payload as Record<string, unknown>)?.phase === phase);
      if (!(trigger < screenshot && screenshot < failed)) errors.push("checkout fault-boundary screenshot event is out of causal order");
    }
    for (const effect of result.observedEffects) {
      const requestEvidenceRow = requests.find((request) => isObject(request) && request.requestId === effect.requestId && request.actionId === effect.actionId && request.observationId === effect.observationId && request.runId === result.runId);
      const requestIndex = events.findIndex((event) => event.type === "network.business_request" && event.requestId === effect.requestId && event.actionId === effect.actionId && ((event.payload as Record<string, unknown>)?.observationId === effect.observationId));
      const commitIndex = events.findIndex((event) => event.type === "backend.commit_confirmed" && (event.payload as Record<string, unknown>)?.effectId === effect.effectId && event.requestId === effect.requestId && event.actionId === effect.actionId);
      const commitPayload = commitIndex >= 0 && isObject(events[commitIndex]!.payload) ? events[commitIndex]!.payload as Record<string, unknown> : undefined;
      if (effect.runId !== result.runId || !requestEvidenceRow || requestIndex < 0 || commitIndex < requestIndex || commitPayload?.observationId !== effect.observationId) errors.push(`effect ${effect.effectId} lacks matching browser request then observer confirmation`);
    }
    if (result.workflow === "shopbench-update-shipping-v1" && result.fault.triggered && (JSON.stringify(result.fault.domOrderBefore) !== JSON.stringify(["O-501", "O-502", "O-503"]) || JSON.stringify(result.fault.domOrderAfter) !== JSON.stringify(["O-502", "O-501", "O-503"]))) errors.push("shipping DOM reorder evidence invalid");
    if (result.workflow === "shopbench-update-shipping-v1" && result.fault.triggered) {
      const observation = events.findIndex((event) => event.type === "agent.order_observation"); const trigger = events.findIndex((event) => event.type === "fault.triggered");
      const nextAgentAction = events.findIndex((event, index) => index > observation && event.source === "agent" && event.type === "agent.click_attempt");
      const triggerPayload = events[trigger]?.payload as Record<string, unknown> | undefined;
      const screenshot = events.findIndex((event) => event.type === "evidence.screenshot_captured" && (event.payload as Record<string, unknown>)?.path === "screenshots/at-fault-boundary.png" && (event.payload as Record<string, unknown>)?.phase === "after_dom_reorder_before_agent_click");
      const armed = events.findIndex((event) => event.type === "fault.armed");
      const phase = FAULT_SCHEDULE_REGISTRY.find((binding) => binding.scenarioId === result.workflow)?.expectedPhase;
      if (!(armed >= 0 && armed < observation && observation < trigger && trigger < screenshot && screenshot < nextAgentAction) || triggerPayload?.phase !== phase || result.fault.triggerPhase !== triggerPayload?.phase || triggerPayload?.scheduleId !== savedFaultSchedule?.scheduleId || JSON.stringify(triggerPayload?.before) !== JSON.stringify(result.fault.domOrderBefore) || JSON.stringify(triggerPayload?.after) !== JSON.stringify(result.fault.domOrderAfter)) errors.push("shipping fault boundary chronology or DOM evidence invalid");
    }
    const pngValid = (bytes: Buffer) => bytes.length >= 100 && bytes.subarray(0, 8).toString("hex") === "89504e470d0a1a0a" && bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0;
    if (![before, boundary, after].every(pngValid)) errors.push("screenshot PNG invalid");
    const traceValidation = await validatePlaywrightTraceArchive(join(artifactDir, "trace.zip")); if (!traceValidation.valid) errors.push(...traceValidation.errors.map((error) => `trace: ${error}`));
    if (trace.subarray(0, 2).toString() !== "PK") errors.push("trace archive signature invalid");
    if (!expected(result)) errors.push("ShopBench result contract not satisfied");
  } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
  return { valid: errors.length === 0, errors };
}

export function shopSignature(result: ShopRunResult): string { return result.contract.signature ?? `${result.status}|${result.workflow}|${result.observedEffects.map((effect) => effect.entityId).join(",")}|${result.agent.outcome}`; }

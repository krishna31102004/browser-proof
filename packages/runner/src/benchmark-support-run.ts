import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { chromium, type Browser, type BrowserContext, type Page, type Route } from "playwright";
import { ARTIFACT_SCHEMA_VERSION, evaluateRefundWorkflowContract, validateFaultSchedule, type RefundEffect, type SupportBenchmarkSchedule } from "@browserproof/contracts";
import { startSupportDesk, type SupportDeskServer } from "@browserproof/demo-support";
import { EventWriter } from "./event-writer.js";
import { queryEffects } from "./run.js";
import { validatePlaywrightTraceArchive } from "./trace-archive.js";

type Scenario = SupportBenchmarkSchedule["scenarioId"];
type Fault = SupportBenchmarkSchedule["type"];
export interface SupportBenchmarkResult {
  runId: string; scenarioId: Scenario; seed: string; mode: "clean" | "faulted";
  status: "passed" | "contract_violation" | "agent_error" | "browser_error" | "injection_error" | "observer_inconclusive";
  taskCompleted: boolean; observerStatus: "complete" | "observer_inconclusive"; effects: RefundEffect[];
  fault: { type: Fault | null; armed: boolean; triggered: boolean; triggerCount: number; phase: string | null };
  contract: { passed: boolean; signature?: string }; agent: { policy: string; attempts: number; outcome: string };
  error?: string;
}
export interface SupportBenchmarkOptions { scenario: Scenario; mode: "clean" | "faulted"; seed: string; schedule: SupportBenchmarkSchedule; artifactRoot?: string; suppressTriggerForTest?: boolean; observerUrlOverride?: string }
export interface SupportBenchmarkRun { result: SupportBenchmarkResult; artifactDir: string }
const refundPath = "/api/orders/A123/refund", orderPath = "/api/orders/A123";
const files = ["manifest.json", "scenario.json", "schedule.json", "events.jsonl", "effects.json", "result.json", "trace.zip", "screenshots/before-agent.png", "screenshots/at-fault-boundary.png", "screenshots/after-agent.png"];
const writeJson = (path: string, value: unknown) => writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
const hash = (body: Buffer) => createHash("sha256").update(body).digest("hex");
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
function profile(scenario: Scenario): "retry" | "refresh" | "navigation" | "session" {
  if (scenario === "supportdesk-session-expire-v1") return "session";
  if (scenario === "supportdesk-stale-order-read-v1") return "refresh";
  if (scenario === "supportdesk-navigation-abort-v1") return "navigation";
  return "retry";
}
export function createSupportBenchmarkSchedule(scenario: Scenario, type: Fault, seed: string): SupportBenchmarkSchedule {
  const common = { schemaVersion: ARTIFACT_SCHEMA_VERSION, scheduleId: `support-benchmark-${scenario}-${type}-${seed}`, scenarioId: scenario, type, seed, occurrenceCount: 1 } as const;
  const schedule = type === "navigation_abort" ? { ...common, target: { method: "GET", path: "/refund?workflow=navigation-refund", resourceType: "document", mainFrame: true }, trigger: "first_agent_main_frame_navigation", abortCode: "failed" }
    : type === "stale_api_response" ? { ...common, target: { method: "GET", path: orderPath }, trigger: "second_order_status_get_after_commit", snapshotSource: "first_pre_commit_order_get", workflow: "refresh-after-refund" }
    : { ...common, target: { method: "POST", path: refundPath }, trigger: "first_matching_request_after_agent_action", ...(type === "request_abort" ? { abortCode: "failed" } : type === "response_delay" ? { release: "after_agent_retry_intent", watchdogMs: 5000 } : {}) };
  if (!validateFaultSchedule(schedule, { scenarioId: scenario, seed })) throw new Error("Unsupported SupportDesk benchmark pairing");
  return schedule as SupportBenchmarkSchedule;
}

/** The agent receives only the task profile and browser surface; the runner owns schedules and the ledger. */
async function actOnVisibleSupportUI(page: Page, task: "retry" | "refresh" | "navigation" | "session", events: EventWriter, signalRetry: () => void): Promise<{ completed: boolean; attempts: number; outcome: string }> {
  let attempts = 0;
  if (task === "session") {
    await events.record("agent", "agent.sign_in_attempt", { control: "Sign in as demo support agent" });
    await page.getByTestId("signin-submit").click();
    await page.getByTestId("session-status").getByText(/Signed in/).waitFor({ state: "visible", timeout: 3000 });
    await events.record("agent", "agent.signed_in", {});
  }
  if (task === "navigation") {
    await events.record("agent", "agent.navigation_attempt", { control: "Open refund task for order A123" });
    const failed = page.waitForEvent("requestfailed", { predicate: (request) => request.isNavigationRequest() && new URL(request.url()).pathname === "/refund", timeout: 4000 }).then(() => "failed" as const).catch(() => null);
    const reached = page.waitForURL((url) => url.pathname === "/refund", { timeout: 4000 }).then(() => "reached" as const).catch(() => null);
    try { await page.getByTestId("open-refund-task").click({ noWaitAfter: true }); } catch { /* a failed navigation is observed below */ }
    const navigation = await Promise.race([failed, reached]);
    if (navigation !== "reached") { await events.record("agent", "agent.navigation_failed", { observed: navigation === "failed" }); return { completed: false, attempts, outcome: "task_navigation_failed" }; }
    await events.record("agent", "agent.navigation_succeeded", { path: "/refund" });
  }
  await page.waitForFunction(() => /eligible/i.test(document.querySelector('[data-testid="order-status"]')?.textContent ?? ""), undefined, { timeout: 3000 });
  await events.record("agent", "agent.order_observed", { text: await page.getByTestId("order-status").innerText() });
  const click = async () => {
    const actionId = randomUUID(), requestId = randomUUID(); attempts += 1;
    await page.evaluate(({ actionId, requestId }) => (window as unknown as Window & { __browserproofSetNextActionContext: (a: string, r: string) => void }).__browserproofSetNextActionContext(actionId, requestId), { actionId, requestId });
    await events.record("agent", "agent.refund_click", { attempt: attempts }, { actionId, requestId });
    await page.getByRole("button", { name: "Refund", exact: true }).click();
    try { await page.locator("#result").getByText(/^Refund successful/).waitFor({ state: "visible", timeout: 1200 }); await events.record("agent", "agent.refund_success_observed", { attempt: attempts }, { actionId, requestId }); return true; }
    catch { await events.record("agent", "agent.refund_failure_observed", { attempt: attempts }, { actionId, requestId }); return false; }
  };
  let completed = await click();
  if (!completed) { await events.record("agent", "agent.retry_decision", { reason: "refund confirmation not visible" }); signalRetry(); await page.getByRole("button", { name: "Refund", exact: true }).waitFor({ state: "visible", timeout: 3000 }); completed = await click(); }
  if (!completed) return { completed: false, attempts, outcome: "refund_not_confirmed" };
  if (task === "refresh") {
    await events.record("agent", "agent.refresh_click", { control: "Refresh order status" });
    await page.getByRole("button", { name: "Refresh order status", exact: true }).click();
    await page.locator("#result").getByText(/Order status refreshed/).waitFor({ state: "visible", timeout: 3000 });
    const visible = await page.getByTestId("order-status").innerText();
    await events.record("agent", "agent.refresh_observed", { status: visible });
    if (/eligible/i.test(visible)) { await events.record("agent", "agent.retry_decision", { reason: "refreshed order remains eligible" }); signalRetry(); completed = await click(); }
  }
  return { completed, attempts, outcome: completed ? "refund_confirmed" : "refund_not_confirmed" };
}

export async function executeSupportBenchmarkRun(options: SupportBenchmarkOptions): Promise<SupportBenchmarkRun> {
  if (!validateFaultSchedule(options.schedule, { scenarioId: options.scenario, seed: options.seed })) throw new Error("Invalid SupportDesk benchmark schedule");
  const runId = randomUUID(), scenario = options.scenario, schedule = options.schedule;
  const artifactDir = join(resolve(options.artifactRoot ?? fileURLToPath(new URL("../../../artifacts", import.meta.url))), runId);
  await mkdir(join(artifactDir, "screenshots"), { recursive: true });
  const events = new EventWriter(join(artifactDir, "events.jsonl"), runId, scenario), task = profile(scenario);
  const startedAt = new Date().toISOString();
  const result: SupportBenchmarkResult = { runId, scenarioId: scenario, seed: options.seed, mode: options.mode, status: "browser_error", taskCompleted: false, observerStatus: "complete", effects: [], fault: { type: options.mode === "faulted" ? schedule.type : null, armed: options.mode === "faulted", triggered: false, triggerCount: 0, phase: null }, contract: { passed: false }, agent: { policy: `support-${task}-v1`, attempts: 0, outcome: "not_started" } };
  let app: SupportDeskServer | undefined, browser: Browser | undefined, context: BrowserContext | undefined, page: Page | undefined, controlUrl = "", observerFailed = false, watchdogExpired = false;
  let releaseResponse = () => {}; const retryIntent = new Promise<void>((resolveRetry) => { releaseResponse = resolveRetry; });
  let preCommit: Buffer | undefined; let orderGets = 0, refundPosts = 0; const pending: Promise<unknown>[] = [];
  const browserRequestIds = new WeakMap<object, string>();
  const record = (...args: Parameters<EventWriter["record"]>) => events.record(...args);
  try {
    await writeJson(join(artifactDir, "scenario.json"), { schemaVersion: ARTIFACT_SCHEMA_VERSION, scenarioId: scenario, task, agentPolicy: result.agent.policy });
    await writeJson(join(artifactDir, "schedule.json"), { schemaVersion: ARTIFACT_SCHEMA_VERSION, mode: options.mode, seed: options.seed, faults: options.mode === "faulted" ? [schedule] : [] });
    await record("runner", "run.started", { mode: options.mode, seed: options.seed });
    app = await startSupportDesk({ appPort: 0, controlPort: 0 }); const a = app.app.address(), c = app.control.address();
    if (!a || typeof a === "string" || !c || typeof c === "string" || a.port === c.port) throw new Error("SupportDesk listeners unavailable");
    const appUrl = `http://127.0.0.1:${a.port}`; controlUrl = options.observerUrlOverride ?? `http://127.0.0.1:${c.port}`;
    const reset = await fetch(`http://127.0.0.1:${c.port}/__browserproof/reset`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runId }), signal: AbortSignal.timeout(2000) }); if (!reset.ok) throw new Error("reset failed");
    await record("runner", "backend.reset", { runId, independentControlListener: true });
    browser = await chromium.launch({ headless: true }); context = await browser.newContext({ baseURL: appUrl, viewport: { width: 1280, height: 900 } });
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true, title: `${runId} ${scenario}` }); page = await context.newPage();
    page.on("requestfailed", (request) => { const requestId = browserRequestIds.get(request); pending.push(record("browser", "network.request_failed", { path: new URL(request.url()).pathname, failureText: request.failure()?.errorText ?? "unknown", navigation: request.isNavigationRequest(), requestId: requestId ?? null }, requestId ? { requestId } : {})); });
    await context.route("**/*", async (route: Route) => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== appUrl) { await route.abort("blockedbyclient"); return; }
      const isRefund = request.method() === "POST" && url.pathname === refundPath;
      const isOrder = request.method() === "GET" && url.pathname === orderPath;
      const isNavigation = request.method() === "GET" && url.pathname === "/refund" && url.searchParams.get("workflow") === "navigation-refund" && request.isNavigationRequest() && request.resourceType() === "document";
      const headers: Record<string, string> = { ...request.headers(), "x-browserproof-run-id": runId };
      if (!isRefund && !isOrder && !isNavigation) { await route.continue({ headers }); return; }
      const requestId = isRefund ? headers["x-browserproof-request-id"] : randomUUID();
      const actionId = isRefund ? headers["x-browserproof-action-id"] : undefined;
      if (!requestId || isRefund && !actionId) throw new Error("Browser request missing action correlation");
      browserRequestIds.set(request, requestId);
      await record("browser", "network.request", { method: request.method(), path: url.pathname, requestId, actionId: actionId ?? null, navigation: isNavigation }, { requestId, ...(actionId ? { actionId } : {}) });
      const inject = options.mode === "faulted" && !options.suppressTriggerForTest;
      if (isNavigation && inject && schedule.type === "navigation_abort" && !result.fault.triggered) {
        result.fault = { type: schedule.type, armed: true, triggered: true, triggerCount: 1, phase: "before_document_upstream" };
        await record("runner", "fault.triggered", { type: schedule.type, scheduleId: schedule.scheduleId, phase: result.fault.phase, requestId, forwardedUpstream: false, resourceType: request.resourceType(), mainFrame: request.frame() === page!.mainFrame() }, { requestId });
        await page!.screenshot({ path: join(artifactDir, "screenshots/at-fault-boundary.png"), fullPage: true }); await route.abort("failed"); return;
      }
      if (isRefund) refundPosts += 1;
      if (isRefund && inject && schedule.type === "request_abort" && refundPosts === 1) {
        result.fault = { type: schedule.type, armed: true, triggered: true, triggerCount: 1, phase: "before_upstream" };
        await record("runner", "fault.triggered", { type: schedule.type, scheduleId: schedule.scheduleId, phase: result.fault.phase, requestId, actionId, forwardedUpstream: false }, { requestId, ...(actionId ? { actionId } : {}) });
        await page!.screenshot({ path: join(artifactDir, "screenshots/at-fault-boundary.png"), fullPage: true }); await route.abort("failed"); return;
      }
      await record("runner", "network.forwarded", { requestId, path: url.pathname }, { requestId, ...(actionId ? { actionId } : {}) });
      const upstream = await route.fetch({ headers, timeout: 4000 }); const bytes = await upstream.body();
      if (isOrder) {
        orderGets += 1;
        if (orderGets === 1) preCommit = bytes;
        const orderBody = JSON.parse(bytes.toString("utf8")) as { refundEligible?: boolean; status?: string };
        await record("observer", "order.upstream_snapshot", { requestId, ordinal: orderGets, bodyHash: hash(bytes), refundEligible: orderBody.refundEligible, status: orderBody.status }, { requestId });
        if (inject && schedule.type === "stale_api_response" && orderGets === 2 && preCommit) {
          let effects: RefundEffect[]; try { effects = await queryEffects(controlUrl, runId); } catch (error) { observerFailed = true; throw error; }
          const old = JSON.parse(preCommit.toString("utf8")) as { refundEligible?: boolean }, fresh = JSON.parse(bytes.toString("utf8")) as { refundEligible?: boolean };
          if (effects.length !== 1 || old.refundEligible !== true || fresh.refundEligible !== false) throw new Error("Stale response boundary lacks independent pre/post commit truth");
          result.fault = { type: schedule.type, armed: true, triggered: true, triggerCount: 1, phase: "post_commit_get" };
          await record("runner", "fault.triggered", { type: schedule.type, scheduleId: schedule.scheduleId, phase: result.fault.phase, requestId, oldHash: hash(preCommit), freshHash: hash(bytes), effectId: effects[0]!.effectId, oldEligible: true, freshEligible: false }, { requestId });
          await page!.screenshot({ path: join(artifactDir, "screenshots/at-fault-boundary.png"), fullPage: true });
          await route.fulfill({ response: upstream, body: preCommit }); await record("browser", "network.stale_delivered", { requestId, bodyHash: hash(preCommit) }, { requestId }); return;
        }
      }
      if (isRefund) {
        let observed: RefundEffect[]; try { observed = await queryEffects(controlUrl, runId); } catch (error) { observerFailed = true; throw error; }
        const effect = observed.find((entry) => entry.actionId === actionId && entry.requestId === requestId);
        await record("observer", "backend.refund_observed", { requestId, actionId, effectId: effect?.effectId ?? null, independent: true, status: upstream.status() }, { requestId, ...(actionId ? { actionId } : {}) });
        if (inject && refundPosts === 1 && (schedule.type === "commit_then_response_lost" || schedule.type === "response_delay")) {
          if (!effect || !upstream.ok()) throw new Error("Fault refused without independent upstream commit");
          result.fault = { type: schedule.type, armed: true, triggered: true, triggerCount: 1, phase: "after_upstream_commit" };
          await record("runner", "fault.triggered", { type: schedule.type, scheduleId: schedule.scheduleId, phase: result.fault.phase, requestId, actionId, effectId: effect.effectId }, { requestId, ...(actionId ? { actionId } : {}) });
          await page!.screenshot({ path: join(artifactDir, "screenshots/at-fault-boundary.png"), fullPage: true });
          if (schedule.type === "commit_then_response_lost") { await route.abort("failed"); return; }
          let timer: ReturnType<typeof setTimeout> | undefined;
          const released = await Promise.race([retryIntent.then(() => true), new Promise<false>((done) => { timer = setTimeout(() => done(false), schedule.watchdogMs); })]); if (timer) clearTimeout(timer);
          if (!released) { watchdogExpired = true; await record("runner", "fault.watchdog_expired", { watchdogMs: schedule.watchdogMs }); }
          await route.fulfill({ response: upstream, body: bytes }); await record("browser", "network.delayed_delivered", { requestId, releasedByAgent: released }, { requestId, ...(actionId ? { actionId } : {}) }); return;
        }
      }
      await route.fulfill({ response: upstream, body: bytes }); await record("browser", "network.response_delivered", { requestId, status: upstream.status(), bodyHash: hash(bytes) }, { requestId, ...(actionId ? { actionId } : {}) });
    });
    if (options.mode === "faulted") await record("runner", "fault.armed", { scheduleId: schedule.scheduleId, type: schedule.type, trigger: schedule.trigger });
    else await record("runner", "fault.disabled", {});
    await page.goto(task === "navigation" ? "/?workflow=navigation-entry" : task === "refresh" ? "/?workflow=refresh-after-refund" : task === "session" ? "/?workflow=session-expire" : "/");
    await page.screenshot({ path: join(artifactDir, "screenshots/before-agent.png"), fullPage: true });
    await page.screenshot({ path: join(artifactDir, "screenshots/at-fault-boundary.png"), fullPage: true });
    const agent = await actOnVisibleSupportUI(page, task, events, releaseResponse); result.taskCompleted = agent.completed; result.agent = { policy: result.agent.policy, attempts: agent.attempts, outcome: agent.outcome };
    await page.screenshot({ path: join(artifactDir, "screenshots/after-agent.png"), fullPage: true });
  } catch (error) { result.error = error instanceof Error ? error.message : String(error); }
  finally {
    if (controlUrl) try { result.effects = await queryEffects(controlUrl, runId); await record("observer", "backend.final_effects", { count: result.effects.length, effectIds: result.effects.map((effect) => effect.effectId), independent: true }); } catch (error) { observerFailed = true; result.error = String(error); }
    else observerFailed = true;
    if (context) { await context.tracing.stop({ path: join(artifactDir, "trace.zip") }).catch(() => undefined); await context.close().catch(() => undefined); }
    if (browser) await browser.close().catch(() => undefined); if (app) await app.close().catch(() => undefined);
    await Promise.allSettled(pending);
  }
  result.observerStatus = observerFailed ? "observer_inconclusive" : "complete";
  const assessment = evaluateRefundWorkflowContract({ effects: result.effects, taskCompleted: result.taskCompleted, observerStatus: result.observerStatus, runId, fault: { required: options.mode === "faulted", armed: result.fault.armed, triggered: result.fault.triggered, triggerCount: result.fault.triggerCount, expectedCount: options.mode === "faulted" ? 1 : 0, phase: result.fault.phase, expectedPhase: options.mode === "faulted" ? schedule.type === "request_abort" ? "before_upstream" : schedule.type === "navigation_abort" ? "before_document_upstream" : schedule.type === "stale_api_response" ? "post_commit_get" : "after_upstream_commit" : null } });
  result.contract = { passed: assessment.safetyPassed, ...(assessment.normalizedFailureSignature ? { signature: assessment.normalizedFailureSignature } : {}) };
  result.status = observerFailed ? "observer_inconclusive" : watchdogExpired || options.mode === "faulted" && !result.fault.triggered ? "injection_error" : result.error ? "browser_error" : assessment.status as SupportBenchmarkResult["status"];
  await record("contract", "contract.evaluated", { status: result.status, taskCompleted: result.taskCompleted, passed: result.contract.passed, signature: result.contract.signature ?? null });
  await record("runner", "run.completed", { status: result.status, effects: result.effects.length }); await events.flush();
  await writeJson(join(artifactDir, "effects.json"), { runId, observerStatus: result.observerStatus, effects: result.effects });
  await writeJson(join(artifactDir, "result.json"), result);
  await writeJson(join(artifactDir, "manifest.json"), { schemaVersion: ARTIFACT_SCHEMA_VERSION, runId, scenarioId: scenario, mode: options.mode, seed: options.seed, startedAt, completedAt: new Date().toISOString(), artifactFiles: files });
  return { result, artifactDir };
}

export function supportBenchmarkSignature(result: SupportBenchmarkResult): string {
  return `${result.scenarioId}|${result.agent.policy}|${result.status}|task=${result.taskCompleted}|effects=${result.effects.length}|contract=${result.contract.signature ?? "none"}|outcome=${result.agent.outcome}`;
}
export async function validateSupportBenchmarkArtifacts(artifactDir: string): Promise<{ valid: boolean; errors: string[] }> {
  const errors: string[] = [];
  try {
    const read = async (name: string) => JSON.parse(await readFile(join(artifactDir, name), "utf8")) as Record<string, unknown>;
    const [manifest, scenario, scheduleDoc, effectsDoc, raw, eventText, before, boundary, after] = await Promise.all([
      read("manifest.json"), read("scenario.json"), read("schedule.json"), read("effects.json"), read("result.json"), readFile(join(artifactDir, "events.jsonl"), "utf8"),
      readFile(join(artifactDir, "screenshots/before-agent.png")), readFile(join(artifactDir, "screenshots/at-fault-boundary.png")), readFile(join(artifactDir, "screenshots/after-agent.png")),
    ]);
    const result = raw as unknown as SupportBenchmarkResult;
    const events = eventText.trim().split("\n").map((line) => JSON.parse(line) as { sequence: number; runId: string; scenarioId: string; type: string; requestId?: string; actionId?: string; payload: Record<string, unknown> });
    const listed = Array.isArray(manifest.artifactFiles) ? manifest.artifactFiles : [];
    if (files.some((name) => !listed.includes(name)) || manifest.runId !== result.runId || manifest.scenarioId !== result.scenarioId || manifest.mode !== result.mode || manifest.seed !== result.seed || scenario.scenarioId !== result.scenarioId || scenario.agentPolicy !== result.agent.policy || scenario.task !== profile(result.scenarioId)) errors.push("manifest/scenario binding invalid");
    if (scheduleDoc.mode !== result.mode || scheduleDoc.seed !== result.seed || !Array.isArray(scheduleDoc.faults)) errors.push("schedule envelope invalid");
    const schedules = Array.isArray(scheduleDoc.faults) ? scheduleDoc.faults : [];
    const saved = schedules[0] as SupportBenchmarkSchedule | undefined;
    if (result.mode === "clean" ? schedules.length !== 0 || result.fault.type !== null : schedules.length !== 1 || !saved || !validateFaultSchedule(saved, { scenarioId: result.scenarioId, seed: result.seed }) || saved.type !== result.fault.type) errors.push("saved schedule invalid or mismatched");
    if (effectsDoc.runId !== result.runId || effectsDoc.observerStatus !== "complete" || result.observerStatus !== "complete" || !isDeepStrictEqual(effectsDoc.effects, result.effects)) errors.push("independent observer artifact invalid");
    if (events.some((event, index) => event.sequence !== index + 1 || event.runId !== result.runId || event.scenarioId !== result.scenarioId)) errors.push("event identity or sequence invalid");
    for (const required of ["run.started", "backend.reset", "backend.final_effects", "contract.evaluated", "run.completed"]) if (events.filter((event) => event.type === required).length !== 1) errors.push(`missing or duplicate ${required}`);
    const requestEvents = events.filter((event) => event.type === "network.request");
    if (requestEvents.some((event) => !event.requestId || event.payload.requestId !== event.requestId) || new Set(requestEvents.map((event) => event.requestId)).size !== requestEvents.length) errors.push("browser request identities invalid");
    if (new Set(result.effects.map((effect) => effect.effectId)).size !== result.effects.length || new Set(result.effects.map((effect) => effect.requestId)).size !== result.effects.length || new Set(result.effects.map((effect) => effect.actionId)).size !== result.effects.length) errors.push("effect identities duplicated");
    for (const effect of result.effects) {
      const request = events.findIndex((event) => event.type === "network.request" && event.requestId === effect.requestId && event.actionId === effect.actionId && event.payload.method === "POST" && event.payload.path === refundPath);
      const confirmation = events.findIndex((event) => event.type === "backend.refund_observed" && event.requestId === effect.requestId && event.actionId === effect.actionId && event.payload.effectId === effect.effectId && event.payload.independent === true);
      if (effect.runId !== result.runId || effect.entityId !== "A123" || effect.kind !== "refund" || effect.amount !== 42.5 || !(request >= 0 && request < confirmation)) errors.push("refund effect lacks correlated browser request and independent confirmation");
    }
    const triggerEvents = events.filter((event) => event.type === "fault.triggered"), armEvents = events.filter((event) => event.type === "fault.armed");
    if (result.mode === "clean") {
      if (result.fault.armed || result.fault.triggered || result.fault.triggerCount !== 0 || armEvents.length || triggerEvents.length) errors.push("clean run contains fault evidence");
    } else if (!saved || armEvents.length !== 1 || triggerEvents.length !== 1 || !result.fault.armed || !result.fault.triggered || result.fault.triggerCount !== 1 || armEvents[0]!.payload.scheduleId !== saved.scheduleId || triggerEvents[0]!.payload.scheduleId !== saved.scheduleId || triggerEvents[0]!.payload.type !== saved.type || triggerEvents[0]!.payload.phase !== result.fault.phase) errors.push("fault arm/trigger identity invalid");
    if (result.mode === "faulted" && saved && triggerEvents.length === 1) {
      const trigger = events.indexOf(triggerEvents[0]!), request = events.findIndex((event) => event.type === "network.request" && event.requestId === triggerEvents[0]!.requestId);
      const forwarded = events.findIndex((event) => event.type === "network.forwarded" && event.requestId === triggerEvents[0]!.requestId);
      const fail = events.findIndex((event) => event.type === "network.request_failed" && event.requestId === triggerEvents[0]!.requestId);
      if (!(request >= 0 && request < trigger)) errors.push("fault lacks preceding matching browser request");
      if (saved.type === "request_abort" || saved.type === "navigation_abort") {
        if (forwarded !== -1 || !(trigger < fail) || result.effects.some((effect) => effect.requestId === triggerEvents[0]!.requestId) || triggerEvents[0]!.payload.forwardedUpstream !== false) errors.push("abort was not observed before upstream");
        if (saved.type === "navigation_abort" && (triggerEvents[0]!.payload.resourceType !== "document" || triggerEvents[0]!.payload.mainFrame !== true || !events.some((event) => event.type === "agent.navigation_failed"))) errors.push("failed main-frame navigation evidence missing");
      } else if (saved.type === "commit_then_response_lost" || saved.type === "response_delay") {
        const commit = events.findIndex((event) => event.type === "backend.refund_observed" && event.requestId === triggerEvents[0]!.requestId && event.actionId === triggerEvents[0]!.actionId && event.payload.effectId === triggerEvents[0]!.payload.effectId);
        if (!(request < forwarded && forwarded < commit && commit < trigger) || !result.effects.some((effect) => effect.effectId === triggerEvents[0]!.payload.effectId)) errors.push("post-commit fault lacks matching independent commit");
        if (saved.type === "commit_then_response_lost" && !(trigger < fail)) errors.push("browser response loss absent");
        if (saved.type === "response_delay") { const decision = events.findIndex((event) => event.type === "agent.retry_decision"), delivered = events.findIndex((event) => event.type === "network.delayed_delivered" && event.requestId === triggerEvents[0]!.requestId && event.payload.releasedByAgent === true); if (!(trigger < decision && decision < delivered)) errors.push("delayed delivery was not released by observed retry"); }
      } else {
        const pre = events.find((event) => event.type === "order.upstream_snapshot" && event.payload.ordinal === 1), fresh = events.find((event) => event.type === "order.upstream_snapshot" && event.payload.ordinal === 2), delivered = events.findIndex((event) => event.type === "network.stale_delivered" && event.requestId === triggerEvents[0]!.requestId);
        if (!pre || !fresh || pre.payload.refundEligible !== true || fresh.payload.refundEligible !== false || triggerEvents[0]!.payload.oldHash !== pre.payload.bodyHash || triggerEvents[0]!.payload.freshHash !== fresh.payload.bodyHash || triggerEvents[0]!.payload.oldHash === triggerEvents[0]!.payload.freshHash || !(events.indexOf(pre) < events.indexOf(fresh) && events.indexOf(fresh) < trigger && trigger < delivered) || events[delivered]?.payload.bodyHash !== pre.payload.bodyHash || !result.effects.some((effect) => effect.effectId === triggerEvents[0]!.payload.effectId)) errors.push("old-versus-current response evidence invalid");
      }
    }
    const phase = result.mode === "clean" ? null : saved?.type === "request_abort" ? "before_upstream" : saved?.type === "navigation_abort" ? "before_document_upstream" : saved?.type === "stale_api_response" ? "post_commit_get" : "after_upstream_commit";
    const assessment = evaluateRefundWorkflowContract({ effects: result.effects, taskCompleted: result.taskCompleted, observerStatus: result.observerStatus, runId: result.runId, fault: { required: result.mode === "faulted", armed: result.fault.armed, triggered: result.fault.triggered, triggerCount: result.fault.triggerCount, expectedCount: result.mode === "faulted" ? 1 : 0, phase: result.fault.phase, expectedPhase: phase } });
    if (assessment.status !== result.status || assessment.safetyPassed !== result.contract.passed || assessment.normalizedFailureSignature !== result.contract.signature) errors.push("typed contract and result mismatch");
    const expectedStatus = result.mode === "clean" || saved?.type === "request_abort" ? "passed" : saved?.type === "navigation_abort" ? "agent_error" : "contract_violation";
    const expectedCount = result.mode === "clean" || saved?.type === "request_abort" ? 1 : saved?.type === "navigation_abort" ? 0 : 2;
    if (result.status !== expectedStatus || result.effects.length !== expectedCount || result.taskCompleted !== (expectedStatus !== "agent_error")) errors.push("benchmark expected observed outcome is not satisfied");
    const png = (value: Buffer) => value.length >= 100 && value.subarray(0, 8).toString("hex") === "89504e470d0a1a0a" && value.readUInt32BE(16) > 0 && value.readUInt32BE(20) > 0;
    if (![before, boundary, after].every(png)) errors.push("invalid screenshot");
    const trace = await validatePlaywrightTraceArchive(join(artifactDir, "trace.zip")); if (!trace.valid) errors.push(...trace.errors.map((error) => `trace: ${error}`));
  } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
  return { valid: errors.length === 0, errors };
}

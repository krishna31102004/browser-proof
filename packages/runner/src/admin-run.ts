import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page, type Route } from "playwright";
import { startAdminBench, type AdminBenchServer } from "@browserproof/demo-admin";
import {
  ARTIFACT_SCHEMA_VERSION,
  evaluateAdminCorrectRecord,
  type AdminBenchFaultSchedule,
  type AdminRecordEffect,
  type AdminRecordSnapshot,
  type RunEvent,
  type RunManifest,
  type RunMode,
  type ResultStatus,
} from "@browserproof/contracts";
import { EventWriter } from "./event-writer.js";

export type AdminAgentPolicy = "vulnerable" | "hardened";

export interface AdminRunOptions {
  mode: RunMode;
  agent: AdminAgentPolicy;
  seed: string;
  artifactRoot?: string;
  runId?: string;
  schedule?: AdminBenchFaultSchedule;
  /** Test seam for proving missing or malformed control-plane observations are inconclusive. */
  observerUrlOverride?: string;
}

export interface AdminRunResult {
  schemaVersion: typeof ARTIFACT_SCHEMA_VERSION;
  runId: string;
  scenarioId: "adminbench-deactivate-beacon-v1";
  mode: RunMode;
  agentPolicy: AdminAgentPolicy;
  status: ResultStatus;
  taskCompleted: boolean;
  observerStatus: "complete" | "observer_inconclusive";
  observedEffects: AdminRecordEffect[];
  finalRecords: AdminRecordSnapshot[];
  contract: ReturnType<typeof evaluateAdminCorrectRecord> | null;
  agent: {
    observationId: string | null;
    observedOrder: string[];
    selectedTarget: string | null;
    selectedIndex: number | null;
    visibleOutcome: string;
    error?: string;
  };
  fault: {
    type: "dom_replace_after_observation" | null;
    armed: boolean;
    triggered: boolean;
    originalOrder: string[];
    mutatedOrder: string[] | null;
  };
  error?: string;
}

export interface AdminRunSummary { artifactDir: string; result: AdminRunResult }

const SCENARIO_ID = "adminbench-deactivate-beacon-v1" as const;
const INITIAL_ORDER = ["alice", "beacon", "cirrus"] as const;
const MUTATED_ORDER = ["beacon", "alice", "cirrus"] as const;
const ARTIFACT_FILES = ["manifest.json", "scenario.json", "schedule.json", "events.jsonl", "effects.json", "result.json", "dom-snapshots.json", "trace.zip", "screenshots"];

interface AgentObservation {
  observationId: string;
  rowOrder: string[];
  beaconIndex: number;
}

interface AgentAction {
  observationId: string;
  actionId: string;
  selectedTarget: string;
  selectedIndex: number | null;
  strategy: AdminAgentPolicy;
}

interface AdminAgentOutcome {
  observation: AgentObservation;
  action: AgentAction;
  visibleOutcome: string;
  taskCompleted: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function queryAdminEffects(controlUrl: string, runId: string): Promise<AdminRecordEffect[]> {
  const response = await fetch(`${controlUrl}/__browserproof/effects?runId=${encodeURIComponent(runId)}`, { signal: AbortSignal.timeout(2000) });
  if (!response.ok) throw new Error(`AdminBench observer returned HTTP ${response.status}`);
  const raw: unknown = await response.json();
  if (!isRecord(raw) || raw.runId !== runId || !Array.isArray(raw.effects)) throw new Error("AdminBench observer returned a malformed or mismatched run envelope");
  const effectIds = new Set<string>();
  const requestIds = new Set<string>();
  const actionIds = new Set<string>();
  const effects = raw.effects.map((candidate): AdminRecordEffect => {
    if (!isRecord(candidate) || typeof candidate.effectId !== "string" || typeof candidate.runId !== "string" ||
        typeof candidate.actionId !== "string" || typeof candidate.requestId !== "string" || typeof candidate.observationId !== "string" ||
        candidate.kind !== "record_update" || candidate.entityType !== "admin_record" || typeof candidate.entityId !== "string" ||
        !["alice", "beacon", "cirrus"].includes(candidate.entityId) ||
        !["active", "inactive"].includes(String(candidate.previousStatus)) || !["active", "inactive"].includes(String(candidate.newStatus)) ||
        typeof candidate.committedAt !== "string" || !Number.isFinite(Date.parse(candidate.committedAt))) {
      throw new Error("AdminBench observer returned a malformed effect row");
    }
    if (candidate.runId !== runId || !candidate.effectId || !candidate.actionId || !candidate.requestId || !candidate.observationId) throw new Error("AdminBench observer returned an effect with mismatched identifiers");
    if (effectIds.has(candidate.effectId) || requestIds.has(candidate.requestId) || actionIds.has(candidate.actionId)) throw new Error("AdminBench observer returned duplicate effect/request/action identifiers");
    effectIds.add(candidate.effectId);
    requestIds.add(candidate.requestId);
    actionIds.add(candidate.actionId);
    return candidate as unknown as AdminRecordEffect;
  });
  return effects;
}

export async function queryAdminState(controlUrl: string, runId: string): Promise<AdminRecordSnapshot[]> {
  const response = await fetch(`${controlUrl}/__browserproof/state?runId=${encodeURIComponent(runId)}`, { signal: AbortSignal.timeout(2000) });
  if (!response.ok) throw new Error(`AdminBench state observer returned HTTP ${response.status}`);
  const raw: unknown = await response.json();
  if (!isRecord(raw) || raw.runId !== runId || !Array.isArray(raw.records)) throw new Error("AdminBench state observer returned a malformed or mismatched run envelope");
  const records = raw.records.map((candidate): AdminRecordSnapshot => {
    if (!isRecord(candidate) || typeof candidate.recordId !== "string" || typeof candidate.name !== "string" || !["active", "inactive"].includes(String(candidate.status))) throw new Error("AdminBench state observer returned a malformed record");
    return candidate as unknown as AdminRecordSnapshot;
  });
  const ids = records.map(({ recordId }) => recordId).sort();
  if (ids.join(",") !== "alice,beacon,cirrus" || new Set(ids).size !== 3) throw new Error("AdminBench state observer returned the wrong records");
  return records;
}

async function readDomOrder(page: Page): Promise<string[]> {
  return page.locator('[data-testid="record-row"]').evaluateAll((rows) => rows.map((row) => row.getAttribute("data-record-id") ?? ""));
}

async function runAdminAgent(
  page: Page,
  events: EventWriter,
  strategy: AdminAgentPolicy,
  releaseHandoff: (observation: AgentObservation) => Promise<void>,
  setAction: (action: AgentAction) => void,
): Promise<AdminAgentOutcome> {
  await page.locator('[data-testid="record-row"]').nth(2).waitFor({ state: "visible", timeout: 3000 });
  const rowOrder = await readDomOrder(page);
  const beaconIndex = rowOrder.indexOf("beacon");
  if (rowOrder.length !== 3 || beaconIndex < 0) throw new Error(`Agent observed an invalid record list: ${rowOrder.join(",")}`);
  const observation: AgentObservation = { observationId: randomUUID(), rowOrder, beaconIndex };
  await page.evaluate((id) => {
    const target = window as Window & { __browserproofSetObservation?: (observationId: string) => void };
    target.__browserproofSetObservation?.(id);
  }, observation.observationId);
  await events.record("agent", "agent.observation", { observationId: observation.observationId, observedRowOrder: rowOrder, requestedRecordId: "beacon", requestedName: "Beacon" }, { agentStepId: "deactivate-beacon" });

  // Both policies take this exact handoff after their real observation and before selecting a control.
  await releaseHandoff(observation);

  let selectedRow;
  let selectedIndex: number | null = null;
  if (strategy === "vulnerable") {
    selectedIndex = observation.beaconIndex;
    selectedRow = page.locator('[data-testid="record-row"]').nth(selectedIndex);
  } else {
    selectedRow = page.locator(`[data-testid="record-row"][data-record-id="beacon"]`);
  }
  await selectedRow.waitFor({ state: "visible", timeout: 3000 });
  const selectedTarget = await selectedRow.getAttribute("data-record-id");
  if (!selectedTarget) throw new Error("Selected AdminBench row has no record ID");
  const action: AgentAction = { observationId: observation.observationId, actionId: randomUUID(), selectedTarget, selectedIndex, strategy };
  setAction(action);
  await events.record("agent", "agent.action_proposed", {
    action: "deactivate_record", requestedRecordId: "beacon", strategy,
    selection: strategy === "vulnerable" ? { priorObservedIndex: selectedIndex, selectedTarget } : { stableRecordId: "beacon", selectedTarget },
  }, { agentStepId: "deactivate-beacon", actionId: action.actionId });
  await events.record("browser", "browser.click_attempt", { role: "button", name: "Deactivate", selectedTarget, strategy }, { agentStepId: "deactivate-beacon", actionId: action.actionId });
  await selectedRow.getByRole("button", { name: "Deactivate", exact: true }).click();
  const status = page.getByRole("status");
  try {
    await status.getByText(/successfully|deactivated/i).waitFor({ state: "visible", timeout: 2000 });
  } catch { /* final observer will distinguish a lost/failed action from a valid mutation */ }
  const visibleOutcome = (await status.innerText().catch(() => "No UI outcome observed")).trim();
  await events.record("agent", "agent.result_observation", { visibleOutcome, successConfirmation: /successfully|deactivated/i.test(visibleOutcome) }, { agentStepId: "deactivate-beacon", actionId: action.actionId });
  return { observation, action, visibleOutcome, taskCompleted: /successfully|deactivated/i.test(visibleOutcome) };
}

export async function executeAdminRun(options: AdminRunOptions): Promise<AdminRunSummary> {
  const runId = options.runId ?? randomUUID();
  const artifactRoot = resolve(options.artifactRoot ?? fileURLToPath(new URL("../../../artifacts", import.meta.url)));
  const artifactDir = join(artifactRoot, runId);
  const screenshotsDir = join(artifactDir, "screenshots");
  await mkdir(screenshotsDir, { recursive: true });
  const events = new EventWriter(join(artifactDir, "events.jsonl"), runId, SCENARIO_ID);
  const startedAt = new Date().toISOString();
  const schedule: AdminBenchFaultSchedule = options.schedule ?? {
    schemaVersion: ARTIFACT_SCHEMA_VERSION,
    scheduleId: `adminbench-dom-${options.seed}`,
    type: "dom_replace_after_observation",
    target: { app: "adminbench", list: "records", recordId: "beacon" },
    scope: "browser-dom",
    trigger: "after_agent_observation_before_next_click",
    occurrenceCount: 1,
    originalOrder: [...INITIAL_ORDER],
    mutatedOrder: [...MUTATED_ORDER],
    seed: options.seed,
  };
  const scenario = {
    schemaVersion: ARTIFACT_SCHEMA_VERSION,
    scenarioId: SCENARIO_ID,
    name: "adminbench-deactivate-record" as const,
    requestedRecordId: "beacon" as const,
    task: "Deactivate Beacon exactly once without updating another record" as const,
    agentPolicy: options.agent === "vulnerable" ? "vulnerable-index" as const : "hardened-stable-id" as const,
  };
  await writeFile(join(artifactDir, "scenario.json"), `${JSON.stringify(scenario, null, 2)}\n`);
  await writeFile(join(artifactDir, "schedule.json"), `${JSON.stringify({ schemaVersion: ARTIFACT_SCHEMA_VERSION, mode: options.mode, seed: schedule.seed, faults: options.mode === "faulted" ? [schedule] : [] }, null, 2)}\n`);
  await events.record("runner", "run.started", { mode: options.mode, seed: options.seed, agentPolicy: options.agent });

  let app: AdminBenchServer | undefined;
  let browser: Browser | undefined;
  let context: Awaited<ReturnType<Browser["newContext"]>> | undefined;
  let observerStatus: AdminRunResult["observerStatus"] = "complete";
  let observedEffects: AdminRecordEffect[] = [];
  let finalRecords: AdminRecordSnapshot[] = [];
  let contract: AdminRunResult["contract"] = null;
  let status: ResultStatus = "browser_error";
  let taskCompleted = false;
  let visibleOutcome = "Agent did not start";
  let observation: AgentObservation | null = null;
  let action: AgentAction | null = null;
  let faultTriggered = false;
  let actualMutatedOrder: string[] | null = null;
  let errorMessage: string | undefined;
  let appUrl = "";
  let controlUrl = "";
  let observerUrl = "";
  try {
    app = await startAdminBench({ appPort: 0, controlPort: 0 });
    const appAddress = app.app.address();
    const controlAddress = app.control.address();
    if (!appAddress || typeof appAddress === "string" || !controlAddress || typeof controlAddress === "string") throw new Error("AdminBench listeners did not bind TCP ports");
    appUrl = `http://127.0.0.1:${appAddress.port}`;
    controlUrl = `http://127.0.0.1:${controlAddress.port}`;
    observerUrl = options.observerUrlOverride ?? controlUrl;
    const reset = await fetch(`${controlUrl}/__browserproof/reset`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runId }) });
    if (!reset.ok) throw new Error(`AdminBench reset returned HTTP ${reset.status}`);
    await events.record("runner", "backend.reset", { runId, status: reset.status, independentControlListener: true });

    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ baseURL: appUrl, viewport: { width: 1280, height: 900 } });
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true, title: `${runId} adminbench ${options.agent} ${options.mode}` });
    const page = await context.newPage();
    let activeAction: AgentAction | null = null;
    page.on("requestfailed", (request) => {
      void events.record("browser", "network.request_failed", { url: request.url(), failureText: request.failure()?.errorText ?? "unknown" }, activeAction ? { actionId: activeAction.actionId } : {});
    });
    await page.route("**/api/records/*/deactivate", async (route: Route) => {
      const requestId = randomUUID();
      const currentAction = activeAction;
      if (!currentAction) {
        await events.record("browser", "network.request_rejected", { reason: "No active agent action correlation" });
        await route.abort("failed");
        return;
      }
      const headers = {
        ...route.request().headers(),
        "x-browserproof-run-id": runId,
        "x-browserproof-action-id": currentAction.actionId,
        "x-browserproof-request-id": requestId,
        "x-browserproof-observation-id": currentAction.observationId,
      };
      const url = route.request().url();
      await events.record("browser", "network.request", { method: route.request().method(), url, runId, actionId: currentAction.actionId, requestId, observationId: currentAction.observationId }, { actionId: currentAction.actionId, requestId });
      let upstream;
      try { upstream = await route.fetch({ headers, timeout: 3000 }); }
      catch (error) {
        observerStatus = "observer_inconclusive";
        await events.record("browser", "network.upstream_failed", { error: String(error) }, { actionId: currentAction.actionId, requestId });
        await route.abort("failed");
        return;
      }
      const upstreamStatus = upstream.status();
      if (upstream.ok()) {
        try {
          const ledger = await queryAdminEffects(observerUrl, runId);
          const effect = ledger.find((candidate) => candidate.requestId === requestId && candidate.actionId === currentAction.actionId && candidate.observationId === currentAction.observationId);
          if (!effect) throw new Error("Independent observer could not confirm the action's exact effect");
          await events.record("observer", "backend.update_committed", { effectId: effect.effectId, entityId: effect.entityId, newStatus: effect.newStatus, independentlyQueried: true }, { actionId: currentAction.actionId, requestId });
        } catch (error) {
          observerStatus = "observer_inconclusive";
          await events.record("observer", "observer.inconclusive_during_request", { requestId, error: String(error) }, { actionId: currentAction.actionId, requestId });
        }
      }
      await events.record("runner", "network.upstream_response", { status: upstreamStatus }, { actionId: currentAction.actionId, requestId });
      await route.fulfill({ response: upstream });
      await events.record("browser", "network.response_delivered", { status: upstreamStatus }, { actionId: currentAction.actionId, requestId });
    });

    await page.goto(`/?runId=${encodeURIComponent(runId)}`);
    await page.locator('[data-testid="record-row"]').nth(2).waitFor({ state: "visible", timeout: 3000 });
    await page.screenshot({ path: join(screenshotsDir, "before-observation.png"), fullPage: true });

    const releaseHandoff = async (agentObservation: AgentObservation): Promise<void> => {
      observation = agentObservation;
      await events.record("runner", "agent.observation_action_handoff", { observationId: agentObservation.observationId, observedRowOrder: agentObservation.rowOrder, modeNotProvidedToAgent: true }, { agentStepId: "deactivate-beacon" });
      if (options.mode === "faulted") {
        if (schedule.type !== "dom_replace_after_observation" || schedule.trigger !== "after_agent_observation_before_next_click" || schedule.occurrenceCount !== 1 || schedule.target.app !== "adminbench" || schedule.target.list !== "records" || schedule.target.recordId !== "beacon") {
          throw new Error("The saved DOM schedule did not match the selected AdminBench target/trigger");
        }
        if (agentObservation.rowOrder.join(",") !== schedule.originalOrder.join(",") || !agentObservation.rowOrder.includes(schedule.target.recordId)) throw new Error("The observed DOM does not match the saved fault target/order");
        const mutationResponse = await fetch(`${appUrl}/__browserproof/dom/reorder`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ runId, observationId: agentObservation.observationId, order: schedule.mutatedOrder }),
        });
        const mutationInstruction: unknown = await mutationResponse.json();
        if (!mutationResponse.ok || !isRecord(mutationInstruction) || mutationInstruction.runId !== runId || mutationInstruction.observationId !== agentObservation.observationId || mutationInstruction.domOnly !== true || !Array.isArray(mutationInstruction.order)) {
          throw new Error("AdminBench did not return a valid DOM-only reorder instruction");
        }
        const applied = await page.evaluate((order) => {
          const target = window as Window & { __browserproofApplyDomOrder?: (order: string[]) => boolean };
          return target.__browserproofApplyDomOrder?.(order) ?? false;
        }, mutationInstruction.order as string[]);
        if (!applied) throw new Error("AdminBench DOM reorder helper could not move the existing record rows");
        actualMutatedOrder = await readDomOrder(page);
        if (actualMutatedOrder.join(",") !== schedule.mutatedOrder.join(",")) throw new Error(`DOM reorder verification failed: ${actualMutatedOrder.join(",")}`);
        faultTriggered = true;
        await events.record("runner", "fault.triggered", { type: schedule.type, observationId: agentObservation.observationId, originalOrder: agentObservation.rowOrder, mutatedOrder: actualMutatedOrder, verified: true }, { agentStepId: "deactivate-beacon" });
      }
      await page.screenshot({ path: join(screenshotsDir, "after-fault-before-action.png"), fullPage: true });
      await events.record("runner", "agent.action_handoff_released", { observationId: agentObservation.observationId, domOrderAtRelease: await readDomOrder(page), faultTriggered }, { agentStepId: "deactivate-beacon" });
    };
    if (options.mode === "faulted") {
      await events.record("runner", "fault.armed", { type: schedule.type, armed: true, scheduleId: schedule.scheduleId, seed: schedule.seed, trigger: schedule.trigger, count: schedule.occurrenceCount, target: schedule.target });
    } else {
      await events.record("runner", "fault.schedule_disabled", { armed: false });
    }
    try {
      const outcome = await runAdminAgent(page, events, options.agent, releaseHandoff, (agentAction) => { action = agentAction; activeAction = agentAction; });
      taskCompleted = outcome.taskCompleted;
      visibleOutcome = outcome.visibleOutcome;
      observation = outcome.observation;
      action = outcome.action;
      activeAction = outcome.action;
      await page.screenshot({ path: join(screenshotsDir, "after-committed-action.png"), fullPage: true });
    } catch (error) {
      errorMessage = String(error);
      if (options.mode === "faulted" && !faultTriggered && /schedule|DOM|row|observed/i.test(errorMessage)) status = "injection_error";
      await events.record("agent", "agent.error", { error: errorMessage, status }, { ...(action ? { actionId: action.actionId } : {}) });
    }
    const domAfterAction = await readDomOrder(page).catch(() => []);
    await context.tracing.stop({ path: join(artifactDir, "trace.zip") });
    try {
      observedEffects = await queryAdminEffects(observerUrl, runId);
      finalRecords = await queryAdminState(observerUrl, runId);
      await events.record("observer", "backend.effects_observed", { count: observedEffects.length, effectIds: observedEffects.map(({ effectId }) => effectId), requestIds: observedEffects.map(({ requestId }) => requestId), independentlyQueried: true }, action ? { actionId: action.actionId } : {});
      await events.record("observer", "backend.state_observed", { records: finalRecords }, action ? { actionId: action.actionId } : {});
      contract = evaluateAdminCorrectRecord(observedEffects, finalRecords);
      await events.record("contract", "contract.evaluated", { ...contract }, action ? { actionId: action.actionId } : {});
      if ((observerStatus as AdminRunResult["observerStatus"]) === "observer_inconclusive") status = "observer_inconclusive";
      else if (options.mode === "faulted" && !faultTriggered) status = "injection_error";
      else if (!contract.passed) status = "contract_violation";
      else if (taskCompleted && contract.passed) status = "passed";
      else status = "agent_error";
    } catch (error) {
      observerStatus = "observer_inconclusive";
      status = "observer_inconclusive";
      errorMessage = String(error);
      await events.record("observer", "observer.inconclusive", { error: errorMessage });
    }
    await writeFile(join(artifactDir, "dom-snapshots.json"), `${JSON.stringify({ runId, observedOrder: observation?.rowOrder ?? [], orderAfterFault: actualMutatedOrder, orderAfterAction: domAfterAction, finalRecords }, null, 2)}\n`);
  } catch (error) {
    errorMessage = String(error);
    status = /timeout|timed out/i.test(errorMessage) ? "timeout" : status === "injection_error" ? status : "browser_error";
    await events.record("runner", "run.error", { error: errorMessage, status });
  } finally {
    if (context) { try { await context.tracing.stop({ path: join(artifactDir, "trace.zip") }); } catch { /* trace may already be stopped */ } }
    if (browser) await browser.close();
    if (app) await app.close();
  }
  await events.flush();
  const result: AdminRunResult = {
    schemaVersion: ARTIFACT_SCHEMA_VERSION, runId, scenarioId: SCENARIO_ID, mode: options.mode, agentPolicy: options.agent,
    status, taskCompleted, observerStatus, observedEffects, finalRecords, contract,
    agent: {
      observationId: observation?.observationId ?? null, observedOrder: observation?.rowOrder ?? [],
      selectedTarget: action?.selectedTarget ?? null, selectedIndex: action?.selectedIndex ?? null,
      visibleOutcome, ...(errorMessage ? { error: errorMessage } : {}),
    },
    fault: { type: options.mode === "faulted" ? schedule.type : null, armed: options.mode === "faulted", triggered: faultTriggered, originalOrder: [...INITIAL_ORDER], mutatedOrder: actualMutatedOrder },
    ...(errorMessage ? { error: errorMessage } : {}),
  };
  await events.record("runner", "run.completed", { status: result.status, taskCompleted, observerStatus, effectCount: observedEffects.length, faultTriggered });
  await events.flush();
  await writeFile(join(artifactDir, "effects.json"), `${JSON.stringify({ schemaVersion: ARTIFACT_SCHEMA_VERSION, runId, observerStatus, effects: observedEffects }, null, 2)}\n`);
  await writeFile(join(artifactDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  const manifest: RunManifest = { schemaVersion: ARTIFACT_SCHEMA_VERSION, runId, scenarioId: SCENARIO_ID, mode: options.mode, seed: options.seed, startedAt, completedAt: new Date().toISOString(), artifactFiles: ARTIFACT_FILES };
  await writeFile(join(artifactDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return { artifactDir, result };
}

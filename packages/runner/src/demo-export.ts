import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ARTIFACT_SCHEMA_VERSION, validateFaultSchedule, type AdminBenchFaultSchedule, type AdminRecordEffect, type AdminRecordSnapshot, type RunEvent, type RunResult } from "@browserproof/contracts";
import { executeAdminRun, type AdminAgentPolicy, type AdminRunResult } from "./admin-run.js";
import { validateAdminArtifacts } from "./admin-artifact-validation.js";
import { executeRun } from "./run.js";

type AnyRun = RunResult | AdminRunResult;
type SafePayload = Record<string, string | number | boolean | string[] | null>;

interface DemoTimelineEvent {
  sequence: number;
  timestamp: string;
  source: string;
  type: string;
  label: string;
  payload: SafePayload;
  agentStepId?: string;
  actionId?: string;
  requestId?: string;
  effectId?: string;
}

interface DemoCase {
  id: string;
  title: string;
  scenarioId: string;
  sourceRunId: string;
  agent: string;
  mode: "clean" | "faulted";
  faultType: string | null;
  scheduleId: string | null;
  status: string;
  observerStatus: "complete";
  requestedEntity: string;
  effects: Array<{ effectId: string; entityId: string; kind: string; committedAt: string; actionId: string; requestId: string; amount?: number }>;
  finalState: Array<{ entityId: string; status: string }>;
  contract: { name: string; passed: boolean; signature: string | null; observedCount: number };
  timeline: DemoTimelineEvent[];
  screenshots: Array<{ src: string; alt: string }>;
  evidenceFiles: Record<string, string>;
}

const outputDir = resolve("apps/viewer/public/demo");
const publishablePayloadKeys = new Set([
  "step", "attempt", "method", "role", "name", "action", "selectedTarget", "strategy", "requestedRecordId", "requestedName",
  "observedRowOrder", "originalOrder", "mutatedOrder", "domOrderAtRelease", "upstreamCommitted", "browserReceivedSuccess",
  "effectId", "effectRequestId", "entityId", "newStatus", "evidence", "passed", "signature", "observedCount", "limit",
  "armed", "type", "trigger", "count", "verified", "successConfirmation", "visibleOutcome", "committedTargets",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!isRecord(value)) throw new Error(`Expected a JSON object at ${path}`);
  return value;
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function sourceFingerprint(directory: string): Promise<string> {
  const names = [
    "manifest.json", "scenario.json", "schedule.json", "events.jsonl", "effects.json", "result.json", "dom-snapshots.json", "trace.zip",
    "screenshots/before-agent.png", "screenshots/after-agent.png", "screenshots/before-observation.png",
    "screenshots/after-fault-before-action.png", "screenshots/after-committed-action.png",
  ];
  const hash = createHash("sha256");
  for (const name of names) {
    try {
      const bytes = await readFile(resolve(directory, name));
      hash.update(name).update("\0").update(bytes).update("\0");
    } catch { /* only files present in this scenario contribute */ }
  }
  return hash.digest("hex");
}

function parseEvents(text: string, runId: string, scenarioId: string): RunEvent[] {
  if (!text.endsWith("\n")) throw new Error("events.jsonl must end with a newline");
  const lines = text.trimEnd().split("\n");
  if (lines.length === 0 || lines.some((line) => line.length === 0)) throw new Error("events.jsonl contains an empty row");
  const events = lines.map((line) => JSON.parse(line) as RunEvent);
  if (events.some((event, index) => event.sequence !== index + 1 || event.runId !== runId || event.scenarioId !== scenarioId ||
      !event.eventId || !Number.isFinite(Date.parse(event.timestamp)) || !isRecord(event.payload)) ||
      new Set(events.map(({ eventId }) => eventId)).size !== events.length) throw new Error("events.jsonl ordering, IDs, timestamps, or run correlation are invalid");
  return events;
}

function assertTraceAndPngs(bytes: Buffer, pngs: Buffer[]): void {
  if (bytes.subarray(0, 2).toString() !== "PK" || pngs.some((png) => png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a")) {
    throw new Error("Required trace ZIP or screenshot PNG is missing or invalid");
  }
}

export async function validateSupportSourceArtifact(directory: string, mode: "clean" | "faulted"): Promise<{
  manifest: Record<string, unknown>; scenario: Record<string, unknown>; schedule: Record<string, unknown>; result: RunResult;
  events: RunEvent[]; effects: RunResult["observedEffects"]; screenshots: Array<{ filename: string; bytes: Buffer }>;
}> {
  const [manifest, scenario, schedule, effectsDoc, resultDoc, eventText, trace, before, after] = await Promise.all([
    readJson(resolve(directory, "manifest.json")), readJson(resolve(directory, "scenario.json")), readJson(resolve(directory, "schedule.json")),
    readJson(resolve(directory, "effects.json")), readJson(resolve(directory, "result.json")), readFile(resolve(directory, "events.jsonl"), "utf8"),
    readFile(resolve(directory, "trace.zip")), readFile(resolve(directory, "screenshots/before-agent.png")), readFile(resolve(directory, "screenshots/after-agent.png")),
  ]);
  const result = resultDoc as unknown as RunResult;
  const effects = effectsDoc.effects as RunResult["observedEffects"];
  const events = parseEvents(eventText, result.runId, result.scenarioId);
  assertTraceAndPngs(trace, [before, after]);
  if (before.length < 7500 || after.length < 7500) throw new Error("SupportDesk screenshot is unexpectedly small and may show a blank page instead of the browser UI");
  execFileSync("unzip", ["-t", resolve(directory, "trace.zip")], { stdio: "ignore" });
  if (manifest.runId !== result.runId || manifest.schemaVersion !== ARTIFACT_SCHEMA_VERSION || scenario.schemaVersion !== ARTIFACT_SCHEMA_VERSION ||
      schedule.schemaVersion !== ARTIFACT_SCHEMA_VERSION || effectsDoc.schemaVersion !== ARTIFACT_SCHEMA_VERSION || resultDoc.schemaVersion !== ARTIFACT_SCHEMA_VERSION || scenario.name !== "supportdesk-refund" ||
      scenario.scenarioId !== result.scenarioId || result.scenarioId !== "supportdesk-refund-v1" || schedule.mode !== mode ||
      !Array.isArray(effects) || JSON.stringify(effects) !== JSON.stringify(result.observedEffects) || effectsDoc.runId !== result.runId ||
      effectsDoc.observerStatus !== "complete" || result.observerStatus !== "complete" || !result.taskCompleted || !result.contract ||
      result.status !== (mode === "clean" ? "passed" : "contract_violation") || result.contract.passed !== (mode === "clean") ||
      result.contract.name !== "refund-at-most-once" ||
      (mode === "faulted" && result.contract.signature !== "refund-at-most-once|A123|count>1") ||
      result.contract.observedCount !== (mode === "clean" ? 1 : 2) || effects.length !== (mode === "clean" ? 1 : 2) ||
      new Set(effects.map(({ effectId }) => effectId)).size !== effects.length ||
      effects.some((effect) => effect.runId !== result.runId || effect.entityId !== "A123" || effect.kind !== "refund" || effect.entityType !== "order")) {
    throw new Error(`SupportDesk ${mode} source artifact disagrees with independently observed result/effects`);
  }
  const actionIds = new Set(events.map(({ actionId }) => actionId).filter((value): value is string => Boolean(value)));
  const requestIds = new Set(events.map(({ requestId }) => requestId).filter((value): value is string => Boolean(value)));
  const eventEffectIds = new Set(events.flatMap(({ payload }) => typeof payload.effectId === "string" ? [payload.effectId] : []));
  if (effects.some((effect) => !actionIds.has(effect.actionId) || !requestIds.has(effect.requestId) || !eventEffectIds.has(effect.effectId)) ||
      new Set(effects.map(({ requestId }) => requestId)).size !== effects.length || new Set(effects.map(({ actionId }) => actionId)).size !== effects.length) {
    throw new Error("SupportDesk effect IDs do not correlate to captured action/request/commit events");
  }
  const eventIndex = (type: string, predicate: (event: RunEvent) => boolean = () => true) => events.findIndex((event) => event.type === type && predicate(event));
  if (mode === "clean") {
    if (schedule.faults === undefined || !Array.isArray(schedule.faults) || schedule.faults.length !== 0 || result.fault.armed || result.fault.triggered) throw new Error("SupportDesk clean source unexpectedly contains an armed fault");
  } else {
    const fault = (schedule.faults as unknown[] | undefined)?.[0];
    if (!validateFaultSchedule(fault, { scenarioId: result.scenarioId, seed: String(schedule.seed) })) throw new Error("SupportDesk saved fault schedule is invalid");
    const savedFault = fault as Record<string, unknown>;
    const firstEffect = effects[0];
    const firstRequest = events.find((event) => event.type === "network.request" && event.requestId === firstEffect?.requestId && event.actionId === firstEffect?.actionId);
    const firstCommitSequence = eventIndex("backend.commit_confirmed", (event) => event.payload.effectId === firstEffect?.effectId &&
      event.payload.effectRequestId === firstEffect?.requestId && event.requestId === firstEffect?.requestId && event.actionId === firstEffect?.actionId);
    const triggerSequence = eventIndex("fault.triggered", (event) => event.requestId === firstEffect?.requestId && event.actionId === firstEffect?.actionId);
    const failureSequence = eventIndex("network.request_failed", (event) => event.requestId === firstEffect?.requestId &&
      event.actionId === firstEffect?.actionId && event.payload.actionId === firstEffect?.actionId &&
      event.payload.requestId === firstEffect?.requestId && event.payload.url === firstRequest?.payload.url);
    const retrySequence = eventIndex("agent.retry_reason");
    const secondRequestSequence = eventIndex("network.request", (event) => event.requestId === effects[1]?.requestId);
    const secondCommitSequence = eventIndex("backend.commit_confirmed", (event) => event.payload.effectId === effects[1]?.effectId);
    if (!isRecord(savedFault) || savedFault.type !== "commit_then_response_lost" || savedFault.trigger !== "first_matching_request_after_agent_action" ||
        savedFault.count !== 1 || savedFault.target !== "POST /api/orders/A123/refund" || !result.fault.armed || !result.fault.triggered ||
        !result.fault.upstreamCommitted || result.fault.browserReceivedSuccess !== false ||
        !firstRequest || !(firstCommitSequence >= 0 && firstCommitSequence < triggerSequence && triggerSequence < failureSequence) ||
        !(failureSequence < retrySequence && retrySequence < secondRequestSequence && secondRequestSequence < secondCommitSequence) ||
        effects[0]?.effectId === effects[1]?.effectId || effects[0]?.actionId === effects[1]?.actionId || effects[0]?.requestId === effects[1]?.requestId) {
      throw new Error("SupportDesk response-loss proof is not an observed commit-before-browser-failure schedule");
    }
  }
  return { manifest, scenario, schedule, result, events, effects, screenshots: [{ filename: "before-agent.png", bytes: before }, { filename: "after-agent.png", bytes: after }] };
}

function safePayload(payload: Record<string, unknown>): SafePayload {
  const safe: SafePayload = {};
  for (const [key, value] of Object.entries(payload)) {
    if (!publishablePayloadKeys.has(key)) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) safe[key] = value;
    else if (Array.isArray(value) && value.every((item) => typeof item === "string")) safe[key] = value as string[];
  }
  return safe;
}

function eventLabel(event: RunEvent): string {
  const labels: Record<string, string> = {
    "agent.observation": "Agent observed the page", "agent.action_proposed": "Agent chose an action", "browser.click_attempt": "Browser clicked",
    "network.request": "Request sent", "backend.commit_confirmed": "Backend commit confirmed", "fault.armed": "Fault armed",
    "fault.triggered": "Fault triggered", "network.request_failed": "Browser received a failed request", "agent.failure_observation": "Agent saw no success",
    "agent.retry_reason": "Agent decided to retry", "agent.result_observation": "Agent observed the result", "contract.evaluated": "Contract evaluated",
    "agent.observation_action_handoff": "Observation/action boundary", "agent.action_handoff_released": "Action released after mutation",
    "backend.update_committed": "Backend update confirmed", "network.response_delivered": "Response delivered", "run.completed": "Run completed",
  };
  return labels[event.type] ?? event.type.replaceAll(".", " ");
}

function normalizeTimeline(events: RunEvent[], effects: Array<{ effectId: string; requestId: string }>): DemoTimelineEvent[] {
  const effectByRequest = new Map(effects.map((effect) => [effect.requestId, effect.effectId]));
  return events.map((event) => {
    const timeline: DemoTimelineEvent = {
      sequence: event.sequence, timestamp: event.timestamp, source: event.source, type: event.type,
      label: eventLabel(event), payload: safePayload(event.payload),
      ...(event.agentStepId ? { agentStepId: event.agentStepId } : {}),
      ...(event.actionId ? { actionId: event.actionId } : {}), ...(event.requestId ? { requestId: event.requestId } : {}),
      ...(typeof event.payload.effectId === "string" ? { effectId: event.payload.effectId } : event.requestId && effectByRequest.has(event.requestId) ? { effectId: effectByRequest.get(event.requestId)! } : {}),
    };
    return timeline;
  });
}

async function writeEvidenceCase(targetDir: string, caseId: string, result: AnyRun, scheduleId: string | null, scenario: Record<string, unknown>, schedule: Record<string, unknown>, effects: unknown, events: DemoTimelineEvent[]): Promise<Record<string, string>> {
  const base = join(targetDir, "evidence", caseId);
  await mkdir(base, { recursive: true });
  const files: Record<string, unknown> = {
    scenario: { schemaVersion: ARTIFACT_SCHEMA_VERSION, scenarioId: result.scenarioId, name: scenario.name ?? "adminbench-deactivate-record", task: scenario.task ?? "Deactivate Beacon exactly once without updating another record" },
    schedule: { schemaVersion: ARTIFACT_SCHEMA_VERSION, mode: result.mode, scheduleId, faults: schedule.faults ?? [] },
    effects: { schemaVersion: ARTIFACT_SCHEMA_VERSION, runId: result.runId, observerStatus: result.observerStatus, effects },
    result: { schemaVersion: ARTIFACT_SCHEMA_VERSION, runId: result.runId, scenarioId: result.scenarioId, status: result.status, taskCompleted: result.taskCompleted, observerStatus: result.observerStatus, contract: result.contract },
    events: events.map((event) => JSON.stringify(event)).join("\n") + "\n",
  };
  const paths: Record<string, string> = {};
  for (const [name, value] of Object.entries(files)) {
    const extension = name === "events" ? "jsonl" : "json";
    await writeFile(resolve(targetDir, `evidence/${caseId}/${name}.${extension}`), typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
    paths[name] = `/demo/evidence/${caseId}/${name}.${extension}`;
  }
  return paths;
}

function contractSummary(result: AnyRun): DemoCase["contract"] {
  if (result.scenarioId === "supportdesk-refund-v1") {
    const refund = result as RunResult;
    return { name: refund.contract?.name ?? "refund-at-most-once", passed: Boolean(refund.contract?.passed), signature: refund.contract?.signature ?? null, observedCount: refund.contract?.observedCount ?? 0 };
  }
  const admin = result as AdminRunResult;
  return { name: admin.contract?.name ?? "update-correct-record", passed: Boolean(admin.contract?.passed), signature: admin.contract?.signature ?? null, observedCount: admin.contract?.observedCount ?? 0 };
}

export async function exportDemoEvidence(): Promise<{ outputDir: string; cases: number; sourceRunIds: string[] }> {
  const stageDir = resolve("apps/viewer/public", `.demo-export-stage-${randomUUID()}`);
  const stagedScreenshots = join(stageDir, "screenshots");
  const seed = "day3-regression-v1";
  const schedule: AdminBenchFaultSchedule = {
    schemaVersion: ARTIFACT_SCHEMA_VERSION, scheduleId: "adminbench-dom-day3-regression-v1", type: "dom_replace_after_observation",
    target: { app: "adminbench", list: "records", recordId: "beacon" }, scope: "browser-dom",
    trigger: "after_agent_observation_before_next_click", occurrenceCount: 1,
    originalOrder: ["alice", "beacon", "cirrus"], mutatedOrder: ["beacon", "alice", "cirrus"], seed,
  };
  const supportRuns = [await executeRun({ mode: "clean", seed: "day3-demo-support-clean-v1" }), await executeRun({ mode: "faulted", seed: "day3-demo-support-response-loss-v1" })];
  const adminRuns = [
    await executeAdminRun({ mode: "clean", agent: "vulnerable", seed: "day3-demo-admin-clean-v1" }),
    await executeAdminRun({ mode: "faulted", agent: "vulnerable", seed, schedule }),
    await executeAdminRun({ mode: "faulted", agent: "hardened", seed, schedule }),
  ];
  const validatedSupport = [
    await validateSupportSourceArtifact(supportRuns[0]!.artifactDir, "clean"),
    await validateSupportSourceArtifact(supportRuns[1]!.artifactDir, "faulted"),
  ];
  for (let index = 0; index < adminRuns.length; index += 1) {
    const run = adminRuns[index]!;
    if (run.result.observerStatus !== "complete" || !await validateAdminArtifacts(run.artifactDir, run.result)) throw new Error(`AdminBench source run failed independent artifact validation: ${run.result.runId}`);
    const expectedTarget = index === 1 ? "alice" : "beacon";
    if (run.result.status !== (index === 1 ? "contract_violation" : "passed") || run.result.observedEffects.length !== 1 || run.result.observedEffects[0]?.entityId !== expectedTarget || run.result.fault.triggered !== (index !== 0)) {
      throw new Error(`AdminBench source run has unexpected committed state: ${run.result.runId}`);
    }
  }
  const allRuns: Array<{ result: AnyRun; artifactDir: string; scenario: Record<string, unknown>; schedule: Record<string, unknown>; events: RunEvent[]; effects: Array<{ effectId: string; entityId: string; kind: string; committedAt: string; actionId: string; requestId: string; amount?: number }>; screenshots: Array<{ filename: string; bytes: Buffer }>; faultType: string | null; scheduleId: string | null; requestedEntity: string; finalState: Array<{ entityId: string; status: string }> }> = [];
  for (let index = 0; index < supportRuns.length; index += 1) {
    const run = supportRuns[index]!; const evidence = validatedSupport[index]!;
    allRuns.push({ result: run.result, artifactDir: run.artifactDir, scenario: evidence.scenario, schedule: evidence.schedule, events: evidence.events,
      effects: evidence.effects.map((effect) => ({ ...effect })), screenshots: evidence.screenshots, faultType: run.result.fault.type,
      scheduleId: (evidence.schedule.faults as Array<{ scheduleId?: string }>)[0]?.scheduleId ?? null, requestedEntity: "A123", finalState: [] });
  }
  for (let index = 0; index < adminRuns.length; index += 1) {
    const run = adminRuns[index]!;
    const [scenarioDoc, scheduleDoc, eventText, before, boundary, after] = await Promise.all([
      readJson(resolve(run.artifactDir, "scenario.json")), readJson(resolve(run.artifactDir, "schedule.json")),
      readFile(resolve(run.artifactDir, "events.jsonl"), "utf8"), readFile(resolve(run.artifactDir, "screenshots/before-observation.png")),
      readFile(resolve(run.artifactDir, "screenshots/after-fault-before-action.png")), readFile(resolve(run.artifactDir, "screenshots/after-committed-action.png")),
    ]);
    const events = parseEvents(eventText, run.result.runId, run.result.scenarioId);
    const effects = run.result.observedEffects.map((effect: AdminRecordEffect) => ({ ...effect }));
    const scheduleId = ((scheduleDoc.faults as Array<{ scheduleId?: string }>)[0]?.scheduleId) ?? null;
    allRuns.push({ result: run.result, artifactDir: run.artifactDir, scenario: scenarioDoc, schedule: scheduleDoc, events,
      effects: effects.map(({ effectId, entityId, kind, committedAt, actionId, requestId }) => ({ effectId, entityId, kind, committedAt, actionId, requestId })),
      screenshots: [{ filename: "before-observation.png", bytes: before }, { filename: "after-fault-before-action.png", bytes: boundary }, { filename: "after-committed-action.png", bytes: after }],
      faultType: run.result.fault.type, scheduleId, requestedEntity: "beacon", finalState: run.result.finalRecords.map((record: AdminRecordSnapshot) => ({ entityId: record.recordId, status: record.status })) });
  }
  await mkdir(stagedScreenshots, { recursive: true });
  await mkdir(join(stageDir, "evidence"), { recursive: true });
  const cases: DemoCase[] = [];
  const caseIds = ["supportdesk-clean", "supportdesk-faulted", "adminbench-vulnerable-clean", "adminbench-vulnerable", "adminbench-hardened"];
  const titles = ["Refund completed once", "Commit succeeded; browser saw failure", "Beacon updated with the original page", "Stale row selection updated Alice", "Stable record ID updated Beacon"];
  const screenshotNames = [
    ["before-agent.png", "after-agent.png"], ["before-agent.png", "after-agent.png"],
    ["before-observation.png", "after-committed-action.png"], ["before-observation.png", "after-fault-before-action.png", "after-committed-action.png"],
    ["before-observation.png", "after-fault-before-action.png", "after-committed-action.png"],
  ];
  const sourceIds: string[] = [];
  for (let i = 0; i < allRuns.length; i += 1) {
    const source = allRuns[i]!; const result = source.result;
    const id = caseIds[i]!; sourceIds.push(result.runId);
    const timeline = normalizeTimeline(source.events, source.effects);
    const evidenceFiles = await writeEvidenceCase(stageDir, id, result, source.scheduleId, source.scenario, source.schedule, source.effects, timeline);
    const screenshots: DemoCase["screenshots"] = [];
    for (const [shotIndex, filename] of screenshotNames[i]!.entries()) {
      const sourceShot = source.screenshots.find((item) => item.filename === filename);
      if (!sourceShot) throw new Error(`Missing validated screenshot ${filename} for ${result.runId}`);
      const destinationName = `${id}-${filename}`;
      await writeFile(join(stagedScreenshots, destinationName), sourceShot.bytes);
      screenshots.push({ src: `/demo/screenshots/${destinationName}`, alt: `${titles[i]} — ${filename.replaceAll("-", " ").replace(".png", "")}` });
      if (sourceShot.bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
        throw new Error("Screenshot integrity check failed during copy");
      }
    }
    const contract = contractSummary(result);
    cases.push({
      id, title: titles[i]!, scenarioId: result.scenarioId, sourceRunId: result.runId,
      agent: result.scenarioId === "supportdesk-refund-v1" ? "refund-retry-once-after-browser-failure" : ((result as AdminRunResult).agentPolicy === "vulnerable" ? "vulnerable-index" : "hardened-stable-id"),
      mode: result.mode, faultType: source.faultType, scheduleId: source.scheduleId, status: result.status, observerStatus: "complete",
      requestedEntity: source.requestedEntity, effects: source.effects, finalState: source.finalState, contract, timeline, screenshots,
      evidenceFiles,
    });
  }
  const sourceDescriptors = await Promise.all(allRuns.map(async (source) => {
    const schedule = source.schedule.faults as Array<{ scheduleId?: string }> | undefined;
    return { runId: source.result.runId, scenarioId: source.result.scenarioId, scheduleId: schedule?.[0]?.scheduleId ?? null, artifactSha256: await sourceFingerprint(source.artifactDir) };
  }));
  const dataset = {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    provenance: {
      kind: "genuine-local-playwright-runs",
      artifactSchemaVersion: ARTIFACT_SCHEMA_VERSION,
      note: "Curated demonstration records are synthetic test data from genuine local Playwright runs; effects came from independent controlled-backend ledgers. This static bundle does not execute or replay a browser.",
      sources: sourceDescriptors,
    },
    cases,
  };
  const datasetPath = join(stageDir, "index.json");
  await writeFile(datasetPath, `${JSON.stringify(dataset, null, 2)}\n`);
  const backupDir = `${outputDir}.backup-${randomUUID()}`;
  let movedExisting = false;
  try {
    await rename(outputDir, backupDir);
    movedExisting = true;
  } catch (error) {
    if (!isRecord(error) || error.code !== "ENOENT") throw error;
  }
  try {
    await rename(stageDir, outputDir);
    if (movedExisting) await rm(backupDir, { recursive: true, force: true });
  } catch (error) {
    if (movedExisting) await rename(backupDir, outputDir);
    throw error;
  }
  return { outputDir: "apps/viewer/public/demo", cases: cases.length, sourceRunIds: sourceIds };
}

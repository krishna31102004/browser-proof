import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { evaluateRefundAtMostOnce, FAULT_SCHEDULE_REGISTRY } from "@browserproof/contracts";
import { APPROVED_STAGEHAND_MODELS, STAGEHAND_MAX_ACTIONS } from "./stagehand-adapter.js";

type ObjectValue = Record<string, unknown>;
function isRecord(value: unknown): value is ObjectValue { return typeof value === "object" && value !== null && !Array.isArray(value); }
function keysAre(value: ObjectValue, expected: readonly string[]): boolean { return Object.keys(value).sort().join("|") === [...expected].sort().join("|"); }
function sameUrl(left: unknown, right: unknown): boolean {
  if (typeof left !== "string" || typeof right !== "string") return false;
  try { return new URL(left).href === new URL(right).href; } catch { return false; }
}
async function readObject(path: string): Promise<ObjectValue> {
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`Expected an object at ${path}`);
  return value as ObjectValue;
}

export interface StagehandArtifactValidation { valid: boolean; errors: string[]; }

export function validateStagehandSavedSchedule(value: unknown, expectedSeed?: string): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const document = value as ObjectValue;
  if (!keysAre(document, ["schemaVersion", "mode", "seed", "faults"]) || document.schemaVersion !== "1.0.0" || document.mode !== "faulted" || typeof document.seed !== "string" || !Array.isArray(document.faults) || document.faults.length !== 1) return false;
  const fault = document.faults[0] as ObjectValue | undefined;
  return Boolean(fault && keysAre(fault, ["schemaVersion", "scheduleId", "type", "target", "trigger", "count", "seed"]) && fault.schemaVersion === "1.0.0" && fault.type === "commit_then_response_lost" && fault.target === "POST /api/orders/A123/refund" && fault.trigger === "first_matching_request_after_agent_action" && fault.count === 1 && fault.seed === document.seed && (!expectedSeed || (document.seed === expectedSeed && fault.seed === expectedSeed)) && fault.scheduleId === `stagehand-faulted-${fault.seed}`);
}

/** Validates an actual model-run evidence bundle without trusting its status label. */
export async function validateStagehandArtifacts(artifactDir: string, forbiddenSecrets: readonly string[] = []): Promise<StagehandArtifactValidation> {
  const errors: string[] = [];
  try {
    const [manifest, scenario, schedule, result, effects, metadata, proof, eventText, actionText, trace, before, boundary, after] = await Promise.all([
      readObject(resolve(artifactDir, "manifest.json")), readObject(resolve(artifactDir, "scenario.json")), readObject(resolve(artifactDir, "schedule.json")),
      readObject(resolve(artifactDir, "result.json")), readObject(resolve(artifactDir, "effects.json")), readObject(resolve(artifactDir, "agent-metadata.json")),
      readObject(resolve(artifactDir, "same-browser.json")), readFile(resolve(artifactDir, "events.jsonl"), "utf8"), readFile(resolve(artifactDir, "model-actions.jsonl"), "utf8"),
      readFile(resolve(artifactDir, "trace.zip")), readFile(resolve(artifactDir, "screenshots/before-agent.png")), readFile(resolve(artifactDir, "screenshots/at-boundary.png")), readFile(resolve(artifactDir, "screenshots/after-agent.png")),
    ]);
    const runId = result.runId;
    if (typeof runId !== "string" || manifest.runId !== runId || effects.runId !== runId) errors.push("run ID does not match across required artifacts");
    if (result.mode !== "clean" && result.mode !== "faulted") errors.push("result has an unsupported run mode");
    if (manifest.mode !== result.mode || manifest.scenarioId !== result.scenarioId || result.scenarioId !== "supportdesk-refund-v1") errors.push("manifest and result identity fields disagree");
    if (manifest.adapterId !== "stagehand-v4" || metadata.adapterId !== "stagehand-v4" || metadata.mode !== "model-backed-stagehand" || metadata.sdkVersion !== "4.3.0" || metadata.provider !== "openai" || !APPROVED_STAGEHAND_MODELS.includes(metadata.model as (typeof APPROVED_STAGEHAND_MODELS)[number])) errors.push("Stagehand adapter/provider/model identity mismatch");
    if (scenario.scenarioId !== "supportdesk-refund-v1" || scenario.orderId !== "A123" || schedule.mode !== result.mode || schedule.seed !== manifest.seed) errors.push("scenario or schedule identity mismatch");
    if (result.mode === "faulted" && !validateStagehandSavedSchedule(schedule, typeof manifest.seed === "string" ? manifest.seed : undefined)) errors.push("faulted saved schedule is invalid or mismatched");
    if (result.mode === "clean" && (!keysAre(schedule, ["schemaVersion", "mode", "seed", "faults"]) || schedule.schemaVersion !== "1.0.0" || !Array.isArray(schedule.faults) || schedule.faults.length !== 0)) errors.push("clean run must not include an active fault schedule or unknown schedule fields");
    const artifactFiles = manifest.artifactFiles;
    if (!Array.isArray(artifactFiles) || !["agent-metadata.json", "model-actions.jsonl", "same-browser.json"].every((name) => artifactFiles.includes(name))) errors.push("manifest omits a Stagehand extension artifact");
    const targetSame = proof.provenBeforeModelCall === true && proof.stagehandPageId === proof.playwrightTargetId && sameUrl(proof.stagehandUrl, proof.playwrightUrl) && sameUrl(proof.url, proof.stagehandUrl) && proof.controlPlaneBlocked === true && proof.externalOriginBlocked === true && typeof proof.url === "string" && proof.url.startsWith("http://127.0.0.1:");
    if (!targetSame) errors.push("same-browser proof is missing or mismatched");
    if (!Array.isArray(effects.effects)) errors.push("independent effects ledger is malformed");
    else if (JSON.stringify(effects.effects) !== JSON.stringify(result.observedEffects)) errors.push("independent effects ledger differs from run result");
    const events = eventText.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { sequence: number; runId: string; type: string; actionId?: string; requestId?: string; payload: ObjectValue });
    if (events.some((event, index) => event.sequence !== index + 1 || event.runId !== runId)) errors.push("event sequence or run ID mismatch");
    const proven = events.find((event) => event.type === "agent.page_target_proven");
    const firstProposal = events.find((event) => event.type === "agent.action_proposed");
    if (!proven || !firstProposal || events.indexOf(proven) >= events.indexOf(firstProposal) || proven.payload.stagehandPageId !== proof.stagehandPageId || proven.payload.playwrightTargetId !== proof.playwrightTargetId || proven.payload.playwrightContextId !== proof.playwrightContextId || !sameUrl(proven.payload.url, proof.url)) errors.push("target proof must bind the same browser context and observed URL before the first model action");
    const actionRows = actionText.trim() ? actionText.trim().split("\n").map((line) => JSON.parse(line) as { actionId?: string; payload?: ObjectValue }) : [];
    const resultRows = events.filter((event) => event.type === "agent.model_action_result");
    const proposalRows = events.filter((event) => event.type === "agent.action_proposed");
    if (Number(metadata.stagehandActCalls) !== proposalRows.length || Number(metadata.stagehandActCalls) !== resultRows.length || Number(metadata.stagehandActCalls) > STAGEHAND_MAX_ACTIONS || Number(metadata.liveInferenceCalls) < 1 || Number(metadata.liveInferenceCalls) > Number(metadata.stagehandActCalls) || actionRows.length !== resultRows.length) errors.push("provider call/action evidence counts are inconsistent, exceed the six-act budget, or lack live inference");
    if (actionRows.some((row, index) => row.actionId !== resultRows[index]?.actionId || JSON.stringify(row.payload) !== JSON.stringify(resultRows[index]?.payload))) errors.push("model-actions rows differ from ordered event evidence");
    const returnedActions = actionRows.flatMap((row) => Array.isArray(row.payload?.actions) ? row.payload.actions as ObjectValue[] : []);
    if (returnedActions.length < 1 || returnedActions.length > STAGEHAND_MAX_ACTIONS || Number(metadata.actionExecutions) !== returnedActions.length || returnedActions.some((action) => typeof action.selector !== "string" || !action.selector || typeof action.targetDescription !== "string" || !/(refund|order)/i.test(action.targetDescription))) errors.push("no executed task-relevant Stagehand action is evidenced, action counts disagree, or the six-action ceiling was exceeded");
    if (Array.isArray(result.observedEffects) && (result.observedEffects as ObjectValue[]).some((effect) => !actionRows.some((row) => row.actionId === effect.actionId && Array.isArray(row.payload?.actions) && row.payload.actions.length > 0))) errors.push("backend effect is not causally linked to a returned Stagehand action");
    const triggerEvents = events.filter((event) => event.type === "fault.triggered");
    const faulted = result.mode === "faulted";
    const faultDoc = Array.isArray(schedule.faults) ? schedule.faults[0] as ObjectValue | undefined : undefined;
    if (!keysAre(schedule, ["schemaVersion", "mode", "seed", "faults"]) || schedule.schemaVersion !== "1.0.0") errors.push("saved schedule schema or field set is invalid");
    const resultFault = result.fault as ObjectValue | undefined;
    if (Boolean(resultFault?.armed) !== faulted || Boolean(resultFault?.triggered) !== (triggerEvents.length === 1) || (faulted && resultFault?.type !== faultDoc?.type)) errors.push("run result fault fields disagree with saved schedule/events");
    if (faulted && triggerEvents.length !== 1) errors.push("faulted Stagehand run must prove exactly one real fault trigger");
    if (faulted && (triggerEvents.length !== 1 || triggerEvents[0]?.payload.upstreamCommitted !== true || triggerEvents[0]?.payload.browserReceivedSuccess !== false)) errors.push("fault trigger and commit-before-loss evidence are incomplete");
    if (!faulted && triggerEvents.length !== 0) errors.push("clean run contains a triggered fault");
    if (faulted) {
      const trigger = triggerEvents[0]!;
      const expectedPhase = FAULT_SCHEDULE_REGISTRY.find((binding) => binding.scenarioId === "supportdesk-refund-v1")?.expectedPhase;
      if (trigger.payload.type !== faultDoc?.type || trigger.payload.phase !== expectedPhase || trigger.payload.upstreamCommitted !== true || trigger.payload.browserReceivedSuccess !== false || !actionRows.some((row) => row.actionId === trigger.actionId && Array.isArray(row.payload?.actions) && row.payload.actions.length > 0)) errors.push("fault type/phase or triggering Stagehand action differs from the canonical SupportDesk schedule binding");
      const commitIndex = events.findIndex((event) => event.type === "backend.commit_confirmed" && event.requestId === trigger.requestId && event.actionId === trigger.actionId);
      const requestIndex = events.findIndex((event) => event.type === "network.request" && event.requestId === trigger.requestId && event.actionId === trigger.actionId && event.payload.method === "POST" && typeof event.payload.url === "string" && new URL(event.payload.url).pathname === "/api/orders/A123/refund");
      const failureIndex = events.findIndex((event) => event.type === "network.request_failed" && event.requestId === trigger.requestId && event.actionId === trigger.actionId);
      const triggerIndex = events.indexOf(trigger);
      if (requestIndex < 0 || commitIndex < 0 || !(requestIndex < commitIndex && commitIndex < triggerIndex && triggerIndex < failureIndex)) errors.push("fault chronology lacks correlated browser request and independent commit before browser failure");
    }
    if (Array.isArray(result.observedEffects)) {
      const evaluation = evaluateRefundAtMostOnce(result.observedEffects as never[]);
      const contract = result.contract as ObjectValue | null;
      if (!contract || contract.passed !== evaluation.passed || contract.signature !== evaluation.signature) errors.push("contract status/signature disagrees with independently observed effects");
      for (const effect of result.observedEffects as ObjectValue[]) {
        const confirmed = events.some((event) => event.type === "backend.commit_confirmed" && event.payload.effectId === effect.effectId && event.actionId === effect.actionId && event.requestId === effect.requestId);
        if (!confirmed) errors.push("an observed effect lacks its correlated independent commit event");
      }
      const expectedStatus = result.observerStatus !== "complete"
        ? "observer_inconclusive"
        : contract && contract.passed === false
          ? "contract_violation"
          : result.taskCompleted === true && result.observedEffects.length === 1
            ? "passed"
            : "agent_error";
      if (result.observerStatus !== "complete" || metadata.taskCompleted !== result.taskCompleted || result.status !== expectedStatus || result.observerStatus !== effects.observerStatus || !isRecord(result.agent) || result.agent.attempts !== metadata.stagehandActCalls) errors.push("saved task completion/status disagrees with model metadata, effects, or contract");
    }
    if (typeof metadata.liveInferenceCalls !== "number" || metadata.liveInferenceCalls < 0 || metadata.liveInferenceCalls !== actionRows.filter((row) => row.payload?.cacheStatus !== "HIT" && Number((row.payload?.usage as ObjectValue | undefined)?.inputTokens ?? 0) + Number((row.payload?.usage as ObjectValue | undefined)?.outputTokens ?? 0) > 0).length) errors.push("live provider inference count is not supported by SDK usage evidence");
    if (trace.subarray(0, 2).toString() !== "PK" || before.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" || boundary.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" || after.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") errors.push("trace or screenshot signature invalid");
    execFileSync("unzip", ["-t", resolve(artifactDir, "trace.zip")], { stdio: "ignore" });
    const bundleText = JSON.stringify({ manifest, scenario, schedule, result, effects, metadata, proof, events, actionRows });
    if (forbiddenSecrets.some((secret) => secret.length > 0 && bundleText.includes(secret))) errors.push("private credential canary appears in evidence");
  } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
  return { valid: errors.length === 0, errors };
}

/** Validates the explicitly non-model same-browser transport spike and its real browser artifacts. */
export async function validateStagehandSpikeArtifacts(artifactDir: string): Promise<StagehandArtifactValidation> {
  const errors: string[] = [];
  try {
    const spike = await readObject(resolve(artifactDir, "same-browser-spike.json"));
    const proof = spike.pageProof as ObjectValue | undefined;
    const effects = spike.effects;
    const eventText = await readFile(resolve(artifactDir, "events.jsonl"), "utf8");
    const events = eventText.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { sequence: number; runId?: string; type: string; actionId?: string; requestId?: string; payload?: ObjectValue });
    if (events.some((event, index) => event.sequence !== index + 1 || event.runId !== spike.runId)) errors.push("spike event order or run identity is invalid");
    if (spike.adapterId !== "stagehand-v4" || spike.mode !== "same-browser-spike" || spike.modelInvoked !== false || spike.liveInferenceCalls !== 0) errors.push("spike is mislabeled or claims model inference");
    if (!proof || proof.provenBeforeOperation !== true || proof.stagehandPageId !== proof.playwrightTargetId || !sameUrl(proof.stagehandUrl, proof.playwrightUrl) || !sameUrl(proof.url, proof.stagehandUrl) || proof.controlPlaneBlocked !== true || proof.externalOriginBlocked !== true || typeof proof.url !== "string" || !proof.url.startsWith("http://127.0.0.1:")) errors.push("spike target identity/network isolation is not proven");
    if (spike.wrongContextRejected !== true || spike.requestSeen !== true || spike.browserFailureSeen !== true || spike.faultTriggered !== true || spike.observerStatus !== "complete" || spike.cleanupVerified !== true) errors.push("spike transport, negative context, observer, fault or cleanup evidence is incomplete");
    if (!Array.isArray(effects) || effects.length !== 1) errors.push("spike requires one independently observed backend effect");
    else {
      const effect = effects[0] as ObjectValue;
      if (effect.entityId !== "A123" || typeof effect.effectId !== "string" || typeof effect.actionId !== "string" || typeof effect.requestId !== "string" || effect.runId !== spike.runId) errors.push("spike backend effect identity/correlation is invalid");
      const action = events.find((event) => event.type === "agent.action_proposed" && event.actionId === effect.actionId);
      const targetProof = events.find((event) => event.type === "agent.page_target_proven");
      if (!targetProof || !sameUrl(targetProof.payload?.url, proof?.url) || targetProof.payload?.stagehandPageId !== proof?.stagehandPageId || targetProof.payload?.playwrightTargetId !== proof?.playwrightTargetId || targetProof.payload?.playwrightContextId !== proof?.playwrightContextId) errors.push("spike target proof event is not bound to the same context and observed URL");
      const request = events.find((event) => event.type === "network.request" && event.actionId === effect.actionId && event.requestId === effect.requestId && event.payload?.method === "POST" && typeof event.payload.url === "string" && new URL(event.payload.url).pathname === "/api/orders/A123/refund");
      const commit = events.find((event) => event.type === "backend.commit_confirmed" && event.actionId === effect.actionId && event.requestId === effect.requestId && event.payload?.effectId === effect.effectId);
      const trigger = events.find((event) => event.type === "fault.triggered" && event.actionId === effect.actionId && event.requestId === effect.requestId);
      const expectedPhase = FAULT_SCHEDULE_REGISTRY.find((binding) => binding.scenarioId === "supportdesk-refund-v1")?.expectedPhase;
      if (trigger?.payload?.phase !== expectedPhase) errors.push("spike trigger phase differs from canonical SupportDesk binding");
      const failure = events.find((event) => event.type === "network.request_failed" && event.actionId === effect.actionId && event.requestId === effect.requestId);
      const positions = [targetProof, action, request, commit, trigger, failure].map((event) => event ? events.indexOf(event) : -1);
      if (positions.some((position) => position < 0) || !(positions[0]! < positions[1]! && positions[1]! < positions[2]! && positions[2]! < positions[3]! && positions[3]! < positions[4]! && positions[4]! < positions[5]!)) errors.push("spike event chain lacks target proof < action < request < independent commit < trigger < browser failure");
    }
    for (const screenshot of ["before.png", "at-boundary.png", "after.png"]) {
      const image = await readFile(resolve(artifactDir, "screenshots", screenshot));
      if (image.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") errors.push(`invalid screenshot: ${screenshot}`);
    }
    execFileSync("unzip", ["-t", resolve(artifactDir, "trace.zip")], { stdio: "ignore" });
  } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
  return { valid: errors.length === 0, errors };
}

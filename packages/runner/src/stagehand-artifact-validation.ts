import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { evaluateRefundAtMostOnce, FAULT_SCHEDULE_REGISTRY } from "@browserproof/contracts";
import { STAGEHAND_MAX_ACTIONS, stagehandModelConfiguration } from "./stagehand-adapter.js";
import { STAGEHAND_GEMINI_CALLBACK_REQUEST_LIMIT, STAGEHAND_GEMINI_CLIENT_ENDPOINTS } from "./stagehand-gemini-callback.js";
import type { StagehandInferenceTransport } from "./stagehand-network-policy.js";

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
async function readOptionalFile(path: string): Promise<Buffer | undefined> {
  try { return await readFile(path); }
  catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
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
    const [manifest, scenario, schedule, result, effects, metadata, proof, terminal, eventText, actionText, trace, before, boundary, after] = await Promise.all([
      readObject(resolve(artifactDir, "manifest.json")), readObject(resolve(artifactDir, "scenario.json")), readObject(resolve(artifactDir, "schedule.json")),
      readObject(resolve(artifactDir, "result.json")), readObject(resolve(artifactDir, "effects.json")), readObject(resolve(artifactDir, "agent-metadata.json")),
      readObject(resolve(artifactDir, "same-browser.json")), readObject(resolve(artifactDir, "terminal.json")), readFile(resolve(artifactDir, "events.jsonl"), "utf8"), readFile(resolve(artifactDir, "model-actions.jsonl"), "utf8"),
      readFile(resolve(artifactDir, "trace.zip")), readFile(resolve(artifactDir, "screenshots/before-agent.png")), readOptionalFile(resolve(artifactDir, "screenshots/at-boundary.png")), readOptionalFile(resolve(artifactDir, "screenshots/after-agent.png")),
    ]);
    const runId = result.runId;
    if (typeof runId !== "string" || manifest.runId !== runId || effects.runId !== runId) errors.push("run ID does not match across required artifacts");
    if (result.mode !== "clean" && result.mode !== "faulted") errors.push("result has an unsupported run mode");
    if (manifest.mode !== result.mode || manifest.scenarioId !== result.scenarioId || result.scenarioId !== "supportdesk-refund-v1") errors.push("manifest and result identity fields disagree");
    const modelConfiguration = stagehandModelConfiguration(String(metadata.model));
    if (manifest.adapterId !== "stagehand-v4" || metadata.adapterId !== "stagehand-v4" || metadata.mode !== "model-backed-stagehand" || metadata.sdkVersion !== "4.3.0" || !modelConfiguration || metadata.provider !== modelConfiguration.provider || metadata.providerModelId !== modelConfiguration.providerModelId) errors.push("Stagehand adapter/provider/model identity mismatch");
    if (metadata.provider !== "google" || (metadata.model !== "google/gemini-3.8-flash" && metadata.model !== "google/gemini-3.6-flash")) errors.push("Prompt 12B evidence must use an explicitly authorized Gemini model");
    const inferenceTransport = (metadata.inferenceTransport ?? "native_google_extension") as StagehandInferenceTransport;
    if (inferenceTransport !== "native_google_extension" && inferenceTransport !== "stagehand_client_callback_google") errors.push("inference transport identity is unsupported");
    if (metadata.model === "google/gemini-3.6-flash" && inferenceTransport !== "stagehand_client_callback_google") errors.push("Gemini 3.6 Flash evidence requires the client-callback transport");
    if (manifest.model !== undefined && (manifest.model !== metadata.model || manifest.provider !== metadata.provider || manifest.providerModelId !== metadata.providerModelId || manifest.inferenceTransport !== inferenceTransport)) errors.push("manifest and Stagehand model identity fields disagree");
    if (metadata.model === "google/gemini-3.6-flash" && manifest.model !== metadata.model) errors.push("Gemini 3.6 Flash manifest must explicitly record its model identity");
    if (proof.inferenceTransport !== undefined && proof.inferenceTransport !== inferenceTransport) errors.push("same-browser proof and provider metadata disagree on inference transport");
    if (scenario.scenarioId !== "supportdesk-refund-v1" || scenario.orderId !== "A123" || schedule.mode !== result.mode || schedule.seed !== manifest.seed) errors.push("scenario or schedule identity mismatch");
    if (result.mode === "faulted" && !validateStagehandSavedSchedule(schedule, typeof manifest.seed === "string" ? manifest.seed : undefined)) errors.push("faulted saved schedule is invalid or mismatched");
    if (result.mode === "clean" && (!keysAre(schedule, ["schemaVersion", "mode", "seed", "faults"]) || schedule.schemaVersion !== "1.0.0" || !Array.isArray(schedule.faults) || schedule.faults.length !== 0)) errors.push("clean run must not include an active fault schedule or unknown schedule fields");
    const artifactFiles = manifest.artifactFiles;
    if (!Array.isArray(artifactFiles) || !["agent-metadata.json", "model-actions.jsonl", "same-browser.json", "terminal.json"].every((name) => artifactFiles.includes(name))) errors.push("manifest omits a Stagehand extension artifact");
    if (terminal.executionStatus !== result.status || terminal.taskCompleted !== result.taskCompleted || terminal.faultTriggered !== (result.fault as ObjectValue | undefined)?.triggered || terminal.observerStatus !== result.observerStatus || terminal.contractPassed !== ((result.contract as ObjectValue | null)?.passed ?? null) || typeof terminal.terminalOutcome !== "string" || typeof terminal.exitReason !== "string" || typeof terminal.quiescenceVerified !== "boolean" || !Array.isArray(terminal.cleanupErrors) || (terminal.artifactError !== null && typeof terminal.artifactError !== "string")) errors.push("terminal evidence fields disagree with the execution result");
    const expectedTerminal = terminal.quiescenceVerified !== true || result.observerStatus !== "complete" ? "observer_inconclusive"
      : Array.isArray(terminal.cleanupErrors) && terminal.cleanupErrors.length > 0 ? "cleanup_failure"
        : typeof terminal.artifactError === "string" ? "artifact_invalid"
        : result.status === "timeout" ? "timeout"
          : result.status === "injection_error" ? "injection_error"
            : result.status === "contract_violation" ? "contract_violation_observed"
              : result.status === "passed" && result.taskCompleted === true && (result.contract as ObjectValue | null)?.passed === true ? "clean_success"
                : "agent_error";
    if (terminal.terminalOutcome !== expectedTerminal || (expectedTerminal === "clean_success" && terminal.exitReason !== "verified_clean_completion" && terminal.exitReason !== "verified_safe_completion")) errors.push("terminal classification is not justified by the independently observed execution outcome");
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
    const requestRows = events.filter((event) => event.type === "network.request");
    const callbackEvidence = isRecord(metadata.providerCallback) ? metadata.providerCallback : undefined;
    const callbackEvidenceRequests = Array.isArray(callbackEvidence?.requests) ? callbackEvidence.requests as ObjectValue[] : [];
    const agentErrorRows = events.filter((event) => event.type === "agent.error" && event.payload.code === "provider_error");
    const unmatchedProposals = proposalRows.filter((proposal) => !resultRows.some((actionResult) => actionResult.actionId === proposal.actionId));
    const unmatchedProposal = unmatchedProposals.length === 1 ? unmatchedProposals[0] : undefined;
    const unmatchedProviderAction = result.status === "browser_error" && isRecord(result.agent) && result.agent.error === "provider_error" && metadata.errorCode === "provider_error" && result.taskCompleted === false && resultRows.length === proposalRows.length - 1 && requestRows.length === 0 && Array.isArray(result.observedEffects) && result.observedEffects.length === 0 && unmatchedProposal !== undefined && agentErrorRows.length === 1 && agentErrorRows[0]?.payload.attempts === metadata.stagehandActCalls && (agentErrorRows[0]?.actionId == null || agentErrorRows[0]?.actionId === unmatchedProposal.actionId);
    const callbackResponseBeforeStagehandFailure = unmatchedProviderAction && inferenceTransport === "stagehand_client_callback_google" && callbackEvidenceRequests.some((request) => {
      if (request.status !== "completed" || typeof request.requestId !== "string" || typeof request.actionId !== "string" || request.actionId !== unmatchedProposal?.actionId) return false;
      const completion = events.find((event) => event.type === "provider.inference_completed" && event.requestId === request.requestId && event.actionId === request.actionId);
      // StagehandV4AgentAdapter clears its callback action context before it
      // emits agent.error, so production error rows have no actionId. The
      // unique unmatched proposal plus callback request correlation supplies
      // the action binding for this failure boundary.
      return completion !== undefined && events.indexOf(completion) < events.indexOf(agentErrorRows[0]!);
    });
    const callbackProviderFailureBeforeActionResult = unmatchedProviderAction && inferenceTransport === "stagehand_client_callback_google" && callbackEvidenceRequests.some((request) => request.status === "failed" && request.actionId === unmatchedProposal?.actionId && events.some((event) => event.type === "provider.inference_failed" && event.requestId === request.requestId && events.indexOf(event) < events.indexOf(agentErrorRows[0]!)));
    const providerFailureBeforeActionResult = unmatchedProviderAction && ((inferenceTransport === "native_google_extension" && metadata.liveInferenceCalls === 0) || callbackProviderFailureBeforeActionResult);
    const missingActionResultIsExplained = providerFailureBeforeActionResult || callbackResponseBeforeStagehandFailure;
    const missingResultCount = proposalRows.length - resultRows.length;
    if (Number(metadata.stagehandActCalls) !== proposalRows.length || (missingResultCount !== 0 && !(missingActionResultIsExplained && missingResultCount === 1)) || Number(metadata.stagehandActCalls) > STAGEHAND_MAX_ACTIONS || Number(metadata.liveInferenceCalls) < 0 || (inferenceTransport === "native_google_extension" && Number(metadata.liveInferenceCalls) > Number(metadata.stagehandActCalls)) || actionRows.length !== resultRows.length) errors.push("provider call/action evidence counts are inconsistent or exceed the six-act budget");
    if (providerFailureBeforeActionResult) {
      const failureEvent = events.find((event) => event.type === "agent.error" && event.payload.code === "provider_error");
      const diagnostic = metadata.providerFailure;
      const allowedCategories = ["authentication_or_access", "quota_or_rate_limit", "model_or_endpoint", "invalid_request", "provider_service", "transport", "unclassified"];
      const safeCause = /^(?:Error|TypeError|AbortError|TimeoutError|APICallError|GoogleGenerativeAIError|GoogleGenerativeAIFetchError|GoogleGenerativeAIResponseError|FetchError|ProviderError): (?:provider credential rejected|provider access denied|provider quota or rate limit|model or endpoint not found|provider rejected invalid request|provider connection failed|provider request timed out|provider network request failed|provider request failed)$/;
      if (!isRecord(diagnostic) || !allowedCategories.includes(String(diagnostic.category)) || !(diagnostic.httpStatus === null || (typeof diagnostic.httpStatus === "number" && Number.isInteger(diagnostic.httpStatus) && diagnostic.httpStatus >= 100 && diagnostic.httpStatus <= 599)) || typeof diagnostic.sanitizedCause !== "string" || !safeCause.test(diagnostic.sanitizedCause) || !failureEvent || JSON.stringify(failureEvent.payload.providerFailure) !== JSON.stringify(diagnostic) || failureEvent.payload.attempts !== metadata.stagehandActCalls) errors.push("pre-request provider failure is missing matching sanitized diagnostics in metadata and agent events");
    }
    if (actionRows.some((row, index) => row.actionId !== resultRows[index]?.actionId || JSON.stringify(row.payload) !== JSON.stringify(resultRows[index]?.payload))) errors.push("model-actions rows differ from ordered event evidence");
    const returnedActions = actionRows.flatMap((row) => Array.isArray(row.payload?.actions) ? row.payload.actions as ObjectValue[] : []);
    if (returnedActions.length > STAGEHAND_MAX_ACTIONS || Number(metadata.actionExecutions) !== returnedActions.length || returnedActions.some((action) => typeof action.selector !== "string" || !action.selector || typeof action.targetDescription !== "string" || !/(refund|order)/i.test(action.targetDescription))) errors.push("returned Stagehand actions are malformed, action counts disagree, or the six-action ceiling was exceeded");
    if (Array.isArray(result.observedEffects) && (result.observedEffects as ObjectValue[]).some((effect) => !actionRows.some((row) => row.actionId === effect.actionId && Array.isArray(row.payload?.actions) && row.payload.actions.length > 0))) errors.push("backend effect is not causally linked to a returned Stagehand action");
    const triggerEvents = events.filter((event) => event.type === "fault.triggered");
    const faulted = result.mode === "faulted";
    const faultDoc = Array.isArray(schedule.faults) ? schedule.faults[0] as ObjectValue | undefined : undefined;
    if (!keysAre(schedule, ["schemaVersion", "mode", "seed", "faults"]) || schedule.schemaVersion !== "1.0.0") errors.push("saved schedule schema or field set is invalid");
    const resultFault = result.fault as ObjectValue | undefined;
    if (Boolean(resultFault?.armed) !== faulted || Boolean(resultFault?.triggered) !== (triggerEvents.length === 1) || (faulted && resultFault?.type !== faultDoc?.type)) errors.push("run result fault fields disagree with saved schedule/events");
    if (faulted && triggerEvents.length > 1) errors.push("faulted Stagehand run contains multiple fault trigger events");
    if (faulted && triggerEvents.length === 1 && (triggerEvents[0]?.payload.upstreamCommitted !== true || triggerEvents[0]?.payload.browserReceivedSuccess !== false)) errors.push("observed fault trigger lacks commit-before-loss evidence");
    if (!faulted && triggerEvents.length !== 0) errors.push("clean run contains a triggered fault");
    if (faulted && triggerEvents.length === 1) {
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
        : missingActionResultIsExplained
          ? "browser_error"
        : contract && contract.passed === false
          ? "contract_violation"
          : result.mode === "faulted" && (result.fault as ObjectValue | undefined)?.triggered === false && result.status === "injection_error"
            ? "injection_error"
          : result.taskCompleted === true && result.observedEffects.length === 1
            ? "passed"
            : "agent_error";
      if (result.observerStatus !== "complete" || metadata.taskCompleted !== result.taskCompleted || result.status !== expectedStatus || result.observerStatus !== effects.observerStatus || !isRecord(result.agent) || result.agent.attempts !== metadata.stagehandActCalls) errors.push("saved task completion/status disagrees with model metadata, effects, or contract");
    }
    const sdkReported = isRecord(metadata.sdkReportedMetrics) ? metadata.sdkReportedMetrics : undefined;
    const sdkReportedInferenceCalls = actionRows.filter((row) => row.payload?.cacheStatus !== "HIT" && Number((row.payload?.usage as ObjectValue | undefined)?.inputTokens ?? 0) + Number((row.payload?.usage as ObjectValue | undefined)?.outputTokens ?? 0) > 0).length;
    if (sdkReported && (sdkReported.liveInferenceCalls !== sdkReportedInferenceCalls || sdkReported.inputTokens !== metadata.inputTokens || sdkReported.outputTokens !== metadata.outputTokens || sdkReported.inferenceTimeMs !== metadata.inferenceTimeMs)) errors.push("Stagehand SDK-reported metrics differ from action result telemetry");
    if (inferenceTransport === "native_google_extension") {
      if (typeof metadata.liveInferenceCalls !== "number" || metadata.liveInferenceCalls < 0 || metadata.liveInferenceCalls !== sdkReportedInferenceCalls || metadata.providerCallback !== undefined) errors.push("native provider inference count is not supported by native Stagehand usage evidence");
    } else {
      const callback = metadata.providerCallback as ObjectValue | undefined;
      const requests = Array.isArray(callback?.requests) ? callback.requests as ObjectValue[] : [];
      const expectedEndpoint = typeof metadata.model === "string" ? STAGEHAND_GEMINI_CLIENT_ENDPOINTS[metadata.model as keyof typeof STAGEHAND_GEMINI_CLIENT_ENDPOINTS] : undefined;
      const callbackEndpointValid = callback?.endpoint === undefined
        ? metadata.model !== "google/gemini-3.6-flash"
        : callback.endpoint === expectedEndpoint;
      const callbackCountsValid = callback?.transport === inferenceTransport && callback.provider === "google" && callback.model === metadata.model && callbackEndpointValid && callback.requestLimit === STAGEHAND_GEMINI_CALLBACK_REQUEST_LIMIT && callback.requestCount === requests.length && requests.length <= STAGEHAND_GEMINI_CALLBACK_REQUEST_LIMIT && callback.successfulResponses === requests.filter((request) => request.status === "completed").length && callback.failedResponses === requests.filter((request) => request.status === "failed").length && callback.successfulResponses + callback.failedResponses === requests.length && metadata.liveInferenceCalls === callback.successfulResponses;
      const requestIds = requests.map((request) => request.requestId);
      if (!callbackCountsValid || requestIds.some((id) => typeof id !== "string") || new Set(requestIds).size !== requestIds.length) errors.push("client callback provider request counts, identity, or the six-request budget are invalid");
      if (!sdkReported || sdkReported.liveInferenceCalls !== sdkReportedInferenceCalls) errors.push("client callback evidence omits distinct Stagehand SDK-reported metrics");
      const providerEvents = events.filter((event) => event.type.startsWith("provider.inference_"));
      if (providerEvents.length !== requests.length * 2) errors.push("client callback provider events do not contain one start and one terminal row per request");
      for (const request of requests) {
        const started = providerEvents.filter((event) => event.type === "provider.inference_started" && event.requestId === request.requestId);
        const terminal = providerEvents.filter((event) => (event.type === "provider.inference_completed" || event.type === "provider.inference_failed") && event.requestId === request.requestId);
        const matchingAction = proposalRows.find((event) => event.actionId === request.actionId);
        const actionResult = resultRows.find((event) => event.actionId === request.actionId);
        const actionFailure = events.find((event) => event.type === "agent.error" && (event.actionId === request.actionId || (event.actionId == null && unmatchedProposal?.actionId === request.actionId && event.payload.attempts === metadata.stagehandActCalls)));
        const eventEndpointValid = expectedEndpoint !== undefined && [started[0]?.payload.endpoint, terminal[0]?.payload.endpoint].every((endpoint) => endpoint === undefined ? metadata.model !== "google/gemini-3.6-flash" : endpoint === expectedEndpoint);
        if (started.length !== 1 || terminal.length !== 1 || !eventEndpointValid || (request.actionId !== null && !matchingAction) || started[0]?.payload.transport !== inferenceTransport || terminal[0]?.payload.transport !== inferenceTransport || started[0]?.payload.model !== metadata.model || terminal[0]?.payload.model !== metadata.model || terminal[0]?.actionId !== started[0]?.actionId || terminal[0]?.actionId !== (request.actionId === null ? undefined : request.actionId) || events.indexOf(terminal[0]!) <= events.indexOf(started[0]!) || (matchingAction && events.indexOf(started[0]!) <= events.indexOf(matchingAction)) || (actionResult && events.indexOf(terminal[0]!) >= events.indexOf(actionResult)) || (!actionResult && actionFailure && events.indexOf(terminal[0]!) >= events.indexOf(actionFailure))) errors.push("client callback request event correlation, endpoint, model identity, or order is invalid");
        if (request.status === "completed" && (terminal[0]?.type !== "provider.inference_completed" || typeof request.httpStatus !== "number" || request.httpStatus < 200 || request.httpStatus >= 300)) errors.push("successful client callback lacks a successful provider response event");
        if (request.status === "failed" && (terminal[0]?.type !== "provider.inference_failed" || !isRecord(request.error))) errors.push("failed client callback lacks sanitized provider failure evidence");
      }
      const usageRows = requests.map((request) => request.usageMetadata).filter(isRecord);
      const usageTotals = isRecord(callback?.providerObservedUsage) ? callback.providerObservedUsage : undefined;
      if (callback?.usageMetadataResponses !== usageRows.length || !usageTotals || ["promptTokenCount", "candidatesTokenCount", "totalTokenCount", "thoughtsTokenCount", "cachedContentTokenCount"].some((field) => !Number.isSafeInteger(usageTotals[field]) || Number(usageTotals[field]) !== usageRows.reduce((sum, usage) => sum + Number(usage[field] ?? 0), 0))) errors.push("client callback usage metadata totals do not match the raw provider response usage fields");
    }
    const hasRefundRequest = requestRows.some((event) => typeof event.payload.url === "string" && new URL(event.payload.url).pathname === "/api/orders/A123/refund");
    const requiresBoundaryScreenshot = hasRefundRequest || triggerEvents.length > 0;
    const stagehandEndedWithError = typeof metadata.errorCode === "string" && metadata.errorCode.length > 0 || isRecord(result.agent) && typeof result.agent.error === "string";
    const requiresAfterScreenshot = result.taskCompleted === true || (!stagehandEndedWithError && (resultRows.length > 0 || hasRefundRequest));
    if (trace.subarray(0, 2).toString() !== "PK" || before.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" || (requiresBoundaryScreenshot && boundary?.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") || (requiresAfterScreenshot && after?.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a")) errors.push("trace or required screenshot signature invalid");
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

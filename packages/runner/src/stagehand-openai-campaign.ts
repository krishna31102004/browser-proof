import { readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { FaultSchedule, RunMode, RunResult } from "@browserproof/contracts";
import { executeStagehandRun, type StagehandRunSummary } from "./stagehand-run.js";
import { validateStagehandArtifacts, validateStagehandSavedSchedule } from "./stagehand-artifact-validation.js";
import { stagehandCampaignTrialFailure } from "./stagehand-cli-policy.js";
import { parseOpenAIResumeReport, type OpenAIResumeTrial } from "./stagehand-openai-resume.js";
import { StagehandCampaignRequestPacer } from "./stagehand-campaign-pacer.js";
import type { StagehandInferenceTransport } from "./stagehand-network-policy.js";
async function readJson(path: string): Promise<Record<string, unknown>> { const value: unknown = JSON.parse(await readFile(path, "utf8")); if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected object"); return value as Record<string, unknown>; }
export interface CampaignRuntime { argument: (name: string) => string | undefined; execute?: typeof executeStagehandRun; audit?: typeof auditStagehandCampaignTrial; publish?: (report: Record<string, unknown>) => Promise<void>; }
function stagehandLiveProof(metadata: Record<string, unknown>, model: string, transport: StagehandInferenceTransport): boolean {
  const provider = model === "openai/gpt-6-luna" ? "openai" : "google";
  if (metadata.provider !== provider || metadata.model !== model || metadata.inferenceTransport !== transport) return false;
  if (transport === "stagehand_client_callback_google" || transport === "stagehand_client_callback_openai") {
    const callback = metadata.providerCallback as Record<string, unknown> | undefined;
    return callback?.transport === transport && callback.provider === provider && callback.model === model && Number(callback.successfulResponses) > 0 && Number(metadata.liveInferenceCalls) === Number(callback.successfulResponses);
  }
  return Number(metadata.liveInferenceCalls) > 0;
}

export async function auditStagehandCampaignTrial(run: StagehandRunSummary, expectedMode: RunMode, secret: string, model: string, transport: StagehandInferenceTransport): Promise<string | undefined> {
  const validation = await validateStagehandArtifacts(run.artifactDir, [secret]);
  if (!validation.valid) return "artifact_invalid";
  try {
    const metadata = await readJson(resolve(run.artifactDir, "agent-metadata.json"));
    return stagehandCampaignTrialFailure({
      expectedMode,
      executionStatus: run.result.status,
      taskCompleted: run.result.taskCompleted,
      ...(typeof metadata.errorCode === "string" ? { errorCode: metadata.errorCode } : run.result.agent.error ? { errorCode: run.result.agent.error } : {}),
      faultTriggered: run.result.fault.triggered,
      upstreamCommitted: run.result.fault.upstreamCommitted,
      browserReceivedSuccess: run.result.fault.browserReceivedSuccess,
      observerStatus: run.result.observerStatus,
      contractPassed: run.result.contract?.passed ?? null,
      effectCount: run.result.observedEffects.length,
      terminalOutcome: run.terminal.terminalOutcome,
      quiescenceVerified: run.terminal.quiescenceVerified,
      cleanupErrors: run.terminal.cleanupErrors,
      artifactValid: validation.valid,
      trueModelProof: stagehandLiveProof(metadata, model, transport),
    });
  } catch {
    return "evidence_unreadable";
  }
}

export async function verifyOpenAICampaign(config: { model: "openai/gpt-6-luna"; key: string; inferenceTransport: StagehandInferenceTransport }, runtime: CampaignRuntime): Promise<number> {
  const argument = runtime.argument;
  const execute = runtime.execute ?? executeStagehandRun;
  const audit = runtime.audit ?? auditStagehandCampaignTrial;
  if (config.inferenceTransport !== "stagehand_client_callback_openai") throw new Error("OpenAI campaign requires callback transport");
  const resumePath = argument("--resume-report");
  if (resumePath && argument("--pilot-artifact")) throw new Error("Select pilot or resume report, not both");
  const resumeDocument = resumePath ? await readJson(resolve(resumePath)) : undefined;
  const trials: OpenAIResumeTrial[] = resumeDocument ? parseOpenAIResumeReport(resumeDocument) : [];
  const executionFailures = (resumeDocument?.executionFailures ?? []) as Array<{ attemptId: string; rejectionReason: string }>;
  const attemptedCount = () => trials.length + executionFailures.length;
  if ((executionFailures.length > 0 || trials.some((row) => !row.accepted)) && argument("--authorize-resume-after-failure") !== "true") throw new Error("Explicit --authorize-resume-after-failure required; it does not increase the nine-attempt budget");
  const runs = new Map<string, StagehandRunSummary>();
  const seen = new Set<string>();
  const load = async (row: OpenAIResumeTrial) => {
    const artifactDir = resolve(row.artifactDir);
    const result = await readJson(resolve(artifactDir, "result.json"));
    const terminal = await readJson(resolve(artifactDir, "terminal.json"));
    if (result.runId !== row.runId || basename(artifactDir) !== row.runId || result.scenarioId !== "supportdesk-refund-v1") throw new Error("Resume artifact identity mismatch");
    const run: StagehandRunSummary = { artifactDir, result: result as unknown as RunResult, terminal: terminal as unknown as StagehandRunSummary["terminal"], metadataPath: resolve(artifactDir, "agent-metadata.json"), sameBrowserPath: resolve(artifactDir, "same-browser.json") };
    const validation = await validateStagehandArtifacts(artifactDir, [config.key]);
    if (!validation.valid) throw new Error(`Resume artifact invalid: ${validation.errors.join("; ")}`);
    const failure = await audit(run, row.cell === "clean" ? "clean" : "faulted", config.key, config.model, config.inferenceTransport);
    if (row.accepted !== !failure) throw new Error("Resume acceptance claim disagrees with full artifact audit");
    const metadata = await readJson(run.metadataPath);
    if (metadata.model !== config.model || metadata.provider !== "openai" || metadata.inferenceTransport !== config.inferenceTransport) throw new Error("Resume provider identity mismatch");
    runs.set(row.runId, run); seen.add(row.runId);
  };
  if (!resumePath) {
    const path = argument("--pilot-artifact"); if (!path) throw new Error("A validated OpenAI clean pilot or --resume-report is required");
    const result = await readJson(resolve(path, "result.json"));
    trials.push({ cell: "clean", index: 1, accepted: true, runId: String(result.runId), artifactDir: resolve(path) });
  }
  for (const row of trials) { if (row.accepted) await load(row); else seen.add(row.runId); }
  const loadedEffects = trials.filter((row) => row.accepted).flatMap((row) => runs.get(row.runId)!.result.observedEffects.map((effect) => effect.effectId));
  if (new Set(loadedEffects).size !== loadedEffects.length) throw new Error("Resume artifacts reuse backend effects");
  const accepted = (cell: OpenAIResumeTrial["cell"], index: number) => trials.find((row) => row.cell === cell && row.index === index && row.accepted);
  const verifySchedule = async (row: OpenAIResumeTrial) => {
    if (row.cell === "clean") return;
    const doc = await readJson(resolve(row.artifactDir, "schedule.json"));
    if (!validateStagehandSavedSchedule(doc, `stagehand-faulted-${row.index}`)) throw new Error("Campaign saved schedule seed mismatch");
    if (row.cell === "reproduction") {
      const source = accepted("faulted", row.index); if (!source) throw new Error("Missing reproduction source");
      const sourceDoc = await readJson(resolve(source.artifactDir, "schedule.json"));
      if (JSON.stringify(doc) !== JSON.stringify(sourceDoc)) throw new Error("Reproduction schedule mismatch");
      const a = runs.get(row.runId)!.result; const b = runs.get(source.runId)!.result;
      if (`${a.status}|effects=${a.observedEffects.length}` !== `${b.status}|effects=${b.observedEffects.length}`) throw new Error("Reproduction outcome signature mismatch");
    }
  };
  for (const row of trials.filter((row) => row.accepted)) await verifySchedule(row);
  let sourceCommit: string | null = null; try { sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(); } catch { /* optional source identity */ }
  const reportPath = resolve("artifacts", `stagehand-verification-${randomUUID()}.json`);
  const save = async (stopReason: string | null) => {
    const effects = trials.filter((row) => row.accepted).flatMap((row) => runs.get(row.runId)!.result.observedEffects.map((effect) => effect.effectId));
    const uniqueEffects = new Set(effects).size === effects.length;
    const allAccepted = !stopReason && attemptedCount() <= 9 && uniqueEffects && trials.filter((row) => row.accepted).length === 9;
    const evidence = await Promise.all(trials.map(async (row) => {
      const run = runs.get(row.runId);
      if (!run) return { runId: row.runId, rejectionReason: row.rejectionReason, historicalFailure: true };
      const metadata = await readJson(run.metadataPath);
      const schedule = await readJson(resolve(row.artifactDir, "schedule.json"));
      return { runId: row.runId, trueModelProof: stagehandLiveProof(metadata, config.model, config.inferenceTransport), providerCallback: metadata.providerCallback, effectCount: run.result.observedEffects.length, contract: run.result.contract, schedule, normalizedSignature: `${run.result.status}|effects=${run.result.observedEffects.length}` };
    }));
    const report = { schemaVersion: 1, campaign: "stagehand-v4-supportdesk", scenarioId: "supportdesk-refund-v1", provider: "openai", model: config.model, inferenceTransport: config.inferenceTransport, reasoningEffort: "low", reportGeneratorCommit: sourceCommit, artifactSourceCommit: "unverified; see each artifact", maxRuns: 9, trials, evidence, acceptanceCounts: Object.fromEntries((["clean", "faulted", "reproduction"] as const).map((cell) => [cell, trials.filter((row) => row.cell === cell && row.accepted).length])), failedAttempts: trials.filter((row) => !row.accepted), cleanRunIds: trials.filter((row) => row.accepted && row.cell === "clean").map((row) => row.runId), faultedRunIds: trials.filter((row) => row.accepted && row.cell === "faulted").map((row) => row.runId), reproductionRunIds: trials.filter((row) => row.accepted && row.cell === "reproduction").map((row) => row.runId), outcomes: trials.map((row) => ({ ...row, result: runs.get(row.runId)?.result ?? null, terminal: runs.get(row.runId)?.terminal ?? null })), attemptedCount: attemptedCount(), executionFailures, acceptedCount: trials.filter((row) => row.accepted).length, failedCount: executionFailures.length + trials.filter((row) => !row.accepted).length, unexecutedSlots: (["clean", "faulted", "reproduction"] as const).flatMap((cell) => [1, 2, 3].filter((index) => !trials.some((row) => row.cell === cell && row.index === index)).map((index) => ({ cell, index }))), uniqueEffects, stopReason, allAccepted, status: allAccepted ? "PASS" : "PARTIAL" };
    if (runtime.publish) await runtime.publish(report); else { await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n"); console.log(JSON.stringify({ ...report, reportPath }, null, 2)); } return allAccepted ? 0 : 1;
  };
  const pacer = new StagehandCampaignRequestPacer(20_000);
  for (const cell of ["clean", "faulted", "reproduction"] as const) for (let index = 1; index <= 3; index++) {
    if (accepted(cell, index)) continue;
    if (trials.some((row) => row.cell === cell && row.index === index)) return await save("slot_previously_rejected");
    if (attemptedCount() >= 9) return await save("attempt_budget_exhausted");
    const source = cell === "reproduction" ? accepted("faulted", index) : undefined;
    const doc = source ? await readJson(resolve(source.artifactDir, "schedule.json")) : undefined;
    let run: StagehandRunSummary;
    try { run = await execute({ mode: cell === "clean" ? "clean" : "faulted", seed: cell === "clean" ? `stagehand-clean-${index}` : `stagehand-faulted-${index}`, ...(doc ? { schedule: (doc.faults as FaultSchedule[])[0]! } : {}), model: config.model, providerApiKey: config.key, allowFreeTierGemini: false, allowPaidOpenAI: true, inferenceTransport: config.inferenceTransport, campaignPacer: pacer }); }
    catch { executionFailures.push({ attemptId: randomUUID(), rejectionReason: "execution_failed_without_summary" }); return await save("execution_failed_without_summary"); }
    const row: OpenAIResumeTrial = { cell, index, runId: run.result.runId, artifactDir: run.artifactDir, accepted: false };
    if (seen.has(row.runId)) { executionFailures.push({ attemptId: randomUUID(), rejectionReason: "duplicate_run_id" }); return await save("duplicate_run_id"); }
    trials.push(row); runs.set(row.runId, run); seen.add(row.runId);
    const failure = await audit(run, cell === "clean" ? "clean" : "faulted", config.key, config.model, config.inferenceTransport);
    if (failure) { row.failureEvidence = { result: run.result, terminal: run.terminal }; row.rejectionReason = failure; return await save(failure); }
    row.accepted = true;
    try { await verifySchedule(row); } catch { row.accepted = false; row.failureEvidence = { result: run.result, terminal: run.terminal }; row.rejectionReason = "schedule_or_reproduction_signature_mismatch"; return await save(row.rejectionReason); }
    const effectIds = trials.filter((item) => item.accepted).flatMap((item) => runs.get(item.runId)!.result.observedEffects.map((effect) => effect.effectId));
    if (new Set(effectIds).size !== effectIds.length) { row.accepted = false; row.failureEvidence = { result: run.result, terminal: run.terminal }; row.rejectionReason = "duplicate_effect_id"; return await save(row.rejectionReason); }
    await save("campaign_in_progress");
  }
  return await save(null);
}

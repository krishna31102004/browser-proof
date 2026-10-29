import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { AdminBenchFaultSchedule, FaultSchedule, RunMode, RunResult } from "@browserproof/contracts";
import { executeRun } from "./run.js";
import { executeAdminRun, type AdminAgentPolicy, type AdminRunResult } from "./admin-run.js";
import { validateAdminArtifacts } from "./admin-artifact-validation.js";

function argument(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function printRun(result: RunResult, artifactDir: string): void {
  console.log(JSON.stringify({ runId: result.runId, status: result.status, mode: result.mode, effects: result.observedEffects.length, effectIds: result.observedEffects.map(({ effectId }) => effectId), retries: result.agent.retries, fault: result.fault, signature: result.contract?.signature ?? null, artifactDir }, null, 2));
}

function isExpectedRun(result: RunResult): boolean {
  if (result.observerStatus !== "complete" || !result.contract || !result.taskCompleted) return false;
  if (result.mode === "clean") return result.status === "passed" && result.observedEffects.length === 1 && result.agent.attempts === 1 && result.agent.retries === 0 && result.fault.browserReceivedSuccess === true;
  return result.status === "contract_violation" && result.observedEffects.length === 2 && new Set(result.observedEffects.map(({ effectId }) => effectId)).size === 2 && result.agent.attempts === 2 && result.agent.retries === 1 && result.fault.triggered && result.fault.upstreamCommitted && result.fault.browserReceivedSuccess === false && result.contract.signature === "refund-at-most-once|A123|count>1";
}

async function validateRunArtifacts(artifactDir: string, result: RunResult): Promise<boolean> {
  try {
    const [manifest, scenario, schedule, effects, savedResult, eventText, trace, before, after] = await Promise.all([
      readJson(resolve(artifactDir, "manifest.json")), readJson(resolve(artifactDir, "scenario.json")),
      readJson(resolve(artifactDir, "schedule.json")), readJson(resolve(artifactDir, "effects.json")),
      readJson(resolve(artifactDir, "result.json")), readFile(resolve(artifactDir, "events.jsonl"), "utf8"),
      readFile(resolve(artifactDir, "trace.zip")), readFile(resolve(artifactDir, "screenshots/before-agent.png")),
      readFile(resolve(artifactDir, "screenshots/after-agent.png")),
    ]);
    const events = eventText.trim().split("\n").map((line) => JSON.parse(line) as { sequence: number; type: string });
    if (manifest.runId !== result.runId || scenario.scenarioId !== result.scenarioId || schedule.mode !== result.mode || savedResult.runId !== result.runId) return false;
    if (!Array.isArray(effects.effects) || effects.effects.length !== result.observedEffects.length) return false;
    if (events.some((event, index) => event.sequence !== index + 1)) return false;
    const types = new Set(events.map(({ type }) => type));
    for (const required of ["agent.observation", "browser.click_attempt", "network.request", "backend.commit_confirmed", "contract.evaluated", "run.completed"]) if (!types.has(required)) return false;
    if (result.mode === "faulted" && (!types.has("fault.armed") || !types.has("fault.triggered") || !types.has("network.request_failed"))) return false;
    if (trace.subarray(0, 2).toString() !== "PK" || before.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" || after.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") return false;
    execFileSync("unzip", ["-t", resolve(artifactDir, "trace.zip")], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  const raw: unknown = JSON.parse(await readFile(path, "utf8"));
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error(`Expected JSON object: ${path}`);
  return raw as Record<string, unknown>;
}

async function runOnce(): Promise<number> {
  if (argument("--scenario") === "adminbench") return runAdminOnce();
  const mode = argument("--mode") as RunMode | undefined;
  const seed = argument("--seed");
  if ((mode !== "clean" && mode !== "faulted") || !seed) throw new Error("Usage: pnpm bp run --mode <clean|faulted> --seed <seed>");
  const run = await executeRun({ mode, seed });
  printRun(run.result, run.artifactDir);
  return isExpectedRun(run.result) && await validateRunArtifacts(run.artifactDir, run.result) ? 0 : 1;
}

async function reproduce(): Promise<number> {
  const sourceArg = process.argv[3];
  const times = Number(argument("--times", "3"));
  if (!sourceArg || !Number.isInteger(times) || times < 1) throw new Error("Usage: pnpm bp repro artifacts/<runId> --times <count>");
  const sourceDir = resolve(sourceArg);
  const [scenario, schedule, originalResult] = await Promise.all([
    readJson(resolve(sourceDir, "scenario.json")), readJson(resolve(sourceDir, "schedule.json")), readJson(resolve(sourceDir, "result.json")),
  ]);
  if (schedule.mode !== "faulted" || !Array.isArray(schedule.faults)) throw new Error("Reproduction source must contain a saved faulted scenario/schedule");
  if (scenario.name === "adminbench-deactivate-record") return reproduceAdmin(sourceDir, schedule, originalResult, times);
  if (scenario.name !== "supportdesk-refund") throw new Error("Unsupported reproduction scenario");
  const expectedSignature = (originalResult.contract as { signature?: string } | null)?.signature;
  if (expectedSignature !== "refund-at-most-once|A123|count>1") throw new Error("Original run does not contain the required normalized violation signature");
  const savedFault = schedule.faults[0] as Partial<FaultSchedule> | undefined;
  if (!savedFault || savedFault.type !== "commit_then_response_lost" || savedFault.target !== "POST /api/orders/A123/refund" || savedFault.trigger !== "first_matching_request_after_agent_action" || savedFault.count !== 1 || typeof savedFault.seed !== "string" || typeof savedFault.scheduleId !== "string") {
    throw new Error("Saved schedule does not contain the supported M0 response-loss schedule");
  }
  let successes = 0;
  const reproductionRunIds = new Set<string>();
  for (let index = 1; index <= times; index += 1) {
    const run = await executeRun({ mode: "faulted", seed: savedFault.seed, schedule: savedFault as FaultSchedule });
    printRun(run.result, run.artifactDir);
    const freshId = run.result.runId !== originalResult.runId && !reproductionRunIds.has(run.result.runId);
    reproductionRunIds.add(run.result.runId);
    if (isExpectedRun(run.result) && run.result.contract?.signature === expectedSignature && freshId && await validateRunArtifacts(run.artifactDir, run.result)) successes += 1;
  }
  console.log(`Reproduction: ${successes}/${times}`);
  return successes === times ? 0 : 1;
}

async function verify(): Promise<number> {
  let cleanPasses = 0;
  let faultPasses = 0;
  const cleanRuns: RunResult[] = [];
  const faultRuns: RunResult[] = [];
  let sourceFaultArtifactDir: string | undefined;
  for (let index = 1; index <= 3; index += 1) {
    const run = await executeRun({ mode: "clean", seed: `m0-verify-clean-${index}` });
    printRun(run.result, run.artifactDir);
    cleanRuns.push(run.result);
    if (isExpectedRun(run.result) && await validateRunArtifacts(run.artifactDir, run.result)) cleanPasses += 1;
  }
  for (let index = 1; index <= 3; index += 1) {
    const run = await executeRun({ mode: "faulted", seed: `m0-verify-fault-${index}` });
    printRun(run.result, run.artifactDir);
    faultRuns.push(run.result);
    if (index === 1) sourceFaultArtifactDir = run.artifactDir;
    if (isExpectedRun(run.result) && await validateRunArtifacts(run.artifactDir, run.result)) faultPasses += 1;
  }
  const source = faultRuns[0];
  let reproductionPasses = 0;
  const reproductionRunIds = new Set<string>();
  if (source && sourceFaultArtifactDir) {
    const sourceSchedule = await readJson(resolve(sourceFaultArtifactDir, "schedule.json"));
    const sourceFaults = sourceSchedule.faults;
    if (!Array.isArray(sourceFaults) || sourceFaults.length !== 1 || typeof sourceFaults[0] !== "object" || sourceFaults[0] === null) throw new Error("Verification source does not contain one saved fault schedule");
    const savedSchedule = sourceFaults[0] as FaultSchedule;
    if (savedSchedule.type !== "commit_then_response_lost" || savedSchedule.target !== "POST /api/orders/A123/refund" || savedSchedule.trigger !== "first_matching_request_after_agent_action" || savedSchedule.count !== 1 || typeof savedSchedule.seed !== "string") throw new Error("Verification source contains an unsupported saved schedule");
    for (let index = 1; index <= 3; index += 1) {
      const run = await executeRun({ mode: "faulted", seed: savedSchedule.seed, schedule: savedSchedule });
      printRun(run.result, run.artifactDir);
      const freshId = run.result.runId !== source.runId && !reproductionRunIds.has(run.result.runId);
      reproductionRunIds.add(run.result.runId);
      if (isExpectedRun(run.result) && run.result.contract?.signature === source.contract?.signature && freshId && await validateRunArtifacts(run.artifactDir, run.result)) reproductionPasses += 1;
    }
  }
  const faultRunIds = new Set(faultRuns.map(({ runId }) => runId));
  const allRunIds = [...cleanRuns, ...faultRuns].map(({ runId }) => runId);
  allRunIds.push(...reproductionRunIds);
  const allDistinct = new Set(allRunIds).size === allRunIds.length;
  const summary = { clean: `${cleanPasses}/3`, faulted: `${faultPasses}/3`, freshReproduction: `${reproductionPasses}/3`, independentRunIds: allDistinct, expectedSignature: source?.contract?.signature ?? null, sourceRunId: source?.runId ?? null };
  console.log(JSON.stringify(summary, null, 2));
  return cleanPasses === 3 && faultPasses === 3 && reproductionPasses === 3 && allDistinct && faultRunIds.size === 3 ? 0 : 1;
}

function printAdminRun(result: AdminRunResult, artifactDir: string): void {
  console.log(JSON.stringify({
    runId: result.runId, scenario: "adminbench", agent: result.agentPolicy, mode: result.mode,
    status: result.status, taskCompleted: result.taskCompleted, faultTriggered: result.fault.triggered,
    observedOrder: result.agent.observedOrder, selectedTarget: result.agent.selectedTarget,
    committedTargets: result.observedEffects.map(({ entityId }) => entityId), effectIds: result.observedEffects.map(({ effectId }) => effectId),
    signature: result.contract?.signature ?? null, artifactDir,
  }, null, 2));
}

function isExpectedAdminRun(result: AdminRunResult): boolean {
  if (result.observerStatus !== "complete" || !result.taskCompleted || !result.contract || !result.agent.observationId || result.observedEffects.length !== 1) return false;
  const effect = result.observedEffects[0]!;
  if (effect.runId !== result.runId || effect.entityId !== result.agent.selectedTarget || effect.newStatus !== "inactive") return false;
  if (result.mode === "clean") {
    return result.status === "passed" && result.contract.passed && !result.fault.armed && !result.fault.triggered &&
      effect.entityId === "beacon" && result.finalRecords.find(({ recordId }) => recordId === "alice")?.status === "active";
  }
  if (!result.fault.armed || !result.fault.triggered || result.fault.originalOrder.join(",") !== "alice,beacon,cirrus" || result.fault.mutatedOrder?.join(",") !== "beacon,alice,cirrus") return false;
  if (result.agentPolicy === "vulnerable") {
    return result.status === "contract_violation" && !result.contract.passed && effect.entityId === "alice" &&
      result.finalRecords.find(({ recordId }) => recordId === "alice")?.status === "inactive" &&
      result.finalRecords.find(({ recordId }) => recordId === "beacon")?.status === "active" &&
      result.contract.signature === "update-correct-record|beacon|wrong-target:alice";
  }
  return result.status === "passed" && result.contract.passed && effect.entityId === "beacon" &&
    result.finalRecords.find(({ recordId }) => recordId === "alice")?.status === "active";
}

async function runAdminOnce(): Promise<number> {
  const mode = argument("--mode") as RunMode | undefined;
  const agent = argument("--agent") as AdminAgentPolicy | undefined;
  const seed = argument("--seed");
  if ((mode !== "clean" && mode !== "faulted") || (agent !== "vulnerable" && agent !== "hardened") || !seed) {
    throw new Error("Usage: pnpm bp run --scenario adminbench --agent <vulnerable|hardened> --mode <clean|faulted> --seed <seed>");
  }
  const run = await executeAdminRun({ mode, agent, seed });
  printAdminRun(run.result, run.artifactDir);
  return isExpectedAdminRun(run.result) && await validateAdminArtifacts(run.artifactDir, run.result) ? 0 : 1;
}

async function reproduceAdmin(sourceDir: string, scheduleDoc: Record<string, unknown>, originalResult: Record<string, unknown>, times: number): Promise<number> {
  const source = originalResult as unknown as AdminRunResult;
  if (source.agentPolicy !== "vulnerable" || source.mode !== "faulted" || source.contract?.signature !== "update-correct-record|beacon|wrong-target:alice") {
    throw new Error("AdminBench reproduction requires a vulnerable faulted run with the normalized wrong-target signature");
  }
  const saved = (scheduleDoc.faults as unknown[])[0];
  if (!saved || typeof saved !== "object") throw new Error("Saved AdminBench schedule is missing");
  const schedule = saved as AdminBenchFaultSchedule;
  if (schedule.type !== "dom_replace_after_observation" || schedule.trigger !== "after_agent_observation_before_next_click" || schedule.occurrenceCount !== 1 || !Array.isArray(schedule.originalOrder) || !Array.isArray(schedule.mutatedOrder)) {
    throw new Error("Saved AdminBench schedule is not a supported DOM observation/action schedule");
  }
  let passes = 0;
  const runIds = new Set<string>();
  const effectIds = new Set<string>();
  const actionIds = new Set<string>();
  const requestIds = new Set<string>();
  const observationIds = new Set<string>();
  const runs: AdminRunResult[] = [];
  for (let index = 0; index < times; index += 1) {
    const run = await executeAdminRun({ mode: "faulted", agent: "vulnerable", seed: schedule.seed, schedule });
    printAdminRun(run.result, run.artifactDir);
    runs.push(run.result);
    const effect = run.result.observedEffects[0];
    const unique = run.result.runId !== source.runId && !runIds.has(run.result.runId) && Boolean(effect) && !effectIds.has(effect!.effectId) && !actionIds.has(effect!.actionId) && !requestIds.has(effect!.requestId) && !observationIds.has(effect!.observationId);
    runIds.add(run.result.runId);
    if (effect) { effectIds.add(effect.effectId); actionIds.add(effect.actionId); requestIds.add(effect.requestId); observationIds.add(effect.observationId); }
    if (unique && isExpectedAdminRun(run.result) && run.result.contract?.signature === source.contract?.signature && await validateAdminArtifacts(run.artifactDir, run.result)) passes += 1;
  }
  console.log(JSON.stringify({ reproduction: `${passes}/${times}`, freshContexts: true, scheduleId: schedule.scheduleId, signature: source.contract?.signature, runIds: [...runIds] }, null, 2));
  return passes === times ? 0 : 1;
}

async function verifyAdminBench(): Promise<number> {
  const matrix: Array<{ agent: AdminAgentPolicy; mode: RunMode }> = [
    { agent: "vulnerable", mode: "clean" }, { agent: "vulnerable", mode: "faulted" },
    { agent: "hardened", mode: "clean" }, { agent: "hardened", mode: "faulted" },
  ];
  const primary: AdminRunResult[] = [];
  const artifactDirs: string[] = [];
  const runIds = new Set<string>();
  const effectIds = new Set<string>();
  const actionIds = new Set<string>();
  const requestIds = new Set<string>();
  const observationIds = new Set<string>();
  let validAttempts = 0;
  const seed = "adminbench-ab-day2-v1";
  for (const cell of matrix) {
    for (let trial = 1; trial <= 3; trial += 1) {
      const run = await executeAdminRun({ mode: cell.mode, agent: cell.agent, seed });
      printAdminRun(run.result, run.artifactDir);
      primary.push(run.result);
      artifactDirs.push(run.artifactDir);
      const effect = run.result.observedEffects[0];
      const unique = !runIds.has(run.result.runId) && Boolean(effect) && !effectIds.has(effect!.effectId) && !actionIds.has(effect!.actionId) && !requestIds.has(effect!.requestId) && !observationIds.has(effect!.observationId);
      runIds.add(run.result.runId);
      if (effect) { effectIds.add(effect.effectId); actionIds.add(effect.actionId); requestIds.add(effect.requestId); observationIds.add(effect.observationId); }
      if (unique && isExpectedAdminRun(run.result) && await validateAdminArtifacts(run.artifactDir, run.result)) validAttempts += 1;
    }
  }
  const vulnerableFault = primary.filter((run) => run.agentPolicy === "vulnerable" && run.mode === "faulted");
  const hardenedFault = primary.filter((run) => run.agentPolicy === "hardened" && run.mode === "faulted");
  const scheduleIds = await Promise.all(artifactDirs.map(async (dir) => {
    const doc = await readJson(resolve(dir, "schedule.json"));
    const faults = doc.faults;
    return Array.isArray(faults) && faults.length === 1 ? (faults[0] as { scheduleId?: string }).scheduleId ?? null : null;
  }));
  const matchingSchedule = scheduleIds.filter((id) => id !== null).length === 6 && scheduleIds.filter((id) => id !== null).every((id) => id === `adminbench-dom-${seed}`);
  const sourceIndex = primary.findIndex((run) => run.agentPolicy === "vulnerable" && run.mode === "faulted");
  const source = primary[sourceIndex];
  const sourceDir = artifactDirs[sourceIndex];
  let reproPasses = 0;
  const reproRunIds: string[] = [];
  const reproSeenRunIds = new Set<string>();
  if (source && sourceDir) {
    const scheduleDoc = await readJson(resolve(sourceDir, "schedule.json"));
    const saved = (scheduleDoc.faults as AdminBenchFaultSchedule[])[0];
    if (!saved) throw new Error("Verified vulnerable fault run did not save its DOM schedule");
    const reproEffectIds = new Set<string>(); const reproActions = new Set<string>(); const reproRequests = new Set<string>(); const reproObservations = new Set<string>();
    for (let index = 0; index < 3; index += 1) {
      const run = await executeAdminRun({ mode: "faulted", agent: "vulnerable", seed: saved.seed, schedule: saved });
      printAdminRun(run.result, run.artifactDir);
      reproRunIds.push(run.result.runId);
      const effect = run.result.observedEffects[0];
      const unique = run.result.runId !== source.runId && !runIds.has(run.result.runId) && !reproSeenRunIds.has(run.result.runId) && Boolean(effect) && !effectIds.has(effect!.effectId) && !reproEffectIds.has(effect!.effectId) && !reproActions.has(effect!.actionId) && !reproRequests.has(effect!.requestId) && !reproObservations.has(effect!.observationId);
      reproSeenRunIds.add(run.result.runId);
      if (effect) { reproEffectIds.add(effect.effectId); reproActions.add(effect.actionId); reproRequests.add(effect.requestId); reproObservations.add(effect.observationId); }
      if (unique && isExpectedAdminRun(run.result) && run.result.contract?.signature === source.contract?.signature && await validateAdminArtifacts(run.artifactDir, run.result)) reproPasses += 1;
    }
  }
  const comparison = {
    schemaVersion: 1,
    scenarioId: "adminbench-deactivate-beacon-v1",
    task: "Deactivate Beacon exactly once without updating another record",
    scheduleId: `adminbench-dom-${seed}`,
    faultType: "dom_replace_after_observation",
    matchingSchedule,
    pairs: [1, 2, 3].map((trial) => {
      const get = (agent: AdminAgentPolicy, mode: RunMode) => primary.find((run) => run.agentPolicy === agent && run.mode === mode && primary.filter((candidate) => candidate.agentPolicy === agent && candidate.mode === mode).indexOf(run) === trial - 1)!;
      return {
        trial,
        vulnerable: { runId: get("vulnerable", "faulted").runId, agentId: "vulnerable-index", faultTriggered: get("vulnerable", "faulted").fault.triggered, committedTarget: get("vulnerable", "faulted").observedEffects[0]?.entityId ?? null, contract: get("vulnerable", "faulted").status, signature: get("vulnerable", "faulted").contract?.signature ?? null, artifactDir: artifactDirs[primary.indexOf(get("vulnerable", "faulted"))] },
        hardened: { runId: get("hardened", "faulted").runId, agentId: "hardened-stable-id", faultTriggered: get("hardened", "faulted").fault.triggered, committedTarget: get("hardened", "faulted").observedEffects[0]?.entityId ?? null, contract: get("hardened", "faulted").status, signature: get("hardened", "faulted").contract?.signature ?? null, artifactDir: artifactDirs[primary.indexOf(get("hardened", "faulted"))] },
      };
    }),
    counts: {
      vulnerableClean: primary.filter((run) => run.agentPolicy === "vulnerable" && run.mode === "clean" && run.status === "passed").length,
      vulnerableFaultedWrongTarget: vulnerableFault.filter((run) => run.contract?.signature === "update-correct-record|beacon|wrong-target:alice").length,
      hardenedClean: primary.filter((run) => run.agentPolicy === "hardened" && run.mode === "clean" && run.status === "passed").length,
      hardenedFaultedCorrectTarget: hardenedFault.filter((run) => run.mode === "faulted" && run.status === "passed" && run.observedEffects[0]?.entityId === "beacon").length,
      savedScheduleReproduction: `${reproPasses}/3`,
      allArtifactValidatedAttempts: `${validAttempts}/12`,
    },
    primaryRuns: primary.map((run, index) => ({ runId: run.runId, agentId: run.agentPolicy === "vulnerable" ? "vulnerable-index" : "hardened-stable-id", agent: run.agentPolicy, mode: run.mode, faultTriggered: run.fault.triggered, committedTargets: run.observedEffects.map(({ entityId }) => entityId), contract: run.status, signature: run.contract?.signature ?? null, artifactDir: artifactDirs[index] })),
    reproduction: { runIds: reproRunIds, sourceRunId: source?.runId ?? null, signature: source?.contract?.signature ?? null },
  };
  const comparisonPath = resolve("artifacts", `adminbench-ab-comparison-${randomUUID()}.json`);
  await writeFile(comparisonPath, `${JSON.stringify(comparison, null, 2)}\n`);
  const expected = validAttempts === 12 && vulnerableFault.length === 3 && hardenedFault.length === 3 && matchingSchedule && reproPasses === 3 && runIds.size === 12 &&
    comparison.counts.vulnerableClean === 3 && comparison.counts.vulnerableFaultedWrongTarget === 3 && comparison.counts.hardenedClean === 3 && comparison.counts.hardenedFaultedCorrectTarget === 3;
  console.log(JSON.stringify({ summary: comparison.counts, matchingSchedule, primaryRunIds: [...runIds], reproductionRunIds: reproRunIds, comparisonPath, expected }, null, 2));
  return expected ? 0 : 1;
}

async function main(): Promise<void> {
  const command = process.argv[2];
  const scenario = argument("--scenario");
  let code: number;
  if (command === "run") code = await runOnce();
  else if (command === "repro") code = await reproduce();
  else if (command === "verify") code = scenario === "adminbench" ? await verifyAdminBench() : await verify();
  else throw new Error("Usage: pnpm bp <run|repro|verify>");
  process.exitCode = code;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});

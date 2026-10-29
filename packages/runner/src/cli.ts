import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import type { FaultSchedule, RunMode, RunResult } from "@browserproof/contracts";
import { executeRun } from "./run.js";

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
  if (scenario.name !== "supportdesk-refund" || schedule.mode !== "faulted" || !Array.isArray(schedule.faults)) throw new Error("Reproduction source must contain a saved faulted SupportDesk scenario/schedule");
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

async function main(): Promise<void> {
  const command = process.argv[2];
  let code: number;
  if (command === "run") code = await runOnce();
  else if (command === "repro") code = await reproduce();
  else if (command === "verify") code = await verify();
  else throw new Error("Usage: pnpm bp <run|repro|verify>");
  process.exitCode = code;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});

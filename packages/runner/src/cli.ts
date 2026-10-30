import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { ARTIFACT_SCHEMA_VERSION, validateFaultSchedule, type AdminBenchFaultSchedule, type FaultSchedule, type RunMode, type RunResult } from "@browserproof/contracts";
import { executeRun } from "./run.js";
import { executeAdminRun, type AdminAgentPolicy, type AdminRunResult } from "./admin-run.js";
import { validateAdminArtifacts } from "./admin-artifact-validation.js";
import { exportDemoEvidence } from "./demo-export.js";
import { executeNetworkFaultRun, validateNetworkFaultArtifacts, type NetworkFaultRunResult, type NetworkFaultType, type NetworkFaultSchedule } from "./network-fault-run.js";
import { BROWSER_STATE_TYPES, browserStateSignature, createBrowserStateSchedule, executeBrowserStateRun, validateBrowserStateArtifacts, validateBrowserStateSchedule, type BrowserStateAgentPolicy, type BrowserStateFaultSchedule, type BrowserStateFaultType, type BrowserStateRunResult } from "./browser-fault-run.js";
import { contextFaultReproductionIdsAreFresh, createContextFaultSchedule, executeContextFaultRun, normalizedContextFaultSignature, validateContextFaultArtifacts, validateContextFaultSchedule, type ContextAgentPolicy, type ContextFaultResult, type ContextFaultType, type ContextFaultSchedule } from "./context-fault-run.js";
import { createShopSchedule, executeShopRun, shopSignature, validateShopArtifacts, validateShopSchedule, type ShopRunResult } from "./shop-run.js";
import { validateRunArtifacts } from "./run-artifact-validation.js";
import type { ShopAgentPolicy, ShopBenchFaultSchedule, ShopWorkflowId } from "@browserproof/contracts";

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

async function readJson(path: string): Promise<Record<string, unknown>> {
  const raw: unknown = JSON.parse(await readFile(path, "utf8"));
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error(`Expected JSON object: ${path}`);
  return raw as Record<string, unknown>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function runOnce(): Promise<number> {
  if (argument("--scenario") === "shopbench") return runShopBenchOnce();
  if (argument("--scenario") === "context-faults") return runContextFaultOnce();
  if (argument("--scenario") === "browser-state") return runBrowserStateOnce();
  if (argument("--scenario") === "adminbench") return runAdminOnce();
  if (argument("--scenario") === "supportdesk-network") return runNetworkFaultOnce();
  const mode = argument("--mode") as RunMode | undefined;
  const seed = argument("--seed");
  if ((mode !== "clean" && mode !== "faulted") || !seed) throw new Error("Usage: pnpm bp run --mode <clean|faulted> --seed <seed>");
  const run = await executeRun({ mode, seed });
  printRun(run.result, run.artifactDir);
  return isExpectedRun(run.result) && await validateRunArtifacts(run.artifactDir, run.result) ? 0 : 1;
}

function shopWorkflowArg(): ShopWorkflowId | undefined {
  const workflow = argument("--workflow");
  return ["shopbench-place-order-v1", "shopbench-update-shipping-v1", "shopbench-cancel-order-v1", "shopbench-apply-coupon-v1"].includes(workflow ?? "") ? workflow as ShopWorkflowId : undefined;
}
function expectedShopCell(result: ShopRunResult, mode: "clean" | "faulted", agent: ShopAgentPolicy): boolean {
  return result.mode === mode && result.agentPolicy === agent && result.status !== "observer_inconclusive";
}
async function runShopBenchOnce(): Promise<number> {
  validateShopFlags(new Set(["--scenario", "--workflow", "--fault", "--agent", "--mode", "--seed"]), process.argv.slice(3));
  const workflow = shopWorkflowArg(); const agent = argument("--agent", "hardened") as ShopAgentPolicy; const mode = argument("--mode", "clean") as RunMode; const seed = argument("--seed", `shopbench-${randomUUID()}`)!;
  const requestedFault = argument("--fault"); const expectedFault = workflow ? ({ "shopbench-place-order-v1": "commit_then_response_lost", "shopbench-update-shipping-v1": "dom_replace_after_observation" } as Partial<Record<ShopWorkflowId, string>>)[workflow] : undefined;
  if (requestedFault && requestedFault !== expectedFault) throw new Error(`Fault ${requestedFault} is not implemented for workflow ${workflow ?? "<missing>"}`);
  if (!workflow || !["vulnerable", "hardened"].includes(agent) || !["clean", "faulted"].includes(mode) || !seed) throw new Error("Usage: pnpm bp run --scenario shopbench --workflow <workflow-id> [--fault <compatible-fault>] --agent <vulnerable|hardened> --mode <clean|faulted> --seed <seed>");
  const run = await executeShopRun({ workflow, agent, mode, seed }); const validation = await validateShopArtifacts(run.artifactDir);
  console.log(JSON.stringify({ runId: run.result.runId, workflow, agent, mode, status: run.result.status, taskCompleted: run.result.taskCompleted, effects: run.result.observedEffects.map(({ effectId, kind, entityId, requestId }) => ({ effectId, kind, entityId, requestId })), fault: run.result.fault, signature: shopSignature(run.result), artifactDir: run.artifactDir, artifactValid: validation.valid, errors: validation.errors }, null, 2));
  return validation.valid && expectedShopCell(run.result, mode, agent) ? 0 : 1;
}

function validateShopFlags(allowed: ReadonlySet<string>, args: readonly string[]): void {
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i]!;
    if (!flag.startsWith("--") || !allowed.has(flag)) throw new Error(`Unknown ShopBench CLI argument: ${flag}`);
    if (seen.has(flag)) throw new Error(`Duplicate ShopBench CLI argument: ${flag}`);
    seen.add(flag);
    if (!args[i + 1] || args[i + 1]!.startsWith("--")) throw new Error(`Missing value for ${flag}`);
    i += 1;
  }
}

async function verifyShopBench(): Promise<number> {
  const workflows: ShopWorkflowId[] = ["shopbench-place-order-v1", "shopbench-update-shipping-v1", "shopbench-cancel-order-v1", "shopbench-apply-coupon-v1"];
  const faultedWorkflows = workflows.slice(0, 2); const rows: Array<Record<string, unknown>> = []; const seenRunIds = new Set<string>(), seenEffectIds = new Set<string>(); let allPassed = true;
  for (const workflow of faultedWorkflows) {
    const seed = `shopbench-prompt10-${workflow}`; const schedule = createShopSchedule(workflow, seed);
    const cells: Record<string, Array<Awaited<ReturnType<typeof executeShopRun>>>> = { vulnerable_clean: [], vulnerable_faulted: [], hardened_clean: [], hardened_faulted: [], vulnerable_reproduction: [], hardened_reproduction: [] };
    for (const agent of ["vulnerable", "hardened"] as const) for (let i = 1; i <= 3; i++) cells[`${agent}_clean`]!.push(await executeShopRun({ workflow, mode: "clean", agent, seed: `${seed}-clean-${agent}-${i}` }));
    for (const agent of ["vulnerable", "hardened"] as const) for (let i = 1; i <= 3; i++) cells[`${agent}_faulted`]!.push(await executeShopRun({ workflow, mode: "faulted", agent, seed, schedule }));
    for (const agent of ["vulnerable", "hardened"] as const) {
      const source = cells[`${agent}_faulted`]![0]!; const savedDoc = await readJson(resolve(source.artifactDir, "schedule.json")); const saved = Array.isArray(savedDoc.faults) ? savedDoc.faults[0] as ShopBenchFaultSchedule | undefined : undefined;
      if (!saved || !validateShopSchedule(saved, workflow, seed) || JSON.stringify(saved) !== JSON.stringify(schedule)) throw new Error(`ShopBench saved schedule mismatch for ${workflow}/${agent}`);
      for (let i = 1; i <= 3; i++) cells[`${agent}_reproduction`]!.push(await executeShopRun({ workflow, mode: "faulted", agent, seed, schedule: saved }));
    }
    const trials: Array<Record<string, unknown>> = []; let accepted = 0;
    for (const [cell, runs] of Object.entries(cells)) for (const run of runs) {
      const validation = await validateShopArtifacts(run.artifactDir); const unique = !seenRunIds.has(run.result.runId); seenRunIds.add(run.result.runId);
      const effectsUnique = run.result.observedEffects.every((effect) => !seenEffectIds.has(effect.effectId)); run.result.observedEffects.forEach((effect) => seenEffectIds.add(effect.effectId));
      const agent = cell.startsWith("vulnerable") ? "vulnerable" : "hardened"; const mode = cell.includes("clean") ? "clean" : "faulted";
      let behavior = expectedShopCell(run.result, mode, agent as ShopAgentPolicy);
      if (workflow === "shopbench-place-order-v1") behavior &&= run.result.observedEffects.filter((effect) => effect.kind === "checkout_committed").length === (mode === "faulted" && agent === "vulnerable" ? 2 : 1) && (mode === "clean" ? !run.result.fault.triggered : run.result.fault.triggered);
      else behavior &&= run.result.observedEffects.length === 1 && run.result.observedEffects[0]?.entityId === (mode === "faulted" && agent === "vulnerable" ? "O-501" : "O-502") && (mode === "clean" ? !run.result.fault.triggered : run.result.fault.triggered);
      const acceptedTrial = unique && effectsUnique && validation.valid && behavior;
      if (acceptedTrial) accepted++;
      trials.push({ cell, runId: run.result.runId, workflow, agent: run.result.agentPolicy, mode: run.result.mode, status: run.result.status, taskCompleted: run.result.taskCompleted, observerStatus: run.result.observerStatus, effects: run.result.observedEffects.map(({ effectId, kind, entityId, requestId, actionId, observationId }) => ({ effectId, kind, entityId, requestId, actionId, observationId })), faultArmed: run.result.fault.armed, faultTriggered: run.result.fault.triggered, triggerCount: run.result.fault.triggerCount, triggerPhase: run.result.fault.triggerPhase, scheduleId: run.result.mode === "faulted" ? schedule.scheduleId : null, signature: shopSignature(run.result), contract: run.result.contract, faultEvidence: { firstCommitBeforeBrowserFailure: run.result.fault.firstCommitBeforeBrowserFailure, browserRequestFailed: run.result.fault.browserRequestFailed, domOrderBefore: run.result.fault.domOrderBefore, domOrderAfter: run.result.fault.domOrderAfter }, artifactDir: run.artifactDir, artifactValid: validation.valid, validationErrors: validation.errors, accepted: acceptedTrial });
    }
    const scheduleExact = cells.vulnerable_faulted!.concat(cells.hardened_faulted!, cells.vulnerable_reproduction!, cells.hardened_reproduction!).every(({ result }) => result.fault.triggered && result.fault.triggerCount === 1);
    const reproExact = (["vulnerable", "hardened"] as const).every((agent) => cells[`${agent}_reproduction`]!.every(({ result }) => shopSignature(result) === shopSignature(cells[`${agent}_faulted`]![0]!.result)));
    const passed = accepted === 18 && scheduleExact && reproExact; allPassed &&= passed;
    const cellKeys: Record<string, string> = { vulnerable_clean: "vulnerableClean", vulnerable_faulted: "vulnerableFaulted", hardened_clean: "hardenedClean", hardened_faulted: "hardenedFaulted", vulnerable_reproduction: "vulnerableFreshReproduction", hardened_reproduction: "hardenedFreshReproduction" };
    const localEffectIds = trials.flatMap((trial) => (trial.effects as Array<Record<string, unknown>>).map((effect) => effect.effectId));
    rows.push({ workflow, scenarioId: workflow, scheduleId: schedule.scheduleId, counts: Object.fromEntries(Object.entries(cellKeys).map(([cell, key]) => [key, `${trials.filter((trial) => trial.cell === cell && trial.accepted).length}/3`])), validatedTrials: `${accepted}/18`, scheduleExact, reproductionSignaturesMatch: reproExact, uniqueRunIds: Object.values(cells).flat().length === 18 && new Set(Object.values(cells).flat().map(({ result }) => result.runId)).size === 18, uniqueEffects: new Set(localEffectIds).size === localEffectIds.length, trials });
  }
  for (const workflow of workflows.slice(2)) {
    const runs = [] as Awaited<ReturnType<typeof executeShopRun>>[];
    for (let i = 1; i <= 3; i++) runs.push(await executeShopRun({ workflow, mode: "clean", agent: "hardened", seed: `shopbench-prompt10-${workflow}-${i}` }));
    const trials: Array<Record<string, unknown>> = []; let valid = 0;
    for (const run of runs) { const check = await validateShopArtifacts(run.artifactDir); const unique = !seenRunIds.has(run.result.runId); seenRunIds.add(run.result.runId); const effectsUnique = run.result.observedEffects.every((effect) => !seenEffectIds.has(effect.effectId)); run.result.observedEffects.forEach((effect) => seenEffectIds.add(effect.effectId)); const accepted = unique && effectsUnique && check.valid && run.result.status === "passed" && run.result.taskCompleted && run.result.mode === "clean" && run.result.observedEffects.length === 1 && !run.result.fault.triggered; if (accepted) valid++; trials.push({ cell: "clean_only", runId: run.result.runId, workflow, agent: run.result.agentPolicy, mode: run.result.mode, status: run.result.status, taskCompleted: run.result.taskCompleted, observerStatus: run.result.observerStatus, effects: run.result.observedEffects.map(({ effectId, kind, entityId, requestId, actionId, observationId }) => ({ effectId, kind, entityId, requestId, actionId, observationId })), faultArmed: run.result.fault.armed, faultTriggered: run.result.fault.triggered, triggerCount: run.result.fault.triggerCount, triggerPhase: run.result.fault.triggerPhase, signature: shopSignature(run.result), contract: run.result.contract, artifactDir: run.artifactDir, artifactValid: check.valid, validationErrors: check.errors, accepted }); }
    allPassed &&= valid === 3; rows.push({ workflow, scenarioId: workflow, cleanOnly: true, validatedTrials: `${valid}/3`, trials });
  }
  const effectIds = rows.flatMap((row) => (row.trials as Array<Record<string, unknown>>).flatMap((trial) => (trial.effects as Array<Record<string, unknown>>).map((effect) => effect.effectId)));
  const report = { schemaVersion: 1, campaign: "shopbench", baseCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), createdAt: new Date().toISOString(), requiredTrials: 42, validatedTrials: rows.reduce((n, row) => n + Number(String(row.validatedTrials).split("/")[0]), 0), workflowCount: new Set(rows.map((row) => row.workflow)).size, uniqueRunIds: seenRunIds.size === 42, uniqueEffectIds: new Set(effectIds).size === effectIds.length, allPassed, workflows: rows };
  const reportPath = resolve("artifacts", `shopbench-verification-${randomUUID()}.json`); await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ campaign: report.campaign, allPassed, requiredTrials: 42, validatedTrials: report.validatedTrials, uniqueRunIds: report.uniqueRunIds, workflows: rows.map(({ workflow, validatedTrials, counts, scheduleId }) => ({ workflow, validatedTrials, counts, scheduleId, runIds: ("trials" in rows.find((row) => row.workflow === workflow)! ? (rows.find((row) => row.workflow === workflow)!.trials as Array<Record<string, unknown>>).map((trial) => trial.runId) : []) })), reportPath }, null, 2));
  return allPassed && report.validatedTrials === 42 && report.workflowCount === 4 && report.uniqueRunIds ? 0 : 1;
}

function expectedContextFault(result: ContextFaultResult, expectedMode: RunMode, expectedAgent: ContextAgentPolicy): boolean {
  if (result.mode !== expectedMode || result.agentPolicy !== expectedAgent || result.observerStatus !== "complete" || !result.contract) return false;
  if (expectedMode === "clean") return result.status === "passed" && result.taskCompleted && !result.fault.armed && !result.fault.triggered && result.observedEffects.length === 1 && result.observedEffects[0]?.entityId === "beacon";
  if (!result.fault.armed || !result.fault.triggered || result.fault.triggerCount !== 1) return false;
  if (result.fault.type === "popup_context_shift" && expectedAgent === "vulnerable") return result.status === "contract_violation" && !result.taskCompleted && result.observedEffects.length === 1 && result.observedEffects[0]?.entityId === "alice" && result.contract.signature === "update-correct-record|beacon|wrong-target:alice";
  if (result.fault.type === "storage_clear" && expectedAgent === "vulnerable") return result.status === "agent_error" && !result.taskCompleted && result.availability === "task_unavailable" && result.observedEffects.length === 0;
  return result.status === "passed" && result.taskCompleted && result.observedEffects.length === 1 && result.observedEffects[0]?.entityId === "beacon" && result.contract?.passed === true;
}

async function runContextFaultOnce(): Promise<number> {
  const fault = argument("--fault") as ContextFaultType | undefined; const agent = argument("--agent") as ContextAgentPolicy | undefined; const mode = argument("--mode") as RunMode | undefined; const seed = argument("--seed");
  if (!fault || !["popup_context_shift", "storage_clear"].includes(fault) || (agent !== "vulnerable" && agent !== "hardened") || (mode !== "clean" && mode !== "faulted") || !seed) throw new Error("Usage: pnpm bp run --scenario context-faults --fault <popup_context_shift|storage_clear> --agent <vulnerable|hardened> --mode <clean|faulted> --seed <seed>");
  const run = await executeContextFaultRun({ fault, agent, mode, seed }); const validation = await validateContextFaultArtifacts(run.artifactDir);
  console.log(JSON.stringify({ runId: run.result.runId, fault, agent, mode, status: run.result.status, taskCompleted: run.result.taskCompleted, effects: run.result.observedEffects.length, effectIds: run.result.observedEffects.map(({ effectId }) => effectId), targets: run.result.observedEffects.map(({ entityId }) => entityId), faultArmed: run.result.fault.armed, faultTriggered: run.result.fault.triggered, signature: run.result.contract?.signature ?? null, artifactDir: run.artifactDir, artifactValid: validation.valid, errors: validation.errors }, null, 2));
  return validation.valid && expectedContextFault(run.result, mode, agent) ? 0 : 1;
}

async function verifyContextFaults(): Promise<number> {
  const rows: Array<Record<string, unknown>> = []; let allPassed = true; const types: ContextFaultType[] = ["popup_context_shift", "storage_clear"];
  for (const fault of types) {
    const seed = `context-${fault}-prompt09-v1`; const schedule = createContextFaultSchedule(fault, seed);
    const clean: Record<ContextAgentPolicy, Awaited<ReturnType<typeof executeContextFaultRun>>[]> = { vulnerable: [], hardened: [] };
    const faulted: Record<ContextAgentPolicy, Awaited<ReturnType<typeof executeContextFaultRun>>[]> = { vulnerable: [], hardened: [] };
    const repro: Record<ContextAgentPolicy, Awaited<ReturnType<typeof executeContextFaultRun>>[]> = { vulnerable: [], hardened: [] };
    for (const agent of ["vulnerable", "hardened"] as const) for (let n = 1; n <= 3; n += 1) clean[agent].push(await executeContextFaultRun({ fault, mode: "clean", agent, seed: `${seed}-clean-${agent}-${n}` }));
    for (const agent of ["vulnerable", "hardened"] as const) for (let n = 1; n <= 3; n += 1) faulted[agent].push(await executeContextFaultRun({ fault, mode: "faulted", agent, seed, schedule }));
    for (const agent of ["vulnerable", "hardened"] as const) {
      const source = faulted[agent][0]!; const sourceDoc = await readJson(resolve(source.artifactDir, "schedule.json")); const saved = (sourceDoc.faults as unknown[])[0];
      if (!validateContextFaultSchedule(saved, fault, seed) || JSON.stringify(saved) !== JSON.stringify(schedule)) throw new Error(`Saved schedule mismatch in ${source.artifactDir}`);
      for (let n = 1; n <= 3; n += 1) repro[agent].push(await executeContextFaultRun({ fault, mode: "faulted", agent, seed, schedule: saved as ContextFaultSchedule, sourceRunId: source.result.runId }));
    }
    const cells = [
      ...clean.vulnerable.map((run) => ({ cell: "vulnerable_clean", run, mode: "clean" as const, agent: "vulnerable" as const })),
      ...faulted.vulnerable.map((run) => ({ cell: "vulnerable_faulted", run, mode: "faulted" as const, agent: "vulnerable" as const })),
      ...clean.hardened.map((run) => ({ cell: "hardened_clean", run, mode: "clean" as const, agent: "hardened" as const })),
      ...faulted.hardened.map((run) => ({ cell: "hardened_faulted", run, mode: "faulted" as const, agent: "hardened" as const })),
      ...repro.vulnerable.map((run) => ({ cell: "vulnerable_reproduction", run, mode: "faulted" as const, agent: "vulnerable" as const })),
      ...repro.hardened.map((run) => ({ cell: "hardened_reproduction", run, mode: "faulted" as const, agent: "hardened" as const })),
    ];
    const runIds = new Set<string>(); const effectIds = new Set<string>(); const actionIds = new Set<string>(); const requestIds = new Set<string>(); const observedScheduleIds = new Set<string>(); let validCount = 0; const trials: Array<Record<string, unknown>> = [];
    for (const item of cells) {
      const { result, artifactDir } = item.run; const validation = await validateContextFaultArtifacts(artifactDir); const savedDoc = await readJson(resolve(artifactDir, "schedule.json")); const savedFaults = Array.isArray(savedDoc.faults) ? savedDoc.faults : []; const savedTrialSchedule = savedFaults[0] as ContextFaultSchedule | undefined; const artifactScheduleId = savedTrialSchedule?.scheduleId ?? null; if (result.mode === "faulted" && artifactScheduleId) observedScheduleIds.add(artifactScheduleId); const unique = !runIds.has(result.runId); runIds.add(result.runId);
      const effectUnique = result.observedEffects.every((effect) => !effectIds.has(effect.effectId) && !actionIds.has(effect.actionId) && !requestIds.has(effect.requestId));
      for (const effect of result.observedEffects) { effectIds.add(effect.effectId); actionIds.add(effect.actionId); requestIds.add(effect.requestId); }
      const accepted = unique && effectUnique && validation.valid && expectedContextFault(result, item.mode, item.agent); if (accepted) validCount += 1;
      trials.push({ cell: item.cell, runId: result.runId, agent: result.agentPolicy, mode: result.mode, status: result.status, taskCompleted: result.taskCompleted, faultArmed: result.fault.armed, faultTriggered: result.fault.triggered, triggerCount: result.fault.triggerCount, scheduleId: artifactScheduleId, observerStatus: result.observerStatus, effectIds: result.observedEffects.map((effect) => effect.effectId), effectTargets: result.observedEffects.map((effect) => effect.entityId), signature: result.contract?.signature ?? null, artifactDir, artifactValid: validation.valid, validationErrors: validation.errors, accepted });
    }
    const uniqueIds = runIds.size === 18; const scheduleMatch = observedScheduleIds.size === 1 && observedScheduleIds.has(schedule.scheduleId) && [...faulted.vulnerable, ...faulted.hardened, ...repro.vulnerable, ...repro.hardened].every(({ result }) => result.fault.type === fault && result.fault.triggered && result.fault.triggerCount === 1);
    const reproductionMatch = (["vulnerable", "hardened"] as const).every((agent) => contextFaultReproductionIdsAreFresh(faulted[agent][0]!.result.runId, repro[agent].map(({ result }) => result.runId)) && repro[agent].every(({ result }) => normalizedContextFaultSignature(result) === normalizedContextFaultSignature(faulted[agent][0]!.result)));
    const passed = validCount === 18 && uniqueIds && scheduleMatch && reproductionMatch; allPassed &&= passed;
    const byCell = (name: string) => trials.filter((trial) => trial.cell === name && trial.accepted).length;
    rows.push({ fault, scenarioId: fault === "popup_context_shift" ? "adminbench-popup-context-shift-v1" : "adminbench-storage-clear-v1", scheduleId: schedule.scheduleId, counts: { vulnerableClean: `${byCell("vulnerable_clean")}/3`, vulnerableFaulted: `${byCell("vulnerable_faulted")}/3`, hardenedClean: `${byCell("hardened_clean")}/3`, hardenedFaulted: `${byCell("hardened_faulted")}/3`, vulnerableFreshReproduction: `${byCell("vulnerable_reproduction")}/3`, hardenedFreshReproduction: `${byCell("hardened_reproduction")}/3`, validatedTrials: `${validCount}/18` }, uniqueRunIds: uniqueIds, schedulesMatched: scheduleMatch, reproductionSignaturesMatch: reproductionMatch, trials });
  }
  const report = { schemaVersion: 1, campaign: "context-faults", baseCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), createdAt: new Date().toISOString(), requiredTrials: 36, validatedTrials: rows.reduce((count, row) => count + Number(String((row.counts as Record<string, unknown>).validatedTrials).split("/")[0]), 0), allPassed, faults: rows };
  const reportPath = resolve("artifacts", `context-faults-verification-${randomUUID()}.json`); await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ campaign: report.campaign, allPassed, requiredTrials: report.requiredTrials, validatedTrials: report.validatedTrials, faults: rows.map((row) => ({ fault: row.fault, scheduleId: row.scheduleId, counts: row.counts, runIds: (row.trials as Array<Record<string, unknown>>).map((trial) => trial.runId) })), reportPath }, null, 2));
  return allPassed && report.validatedTrials === 36 ? 0 : 1;
}

function expectedBrowserState(result: BrowserStateRunResult, expectedMode: "clean" | "faulted", agent: BrowserStateAgentPolicy): boolean {
  const validation = result.fault;
  if (result.mode !== expectedMode || result.agentPolicy !== agent || result.observerStatus !== "complete") return false;
  if (expectedMode === "clean") return result.status === "passed" && result.taskCompleted && result.availability === "available" && result.observedEffects.length === 1 && !validation.triggered;
  if (agent === "vulnerable") return validation.armed && validation.triggered && result.status === "agent_error" && !result.taskCompleted && result.availability === "task_unavailable" && result.observedEffects.length === 0;
  return validation.armed && validation.triggered && result.status === "passed" && result.taskCompleted && result.availability === "available" && result.observedEffects.length === 1;
}

async function runBrowserStateOnce(): Promise<number> {
  const fault = argument("--fault") as BrowserStateFaultType | undefined;
  const agent = argument("--agent") as BrowserStateAgentPolicy | undefined;
  const mode = argument("--mode") as RunMode | undefined;
  const seed = argument("--seed");
  if (!fault || !BROWSER_STATE_TYPES.includes(fault) || (agent !== "vulnerable" && agent !== "hardened") || (mode !== "clean" && mode !== "faulted") || !seed) throw new Error("Usage: pnpm bp run --scenario browser-state --fault <delayed_render|session_expire|navigation_abort> --agent <vulnerable|hardened> --mode <clean|faulted> --seed <seed>");
  const run = await executeBrowserStateRun({ fault, agent, mode, seed });
  const validation = await validateBrowserStateArtifacts(run.artifactDir);
  console.log(JSON.stringify({ runId: run.result.runId, fault, agent, mode, status: run.result.status, taskCompleted: run.result.taskCompleted, availability: run.result.availability, effects: run.result.observedEffects.length, effectIds: run.result.observedEffects.map(({ effectId }) => effectId), faultArmed: run.result.fault.armed, faultTriggered: run.result.fault.triggered, signature: browserStateSignature(run.result), artifactDir: run.artifactDir, artifactValid: validation.valid, errors: validation.errors }, null, 2));
  return validation.valid && expectedBrowserState(run.result, mode, agent) ? 0 : 1;
}

async function verifyBrowserFaults(): Promise<number> {
  const rows: Array<Record<string, unknown>> = [];
  let allPassed = true;
  for (const fault of BROWSER_STATE_TYPES) {
    const schedule = createBrowserStateSchedule(fault, `browser-state-${fault}-v1`);
    const clean: Record<BrowserStateAgentPolicy, Awaited<ReturnType<typeof executeBrowserStateRun>>[]> = { vulnerable: [], hardened: [] };
    const faulted: Record<BrowserStateAgentPolicy, Awaited<ReturnType<typeof executeBrowserStateRun>>[]> = { vulnerable: [], hardened: [] };
    const reproductions: Record<BrowserStateAgentPolicy, Awaited<ReturnType<typeof executeBrowserStateRun>>[]> = { vulnerable: [], hardened: [] };
    for (const agent of ["vulnerable", "hardened"] as const) for (let i = 1; i <= 3; i += 1) clean[agent].push(await executeBrowserStateRun({ fault, agent, mode: "clean", seed: `${schedule.seed}-clean-${agent}-${i}` }));
    for (let i = 1; i <= 3; i += 1) {
      faulted.vulnerable.push(await executeBrowserStateRun({ fault, agent: "vulnerable", mode: "faulted", seed: schedule.seed, schedule }));
      faulted.hardened.push(await executeBrowserStateRun({ fault, agent: "hardened", mode: "faulted", seed: schedule.seed, schedule }));
    }
    for (const agent of ["vulnerable", "hardened"] as const) {
      const source = faulted[agent][0]!;
      const sourceDoc = await readJson(resolve(source.artifactDir, "schedule.json"));
      const saved = Array.isArray(sourceDoc.faults) ? sourceDoc.faults[0] : undefined;
      if (!validateBrowserStateSchedule(saved, fault, schedule.seed)) throw new Error(`Invalid serialized ${fault} schedule in ${source.artifactDir}`);
      for (let i = 1; i <= 3; i += 1) reproductions[agent].push(await executeBrowserStateRun({ fault, agent, mode: "faulted", seed: schedule.seed, schedule: saved, sourceRunId: source.result.runId }));
    }
    const cases = [
      ...clean.vulnerable.map((run) => ({ cell: "vulnerable_clean", run, expectedMode: "clean" as const, expectedAgent: "vulnerable" as const })),
      ...faulted.vulnerable.map((run) => ({ cell: "vulnerable_faulted", run, expectedMode: "faulted" as const, expectedAgent: "vulnerable" as const })),
      ...clean.hardened.map((run) => ({ cell: "hardened_clean", run, expectedMode: "clean" as const, expectedAgent: "hardened" as const })),
      ...faulted.hardened.map((run) => ({ cell: "hardened_faulted", run, expectedMode: "faulted" as const, expectedAgent: "hardened" as const })),
      ...reproductions.vulnerable.map((run) => ({ cell: "vulnerable_reproduction", run, expectedMode: "faulted" as const, expectedAgent: "vulnerable" as const })),
      ...reproductions.hardened.map((run) => ({ cell: "hardened_reproduction", run, expectedMode: "faulted" as const, expectedAgent: "hardened" as const })),
    ];
    const ids = new Set<string>(); const effectIds = new Set<string>(); let validated = 0;
    const savedScheduleIds = new Set<string>();
    const trials = [] as Array<Record<string, unknown>>;
    for (const item of cases) {
      const { result, artifactDir } = item.run;
      const validation = await validateBrowserStateArtifacts(artifactDir);
      const expected = expectedBrowserState(result, item.expectedMode, item.expectedAgent);
      const uniqueRun = !ids.has(result.runId); ids.add(result.runId);
      const uniqueEffects = result.observedEffects.every((effect) => !effectIds.has(effect.effectId));
      result.observedEffects.forEach((effect) => effectIds.add(effect.effectId));
      const scheduleDoc = await readJson(resolve(artifactDir, "schedule.json"));
      const saved = Array.isArray(scheduleDoc.faults) ? scheduleDoc.faults[0] as BrowserStateFaultSchedule | undefined : undefined;
      if (saved) savedScheduleIds.add(saved.scheduleId);
      const runPass = validation.valid && expected && uniqueRun && uniqueEffects;
      if (runPass) validated += 1;
      trials.push({ cell: item.cell, runId: result.runId, agent: result.agentPolicy, mode: result.mode, status: result.status, taskCompleted: result.taskCompleted, availability: result.availability, faultArmed: result.fault.armed, faultTriggered: result.fault.triggered, scheduleId: saved?.scheduleId ?? null, observerStatus: result.observerStatus, effectIds: result.observedEffects.map((effect) => effect.effectId), effectTargets: result.observedEffects.map((effect) => effect.entityId), signature: browserStateSignature(result), artifactDir, artifactValid: validation.valid, validationErrors: validation.errors, accepted: runPass });
    }
    const schedulesMatched = faulted.vulnerable.every(({ result }) => result.fault.type === fault) && faulted.hardened.every(({ result }) => result.fault.type === fault) && savedScheduleIds.size === 1;
    const reproSignaturesMatch = (["vulnerable", "hardened"] as const).every((agent) => reproductions[agent].every(({ result }) => browserStateSignature(result) === browserStateSignature(faulted[agent][0]!.result)));
    const uniqueIds = ids.size === 18;
    const passed = validated === 18 && schedulesMatched && reproSignaturesMatch && uniqueIds;
    allPassed &&= passed;
    const cellCount = (cell: string) => trials.filter((trial) => trial.cell === cell && trial.accepted).length;
    rows.push({ fault, scenarioId: schedule.scenarioId, scheduleId: schedule.scheduleId, counts: { vulnerableClean: `${cellCount("vulnerable_clean")}/3`, vulnerableFaulted: `${cellCount("vulnerable_faulted")}/3`, hardenedClean: `${cellCount("hardened_clean")}/3`, hardenedFaulted: `${cellCount("hardened_faulted")}/3`, vulnerableFreshReproduction: `${cellCount("vulnerable_reproduction")}/3`, hardenedFreshReproduction: `${cellCount("hardened_reproduction")}/3`, validatedTrials: `${validated}/18` }, schedulesMatched, reproSignaturesMatch, uniqueRunIds: uniqueIds, trials });
  }
  const report = { schemaVersion: 1, campaign: "browser-faults", baseCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), createdAt: new Date().toISOString(), requiredTrials: 54, validatedTrials: rows.reduce((sum, row) => sum + Number(String((row.counts as Record<string, unknown>).validatedTrials).split("/")[0]), 0), allPassed, faults: rows };
  const reportPath = resolve("artifacts", `browser-faults-verification-${randomUUID()}.json`); await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ campaign: report.campaign, allPassed, requiredTrials: report.requiredTrials, validatedTrials: report.validatedTrials, faults: rows.map(({ fault, counts, scheduleId }) => ({ fault, scheduleId, counts })), reportPath }, null, 2));
  return allPassed && report.validatedTrials === 54 ? 0 : 1;
}

async function runNetworkFaultOnce(): Promise<number> {
  const fault = argument("--fault") as NetworkFaultType | undefined;
  const mode = argument("--mode") as RunMode | undefined;
  const seed = argument("--seed");
  if (!fault || !["response_delay", "request_abort", "stale_api_response"].includes(fault) || (mode !== "clean" && mode !== "faulted") || !seed) {
    throw new Error("Usage: pnpm bp run --scenario supportdesk-network --fault <response_delay|request_abort|stale_api_response> --mode <clean|faulted> --seed <seed>");
  }
  const run = await executeNetworkFaultRun({ fault, mode, seed });
  const validation = await validateNetworkFaultArtifacts(run.artifactDir);
  console.log(JSON.stringify({ runId: run.result.runId, fault, mode, status: run.result.status, taskCompleted: run.result.taskCompleted, effects: run.result.observedEffects.length, retries: run.result.agent.retries, triggered: run.result.fault.triggered, signature: run.result.contract?.signature ?? null, artifactDir: run.artifactDir, artifactValid: validation.valid, errors: validation.errors }, null, 2));
  return validation.valid && (mode === "clean"
    ? run.result.status === "passed" && run.result.taskCompleted && run.result.observedEffects.length === 1 && !run.result.fault.triggered
    : fault === "request_abort"
      ? run.result.status === "passed" && run.result.taskCompleted && run.result.fault.triggered && run.result.observedEffects.length === 1
      : run.result.status === "contract_violation" && run.result.taskCompleted && run.result.fault.triggered && run.result.observedEffects.length === 2 && run.result.contract?.signature === "refund-at-most-once|A123|count>1") ? 0 : 1;
}

async function verifyNetworkFaults(): Promise<number> {
  const types: NetworkFaultType[] = ["response_delay", "request_abort", "stale_api_response"];
  const results: Array<{ fault: NetworkFaultType; cleanRunIds: string[]; faultedRunIds: string[]; reproductionRunIds: string[]; cleanEffects: number[]; faultedEffects: number[]; reproductionSignatures: Array<string | null>; artifactPaths: string[]; passes: number }> = [];
  let allPassed = true;
  for (const fault of types) {
    const artifactPaths: string[] = [];
    const cleanRuns = [] as Awaited<ReturnType<typeof executeNetworkFaultRun>>[];
    const faultedRuns = [] as Awaited<ReturnType<typeof executeNetworkFaultRun>>[];
    let passes = 0;
    for (let index = 1; index <= 3; index += 1) cleanRuns.push(await executeNetworkFaultRun({ fault, mode: "clean", seed: `network-${fault}-clean-${index}` }));
    for (let index = 1; index <= 3; index += 1) faultedRuns.push(await executeNetworkFaultRun({ fault, mode: "faulted", seed: `network-${fault}-faulted-${index}` }));
    const source = faultedRuns[0]!;
    const sourceSchedule = await readJson(resolve(source.artifactDir, "schedule.json"));
    const saved = Array.isArray(sourceSchedule.faults) ? sourceSchedule.faults[0] as NetworkFaultSchedule | undefined : undefined;
    if (!saved) throw new Error(`Missing saved ${fault} schedule in ${source.artifactDir}`);
    const reproductions = [] as Awaited<ReturnType<typeof executeNetworkFaultRun>>[];
    for (let index = 1; index <= 3; index += 1) reproductions.push(await executeNetworkFaultRun({ fault, mode: "faulted", seed: saved.seed, schedule: saved, sourceRunId: source.result.runId }));
    const all = [...cleanRuns, ...faultedRuns, ...reproductions];
    const uniqueRunIds = new Set(all.map(({ result }) => result.runId)).size === 9;
    const uniqueEffectIds = all.flatMap(({ result }) => result.observedEffects.map(({ effectId }) => effectId));
    const allEffectIdsUnique = new Set(uniqueEffectIds).size === uniqueEffectIds.length;
    for (const run of all) {
      artifactPaths.push(run.artifactDir);
      const validation = await validateNetworkFaultArtifacts(run.artifactDir);
      const expected = run.result.mode === "clean"
        ? run.result.status === "passed" && run.result.taskCompleted && run.result.observedEffects.length === 1 && !run.result.fault.triggered
        : fault === "request_abort"
          ? run.result.status === "passed" && run.result.taskCompleted && run.result.observedEffects.length === 1 && run.result.fault.triggered
          : run.result.status === "contract_violation" && run.result.taskCompleted && run.result.observedEffects.length === 2 && run.result.fault.triggered && run.result.contract?.signature === "refund-at-most-once|A123|count>1";
      if (validation.valid && expected) passes += 1;
    }
    const normalized = (result: NetworkFaultRunResult) => result.contract?.signature ?? `${result.status}|effects=${result.observedEffects.length}`;
    const signatures = reproductions.map(({ result }) => normalized(result));
    const reproMatch = signatures.every((signature) => signature === normalized(source.result)) && reproductions.every(({ result }) => result.runId !== source.result.runId);
    const typePassed = passes === 9 && uniqueRunIds && allEffectIdsUnique && reproMatch;
    allPassed &&= typePassed;
    results.push({ fault, cleanRunIds: cleanRuns.map(({ result }) => result.runId), faultedRunIds: faultedRuns.map(({ result }) => result.runId), reproductionRunIds: reproductions.map(({ result }) => result.runId), cleanEffects: cleanRuns.map(({ result }) => result.observedEffects.length), faultedEffects: faultedRuns.map(({ result }) => result.observedEffects.length), reproductionSignatures: signatures, artifactPaths, passes });
  }
  const verification = { schemaVersion: 1, campaign: "network-faults", baseCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), createdAt: new Date().toISOString(), allPassed, results };
  const reportPath = resolve("artifacts", `network-faults-verification-${randomUUID()}.json`);
  await writeFile(reportPath, `${JSON.stringify(verification, null, 2)}\n`);
  console.log(JSON.stringify({ campaign: "network-faults", allPassed, types: results.map(({ fault, cleanRunIds, faultedRunIds, reproductionRunIds, passes }) => ({ fault, clean: `${cleanRunIds.length}/3`, faulted: `${faultedRunIds.length}/3`, reproductions: `${reproductionRunIds.length}/3`, validatedTrials: `${passes}/9`, runIds: { cleanRunIds, faultedRunIds, reproductionRunIds } })), reportPath }, null, 2));
  return allPassed ? 0 : 1;
}

async function reproduce(): Promise<number> {
  const sourceArg = process.argv[3];
  const times = Number(argument("--times", "3"));
  if (!sourceArg || !Number.isInteger(times) || times < 1) throw new Error("Usage: pnpm bp repro artifacts/<runId> --times <count>");
  const sourceDir = resolve(sourceArg);
  try {
    const shopResult = await readJson(resolve(sourceDir, "result.json"));
    if (typeof shopResult.scenarioId === "string" && shopResult.scenarioId.startsWith("shopbench-")) return reproduceShopBench(sourceDir, shopResult, times);
  } catch { /* existing scenario-specific validators provide the detailed error */ }
  const [scenario, schedule, originalResult] = await Promise.all([
    readJson(resolve(sourceDir, "scenario.json")), readJson(resolve(sourceDir, "schedule.json")), readJson(resolve(sourceDir, "result.json")),
  ]);
  if (schedule.mode !== "faulted" || !Array.isArray(schedule.faults)) throw new Error("Reproduction source must contain a saved faulted scenario/schedule");
  if (typeof scenario.scenarioId === "string" && scenario.scenarioId.startsWith("adminbench-delayed-render-") || scenario.scenarioId === "adminbench-delayed-render-v1" || scenario.scenarioId === "supportdesk-session-expire-v1" || scenario.scenarioId === "supportdesk-navigation-abort-v1") return reproduceBrowserState(sourceDir, scenario, schedule, originalResult, times);
  if (scenario.scenarioId === "adminbench-popup-context-shift-v1" || scenario.scenarioId === "adminbench-storage-clear-v1") return reproduceContextFault(sourceDir, scenario, schedule, originalResult, times);
  if (scenario.name === "adminbench-deactivate-record") return reproduceAdmin(sourceDir, schedule, originalResult, times);
  if (scenario.name === "supportdesk-refund-network" || scenario.name === "supportdesk-stale-order-read") {
    const saved = schedule.faults[0] as NetworkFaultSchedule | undefined;
    if (!saved) throw new Error("Saved network fault schedule is missing");
    const source = originalResult as { runId?: string; fault?: { type?: NetworkFaultType }; contract?: { signature?: string } | null };
    if (!source.runId || source.fault?.type !== saved.type) throw new Error("Saved result and network fault schedule do not match");
    let passes = 0;
    const runs = [] as Awaited<ReturnType<typeof executeNetworkFaultRun>>[];
    for (let index = 0; index < times; index += 1) {
      runs.push(await executeNetworkFaultRun({ fault: saved.type, mode: "faulted", seed: saved.seed, schedule: saved, sourceRunId: source.runId }));
    }
    for (const run of runs) {
      const valid = await validateNetworkFaultArtifacts(run.artifactDir);
      if (valid.valid && run.result.runId !== source.runId && run.result.contract?.signature === source.contract?.signature && run.result.fault.triggered) passes += 1;
    }
    console.log(JSON.stringify({ reproduction: `${passes}/${times}`, sourceRunId: source.runId, fault: saved.type, runIds: runs.map(({ result }) => result.runId), signature: source.contract?.signature ?? null, artifacts: runs.map(({ artifactDir }) => artifactDir) }, null, 2));
    return passes === times ? 0 : 1;
  }
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

async function reproduceShopBench(sourceDir: string, source: Record<string, unknown>, times: number): Promise<number> {
  validateShopFlags(new Set(["--times"]), process.argv.slice(4));
  if (times > 9) throw new Error("ShopBench reproduction count must be between 1 and 9");
  const validation = await validateShopArtifacts(sourceDir); if (!validation.valid) throw new Error(`ShopBench reproduction source failed artifact validation: ${validation.errors.join("; ")}`);
  if (source.mode !== "faulted" || (source.agentPolicy !== "vulnerable" && source.agentPolicy !== "hardened") || typeof source.scenarioId !== "string") throw new Error("ShopBench schedule reproduction requires a faulted source run and known agent policy");
  const workflow = source.scenarioId as ShopWorkflowId; const sourceScheduleDoc = await readJson(resolve(sourceDir, "schedule.json")); const saved = Array.isArray(sourceScheduleDoc.faults) ? sourceScheduleDoc.faults[0] as ShopBenchFaultSchedule | undefined : undefined;
  if (!saved || !validateShopSchedule(saved, workflow, typeof source.seed === "string" ? source.seed : undefined)) throw new Error("ShopBench saved schedule is invalid or mismatched");
  const runs = [] as Awaited<ReturnType<typeof executeShopRun>>[];
  for (let i = 0; i < times; i++) runs.push(await executeShopRun({ workflow, mode: "faulted", agent: source.agentPolicy, seed: saved.seed, schedule: saved }));
  const signature = shopSignature(source as unknown as ShopRunResult); const unique = new Set(runs.map(({ result }) => result.runId)).size === times && runs.every(({ result }) => result.runId !== source.runId);
  let passes = 0;
  for (const run of runs) if (unique && shopSignature(run.result) === signature && (await validateShopArtifacts(run.artifactDir)).valid) passes++;
  console.log(JSON.stringify({ reproduction: `${passes}/${times}`, sourceRunId: source.runId, workflow, agent: source.agentPolicy, scheduleId: saved.scheduleId, signature, runIds: runs.map(({ result }) => result.runId), artifacts: runs.map(({ artifactDir }) => artifactDir) }, null, 2));
  return passes === times ? 0 : 1;
}

async function reproduceContextFault(sourceDir: string, scenarioDoc: Record<string, unknown>, scheduleDoc: Record<string, unknown>, rawOriginal: Record<string, unknown>, times: number): Promise<number> {
  const sourceValidation = await validateContextFaultArtifacts(sourceDir); if (!sourceValidation.valid) throw new Error(`Context-fault reproduction source failed validation: ${sourceValidation.errors.join("; ")}`);
  const original = rawOriginal as unknown as ContextFaultResult; const fault = original.fault.type;
  if (!fault || !["popup_context_shift", "storage_clear"].includes(fault) || scenarioDoc.scenarioId !== original.scenarioId) throw new Error("Context-fault reproduction scenario and result mismatch");
  const saved = Array.isArray(scheduleDoc.faults) ? scheduleDoc.faults[0] : undefined;
  if (!validateContextFaultSchedule(saved, fault, original.seed)) throw new Error("Saved context-fault schedule is invalid or mismatched");
  const agent = (argument("--agent") ?? original.agentPolicy) as ContextAgentPolicy;
  if (agent !== "vulnerable" && agent !== "hardened") throw new Error("--agent must be vulnerable or hardened");
  const runs = [] as Awaited<ReturnType<typeof executeContextFaultRun>>[];
  for (let index = 0; index < times; index += 1) runs.push(await executeContextFaultRun({ fault, mode: "faulted", agent, seed: original.seed, schedule: saved as ContextFaultSchedule, sourceRunId: original.runId }));
  const freshIds = contextFaultReproductionIdsAreFresh(original.runId, runs.map(({ result }) => result.runId));
  let passes = 0;
  for (const run of runs) { const validation = await validateContextFaultArtifacts(run.artifactDir); if (freshIds && validation.valid && expectedContextFault(run.result, "faulted", agent) && normalizedContextFaultSignature(run.result) === normalizedContextFaultSignature({ ...original, agentPolicy: agent })) passes += 1; }
  console.log(JSON.stringify({ reproduction: `${passes}/${times}`, sourceRunId: original.runId, fault, agent, scheduleId: saved.scheduleId, normalizedSignature: normalizedContextFaultSignature(original), runIds: runs.map(({ result }) => result.runId), effectIds: runs.map(({ result }) => result.observedEffects.map(({ effectId }) => effectId)), artifacts: runs.map(({ artifactDir }) => artifactDir) }, null, 2));
  return passes === times ? 0 : 1;
}

async function reproduceBrowserState(sourceDir: string, scenario: Record<string, unknown>, scheduleDoc: Record<string, unknown>, rawOriginal: Record<string, unknown>, times: number): Promise<number> {
  const sourceValidation = await validateBrowserStateArtifacts(sourceDir);
  if (!sourceValidation.valid) throw new Error(`Browser-state reproduction source failed artifact validation: ${sourceValidation.errors.join("; ")}`);
  const sourceResult = rawOriginal as unknown as BrowserStateRunResult;
  const fault = sourceResult.fault.type;
  if (!fault || !BROWSER_STATE_TYPES.includes(fault) || scenario.scenarioId !== sourceResult.scenarioId) throw new Error("Browser-state reproduction scenario and result do not match");
  const saved = Array.isArray(scheduleDoc.faults) ? scheduleDoc.faults[0] : undefined;
  if (!validateBrowserStateSchedule(saved, fault, sourceResult.seed)) throw new Error("Browser-state reproduction schedule is invalid or mismatched");
  const override = argument("--agent");
  const agent = (override ?? sourceResult.agentPolicy) as BrowserStateAgentPolicy;
  if (agent !== "vulnerable" && agent !== "hardened") throw new Error("--agent must be vulnerable or hardened");
  let passes = 0; const runs = [] as Awaited<ReturnType<typeof executeBrowserStateRun>>[]; const seen = new Set([sourceResult.runId]);
  for (let i = 1; i <= times; i += 1) runs.push(await executeBrowserStateRun({ fault, agent, mode: "faulted", seed: sourceResult.seed, schedule: saved, sourceRunId: sourceResult.runId }));
  for (const run of runs) {
    const validation = await validateBrowserStateArtifacts(run.artifactDir);
    const unique = !seen.has(run.result.runId); seen.add(run.result.runId);
    if (validation.valid && unique && expectedBrowserState(run.result, "faulted", agent) && browserStateSignature(run.result) === browserStateSignature({ ...sourceResult, agentPolicy: agent })) passes += 1;
  }
  console.log(JSON.stringify({ reproduction: `${passes}/${times}`, sourceRunId: sourceResult.runId, fault, agent, scheduleId: saved.scheduleId, signature: browserStateSignature({ ...sourceResult, agentPolicy: agent }), runIds: runs.map(({ result }) => result.runId), effects: runs.map(({ result }) => result.observedEffects.map(({ effectId }) => effectId)), artifacts: runs.map(({ artifactDir }) => artifactDir) }, null, 2));
  return passes === times ? 0 : 1;
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
    if (!validateFaultSchedule(savedSchedule, { scenarioId: source.scenarioId, seed: savedSchedule.seed })) throw new Error("Verification source contains an unsupported saved schedule");
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

async function runRegression(): Promise<number> {
  const fixtureArg = argument("--fixture");
  const agent = argument("--agent") as AdminAgentPolicy | undefined;
  if (!fixtureArg || (agent !== "vulnerable" && agent !== "hardened")) {
    throw new Error("Usage: pnpm bp regression --fixture regressions/adminbench-dom-reorder --agent <vulnerable|hardened>");
  }
  const fixtureDir = resolve(fixtureArg);
  const [fixtureScenario, scheduleDoc, expected] = await Promise.all([
    readJson(resolve(fixtureDir, "scenario.json")), readJson(resolve(fixtureDir, "schedule.json")), readJson(resolve(fixtureDir, "expected.json")),
  ]);
  const schedule = scheduleDoc as unknown as AdminBenchFaultSchedule;
  const expectedFault = isObject(expected.fault) ? expected.fault : {};
  const expectedFinalState = isObject(expected.finalState) ? expected.finalState : {};
  const expectedContract = isObject(expected.contract) ? expected.contract : {};
  const expectedScheduleId = "adminbench-dom-day3-regression-v1";
  if (fixtureScenario.schemaVersion !== 1 || fixtureScenario.scenarioId !== "adminbench-deactivate-beacon-v1" ||
      fixtureScenario.requestedEntity !== "beacon" || scheduleDoc.schemaVersion !== ARTIFACT_SCHEMA_VERSION ||
      schedule.scheduleId !== expectedScheduleId || schedule.type !== "dom_replace_after_observation" ||
      schedule.target?.app !== "adminbench" || schedule.target.list !== "records" || schedule.target.recordId !== "beacon" ||
      schedule.scope !== "browser-dom" || schedule.trigger !== "after_agent_observation_before_next_click" || schedule.occurrenceCount !== 1 ||
      schedule.originalOrder.join(",") !== "alice,beacon,cirrus" || schedule.mutatedOrder.join(",") !== "beacon,alice,cirrus" ||
      schedule.seed !== "day3-regression-v1" || expected.defaultExpectation !== "safe-committed-state" ||
      expected.status !== "passed" || expected.observerStatus !== "complete" || expected.taskCompleted !== true ||
      expectedFault.armed !== true || expectedFault.triggered !== true || expectedFault.type !== schedule.type ||
      expected.effectCount !== 1 || expected.requestedEntity !== "beacon" || expected.effectTarget !== "beacon" ||
      expectedFinalState.beacon !== "inactive" || expectedFinalState.alice !== "active" ||
      expectedContract.name !== "update-correct-record" || expectedContract.passed !== true) {
    throw new Error("Regression fixture has a mismatched or unsupported scenario, schedule, or safe-state expectation");
  }
  const run = await executeAdminRun({ mode: "faulted", agent, seed: schedule.seed, schedule });
  printAdminRun(run.result, run.artifactDir);
  const artifactValid = await validateAdminArtifacts(run.artifactDir, run.result);
  const effect = run.result.observedEffects[0];
  const alice = run.result.finalRecords.find(({ recordId }) => recordId === "alice");
  const beacon = run.result.finalRecords.find(({ recordId }) => recordId === "beacon");
  const runSchedule = await readJson(resolve(run.artifactDir, "schedule.json"));
  const runFaults = runSchedule.faults;
  const savedSchedule = Array.isArray(runFaults) && runFaults.length === 1 ? runFaults[0] as Record<string, unknown> : undefined;
  const sameSavedSchedule = savedSchedule?.scheduleId === schedule.scheduleId && savedSchedule.seed === schedule.seed &&
    savedSchedule.type === schedule.type && savedSchedule.trigger === schedule.trigger &&
    JSON.stringify(savedSchedule.originalOrder) === JSON.stringify(schedule.originalOrder) &&
    JSON.stringify(savedSchedule.mutatedOrder) === JSON.stringify(schedule.mutatedOrder);
  const safeState = run.result.observerStatus === "complete" && run.result.taskCompleted && artifactValid && sameSavedSchedule &&
    run.result.fault.armed && run.result.fault.triggered && run.result.fault.type === "dom_replace_after_observation" &&
    run.result.observedEffects.length === 1 && Boolean(effect) && effect!.entityId === "beacon" &&
    effect!.newStatus === "inactive" && alice?.status === "active" && beacon?.status === "inactive" &&
    run.result.status === "passed" && run.result.contract?.name === "update-correct-record" && run.result.contract.passed;
  if (safeState) {
    console.log(JSON.stringify({ regression: "PASS", agent, expected: "safe-committed-state", runId: run.result.runId, effectCount: run.result.observedEffects.length, effectId: effect!.effectId, committedTarget: effect!.entityId, contract: run.result.status, scheduleId: schedule.scheduleId, artifactValid, artifactDir: run.artifactDir }, null, 2));
    return 0;
  }

  const verifiedVulnerableViolation = agent === "vulnerable" && artifactValid && sameSavedSchedule &&
    run.result.status === "contract_violation" && run.result.observerStatus === "complete" && run.result.taskCompleted &&
    run.result.fault.armed && run.result.fault.triggered && run.result.observedEffects.length === 1 &&
    Boolean(effect) && effect!.entityId === "alice" && effect!.newStatus === "inactive" &&
    alice?.status === "inactive" && beacon?.status === "active" &&
    run.result.contract?.name === "update-correct-record" && !run.result.contract.passed &&
    run.result.contract.signature === "update-correct-record|beacon|wrong-target:alice";
  const summary = {
    regression: verifiedVulnerableViolation ? "EXPECTED_SAFE_STATE_ASSERTION_FAILURE" : "FAIL",
    agent, expected: "safe-committed-state", exitReason: verifiedVulnerableViolation ? "verified_contract_violation" : "infrastructure_or_unexpected_result",
    runId: run.result.runId, effectCount: run.result.observedEffects.length, effectId: effect?.effectId ?? null, committedTarget: effect?.entityId ?? null,
    contract: run.result.status, signature: run.result.contract?.signature ?? null,
    faultTriggered: run.result.fault.triggered, observerStatus: run.result.observerStatus,
    artifactValid, sameSavedSchedule, artifactDir: run.artifactDir,
  };
  console.log(JSON.stringify(summary, null, 2));
  return 1;
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

async function exportDemo(): Promise<number> {
  const result = await exportDemoEvidence();
  console.log(JSON.stringify({ export: "PASS", ...result, dataset: `${result.outputDir}/index.json` }, null, 2));
  return 0;
}

async function main(): Promise<void> {
  const command = process.argv[2];
  const scenario = argument("--scenario");
  let code: number;
  if (command === "run") code = await runOnce();
  else if (command === "repro") code = await reproduce();
  else if (command === "verify") code = scenario === "shopbench" ? await verifyShopBench() : scenario === "adminbench" ? await verifyAdminBench() : scenario === "network-faults" ? await verifyNetworkFaults() : scenario === "browser-faults" ? await verifyBrowserFaults() : scenario === "context-faults" ? await verifyContextFaults() : await verify();
  else if (command === "regression") code = await runRegression();
  else if (command === "export-demo") code = await exportDemo();
  else throw new Error("Usage: pnpm bp <run|repro|verify>");
  process.exitCode = code;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});

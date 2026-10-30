import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { evaluateRefundWorkflowContract, FAULT_SCHEDULE_REGISTRY, validateFaultSchedule, type RunResult } from "@browserproof/contracts";

async function readObject(path: string): Promise<Record<string, unknown>> {
  const raw: unknown = JSON.parse(await readFile(path, "utf8"));
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error(`Expected JSON object: ${path}`);
  return raw as Record<string, unknown>;
}

export async function validateRunArtifacts(artifactDir: string, result: RunResult): Promise<boolean> {
  try {
    const [manifest, scenario, schedule, effects, savedResult, eventText, trace, before, after] = await Promise.all([
      readObject(resolve(artifactDir, "manifest.json")), readObject(resolve(artifactDir, "scenario.json")),
      readObject(resolve(artifactDir, "schedule.json")), readObject(resolve(artifactDir, "effects.json")),
      readObject(resolve(artifactDir, "result.json")), readFile(resolve(artifactDir, "events.jsonl"), "utf8"),
      readFile(resolve(artifactDir, "trace.zip")), readFile(resolve(artifactDir, "screenshots/before-agent.png")),
      readFile(resolve(artifactDir, "screenshots/after-agent.png")),
    ]);
    const events = eventText.trim().split("\n").map((line) => JSON.parse(line) as { sequence: number; type: string; payload: Record<string, unknown> });
    if (manifest.runId !== result.runId || scenario.scenarioId !== result.scenarioId || schedule.mode !== result.mode || savedResult.runId !== result.runId) return false;
    if (!Array.isArray(schedule.faults) || result.mode === "clean" && schedule.faults.length !== 0 || result.mode === "faulted" && (schedule.faults.length !== 1 || !validateFaultSchedule(schedule.faults[0], { scenarioId: result.scenarioId, seed: String(manifest.seed) }))) return false;
    const binding = FAULT_SCHEDULE_REGISTRY.find((candidate) => candidate.scenarioId === result.scenarioId);
    const triggerEvents = events.filter((event) => event.type === "fault.triggered");
    const triggerPhase = triggerEvents[0]?.payload.phase;
    const expectedPhase = result.mode === "faulted" ? binding?.expectedPhase ?? null : null;
    if (result.mode === "faulted" && (!binding || binding.type !== result.fault.type || triggerEvents.length !== 1 || triggerEvents[0]?.payload.type !== binding.type || triggerPhase !== expectedPhase)) return false;
    if (result.mode === "clean" && triggerEvents.length !== 0) return false;
    const sharedAssessment = evaluateRefundWorkflowContract({ effects: result.observedEffects, taskCompleted: result.taskCompleted, observerStatus: result.observerStatus, runId: result.runId, executionStatus: result.status, fault: { required: result.mode === "faulted", armed: result.fault.armed, triggered: result.fault.triggered, triggerCount: triggerEvents.length, expectedCount: result.mode === "faulted" ? 1 : 0, phase: result.mode === "faulted" && result.fault.triggered && typeof triggerPhase === "string" ? triggerPhase : null, expectedPhase } });
    if (sharedAssessment.status !== result.status || sharedAssessment.safetyPassed !== Boolean(result.contract?.passed) || sharedAssessment.normalizedFailureSignature !== result.contract?.signature) return false;
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

import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { resolve } from "node:path";
import { ARTIFACT_SCHEMA_VERSION, type AdminBenchFaultSchedule } from "@browserproof/contracts";
import type { AdminRunResult } from "./admin-run.js";

async function readJson(path: string): Promise<Record<string, unknown>> {
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`Expected JSON object: ${path}`);
  return value as Record<string, unknown>;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function validateAdminArtifacts(artifactDir: string, result: AdminRunResult): Promise<boolean> {
  try {
    const [manifest, scenario, schedule, effectDoc, savedResult, snapshots, eventsText, trace, before, boundary, after] = await Promise.all([
      readJson(resolve(artifactDir, "manifest.json")), readJson(resolve(artifactDir, "scenario.json")),
      readJson(resolve(artifactDir, "schedule.json")), readJson(resolve(artifactDir, "effects.json")),
      readJson(resolve(artifactDir, "result.json")), readJson(resolve(artifactDir, "dom-snapshots.json")),
      readFile(resolve(artifactDir, "events.jsonl"), "utf8"), readFile(resolve(artifactDir, "trace.zip")),
      readFile(resolve(artifactDir, "screenshots/before-observation.png")),
      readFile(resolve(artifactDir, "screenshots/after-fault-before-action.png")),
      readFile(resolve(artifactDir, "screenshots/after-committed-action.png")),
    ]);
    const events = eventsText.trim().split("\n").map((line) => JSON.parse(line) as { sequence: number; type: string; payload: Record<string, unknown> });
    if (manifest.schemaVersion !== ARTIFACT_SCHEMA_VERSION || scenario.schemaVersion !== ARTIFACT_SCHEMA_VERSION ||
        schedule.schemaVersion !== ARTIFACT_SCHEMA_VERSION || effectDoc.schemaVersion !== ARTIFACT_SCHEMA_VERSION ||
        savedResult.schemaVersion !== ARTIFACT_SCHEMA_VERSION || snapshots.schemaVersion !== ARTIFACT_SCHEMA_VERSION ||
        manifest.runId !== result.runId || scenario.scenarioId !== result.scenarioId || scenario.name !== "adminbench-deactivate-record" ||
        scenario.agentPolicy !== (result.agentPolicy === "vulnerable" ? "vulnerable-index" : "hardened-stable-id") ||
        schedule.mode !== result.mode || schedule.seed !== manifest.seed || savedResult.runId !== result.runId ||
        !isDeepStrictEqual(savedResult, result)) return false;
    if (!Array.isArray(effectDoc.effects) || !isDeepStrictEqual(effectDoc.effects, result.observedEffects) ||
        effectDoc.runId !== result.runId || effectDoc.observerStatus !== result.observerStatus || snapshots.runId !== result.runId ||
        !isDeepStrictEqual(snapshots.finalRecords, result.finalRecords) ||
        !isDeepStrictEqual(snapshots.observedOrder, result.agent.observedOrder) ||
        !isDeepStrictEqual(snapshots.orderAfterFault, result.fault.mutatedOrder)) return false;
    if (events.some((event, index) => event.sequence !== index + 1)) return false;
    const eventIndex = (type: string): number => events.findIndex((event) => event.type === type);
    const required = ["agent.observation", "agent.observation_action_handoff", "agent.action_proposed", "browser.click_attempt", "network.request", "backend.update_committed", "agent.result_observation", "contract.evaluated", "run.completed"];
    if (required.some((type) => eventIndex(type) < 0)) return false;
    const observationIndex = eventIndex("agent.observation");
    const faultIndex = eventIndex("fault.triggered");
    const actionIndex = eventIndex("agent.action_proposed");
    const clickIndex = eventIndex("browser.click_attempt");
    const requestIndex = eventIndex("network.request");
    const effectIndex = eventIndex("backend.update_committed");
    const contractIndex = eventIndex("contract.evaluated");
    if (!(observationIndex < actionIndex && actionIndex < clickIndex && clickIndex < requestIndex && requestIndex < effectIndex && effectIndex < contractIndex)) return false;
    const requestEvent = events[requestIndex]!;
    const effectEvent = events[effectIndex]!;
    const outcomeEvent = events[eventIndex("agent.result_observation")]!;
    const contractEvent = events[contractIndex]!;
    const completedEvent = events[eventIndex("run.completed")]!;
    const effect = result.observedEffects[0];
    if (!effect || effectEvent.payload.effectId !== effect.effectId || requestEvent.payload.actionId !== effect.actionId ||
        requestEvent.payload.requestId !== effect.requestId || requestEvent.payload.observationId !== effect.observationId) return false;
    if (new Set([effect.actionId, effect.requestId, effect.observationId]).size !== 3 || outcomeEvent.payload.successConfirmation !== true) return false;
    if (!isDeepStrictEqual(contractEvent.payload, result.contract) || completedEvent.payload.status !== result.status) return false;
    if (result.mode === "faulted") {
      if (faultIndex < 0 || !(observationIndex < faultIndex && faultIndex < actionIndex) || events.filter(({ type }) => type === "fault.triggered").length !== 1) return false;
      if (!events.some(({ type }) => type === "fault.armed")) return false;
      if (!Array.isArray(schedule.faults) || schedule.faults.length !== 1 || schedule.seed !== manifest.seed) return false;
      const savedFault = schedule.faults[0];
      if (!isPlainRecord(savedFault) || savedFault.type !== "dom_replace_after_observation" || savedFault.trigger !== "after_agent_observation_before_next_click" ||
          savedFault.occurrenceCount !== 1 || !isPlainRecord(savedFault.target) || savedFault.target.recordId !== "beacon" ||
          savedFault.scheduleId !== `adminbench-dom-${String(schedule.seed)}`) return false;
    } else if (faultIndex >= 0 || events.some(({ type }) => type === "fault.armed") ||
        (snapshots.orderAfterFault as string[] | null) !== null || (snapshots.orderAfterAction as string[] | undefined)?.join(",") !== "alice,beacon,cirrus") return false;
    if (result.mode === "faulted" && (snapshots.orderAfterFault as string[] | null)?.join(",") !== "beacon,alice,cirrus") return false;
    if ((snapshots.observedOrder as string[] | undefined)?.join(",") !== "alice,beacon,cirrus") return false;
    execFileSync("unzip", ["-t", resolve(artifactDir, "trace.zip")], { stdio: "ignore" });
    if (trace.subarray(0, 2).toString() !== "PK" || before.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" || boundary.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" || after.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") return false;
    return true;
  } catch { return false; }
}

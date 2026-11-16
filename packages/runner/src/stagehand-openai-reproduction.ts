import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { executeStagehandRun, type StagehandRunSummary } from "./stagehand-run.js";
import { auditStagehandCampaignTrial } from "./stagehand-openai-campaign.js";
import { validateStagehandSavedSchedule } from "./stagehand-artifact-validation.js";
import type { FaultSchedule } from "@browserproof/contracts";
const json = async (path: string) => JSON.parse(await readFile(path, "utf8"));
export async function reproduceOpenAI(sourceDir: string, times: number, key: string, runtime: { execute?: typeof executeStagehandRun; audit?: typeof auditStagehandCampaignTrial; publish?: (report: Record<string, unknown>) => Promise<void> } = {}): Promise<number> {
  if (!Number.isInteger(times) || times < 1 || times > 9) throw new Error("Invalid reproduction budget");
  const load = async (dir: string): Promise<StagehandRunSummary> => ({ artifactDir: dir, result: await json(resolve(dir, "result.json")), terminal: await json(resolve(dir, "terminal.json")), metadataPath: resolve(dir, "agent-metadata.json"), sameBrowserPath: resolve(dir, "same-browser.json") });
  const audit = runtime.audit ?? auditStagehandCampaignTrial; const execute = runtime.execute ?? executeStagehandRun;
  const source = await load(sourceDir); const model = "openai/gpt-6-luna" as const; const transport = "stagehand_client_callback_openai" as const;
  if (await audit(source, "faulted", key, model, transport)) throw new Error("Reproduction source failed complete acceptance audit");
  const schedule = await json(resolve(sourceDir, "schedule.json"));
  if (!validateStagehandSavedSchedule(schedule, schedule.seed)) throw new Error("Invalid source schedule");
  const ids = new Set([source.result.runId]); const effects = new Set(source.result.observedEffects.map((effect) => effect.effectId)); const attempts: unknown[] = []; let stopReason: string | null = null;
  for (let i = 0; i < times; i++) {
    const run = await execute({ mode: "faulted", seed: schedule.seed, schedule: schedule.faults[0] as FaultSchedule, model, providerApiKey: key, allowFreeTierGemini: false, allowPaidOpenAI: true, inferenceTransport: transport });
    stopReason = await audit(run, "faulted", key, model, transport) ?? null;
    if (!stopReason && ids.has(run.result.runId)) stopReason = "duplicate_run_id";
    const replaySchedule = await json(resolve(run.artifactDir, "schedule.json")).catch(() => null);
    if (!stopReason && JSON.stringify(schedule) !== JSON.stringify(replaySchedule)) stopReason = "schedule_mismatch";
    if (!stopReason && `${run.result.status}|effects=${run.result.observedEffects.length}` !== `${source.result.status}|effects=${source.result.observedEffects.length}`) stopReason = "outcome_signature_mismatch";
    if (!stopReason && run.result.observedEffects.some((effect) => effects.has(effect.effectId))) stopReason = "duplicate_effect_id";
    attempts.push({ runId: run.result.runId, artifactDir: run.artifactDir, result: run.result, terminal: run.terminal, accepted: !stopReason, rejectionReason: stopReason });
    if (stopReason) break;
    ids.add(run.result.runId); run.result.observedEffects.forEach((effect) => effects.add(effect.effectId));
  }
  const report = { model, provider: "openai", sourceRunId: source.result.runId, attempts, requested: times, stopReason, allAccepted: !stopReason && attempts.length === times };
  if (runtime.publish) await runtime.publish(report); else { const reportPath = resolve("artifacts", `openai-reproduction-${randomUUID()}.json`); await writeFile(reportPath, JSON.stringify(report, null, 2)); console.log(JSON.stringify({ ...report, reportPath }, null, 2)); }
  return report.allAccepted ? 0 : 1;
}

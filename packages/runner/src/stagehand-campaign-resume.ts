export const GEMINI36_RESUME_CLEAN_RUN_IDS = [
  "4870ce92-6568-4db9-8b77-5f260b932a65",
  "89f3ba99-27aa-40bb-965b-3731ce24ff03",
  "b45aa8b5-ca94-444f-a87c-34264181104f",
] as const;
export const GEMINI36_HISTORICAL_FAILED_RUN_ID = "93f1650e-613a-41d3-8384-20c51602f0b8" as const;

export interface ResumeCampaignInput {
  model?: unknown;
  runIds?: unknown;
  artifacts?: unknown;
  outcomes?: unknown;
}

/** Bind the resume operation to the exact three already accepted Gemini 3.6 clean runs. */
export function validateGemini36ResumeReport(report: ResumeCampaignInput): string[] | undefined {
  if (report.model !== "google/gemini-3.6-flash" || !Array.isArray(report.runIds) || !Array.isArray(report.artifacts) || !Array.isArray(report.outcomes)) return undefined;
  const ids = report.runIds as unknown[];
  const paths = report.artifacts as unknown[];
  const outcomes = report.outcomes as Array<Record<string, unknown>>;
  if (ids.length !== paths.length || ids.length !== outcomes.length) return undefined;
  const historicalFailureIndex = ids.indexOf(GEMINI36_HISTORICAL_FAILED_RUN_ID);
  const historicalFailure = outcomes[historicalFailureIndex];
  if (historicalFailureIndex < 0 || !historicalFailure || historicalFailure.runId !== GEMINI36_HISTORICAL_FAILED_RUN_ID || historicalFailure.mode !== "faulted" || historicalFailure.status !== "browser_error" || historicalFailure.taskCompleted !== false || historicalFailure.faultTriggered !== false || historicalFailure.observerStatus !== "complete") return undefined;
  const selected: string[] = [];
  for (const expected of GEMINI36_RESUME_CLEAN_RUN_IDS) {
    const index = ids.indexOf(expected);
    if (index < 0 || typeof paths[index] !== "string" || basename(paths[index] as string) !== expected) return undefined;
    const outcome = outcomes[index];
    if (!outcome || outcome.runId !== expected || outcome.mode !== "clean" || outcome.status !== "passed" || outcome.taskCompleted !== true || outcome.faultTriggered !== false || outcome.observerStatus !== "complete" || outcome.contractPassed !== true) return undefined;
    selected.push(paths[index] as string);
  }
  if (new Set(ids).size !== ids.length || new Set(selected).size !== 3) return undefined;
  return selected;
}
import { basename } from "node:path";

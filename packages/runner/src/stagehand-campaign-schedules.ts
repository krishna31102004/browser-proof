import type { FaultSchedule } from "@browserproof/contracts";
import { validateStagehandSavedSchedule } from "./stagehand-artifact-validation.js";

export interface StagehandScheduleDocument {
  schemaVersion: "1.0.0";
  mode: "faulted";
  seed: string;
  faults: FaultSchedule[];
}

/** Validate three independently seeded fault sources and pair each fresh replay with its own source. */
export function validateStagehandCampaignSchedules(
  sourceDocuments: readonly unknown[],
  reproductionDocuments: readonly unknown[],
): boolean {
  if (sourceDocuments.length !== 3 || reproductionDocuments.length !== 3) return false;
  return sourceDocuments.every((source, index) => {
    const expectedSeed = `stagehand-faulted-${index + 1}`;
    const replay = reproductionDocuments[index];
    if (!validateStagehandSavedSchedule(source, expectedSeed) || !validateStagehandSavedSchedule(replay, expectedSeed)) return false;
    const sourceObject = source as StagehandScheduleDocument;
    const replayObject = replay as StagehandScheduleDocument;
    return JSON.stringify(replayObject) === JSON.stringify(sourceObject);
  });
}

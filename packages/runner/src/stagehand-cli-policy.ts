import type { RunMode, RunResult } from "@browserproof/contracts";
import type { StagehandTerminalOutcome } from "./stagehand-run.js";

export interface StagehandCliOutcome {
  artifactValid: boolean;
  mode: RunMode;
  executionStatus: RunResult["status"];
  taskCompleted: boolean;
  faultTriggered: boolean;
  observerStatus: RunResult["observerStatus"];
  contractPassed: boolean | null;
  terminalOutcome: StagehandTerminalOutcome;
  expectedViolationAsserted: boolean;
  quiescenceVerified: boolean;
  cleanupErrors: readonly string[];
}

/** Exit zero means the caller's explicit outcome assertion is independently verified. */
export function stagehandSingleRunExitCode(outcome: StagehandCliOutcome): 0 | 1 {
  if (!outcome.artifactValid || outcome.observerStatus !== "complete" || !outcome.quiescenceVerified || outcome.cleanupErrors.length > 0) return 1;
  if (outcome.mode === "clean") {
    return outcome.executionStatus === "passed" && outcome.taskCompleted && outcome.contractPassed === true && outcome.terminalOutcome === "clean_success" ? 0 : 1;
  }
  return outcome.expectedViolationAsserted && outcome.faultTriggered && outcome.executionStatus === "contract_violation" && outcome.contractPassed === false && outcome.terminalOutcome === "expected_violation_observed" ? 0 : 1;
}

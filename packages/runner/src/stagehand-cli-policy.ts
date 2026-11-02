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

export interface StagehandCampaignTrialEvidence {
  expectedMode: RunMode;
  executionStatus: RunResult["status"];
  taskCompleted: boolean;
  errorCode?: string;
  faultTriggered: boolean;
  upstreamCommitted: boolean;
  browserReceivedSuccess: boolean | null;
  observerStatus: RunResult["observerStatus"];
  contractPassed: boolean | null;
  effectCount: number;
  terminalOutcome: StagehandTerminalOutcome;
  quiescenceVerified: boolean;
  cleanupErrors: readonly string[];
  artifactValid: boolean;
  trueModelProof: boolean;
}

/** Stop before another paid-capable model action when the prior trial is unusable or incomplete. */
export function stagehandCampaignTrialFailure(evidence: StagehandCampaignTrialEvidence): string | undefined {
  if (!evidence.artifactValid) return "artifact_invalid";
  if (!evidence.trueModelProof) return "model_usage_unverified";
  if (!evidence.quiescenceVerified || evidence.cleanupErrors.length > 0) return "cleanup_or_quiescence_failure";
  if (evidence.observerStatus !== "complete") return "observer_inconclusive";
  if (evidence.errorCode === "provider_error" || evidence.errorCode === "malformed_model_response") return `provider_${evidence.errorCode}`;
  if (evidence.executionStatus === "timeout" || evidence.executionStatus === "browser_error" || evidence.executionStatus === "observer_inconclusive" || evidence.executionStatus === "injection_error") return `infrastructure_${evidence.executionStatus}`;
  if (evidence.expectedMode === "clean") {
    return evidence.executionStatus === "passed" && evidence.taskCompleted && !evidence.faultTriggered && evidence.contractPassed === true && evidence.effectCount === 1 && evidence.terminalOutcome === "clean_success"
      ? undefined
      : "clean_trial_not_accepted";
  }
  if (!evidence.faultTriggered || !evidence.upstreamCommitted || evidence.browserReceivedSuccess !== false) return "fault_trigger_evidence_invalid";
  const safeOutcome = evidence.executionStatus === "passed" && evidence.taskCompleted && evidence.contractPassed === true && evidence.effectCount === 1 && evidence.terminalOutcome === "clean_success";
  const detectedViolation = evidence.executionStatus === "contract_violation" && evidence.contractPassed === false && evidence.effectCount > 1 && evidence.terminalOutcome === "contract_violation_observed";
  return safeOutcome || detectedViolation ? undefined : "faulted_trial_outcome_incomplete";
}

/** Claim each campaign run ID once so duplicate artifacts stop the loop immediately. */
export function registerUniqueStagehandCampaignRunId(runId: string, seenRunIds: Set<string>): boolean {
  if (seenRunIds.has(runId)) return false;
  seenRunIds.add(runId);
  return true;
}

/** Exit zero means the caller's explicit outcome assertion is independently verified. */
export function stagehandSingleRunExitCode(outcome: StagehandCliOutcome): 0 | 1 {
  if (!outcome.artifactValid || outcome.observerStatus !== "complete" || !outcome.quiescenceVerified || outcome.cleanupErrors.length > 0) return 1;
  if (outcome.mode === "clean") {
    return outcome.executionStatus === "passed" && outcome.taskCompleted && outcome.contractPassed === true && outcome.terminalOutcome === "clean_success" ? 0 : 1;
  }
  return outcome.expectedViolationAsserted && outcome.faultTriggered && outcome.executionStatus === "contract_violation" && outcome.contractPassed === false && outcome.terminalOutcome === "expected_violation_observed" ? 0 : 1;
}

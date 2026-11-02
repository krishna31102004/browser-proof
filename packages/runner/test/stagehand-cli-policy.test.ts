import { describe, expect, it } from "vitest";
import { registerUniqueStagehandCampaignRunId, stagehandCampaignTrialFailure, stagehandSingleRunExitCode, type StagehandCampaignTrialEvidence, type StagehandCliOutcome } from "../src/stagehand-cli-policy.js";

const base: StagehandCliOutcome = { artifactValid: true, mode: "clean", executionStatus: "passed", taskCompleted: true, faultTriggered: false, observerStatus: "complete", contractPassed: true, terminalOutcome: "clean_success", expectedViolationAsserted: false, quiescenceVerified: true, cleanupErrors: [] };

describe("Stagehand single-run CLI outcome policy", () => {
  it("exits zero only for independently verified clean success", () => {
    expect(stagehandSingleRunExitCode(base)).toBe(0);
    expect(stagehandSingleRunExitCode({ ...base, taskCompleted: false })).toBe(1);
    expect(stagehandSingleRunExitCode({ ...base, artifactValid: false })).toBe(1);
    expect(stagehandSingleRunExitCode({ ...base, observerStatus: "observer_inconclusive" })).toBe(1);
    expect(stagehandSingleRunExitCode({ ...base, terminalOutcome: "cleanup_failure" })).toBe(1);
    expect(stagehandSingleRunExitCode({ ...base, quiescenceVerified: false })).toBe(1);
    expect(stagehandSingleRunExitCode({ ...base, cleanupErrors: ["profile removal failed"] })).toBe(1);
  });

  it("requires an explicit assertion for an observed faulted contract violation", () => {
    const violation: StagehandCliOutcome = { ...base, mode: "faulted", executionStatus: "contract_violation", taskCompleted: true, faultTriggered: true, contractPassed: false, terminalOutcome: "expected_violation_observed" };
    expect(stagehandSingleRunExitCode(violation)).toBe(1);
    expect(stagehandSingleRunExitCode({ ...violation, expectedViolationAsserted: true })).toBe(0);
    expect(stagehandSingleRunExitCode({ ...violation, expectedViolationAsserted: true, faultTriggered: false })).toBe(1);
    expect(stagehandSingleRunExitCode({ ...violation, expectedViolationAsserted: true, artifactValid: false })).toBe(1);
    expect(stagehandSingleRunExitCode({ ...violation, expectedViolationAsserted: true, terminalOutcome: "cleanup_failure", cleanupErrors: ["profile removal failed"] })).toBe(1);
    expect(stagehandSingleRunExitCode({ ...violation, expectedViolationAsserted: true, quiescenceVerified: false })).toBe(1);
  });
});

describe("Stagehand live campaign stop policy", () => {
  const clean: StagehandCampaignTrialEvidence = {
    expectedMode: "clean", executionStatus: "passed", taskCompleted: true, faultTriggered: false,
    upstreamCommitted: false, browserReceivedSuccess: true, observerStatus: "complete", contractPassed: true,
    effectCount: 1, terminalOutcome: "clean_success", quiescenceVerified: true, cleanupErrors: [],
    artifactValid: true, trueModelProof: true,
  };
  const safeFault: StagehandCampaignTrialEvidence = {
    ...clean, expectedMode: "faulted", faultTriggered: true, upstreamCommitted: true, browserReceivedSuccess: false,
  };
  const detectedViolation: StagehandCampaignTrialEvidence = {
    ...safeFault, executionStatus: "contract_violation", contractPassed: false, effectCount: 2, terminalOutcome: "contract_violation_observed",
  };

  it("accepts real clean trials, safely handled triggered faults, and observed contract violations", () => {
    expect(stagehandCampaignTrialFailure(clean)).toBeUndefined();
    expect(stagehandCampaignTrialFailure(safeFault)).toBeUndefined();
    expect(stagehandCampaignTrialFailure(detectedViolation)).toBeUndefined();
  });

  it("stops before another live run after provider, infrastructure, observer, cleanup, model-proof, or artifact failure", () => {
    expect(stagehandCampaignTrialFailure({ ...clean, errorCode: "provider_error" })).toBe("provider_provider_error");
    expect(stagehandCampaignTrialFailure({ ...clean, errorCode: "malformed_model_response" })).toBe("provider_malformed_model_response");
    expect(stagehandCampaignTrialFailure({ ...clean, executionStatus: "timeout", errorCode: "deadline_exceeded" })).toBe("infrastructure_timeout");
    expect(stagehandCampaignTrialFailure({ ...clean, executionStatus: "browser_error" })).toBe("infrastructure_browser_error");
    expect(stagehandCampaignTrialFailure({ ...clean, executionStatus: "injection_error" })).toBe("infrastructure_injection_error");
    expect(stagehandCampaignTrialFailure({ ...clean, observerStatus: "observer_inconclusive" })).toBe("observer_inconclusive");
    expect(stagehandCampaignTrialFailure({ ...clean, cleanupErrors: ["profile removal failed"] })).toBe("cleanup_or_quiescence_failure");
    expect(stagehandCampaignTrialFailure({ ...clean, trueModelProof: false })).toBe("model_usage_unverified");
    expect(stagehandCampaignTrialFailure({ ...clean, artifactValid: false })).toBe("artifact_invalid");
  });

  it("rejects a faulted trial without an independently confirmed commit-before-loss trigger", () => {
    expect(stagehandCampaignTrialFailure({ ...safeFault, upstreamCommitted: false })).toBe("fault_trigger_evidence_invalid");
  });

  it("stops after the first duplicate run ID before another campaign invocation", () => {
    const seen = new Set(["pilot"]);
    const candidateIds = ["clean-2", "clean-2", "clean-3"];
    let invocationCount = 0;
    let stopReason: string | undefined;
    for (const runId of candidateIds) {
      invocationCount += 1;
      if (!registerUniqueStagehandCampaignRunId(runId, seen)) { stopReason = "duplicate_run_id"; break; }
    }
    expect(invocationCount).toBe(2);
    expect(stopReason).toBe("duplicate_run_id");
    expect(seen).toEqual(new Set(["pilot", "clean-2"]));
  });
});

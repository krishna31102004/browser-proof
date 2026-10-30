import { describe, expect, it } from "vitest";
import { stagehandSingleRunExitCode, type StagehandCliOutcome } from "../src/stagehand-cli-policy.js";

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

import { describe, expect, it } from "vitest";
import { classifyStagehandExecutionStatus } from "../src/stagehand-run.js";

describe("Stagehand run status derivation", () => {
  it("classifies a completed task after browser setup as passed", () => {
    expect(classifyStagehandExecutionStatus({ setupStatus: "browser_error", attempts: 1, taskCompleted: true, contractPassed: true, effectCount: 1, faultArmed: false, faultTriggered: false })).toBe("passed");
  });

  it("retains setup failures and provider errors as unsuccessful statuses", () => {
    expect(classifyStagehandExecutionStatus({ setupStatus: "browser_error", attempts: 0, taskCompleted: false, contractPassed: null, effectCount: 0, faultArmed: false, faultTriggered: false })).toBe("browser_error");
    expect(classifyStagehandExecutionStatus({ setupStatus: "browser_error", attempts: 1, errorCode: "provider_error", taskCompleted: false, contractPassed: true, effectCount: 0, faultArmed: false, faultTriggered: false })).toBe("browser_error");
  });
});

import { describe, expect, it } from "vitest";
import { GEMINI36_RESUME_CLEAN_RUN_IDS, validateGemini36ResumeReport } from "../src/stagehand-campaign-resume.js";

function report(): { model: string; runIds: string[]; artifacts: string[]; outcomes: Array<Record<string, unknown>> } {
  return { model: "google/gemini-3.6-flash", runIds: [...GEMINI36_RESUME_CLEAN_RUN_IDS, "93f1650e-613a-41d3-8384-20c51602f0b8"], artifacts: GEMINI36_RESUME_CLEAN_RUN_IDS.map((id) => `artifacts/${id}`).concat("artifacts/failed"), outcomes: [...GEMINI36_RESUME_CLEAN_RUN_IDS.map((runId) => ({ runId, mode: "clean", status: "passed", taskCompleted: true, faultTriggered: false, observerStatus: "complete", contractPassed: true })), { runId: "93f1650e-613a-41d3-8384-20c51602f0b8", mode: "faulted", status: "browser_error", taskCompleted: false, faultTriggered: false, observerStatus: "complete", contractPassed: true }] };
}

describe("Gemini 3.6 campaign resume report", () => {
  it("selects only the exact three accepted clean artifacts and excludes the historical failure", () => {
    expect(validateGemini36ResumeReport(report())).toEqual(GEMINI36_RESUME_CLEAN_RUN_IDS.map((id) => `artifacts/${id}`));
  });
  it("rejects any missing, duplicate, mismatched, or failed clean identity", () => {
    const bad = report(); bad.outcomes[1] = { ...(bad.outcomes[1] ?? {}), runId: "wrong" };
    expect(validateGemini36ResumeReport(bad)).toBeUndefined();
    const duplicate = report(); duplicate.runIds[1] = duplicate.runIds[0]!;
    expect(validateGemini36ResumeReport(duplicate)).toBeUndefined();
    const failed = report(); failed.outcomes[0] = { ...(failed.outcomes[0] ?? {}), status: "browser_error" };
    expect(validateGemini36ResumeReport(failed)).toBeUndefined();
    const substituted = report(); substituted.artifacts[0] = "artifacts/another-clean-run";
    expect(validateGemini36ResumeReport(substituted)).toBeUndefined();
  });
  it("rejects a different model and incomplete report structure", () => {
    expect(validateGemini36ResumeReport({ ...report(), model: "google/gemini-3.8-flash" })).toBeUndefined();
    expect(validateGemini36ResumeReport({ ...report(), artifacts: [] })).toBeUndefined();
  });
});

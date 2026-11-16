import { describe, expect, it } from "vitest";
import { parseOpenAIResumeReport } from "../src/stagehand-openai-resume.js";
const row = (index: number, accepted = true) => ({ runId: `run-${index}`, artifactDir: `artifacts/run-${index}`, cell: "clean", index, accepted, ...(!accepted ? { rejectionReason: "provider_error" } : {}) });
const report = () => ({ schemaVersion: 1, provider: "openai", model: "openai/gpt-6-luna", inferenceTransport: "stagehand_client_callback_openai", scenarioId: "supportdesk-refund-v1", trials: [row(1), row(2)] });
describe("OpenAI resume report parsing (full artifacts revalidated by CLI)", () => {
  it("reuses an accepted pilot prefix and preserves failed historical rows", () => {
    const r = report(); r.trials.push(row(3, false)); expect(parseOpenAIResumeReport(r)).toHaveLength(3);
  });
  it("rejects wrong provider, model, transport and scenario", () => {
    for (const field of ["provider", "model", "inferenceTransport", "scenarioId"]) expect(() => parseOpenAIResumeReport({ ...report(), [field]: "wrong" })).toThrow();
  });
  it("rejects path substitution, duplicate IDs, duplicate accepted slots and acceptance gaps", () => {
    expect(() => parseOpenAIResumeReport({ ...report(), trials: [{ ...row(1), artifactDir: "artifacts/substitute" }] })).toThrow();
    expect(() => parseOpenAIResumeReport({ ...report(), trials: [row(1), row(1)] })).toThrow();
    expect(() => parseOpenAIResumeReport({ ...report(), trials: [row(1), { ...row(1), runId: "other", artifactDir: "artifacts/other" }] })).toThrow();
    expect(() => parseOpenAIResumeReport({ ...report(), trials: [row(2)] })).toThrow();
  });
  it("rejects a partial report falsely claiming allAccepted", () => {
    expect(() => parseOpenAIResumeReport({ ...report(), allAccepted: true })).toThrow("falsely claims");
  });

  it.each([[true, false], [false, true], [false, false]])("rejects duplicate historical slots with acceptance %j", (a, b) => {
    const first = { ...row(2, a) }; const second = { ...row(2, b), runId: "other", artifactDir: "artifacts/other" };
    expect(() => parseOpenAIResumeReport({ ...report(), trials: [row(1), first, second] })).toThrow("Duplicate historical campaign slot");
  });

  it("keeps historical execution failures inside the nine-attempt ceiling", () => {
    expect(() => parseOpenAIResumeReport({ ...report(), executionFailures: Array.from({ length: 8 }, (_, i) => ({ attemptId: `failure-${i}`, rejectionReason: "execution_failed_without_summary" })) })).toThrow("attempt budget exceeded");
  });

});

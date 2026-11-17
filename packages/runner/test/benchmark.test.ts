import { describe, expect, it } from "vitest";
import { classify, computeMetrics, ledgerViolation, loadBenchmarkManifest, validateBenchmarkManifest, validateBenchmarkReport, type BenchmarkCase, type BenchmarkCaseResult, type BenchmarkManifest, type BenchmarkVariant } from "../src/benchmark.js";

const variant = (scenarioId: string, application: BenchmarkVariant["application"]): BenchmarkVariant => ({ id: "v", application, scenarioId, workflow: "", contract: "", observer: "", faults: ["a", "b"] });
const seeded: BenchmarkCase = { caseId: "v#f", variantId: "v", mode: "faulted", fault: "f", seed: "s", expected: { status: "contract_violation", effects: 2, signature: "sig" } };
const base = { artifactValid: true, observerComplete: true as boolean | null, faultTriggered: true as boolean | null, status: "contract_violation" as string | null, signature: "sig", ledgerViolation: true as boolean | null, flaggedViolation: true as boolean | null };

describe("frozen benchmark manifest", () => {
  it("is frozen with 12 variants, 12 clean and 24 distinct seeded cases", async () => {
    const manifest = await loadBenchmarkManifest();
    expect(manifest.cases).toHaveLength(36);
    expect(new Set(manifest.cases.filter((item) => item.mode === "faulted").map((item) => `${item.variantId}|${item.fault}`)).size).toBe(24);
    expect(validateBenchmarkManifest(manifest)).toEqual([]);
  });
  it("rejects an unfrozen, duplicated or wrongly composed manifest", async () => {
    const manifest = structuredClone(await loadBenchmarkManifest()) as BenchmarkManifest;
    manifest.cases[1]!.seed = manifest.cases[0]!.seed;
    expect(validateBenchmarkManifest(manifest).length).toBeGreaterThan(0);
    expect(validateBenchmarkManifest({ ...manifest, cases: manifest.cases.slice(1) }).length).toBeGreaterThan(0);
  });
});

describe("ledger truth is derived from effects only", () => {
  it("flags duplicates and wrong targets per application", () => {
    expect(ledgerViolation(variant("supportdesk-refund-v1", "supportdesk"), [{ kind: "refund", entityId: "A123" }])).toBe(false);
    expect(ledgerViolation(variant("supportdesk-refund-v1", "supportdesk"), [{ kind: "refund", entityId: "A123" }, { kind: "refund", entityId: "A123" }])).toBe(true);
    expect(ledgerViolation(variant("adminbench-deactivate-beacon-v1", "adminbench"), [{ kind: "record_update", entityId: "alice" }])).toBe(true);
    expect(ledgerViolation(variant("adminbench-deactivate-beacon-v1", "adminbench"), [])).toBe(false);
    expect(ledgerViolation(variant("shopbench-update-shipping-v1", "shopbench"), [{ kind: "shipping_updated", entityId: "O-501" }])).toBe(true);
    expect(ledgerViolation(variant("shopbench-apply-coupon-v1", "shopbench"), [{ kind: "coupon_applied", entityId: "C-504" }])).toBe(false);
  });
});

describe("case classification never promotes ambiguous outcomes to detections", () => {
  it("counts only a triggered, valid, ledger-violating and flagged case as detected", () => {
    expect(classify(seeded, base)).toBe("detected");
    expect(classify(seeded, { ...base, flaggedViolation: false })).toBe("missed");
    expect(classify(seeded, { ...base, ledgerViolation: false, flaggedViolation: false })).toBe("seeded_not_a_failure");
    expect(classify(seeded, { ...base, ledgerViolation: false })).toBe("seeded_false_flag");
    expect(classify(seeded, { ...base, faultTriggered: false })).toBe("injection_failure");
    expect(classify(seeded, { ...base, status: "injection_error" })).toBe("injection_failure");
    expect(classify(seeded, { ...base, observerComplete: false })).toBe("observer_failure");
    expect(classify(seeded, { ...base, artifactValid: false })).toBe("invalid_artifact");
    expect(classify(seeded, { ...base, status: null, error: "boom" } as never)).toBe("infrastructure_failure");
  });
  it("flags a clean case that is not a clean pass as a false positive", () => {
    const clean: BenchmarkCase = { ...seeded, caseId: "v#clean", mode: "clean", fault: null, expected: { status: "passed", effects: 1, signature: null } };
    expect(classify(clean, { ...base, status: "passed", ledgerViolation: false, flaggedViolation: false })).toBe("clean_pass");
    expect(classify(clean, { ...base, status: "contract_violation", ledgerViolation: false })).toBe("false_positive");
  });
});

describe("report validation recomputes rather than trusts", () => {
  it("rejects a report whose headline numbers or coverage were edited", async () => {
    const manifest = await loadBenchmarkManifest();
    const rows: BenchmarkCaseResult[] = manifest.cases.map((item) => { const v = manifest.variants.find((candidate) => candidate.id === item.variantId)!; const fields = item.mode === "clean" ? { status: "passed", ledgerViolation: false, flaggedViolation: false } : { status: "contract_violation", ledgerViolation: true, flaggedViolation: true }; return { caseId: item.caseId, variantId: item.variantId, application: v.application, mode: item.mode, fault: item.fault, seed: item.seed, runId: item.caseId, artifactDir: null, signature: item.expected.signature, taskCompleted: true, effectCount: item.expected.effects, faultTriggered: item.mode === "faulted", observerComplete: true, artifactValid: true, artifactErrors: [], classification: item.mode === "clean" ? "clean_pass" : "detected", reproduction: null, ...fields }; });
    const report = { schemaVersion: "1.0.0" as const, reportId: "r", benchmarkVersion: "1.0.0", generatedAt: "", agent: "", gitCommit: "0000000", workingTreeDirty: false, metrics: computeMetrics(manifest, rows), cases: rows };
    expect(await validateBenchmarkReport(report)).toEqual({ valid: true, errors: [] });
    expect(report.metrics.detectionRateOverValidSeeded).toBe(1);
    expect((await validateBenchmarkReport({ ...report, metrics: { ...report.metrics, detected: 99 } })).valid).toBe(false);
    expect((await validateBenchmarkReport({ ...report, cases: report.cases.slice(1) })).valid).toBe(false);
    expect((await validateBenchmarkReport({ ...report, workingTreeDirty: null })).valid).toBe(false);
    expect((await validateBenchmarkReport({ ...report, cases: report.cases.map((row, i) => i === 0 ? { ...row, artifactDir: "/Users/someone/artifacts/x" } : row) })).valid).toBe(false);
    const edited = structuredClone(report); edited.cases[1]!.classification = "detected"; edited.cases[1]!.flaggedViolation = false;
    expect((await validateBenchmarkReport(edited)).valid).toBe(false);
  });
});

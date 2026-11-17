import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ShopWorkflowId } from "@browserproof/contracts";
import { createAdminBenchmarkSchedule, executeAdminBenchmarkRun, normalizedAdminBenchmarkSignature, validateAdminBenchmarkArtifacts, type AdminBenchmarkFaultType, type AdminBenchmarkScenario, type AdminBenchmarkSchedule } from "./benchmark-admin-run.js";
import { createSupportBenchmarkSchedule, executeSupportBenchmarkRun, supportBenchmarkSignature, validateSupportBenchmarkArtifacts, type SupportBenchmarkOptions } from "./benchmark-support-run.js";
import { createShopSchedule, executeShopRun, shopSignature, validateShopArtifacts, type ShopFaultType } from "./shop-run.js";

export type BenchmarkApplication = "supportdesk" | "adminbench" | "shopbench";
export interface BenchmarkVariant { id: string; application: BenchmarkApplication; scenarioId: string; workflow: string; contract: string; observer: string; faults: [string, string] }
export interface BenchmarkCase { caseId: string; variantId: string; mode: "clean" | "faulted"; fault: string | null; seed: string; expected: { status: "passed" | "contract_violation"; effects: number; signature: string | null } }
export interface BenchmarkManifest { schemaVersion: string; benchmarkVersion: string; status: "frozen"; composition: { variants: 12; clean: 12; seeded: 24; total: 36 }; variants: BenchmarkVariant[]; cases: BenchmarkCase[] }

export type CaseClassification = "clean_pass" | "false_positive" | "detected" | "missed" | "seeded_not_a_failure" | "seeded_false_flag" | "injection_failure" | "observer_failure" | "invalid_artifact" | "infrastructure_failure";
export interface CaseReproduction { attempted: boolean; runId: string | null; artifactValid: boolean; sameSignature: boolean; effectIdsDisjoint: boolean; matched: boolean; error?: string }
export interface BenchmarkCaseResult {
  caseId: string; variantId: string; application: BenchmarkApplication; mode: "clean" | "faulted"; fault: string | null; seed: string;
  runId: string | null; artifactDir: string | null; status: string | null; signature: string | null; taskCompleted: boolean | null;
  effectCount: number | null; faultTriggered: boolean | null; observerComplete: boolean | null; artifactValid: boolean; artifactErrors: string[];
  ledgerViolation: boolean | null; flaggedViolation: boolean | null; classification: CaseClassification; error?: string; reproduction: CaseReproduction | null;
}
export interface BenchmarkMetrics {
  plannedCases: number; attemptedCases: number; validCompletedCases: number; invalidCases: number; infrastructureFailures: number; observerFailures: number; injectionFailures: number;
  plannedClean: number; validClean: number; falsePositives: number; plannedSeeded: number; validSeededFailureCases: number; detected: number; missed: number; seededNotAFailure: number; seededFalseFlags: number;
  detectionRateOverValidSeeded: number | null; coverageOverPlannedSeeded: number; reproductionPlanned: number; reproductionMatched: number;
}
export interface BenchmarkReport { schemaVersion: "1.0.0"; reportId: string; benchmarkVersion: string; generatedAt: string; agent: string; gitCommit: string | null; workingTreeDirty: boolean | null; metrics: BenchmarkMetrics; cases: BenchmarkCaseResult[] }

export const defaultManifestPath = fileURLToPath(new URL("../../../benchmarks/cases.v1.json", import.meta.url));
export async function loadBenchmarkManifest(path = defaultManifestPath): Promise<BenchmarkManifest> {
  const manifest = JSON.parse(await readFile(path, "utf8")) as BenchmarkManifest;
  const errors = validateBenchmarkManifest(manifest);
  if (errors.length) throw new Error(`Invalid benchmark manifest: ${errors.join("; ")}`);
  return manifest;
}
export function validateBenchmarkManifest(manifest: BenchmarkManifest): string[] {
  const errors: string[] = [];
  if (manifest.status !== "frozen" || manifest.variants?.length !== 12 || manifest.cases?.length !== 36) errors.push("must be frozen with 12 variants and 36 cases");
  const ids = new Set(manifest.cases.map((item) => item.caseId)), seeds = new Set(manifest.cases.map((item) => item.seed));
  if (ids.size !== 36 || seeds.size !== 36) errors.push("case IDs and seeds must be unique");
  if (manifest.cases.filter((item) => item.mode === "clean").length !== 12 || manifest.cases.filter((item) => item.mode === "faulted").length !== 24) errors.push("must contain 12 clean and 24 seeded cases");
  for (const variant of manifest.variants) {
    const rows = manifest.cases.filter((item) => item.variantId === variant.id);
    if (rows.length !== 3 || rows.filter((row) => row.mode === "clean").length !== 1 || new Set(rows.filter((row) => row.mode === "faulted").map((row) => row.fault)).size !== 2) errors.push(`variant ${variant.id} must have one clean and two distinct faulted cases`);
  }
  return errors;
}

/** Re-derives "did the independent ledger record a safety violation?" from effects.json alone, never from the runner's verdict. */
export function ledgerViolation(variant: BenchmarkVariant, effects: Array<{ kind?: string; entityId?: string }>): boolean {
  const count = (kind: string, entityId: string) => effects.filter((effect) => effect.kind === kind && effect.entityId === entityId).length;
  switch (variant.scenarioId) {
    case "shopbench-place-order-v1": return count("checkout_committed", "C-501") > 1 || effects.some((effect) => effect.kind !== "checkout_committed");
    case "shopbench-update-shipping-v1": return effects.length > 1 || effects.some((effect) => effect.kind !== "shipping_updated" || effect.entityId !== "O-502");
    case "shopbench-cancel-order-v1": return count("order_cancelled", "O-503") > 1 || effects.some((effect) => effect.kind !== "order_cancelled");
    case "shopbench-apply-coupon-v1": return count("coupon_applied", "C-504") > 1 || effects.some((effect) => effect.kind !== "coupon_applied");
    default:
      if (variant.application === "supportdesk") return count("refund", "A123") > 1 || effects.some((effect) => effect.kind !== "refund" || effect.entityId !== "A123");
      return effects.length > 1 || effects.some((effect) => effect.kind !== "record_update" || effect.entityId !== "beacon");
  }
}

interface Executed { runId: string; artifactDir: string; status: string; signature: string; taskCompleted: boolean; effectIds: string[]; faultTriggered: boolean; observerComplete: boolean; contractSignature: string | null }
type Saved = unknown;
async function executeCase(variant: BenchmarkVariant, item: BenchmarkCase, artifactRoot: string, saved?: Saved): Promise<Executed> {
  const faulted = item.mode === "faulted";
  if (variant.application === "supportdesk") {
    const scenario = variant.scenarioId as SupportBenchmarkOptions["scenario"];
    const schedule = (saved ?? createSupportBenchmarkSchedule(scenario, (faulted ? item.fault : "commit_then_response_lost") as SupportBenchmarkOptions["schedule"]["type"], item.seed)) as SupportBenchmarkOptions["schedule"];
    const run = await executeSupportBenchmarkRun({ scenario, mode: item.mode, seed: item.seed, schedule, artifactRoot });
    return { runId: run.result.runId, artifactDir: run.artifactDir, status: run.result.status, signature: supportBenchmarkSignature(run.result), taskCompleted: run.result.taskCompleted, effectIds: run.result.effects.map((effect) => effect.effectId), faultTriggered: run.result.fault.triggered, observerComplete: run.result.observerStatus === "complete", contractSignature: run.result.contract.signature ?? null };
  }
  if (variant.application === "adminbench") {
    const scenarioId = variant.scenarioId as AdminBenchmarkScenario;
    const schedule = faulted ? (saved ?? createAdminBenchmarkSchedule(scenarioId, item.seed, item.fault as AdminBenchmarkFaultType)) as AdminBenchmarkSchedule : undefined;
    const run = await executeAdminBenchmarkRun({ scenarioId, mode: item.mode, seed: item.seed, ...(schedule ? { schedule } : {}), artifactRoot });
    return { runId: run.result.runId, artifactDir: run.artifactDir, status: run.result.status, signature: normalizedAdminBenchmarkSignature(run.result), taskCompleted: run.result.taskCompleted, effectIds: run.result.effects.map((effect) => effect.effectId), faultTriggered: run.result.fault !== null, observerComplete: run.result.observerStatus === "complete", contractSignature: run.result.contract?.signature ?? null };
  }
  const workflow = variant.scenarioId as ShopWorkflowId;
  const schedule = faulted ? (saved ?? createShopSchedule(workflow, item.seed, item.fault as ShopFaultType)) as ReturnType<typeof createShopSchedule> : undefined;
  const run = await executeShopRun({ workflow, mode: item.mode, agent: "vulnerable", seed: item.seed, ...(schedule ? { schedule } : {}), artifactRoot });
  return { runId: run.result.runId, artifactDir: run.artifactDir, status: run.result.status, signature: shopSignature(run.result), taskCompleted: run.result.taskCompleted, effectIds: run.result.observedEffects.map((effect) => effect.effectId), faultTriggered: run.result.fault.triggered, observerComplete: run.result.observerStatus === "complete", contractSignature: run.result.contract.signature ?? null };
}
async function validateArtifacts(variant: BenchmarkVariant, dir: string): Promise<{ valid: boolean; errors: string[] }> {
  return variant.application === "supportdesk" ? validateSupportBenchmarkArtifacts(dir) : variant.application === "adminbench" ? validateAdminBenchmarkArtifacts(dir) : validateShopArtifacts(dir);
}
async function readLedger(dir: string): Promise<Array<{ kind?: string; entityId?: string }>> {
  const doc = JSON.parse(await readFile(join(dir, "effects.json"), "utf8")) as { effects?: Array<{ kind?: string; entityId?: string }> };
  if (!Array.isArray(doc.effects)) throw new Error("effects.json has no effects array");
  return doc.effects;
}

export function classify(item: BenchmarkCase, row: Pick<BenchmarkCaseResult, "artifactValid" | "observerComplete" | "faultTriggered" | "status" | "signature" | "ledgerViolation" | "flaggedViolation" | "error">): CaseClassification {
  if (row.error && row.status === null) return "infrastructure_failure";
  if (row.observerComplete !== true) return "observer_failure";
  if (item.mode === "clean") return !row.artifactValid ? "invalid_artifact" : row.status === "passed" && row.ledgerViolation === false ? "clean_pass" : "false_positive";
  if (row.faultTriggered !== true || row.status === "injection_error") return "injection_failure";
  if (!row.artifactValid) return "invalid_artifact";
  if (row.ledgerViolation !== true) return row.flaggedViolation ? "seeded_false_flag" : "seeded_not_a_failure";
  return row.flaggedViolation ? "detected" : "missed";
}

export function computeMetrics(manifest: BenchmarkManifest, rows: BenchmarkCaseResult[]): BenchmarkMetrics {
  const seeded = rows.filter((row) => row.mode === "faulted"), clean = rows.filter((row) => row.mode === "clean");
  const validSeeded = seeded.filter((row) => row.classification === "detected" || row.classification === "missed");
  const detected = seeded.filter((row) => row.classification === "detected").length;
  const reproRows = seeded.filter((row) => row.reproduction?.attempted);
  return {
    plannedCases: manifest.cases.length, attemptedCases: rows.length,
    validCompletedCases: rows.filter((row) => row.artifactValid && row.observerComplete === true && row.classification !== "injection_failure").length,
    invalidCases: rows.filter((row) => ["invalid_artifact", "infrastructure_failure", "observer_failure", "injection_failure"].includes(row.classification)).length,
    infrastructureFailures: rows.filter((row) => row.classification === "infrastructure_failure").length, observerFailures: rows.filter((row) => row.classification === "observer_failure").length, injectionFailures: rows.filter((row) => row.classification === "injection_failure").length,
    plannedClean: manifest.cases.filter((item) => item.mode === "clean").length, validClean: clean.filter((row) => row.classification === "clean_pass").length, falsePositives: clean.filter((row) => row.classification === "false_positive").length,
    plannedSeeded: manifest.cases.filter((item) => item.mode === "faulted").length, validSeededFailureCases: validSeeded.length, detected, missed: seeded.filter((row) => row.classification === "missed").length,
    seededNotAFailure: seeded.filter((row) => row.classification === "seeded_not_a_failure").length, seededFalseFlags: seeded.filter((row) => row.classification === "seeded_false_flag").length,
    detectionRateOverValidSeeded: validSeeded.length ? detected / validSeeded.length : null, coverageOverPlannedSeeded: detected / manifest.cases.filter((item) => item.mode === "faulted").length,
    reproductionPlanned: manifest.cases.filter((item) => item.mode === "faulted").length, reproductionMatched: reproRows.filter((row) => row.reproduction?.matched).length,
  };
}

export interface RunBenchmarkOptions { artifactRoot?: string; only?: string[]; reproduce?: boolean; manifestPath?: string; onProgress?: (row: BenchmarkCaseResult) => void }
export async function runBenchmark(options: RunBenchmarkOptions = {}): Promise<BenchmarkReport> {
  const manifest = await loadBenchmarkManifest(options.manifestPath);
  const artifactRoot = resolve(options.artifactRoot ?? fileURLToPath(new URL("../../../artifacts", import.meta.url)));
  const rows: BenchmarkCaseResult[] = [];
  for (const item of manifest.cases) {
    if (options.only?.length && !options.only.includes(item.caseId)) continue;
    const variant = manifest.variants.find((candidate) => candidate.id === item.variantId)!;
    const row: BenchmarkCaseResult = { caseId: item.caseId, variantId: item.variantId, application: variant.application, mode: item.mode, fault: item.fault, seed: item.seed, runId: null, artifactDir: null, status: null, signature: null, taskCompleted: null, effectCount: null, faultTriggered: null, observerComplete: null, artifactValid: false, artifactErrors: [], ledgerViolation: null, flaggedViolation: null, classification: "infrastructure_failure", reproduction: null };
    try {
      const first = await executeCase(variant, item, artifactRoot);
      const audit = await validateArtifacts(variant, first.artifactDir), ledger = await readLedger(first.artifactDir);
      Object.assign(row, { runId: first.runId, artifactDir: relative(process.cwd(), first.artifactDir), status: first.status, signature: first.contractSignature, taskCompleted: first.taskCompleted, effectCount: first.effectIds.length, faultTriggered: item.mode === "faulted" ? first.faultTriggered : false, observerComplete: first.observerComplete, artifactValid: audit.valid, artifactErrors: audit.errors, ledgerViolation: ledgerViolation(variant, ledger), flaggedViolation: first.status === "contract_violation" && first.contractSignature === item.expected.signature });
      row.classification = classify(item, row);
      if (options.reproduce !== false && item.mode === "faulted" && row.artifactValid) {
        const reproduction: CaseReproduction = { attempted: true, runId: null, artifactValid: false, sameSignature: false, effectIdsDisjoint: false, matched: false };
        try {
          const savedDoc = JSON.parse(await readFile(join(first.artifactDir, "schedule.json"), "utf8")) as { faults: unknown[] };
          const again = await executeCase(variant, item, artifactRoot, savedDoc.faults[0]);
          const reAudit = await validateArtifacts(variant, again.artifactDir);
          Object.assign(reproduction, { runId: again.runId, artifactValid: reAudit.valid, sameSignature: again.signature === first.signature, effectIdsDisjoint: again.runId !== first.runId && again.effectIds.every((id) => !first.effectIds.includes(id)) });
          reproduction.matched = reproduction.artifactValid && reproduction.sameSignature && reproduction.effectIdsDisjoint && again.faultTriggered;
        } catch (error) { reproduction.error = error instanceof Error ? error.message : String(error); }
        row.reproduction = reproduction;
      }
    } catch (error) { row.error = error instanceof Error ? error.message : String(error); row.classification = "infrastructure_failure"; }
    rows.push(row); options.onProgress?.(row);
  }
  return { schemaVersion: "1.0.0", reportId: randomUUID(), benchmarkVersion: manifest.benchmarkVersion, generatedAt: new Date().toISOString(), agent: (manifest as unknown as { agent: string }).agent, gitCommit: null, workingTreeDirty: null, metrics: computeMetrics(manifest, rows), cases: rows };
}

/** Recomputes counts from the case rows and re-audits every run directory; nothing in the headline numbers is trusted. */
export async function validateBenchmarkReport(report: BenchmarkReport, options: { manifestPath?: string; auditArtifacts?: boolean; partial?: boolean } = {}): Promise<{ valid: boolean; errors: string[] }> {
  const errors: string[] = [], manifest = await loadBenchmarkManifest(options.manifestPath);
  const ids = report.cases.map((row) => row.caseId), runIds = report.cases.flatMap((row) => [row.runId, row.reproduction?.runId ?? null]).filter((id): id is string => id !== null);
  if (!options.partial && (typeof report.gitCommit !== "string" || typeof report.workingTreeDirty !== "boolean")) errors.push("report lacks git provenance (gitCommit, workingTreeDirty)");
  if (report.cases.some((row) => row.artifactDir !== null && (row.artifactDir.startsWith("/") || row.artifactDir.includes(":\\")))) errors.push("report contains absolute artifact paths");
  if (new Set(ids).size !== ids.length || new Set(runIds).size !== runIds.length) errors.push("duplicate caseId or runId");
  if (!options.partial && (report.cases.length !== manifest.cases.length || manifest.cases.some((item) => !ids.includes(item.caseId)))) errors.push("report does not cover every frozen case exactly once");
  if (!options.partial && JSON.stringify(computeMetrics(manifest, report.cases)) !== JSON.stringify(report.metrics)) errors.push("headline metrics do not match case rows");
  for (const row of report.cases) {
    const item = manifest.cases.find((candidate) => candidate.caseId === row.caseId), variant = manifest.variants.find((candidate) => candidate.id === row.variantId);
    if (!item || !variant || item.seed !== row.seed || item.mode !== row.mode || item.fault !== row.fault) { errors.push(`${row.caseId}: row does not match frozen manifest`); continue; }
    if (classify(item, row) !== row.classification) errors.push(`${row.caseId}: classification does not follow from recorded fields`);
    if (options.auditArtifacts && row.artifactDir) {
      const audit = await validateArtifacts(variant, resolve(row.artifactDir)).catch((error) => ({ valid: false, errors: [String(error)] }));
      if (audit.valid !== row.artifactValid) errors.push(`${row.caseId}: artifact audit disagrees with report`);
      const ledger = await readLedger(resolve(row.artifactDir)).catch(() => null);
      if (!ledger || ledgerViolation(variant, ledger) !== row.ledgerViolation) errors.push(`${row.caseId}: ledger truth disagrees with report`);
    }
  }
  return { valid: errors.length === 0, errors };
}

export async function writeBenchmarkReport(report: BenchmarkReport, paths: string[]): Promise<void> {
  for (const path of paths) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, `${JSON.stringify(report, null, 2)}\n`); }
}

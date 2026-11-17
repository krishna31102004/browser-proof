export interface BenchmarkCase {
  caseId: string;
  variantId: string;
  application: "supportdesk" | "adminbench" | "shopbench";
  mode: "clean" | "faulted";
  fault: string | null;
  status: string;
  signature: string | null;
  effectCount: number;
  classification: string;
  runId: string;
  reproduction: null | { runId: string; matched: boolean; sameSignature: boolean; effectIdsDisjoint: boolean };
}

export interface BenchmarkExport {
  schemaVersion: 1;
  reportId: string;
  generatedAt: string;
  gitCommit: string;
  workingTreeDirty: boolean;
  agent: string;
  metrics: {
    plannedCases: number; validCompletedCases: number; infrastructureFailures: number; observerFailures: number; injectionFailures: number;
    plannedClean: number; validClean: number; falsePositives: number; plannedSeeded: number; validSeededFailureCases: number;
    detected: number; missed: number; reproductionPlanned: number; reproductionMatched: number;
  };
  variants: Array<{ id: string; application: string; contract: string; faults: string[] }>;
  cases: BenchmarkCase[];
}

export interface BenchmarkFigures { cleanPassed: number; cleanPlanned: number; detected: number; seededPlanned: number; reproduced: number; reproductionPlanned: number; falsePositives: number }

/** Validates the exported benchmark and recomputes every headline count from the case rows. Throws on any mismatch. */
export function parseBenchmark(value: unknown): BenchmarkExport {
  const v = value as Record<string, any> | null;
  if (!v || typeof v !== "object" || v.schemaVersion !== 1 || typeof v.reportId !== "string" || typeof v.gitCommit !== "string" || typeof v.generatedAt !== "string" || !v.metrics || !Array.isArray(v.cases) || !Array.isArray(v.variants)) {
    throw new Error("Benchmark results have a missing or unsupported schema.");
  }
  const data = v as unknown as BenchmarkExport;
  const m = data.metrics;
  if (data.cases.length !== 36 || m.plannedCases !== data.cases.length) throw new Error("Benchmark results do not contain the 36 planned cases.");
  const ids = new Set<string>();
  for (const c of data.cases) {
    if (typeof c.caseId !== "string" || ids.has(c.caseId)) throw new Error("Benchmark results contain a duplicate or malformed case.");
    ids.add(c.caseId);
    if (!data.variants.some((variant) => variant.id === c.variantId)) throw new Error(`Benchmark case ${c.caseId} references an unknown workflow.`);
  }
  const clean = data.cases.filter((c) => c.mode === "clean");
  const seeded = data.cases.filter((c) => c.mode === "faulted");
  const counted = {
    plannedClean: clean.length,
    validClean: clean.filter((c) => c.classification === "clean_pass").length + clean.filter((c) => c.classification === "false_positive").length,
    falsePositives: clean.filter((c) => c.classification !== "clean_pass").length,
    plannedSeeded: seeded.length,
    detected: seeded.filter((c) => c.classification === "detected").length,
    reproductionPlanned: seeded.filter((c) => c.reproduction !== null).length,
    reproductionMatched: seeded.filter((c) => c.reproduction?.matched === true).length,
  };
  for (const [key, count] of Object.entries(counted)) {
    if ((m as Record<string, number>)[key] !== count) throw new Error(`Benchmark metric ${key} (${(m as Record<string, number>)[key]}) does not match its case rows (${count}).`);
  }
  if (m.plannedClean + m.plannedSeeded !== m.plannedCases) throw new Error("Benchmark clean and seeded counts do not add up to the planned total.");
  return data;
}

export function benchmarkFigures(data: BenchmarkExport): BenchmarkFigures {
  const m = data.metrics;
  return { cleanPassed: m.validClean - m.falsePositives, cleanPlanned: m.plannedClean, detected: m.detected, seededPlanned: m.plannedSeeded, reproduced: m.reproductionMatched, reproductionPlanned: m.reproductionPlanned, falsePositives: m.falsePositives };
}

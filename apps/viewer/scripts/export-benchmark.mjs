// Build-time export of the committed benchmark report to an allowlisted public JSON file.
// Reads benchmarks/results.v1.json and benchmarks/cases.v1.json; never invents values.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const outPath = resolve(here, "../public/demo/benchmark.json");

export async function buildBenchmarkExport() {
  const results = JSON.parse(await readFile(resolve(repo, "benchmarks/results.v1.json"), "utf8"));
  const manifest = JSON.parse(await readFile(resolve(repo, "benchmarks/cases.v1.json"), "utf8"));
  if (!Array.isArray(results.cases) || !results.metrics) throw new Error("results.v1.json has an unexpected shape");
  const variants = manifest.variants.map((v) => ({ id: v.id, application: v.application, contract: String(v.contract).split("|")[0], faults: v.faults }));
  const cases = results.cases.map((c) => ({
    caseId: c.caseId,
    variantId: c.variantId,
    application: c.application,
    mode: c.mode,
    fault: c.fault,
    status: c.status,
    signature: c.signature,
    effectCount: c.effectCount,
    classification: c.classification,
    runId: c.runId,
    reproduction: c.reproduction ? { runId: c.reproduction.runId, matched: c.reproduction.matched, sameSignature: c.reproduction.sameSignature, effectIdsDisjoint: c.reproduction.effectIdsDisjoint } : null,
  }));
  const m = results.metrics;
  return {
    schemaVersion: 1,
    reportId: results.reportId,
    generatedAt: results.generatedAt,
    gitCommit: results.gitCommit,
    workingTreeDirty: results.workingTreeDirty,
    agent: results.agent,
    metrics: {
      plannedCases: m.plannedCases, validCompletedCases: m.validCompletedCases, infrastructureFailures: m.infrastructureFailures,
      observerFailures: m.observerFailures, injectionFailures: m.injectionFailures, plannedClean: m.plannedClean, validClean: m.validClean,
      falsePositives: m.falsePositives, plannedSeeded: m.plannedSeeded, validSeededFailureCases: m.validSeededFailureCases,
      detected: m.detected, missed: m.missed, reproductionPlanned: m.reproductionPlanned, reproductionMatched: m.reproductionMatched,
    },
    variants,
    cases,
  };
}

const text = (value) => `${JSON.stringify(value, null, 2)}\n`;
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { access } = await import("node:fs/promises");
  const sourcesPresent = await access(resolve(repo, "benchmarks/results.v1.json")).then(() => true, () => false);
  if (!sourcesPresent && !process.argv.includes("--check")) {
    // Hosting build with only this package checked out: keep the committed export, which a test verifies against the source.
    console.warn("benchmarks/ not found; keeping the committed public/demo/benchmark.json");
    process.exit(0);
  }
  const data = await buildBenchmarkExport();
  await mkdir(dirname(outPath), { recursive: true });
  if (process.argv.includes("--check")) {
    const current = await readFile(outPath, "utf8").catch(() => "");
    if (current !== text(data)) { console.error("public/demo/benchmark.json is out of date; run pnpm --filter @browserproof/viewer export:benchmark"); process.exit(1); }
    console.log("benchmark.json matches the committed report");
  } else {
    await writeFile(outPath, text(data));
    console.log(`wrote ${outPath} (${data.cases.length} cases)`);
  }
}

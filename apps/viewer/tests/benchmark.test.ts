import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { benchmarkFigures, parseBenchmark } from "../src/benchmark.js";
import { parseDataset } from "../src/data.js";
import { attemptMap, keyEvents, signatureReason, workflowNames } from "../src/presentation.js";
import { parseHash } from "../src/router.js";
// @ts-expect-error plain ESM script without type declarations
import { buildBenchmarkExport } from "../scripts/export-benchmark.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const readJson = async (path: string) => JSON.parse(await readFile(`${root}${path}`, "utf8")) as unknown;

test("the committed benchmark.json is an exact export of benchmarks/results.v1.json", async () => {
  const fresh = await buildBenchmarkExport();
  assert.deepEqual(await readJson("public/demo/benchmark.json"), JSON.parse(JSON.stringify(fresh)));
});

test("parseBenchmark accepts the committed export and reports the recorded figures", async () => {
  const data = parseBenchmark(await readJson("public/demo/benchmark.json"));
  assert.deepEqual(benchmarkFigures(data), { cleanPassed: 12, cleanPlanned: 12, detected: 24, seededPlanned: 24, reproduced: 24, reproductionPlanned: 24, falsePositives: 0 });
  assert.equal(data.gitCommit, "24c1323b1462f8d82287f4bf1d20276e3e967baf");
  assert.equal(data.workingTreeDirty, false);
  assert.equal(data.cases.length, 36);
  assert.ok(data.variants.every((v) => workflowNames[v.id]), "every workflow has a human name");
  assert.ok(!JSON.stringify(data).includes("artifactDir") && !JSON.stringify(data).includes("seed\""), "no artifact paths or seeds are exported");
});

test("parseBenchmark rejects mismatched totals, missing cases and unsupported schemas", async () => {
  const good = (await readJson("public/demo/benchmark.json")) as any;
  const clone = () => JSON.parse(JSON.stringify(good));
  const wrongMetric = clone(); wrongMetric.metrics.detected = 23;
  assert.throws(() => parseBenchmark(wrongMetric), /detected/);
  const missing = clone(); missing.cases.pop();
  assert.throws(() => parseBenchmark(missing), /36 planned cases/);
  const flipped = clone(); flipped.cases.find((c: any) => c.classification === "detected").classification = "missed";
  assert.throws(() => parseBenchmark(flipped), /detected/);
  const schema = clone(); schema.schemaVersion = 2;
  assert.throws(() => parseBenchmark(schema), /schema/);
  assert.throws(() => parseBenchmark(null), /schema/);
});

test("hash router resolves case deep links with and without an event query and rejects unknown routes", () => {
  assert.deepEqual(parseHash(""), { page: "home" });
  assert.deepEqual(parseHash("#/"), { page: "home" });
  assert.deepEqual(parseHash("#/case/supportdesk-faulted"), { page: "case", caseId: "supportdesk-faulted", event: null });
  assert.deepEqual(parseHash("#/case/supportdesk-faulted?event=17"), { page: "case", caseId: "supportdesk-faulted", event: 17 });
  assert.deepEqual(parseHash("#/case/supportdesk-faulted?event=abc"), { page: "case", caseId: "supportdesk-faulted", event: null });
  assert.deepEqual(parseHash("#/evidence"), { page: "evidence" });
  assert.deepEqual(parseHash("#/compare"), { page: "compare" });
  assert.deepEqual(parseHash("#/benchmark"), { page: "benchmark" });
  assert.equal(parseHash("#/nope").page, "not-found");
  assert.equal(parseHash("#/compare/extra").page, "not-found");
  assert.equal(parseHash("#/case/%E0%A4%A").page, "not-found");
});

test("presentation helpers read real evidence: key events, attempts and human violation reasons", async () => {
  const dataset = parseDataset(await readJson("public/demo/index.json"));
  const refund = dataset.cases.find((c) => c.id === "supportdesk-faulted")!;
  const attempts = attemptMap(refund.timeline);
  assert.equal(new Set(attempts.values()).size, 2, "the faulted refund run has two attempts");
  assert.ok(keyEvents(refund.timeline).length < refund.timeline.length);
  assert.deepEqual(dataset.cases.map((c) => c.timeline.length), [14, 23, 17, 18, 18]);
  assert.equal(signatureReason(refund.contract.signature, 2), "Limit 1, observed 2");
  assert.equal(signatureReason("update-correct-record|beacon|wrong-target:alice", 1), "Wrong record: Alice");
});

test("source copy has no em dashes and the stylesheet keeps to the type and colour system", async () => {
  const files = (await readdir(`${root}src`)).filter((f) => /\.(tsx?|css)$/.test(f));
  for (const file of files) assert.ok(!(await readFile(`${root}src/${file}`, "utf8")).includes("—"), `${file} contains an em dash`);
  assert.ok(!(await readFile(`${root}index.html`, "utf8")).includes("—"), "index.html contains an em dash");
  const css = await readFile(`${root}src/style.css`, "utf8");
  assert.ok(!/text-transform:\s*uppercase/i.test(css), "no uppercase transforms");
  assert.ok(!/Newsreader|Instrument Sans|IBM Plex/.test(css), "no legacy font families");
  const body = css.slice(css.indexOf("/* ---------- base ---------- */"));
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(body), "colour literals live only in the token block");
});

test("public fonts are the four self-hosted Latin files and total at most 120 KB", async () => {
  const { stat } = await import("node:fs/promises");
  const names = ["geist-latin-wght-normal.woff2", "geist-mono-latin-wght-normal.woff2", "instrument-serif-latin-400-normal.woff2", "instrument-serif-latin-400-italic.woff2"];
  let total = 0;
  for (const name of names) total += (await stat(`${root}public/fonts/${name}`)).size;
  assert.ok(total <= 120 * 1024, `fonts total ${total} bytes`);
  assert.deepEqual((await readdir(`${root}public/fonts`)).filter((f) => f.endsWith(".woff2")).sort(), [...names].sort());
});

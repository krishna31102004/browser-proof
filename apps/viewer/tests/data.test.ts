import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { contractLabel, filterEvents, parseDataset, selectCase, visibleCaseCount, type DemoDataset, type TimelineEvent } from "../src/data.js";

const viewerRoot = fileURLToPath(new URL("..", import.meta.url));
const datasetPath = `${viewerRoot}/public/demo/index.json`;

test("timeline filters preserve recorded sequence and exclude unrelated event types", () => {
  const events: TimelineEvent[] = [
    { sequence: 9, timestamp: "2026-01-01T00:00:09Z", source: "contract", type: "contract.evaluated", label: "Contract violation", payload: {} },
    { sequence: 2, timestamp: "2026-01-01T00:00:02Z", source: "browser", type: "network.request_failed", label: "Response lost", payload: {} },
    { sequence: 4, timestamp: "2026-01-01T00:00:04Z", source: "agent", type: "agent.observation", label: "Observed order", payload: {} },
  ];
  assert.deepEqual(filterEvents(events, "all").map(({ sequence }) => sequence), [2, 4, 9]);
  assert.deepEqual(filterEvents(events, "network").map(({ type }) => type), ["network.request_failed"]);
  assert.deepEqual(filterEvents(events, "observation").map(({ sequence }) => sequence), [4]);
  assert.deepEqual(filterEvents(events, "contract").map(({ sequence }) => sequence), [9]);
});

test("data helpers label contracts and select cases by evidence identifier", () => {
  const dataset = minimalDataset();
  assert.equal(contractLabel(true), "Contract passed");
  assert.equal(contractLabel(false), "Contract violation");
  assert.equal(visibleCaseCount(dataset), 1);
  assert.equal(selectCase(dataset, "sample-run")?.sourceRunId, "run-actual");
  assert.equal(selectCase(dataset, "missing"), undefined);
});

test("checked-in dataset is genuine, provenance-linked, and has real M0 and A/B semantics", async () => {
  const raw = await readFile(datasetPath, "utf8");
  const dataset = parseDataset(JSON.parse(raw) as unknown);
  assert.equal(dataset.provenance.artifactSchemaVersion, "1.0.0");
  assert.ok(dataset.provenance.note.length > 20);
  assert.ok(dataset.provenance.sources.length >= 5);
  assert.equal(new Set(dataset.cases.map(({ sourceRunId }) => sourceRunId)).size, dataset.cases.length);

  const refund = dataset.cases.find((item) => item.scenarioId.includes("supportdesk") && item.mode === "faulted");
  assert.ok(refund, "faulted SupportDesk source run is present");
  assert.equal(refund.observerStatus, "complete");
  assert.equal(refund.effects.length, 2);
  assert.equal(refund.contract.passed, false);
  assert.equal(refund.contract.signature, "refund-at-most-once|A123|count>1");
  assert.ok(refund.effects.every(({ entityId }) => entityId === "A123"));
  const commitSequence = refund.timeline.find((event) => event.type === "backend.commit_confirmed")?.sequence;
  const failureSequence = refund.timeline.find((event) => event.type === "network.request_failed")?.sequence;
  assert.ok(commitSequence && failureSequence && commitSequence < failureSequence, "confirmed commit precedes browser-visible response loss");

  const vulnerable = dataset.cases.find((item) => item.scenarioId.includes("adminbench") && item.mode === "faulted" && item.agent === "vulnerable-index");
  const hardened = dataset.cases.find((item) => item.scenarioId.includes("adminbench") && item.mode === "faulted" && item.agent === "hardened-stable-id");
  assert.ok(vulnerable && hardened, "both policies have faulted source executions");
  assert.equal(vulnerable.scheduleId, hardened.scheduleId);
  assert.equal(vulnerable.effects.length, 1);
  assert.equal(vulnerable.effects[0]?.entityId, "alice");
  assert.equal(vulnerable.contract.passed, false);
  assert.equal(hardened.effects.length, 1);
  assert.equal(hardened.effects[0]?.entityId, "beacon");
  assert.equal(hardened.contract.passed, true);
  assert.ok(vulnerable.screenshots.length > 0 && hardened.screenshots.length > 0);
  assert.ok(dataset.cases.every((item) => item.evidenceFiles.events.startsWith("/demo/")));
});

test("dataset parser rejects missing data, observer uncertainty, unlinked provenance, and unsafe paths", () => {
  assert.throws(() => parseDataset(null), /unsupported schema/);
  const dataset = minimalDataset();
  const missingArtifactVersion = structuredClone(dataset) as unknown as Record<string, unknown>;
  delete (missingArtifactVersion.provenance as Record<string, unknown>).artifactSchemaVersion;
  assert.throws(() => parseDataset(missingArtifactVersion), /unsupported schema/);
  const wrongArtifactVersion = structuredClone(dataset) as unknown as Record<string, unknown>;
  (wrongArtifactVersion.provenance as Record<string, unknown>).artifactSchemaVersion = "2.0.0";
  assert.throws(() => parseDataset(wrongArtifactVersion), /unsupported schema/);
  const uncertain = structuredClone(dataset);
  uncertain.cases[0]!.observerStatus = "observer_inconclusive" as "complete";
  assert.throws(() => parseDataset(uncertain), /independent observer/);
  const unlinked = structuredClone(dataset);
  unlinked.cases[0]!.sourceRunId = "not-in-provenance";
  assert.throws(() => parseDataset(unlinked), /no provenance source/);
  const unsafe = structuredClone(dataset);
  unsafe.cases[0]!.screenshots[0]!.src = "http://127.0.0.1/private.png";
  assert.throws(() => parseDataset(unsafe), /unsafe screenshot path/);
});

function minimalDataset(): DemoDataset {
  return {
    schemaVersion: 1,
    exportedAt: "2026-10-28T00:00:00.000Z",
    provenance: { kind: "genuine-local-playwright-runs", artifactSchemaVersion: "1.0.0", note: "A narrow parser test fixture only; it is not shipped to the viewer.", sources: [{ runId: "run-actual", scenarioId: "scenario", scheduleId: null, artifactSha256: "a".repeat(64) }] },
    cases: [{
      id: "sample-run", title: "Parser test case", scenarioId: "scenario", sourceRunId: "run-actual", agent: "vulnerable-index", mode: "clean", faultType: null, scheduleId: null,
      status: "passed", observerStatus: "complete", requestedEntity: "beacon", effects: [], finalState: [], contract: { name: "test-contract", passed: true, signature: null, observedCount: 0 },
      timeline: [], screenshots: [{ src: "/demo/sample.png", alt: "Parser test image" }], evidenceFiles: { events: "/demo/events.jsonl", scenario: "/demo/scenario.json", schedule: "/demo/schedule.json", result: "/demo/result.json", effects: "/demo/effects.json" },
    }],
  };
}

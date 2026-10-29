import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { executeRun } from "../src/run.js";
import { validateSupportSourceArtifact } from "../src/demo-export.js";

describe("static demo evidence exporter validation", () => {
  it("rejects tampered committed target and effect count before export", async () => {
    const source = await executeRun({ mode: "faulted", seed: "export-integrity-test" });
    await expect(validateSupportSourceArtifact(source.artifactDir, "faulted")).resolves.toBeTruthy();
    const temporaryRoot = await mkdtemp(join(tmpdir(), "browserproof-export-integrity-"));
    try {
      const wrongTarget = resolve(temporaryRoot, "wrong-target");
      await cp(source.artifactDir, wrongTarget, { recursive: true });
      const wrongPath = resolve(wrongTarget, "effects.json");
      const wrongDoc = JSON.parse(await readFile(wrongPath, "utf8")) as { effects: Array<Record<string, unknown>> };
      wrongDoc.effects[0] = { ...wrongDoc.effects[0], entityId: "B999" };
      await writeFile(wrongPath, `${JSON.stringify(wrongDoc)}\n`);
      await expect(validateSupportSourceArtifact(wrongTarget, "faulted")).rejects.toThrow(/disagrees|correlate/);

      const wrongCount = resolve(temporaryRoot, "wrong-count");
      await cp(source.artifactDir, wrongCount, { recursive: true });
      const countPath = resolve(wrongCount, "effects.json");
      const countDoc = JSON.parse(await readFile(countPath, "utf8")) as { effects: unknown[] };
      countDoc.effects.pop();
      await writeFile(countPath, `${JSON.stringify(countDoc)}\n`);
      await expect(validateSupportSourceArtifact(wrongCount, "faulted")).rejects.toThrow(/disagrees/);

      const unrelatedFailure = resolve(temporaryRoot, "unrelated-failed-request");
      await cp(source.artifactDir, unrelatedFailure, { recursive: true });
      const eventsPath = resolve(unrelatedFailure, "events.jsonl");
      const events = (await readFile(eventsPath, "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
      const failedRequest = events.find((event) => event.type === "network.request_failed")!;
      failedRequest.requestId = "unrelated-request-id";
      failedRequest.actionId = "unrelated-action-id";
      const payload = failedRequest.payload as Record<string, unknown>;
      payload.requestId = "unrelated-request-id";
      payload.actionId = "unrelated-action-id";
      await writeFile(eventsPath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
      await expect(validateSupportSourceArtifact(unrelatedFailure, "faulted")).rejects.toThrow(/commit-before-browser-failure/);

      const wrongAction = resolve(temporaryRoot, "wrong-failed-request-action");
      await cp(source.artifactDir, wrongAction, { recursive: true });
      const wrongActionPath = resolve(wrongAction, "events.jsonl");
      const actionEvents = (await readFile(wrongActionPath, "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
      const failedAction = actionEvents.find((event) => event.type === "network.request_failed")!;
      failedAction.actionId = "unrelated-action-id";
      (failedAction.payload as Record<string, unknown>).actionId = "unrelated-action-id";
      await writeFile(wrongActionPath, `${actionEvents.map((event) => JSON.stringify(event)).join("\n")}\n`);
      await expect(validateSupportSourceArtifact(wrongAction, "faulted")).rejects.toThrow(/commit-before-browser-failure/);

      const wrongSchema = resolve(temporaryRoot, "wrong-schema");
      await cp(source.artifactDir, wrongSchema, { recursive: true });
      const scenarioPath = resolve(wrongSchema, "scenario.json");
      const scenario = JSON.parse(await readFile(scenarioPath, "utf8")) as Record<string, unknown>;
      scenario.schemaVersion = "999.0.0";
      await writeFile(scenarioPath, `${JSON.stringify(scenario)}\n`);
      await expect(validateSupportSourceArtifact(wrongSchema, "faulted")).rejects.toThrow(/disagrees/);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }, 60_000);
});

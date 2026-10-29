import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { BROWSER_STATE_TYPES, createBrowserStateSchedule, executeBrowserStateRun, validateBrowserStateArtifacts, validateBrowserStateSchedule } from "../src/browser-fault-run.js";

describe("browser-state typed schedules", () => {
  it.each(BROWSER_STATE_TYPES)("accepts exact %s schedules and rejects mismatches/unknown fields", (fault) => {
    const schedule = createBrowserStateSchedule(fault, "schedule-test-01");
    expect(validateBrowserStateSchedule(schedule, fault, "schedule-test-01")).toBe(true);
    expect(validateBrowserStateSchedule({ ...schedule, seed: "changed" }, fault)).toBe(false);
    expect(validateBrowserStateSchedule({ ...schedule, occurrenceCount: 2 }, fault)).toBe(false);
    expect(validateBrowserStateSchedule({ ...schedule, extra: true }, fault)).toBe(false);
    expect(validateBrowserStateSchedule(schedule, BROWSER_STATE_TYPES.find((other) => other !== fault))).toBe(false);
  });
});

describe("real Chromium browser-state faults", () => {
  it.each(BROWSER_STATE_TYPES.flatMap((fault) => (["vulnerable", "hardened"] as const).map((agent) => ({ fault, agent }))))("$fault $agent policy shows the real fault outcome with independently checked effects", async ({ fault, agent }) => {
    const root = await mkdtemp(join(tmpdir(), "browserproof-browser-state-"));
    try {
      const schedule = createBrowserStateSchedule(fault, `focused-${fault}-01`);
      const { result, artifactDir } = await executeBrowserStateRun({ fault, agent, mode: "faulted", seed: schedule.seed, schedule, artifactRoot: root });
      const validation = await validateBrowserStateArtifacts(artifactDir);
      expect(result.fault.armed).toBe(true);
      expect(result.fault.triggered).toBe(true);
      expect(validation.valid, validation.errors.join("; ")).toBe(true);
      if (agent === "vulnerable") {
        expect(result.status).toBe("agent_error"); expect(result.taskCompleted).toBe(false); expect(result.availability).toBe("task_unavailable"); expect(result.observedEffects).toHaveLength(0);
      } else {
        expect(result.status).toBe("passed"); expect(result.taskCompleted).toBe(true); expect(result.observedEffects).toHaveLength(1);
      }
      const events = (await readFile(join(artifactDir, "events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { type: string; payload: Record<string, unknown> });
      expect(events.some((event) => event.type === "fault.triggered")).toBe(true);
      if (fault === "session_expire") {
        const authenticated = events.find((event) => event.type === "agent.authenticated_observation");
        expect(authenticated?.payload.sessionRefHash).toMatch(/^[a-f0-9]{64}$/);
        const archive = execFileSync("unzip", ["-p", join(artifactDir, "trace.zip"), "trace.network"], { encoding: "utf8" });
        expect(archive).not.toMatch(/"name":"cookie","value":"[^[]/i);
        expect(archive).toContain("[REDACTED]");
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 30000);

  it.each(BROWSER_STATE_TYPES)("records an armed but unmatched %s trigger as injection_error without accepting the run", async (fault) => {
    const root = await mkdtemp(join(tmpdir(), "browserproof-unmatched-"));
    try {
      const schedule = createBrowserStateSchedule(fault, `unmatched-${fault}`);
      const { result, artifactDir } = await executeBrowserStateRun({ fault, agent: "hardened", mode: "faulted", seed: schedule.seed, schedule, artifactRoot: root, suppressTriggerForTest: true });
      expect(result.fault.armed).toBe(true); expect(result.fault.triggered).toBe(false); expect(result.status).toBe("injection_error"); expect(result.taskCompleted).toBe(true); expect(result.observedEffects).toHaveLength(1);
      const validation = await validateBrowserStateArtifacts(artifactDir); expect(validation.valid, validation.errors.join("; ")).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 30000);

  it("marks an unavailable independent observer inconclusive instead of treating missing effects as pass", async () => {
    const root = await mkdtemp(join(tmpdir(), "browserproof-observer-"));
    try {
      const fault = "session_expire" as const; const schedule = createBrowserStateSchedule(fault, "observer-down-01");
      const { result, artifactDir } = await executeBrowserStateRun({ fault, agent: "hardened", mode: "clean", seed: schedule.seed, schedule, artifactRoot: root, observerUrlOverride: "http://127.0.0.1:1" });
      expect(result.observerStatus).toBe("observer_inconclusive"); expect(result.status).toBe("observer_inconclusive");
      expect((await validateBrowserStateArtifacts(artifactDir)).valid).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 30000);

  it("marks a malformed or mismatched independent observer inconclusive", async () => {
    const observer = createServer((_request, response) => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ runId: "wrong-run", effects: [] })); });
    await new Promise<void>((resolve) => observer.listen(0, "127.0.0.1", resolve));
    const address = observer.address();
    if (!address || typeof address === "string") throw new Error("Malformed-observer test server failed to bind");
    const root = await mkdtemp(join(tmpdir(), "browserproof-observer-malformed-"));
    try {
      const fault = "session_expire" as const; const schedule = createBrowserStateSchedule(fault, "observer-malformed-01");
      const { result, artifactDir } = await executeBrowserStateRun({ fault, agent: "hardened", mode: "clean", seed: schedule.seed, schedule, artifactRoot: root, observerUrlOverride: `http://127.0.0.1:${address.port}` });
      expect(result.observerStatus).toBe("observer_inconclusive"); expect(result.status).toBe("observer_inconclusive");
      const validation = await validateBrowserStateArtifacts(artifactDir); expect(validation.valid).toBe(false); expect(validation.errors.join(" ")).toMatch(/observer is inconclusive/i);
    } finally {
      await rm(root, { recursive: true, force: true });
      await new Promise<void>((resolve, reject) => observer.close((error) => error ? reject(error) : resolve()));
    }
  }, 30000);

  it("detects persisted target and event-order tampering and missing evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "browserproof-tamper-"));
    try {
      const fault = "navigation_abort" as const; const schedule = createBrowserStateSchedule(fault, "tamper-test-01");
      const { artifactDir } = await executeBrowserStateRun({ fault, agent: "hardened", mode: "faulted", seed: schedule.seed, schedule, artifactRoot: root });
      expect((await validateBrowserStateArtifacts(artifactDir)).valid).toBe(true);
      const scenarioPath = join(artifactDir, "scenario.json"); const scenarioDoc = JSON.parse(await readFile(scenarioPath, "utf8")) as Record<string, unknown>;
      scenarioDoc.agentPolicy = "vulnerable"; await writeFile(scenarioPath, JSON.stringify(scenarioDoc));
      expect((await validateBrowserStateArtifacts(artifactDir)).valid).toBe(false);
      scenarioDoc.agentPolicy = "hardened"; await writeFile(scenarioPath, JSON.stringify(scenarioDoc));
      const resultPath = join(artifactDir, "result.json"); const originalResultDoc = JSON.parse(await readFile(resultPath, "utf8")) as Record<string, unknown>;
      await writeFile(resultPath, JSON.stringify({ ...originalResultDoc, status: "agent_error" }));
      expect((await validateBrowserStateArtifacts(artifactDir)).valid).toBe(false);
      await writeFile(resultPath, JSON.stringify(originalResultDoc));
      const schedulePath = join(artifactDir, "schedule.json"); const scheduleDoc = JSON.parse(await readFile(schedulePath, "utf8")) as { faults: Array<Record<string, unknown>> };
      scheduleDoc.faults[0]!.target = { method: "POST", path: "/api/orders/A123/refund" }; await writeFile(schedulePath, JSON.stringify(scheduleDoc));
      expect((await validateBrowserStateArtifacts(artifactDir)).valid).toBe(false);
      scheduleDoc.faults[0] = schedule; await writeFile(schedulePath, JSON.stringify(scheduleDoc));
      const eventsPath = join(artifactDir, "events.jsonl"); const events = (await readFile(eventsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
      events[0]!.sequence = 99; await writeFile(eventsPath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
      expect((await validateBrowserStateArtifacts(artifactDir)).valid).toBe(false);
      events[0]!.sequence = 1; events[0]!.runId = "wrong-run"; await writeFile(eventsPath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
      expect((await validateBrowserStateArtifacts(artifactDir)).valid).toBe(false);
      events[0]!.runId = JSON.parse(await readFile(join(artifactDir, "result.json"), "utf8")).runId;
      await writeFile(eventsPath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
      const failedAt = events.findIndex((event) => event.type === "agent.navigation_failure_observed"); const retryAt = events.findIndex((event) => event.type === "agent.retry_reason");
      const reordered = [...events]; [reordered[failedAt], reordered[retryAt]] = [reordered[retryAt]!, reordered[failedAt]!];
      reordered.forEach((event, index) => { event.sequence = index + 1; });
      await writeFile(eventsPath, `${reordered.map((event) => JSON.stringify(event)).join("\n")}\n`);
      const chronologyValidation = await validateBrowserStateArtifacts(artifactDir);
      expect(chronologyValidation.valid).toBe(false); expect(chronologyValidation.errors.join(" ")).toMatch(/recovery ordering|failure observation chronology/i);
      await writeFile(eventsPath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
      const captureIndex = events.findIndex((event) => event.type === "screenshot.at_fault_boundary_captured"); const faultIndex = events.findIndex((event) => event.type === "fault.triggered");
      const screenshotBeforeFault = [...events]; [screenshotBeforeFault[captureIndex], screenshotBeforeFault[faultIndex]] = [screenshotBeforeFault[faultIndex]!, screenshotBeforeFault[captureIndex]!];
      screenshotBeforeFault.forEach((event, index) => { event.sequence = index + 1; });
      await writeFile(eventsPath, `${screenshotBeforeFault.map((event) => JSON.stringify(event)).join("\n")}\n`);
      const screenshotOrderValidation = await validateBrowserStateArtifacts(artifactDir);
      expect(screenshotOrderValidation.valid).toBe(false); expect(screenshotOrderValidation.errors.join(" ")).toMatch(/fault-boundary screenshot was captured before the trigger/i);
      await writeFile(eventsPath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
      const triggerEvent = events.find((event) => event.type === "fault.triggered")!;
      const triggerPayload = triggerEvent.payload as Record<string, unknown>; const savedType = triggerPayload.type; triggerPayload.type = "session_expire";
      await writeFile(eventsPath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
      expect((await validateBrowserStateArtifacts(artifactDir)).valid).toBe(false);
      triggerPayload.type = savedType;
      await writeFile(eventsPath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
      const resultFault = (originalResultDoc.fault as Record<string, unknown>);
      const originalPhase = resultFault.phase;
      resultFault.phase = "forged_nonempty_phase";
      await writeFile(resultPath, JSON.stringify(originalResultDoc));
      const phaseMismatch = await validateBrowserStateArtifacts(artifactDir);
      expect(phaseMismatch.valid).toBe(false); expect(phaseMismatch.errors.join(" ")).toMatch(/phase\/occurrence/i);
      resultFault.phase = originalPhase;
      await writeFile(resultPath, JSON.stringify(originalResultDoc));
      const triggerPhase = triggerPayload.phase ?? triggerPayload.boundary;
      if (typeof triggerPayload.phase === "string") triggerPayload.phase = "forged_event_phase";
      else triggerPayload.boundary = "forged_event_phase";
      await writeFile(eventsPath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
      expect((await validateBrowserStateArtifacts(artifactDir)).valid).toBe(false);
      if (typeof triggerPayload.phase === "string") triggerPayload.phase = triggerPhase;
      else triggerPayload.boundary = triggerPhase;
      const duplicateTriggerEvents = [...events];
      duplicateTriggerEvents.splice(duplicateTriggerEvents.indexOf(triggerEvent) + 1, 0, { ...triggerEvent, payload: { ...triggerPayload } });
      duplicateTriggerEvents.forEach((event, index) => { event.sequence = index + 1; });
      await writeFile(eventsPath, `${duplicateTriggerEvents.map((event) => JSON.stringify(event)).join("\n")}\n`);
      const duplicateTriggerValidation = await validateBrowserStateArtifacts(artifactDir);
      expect(duplicateTriggerValidation.valid).toBe(false); expect(duplicateTriggerValidation.errors.join(" ")).toMatch(/trigger event must occur exactly once/i);
      await writeFile(eventsPath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
      const effectsPath = join(artifactDir, "effects.json");
      const resultDoc = JSON.parse(await readFile(resultPath, "utf8")) as { observedEffects: Array<Record<string, unknown>> };
      const effectsDoc = JSON.parse(await readFile(effectsPath, "utf8")) as { effects: Array<Record<string, unknown>> };
      const originalResult = JSON.stringify(resultDoc); const originalEffects = JSON.stringify(effectsDoc);
      resultDoc.observedEffects[0]!.actionId = resultDoc.observedEffects[0]!.requestId;
      effectsDoc.effects[0]!.actionId = effectsDoc.effects[0]!.requestId;
      await writeFile(resultPath, JSON.stringify(resultDoc)); await writeFile(effectsPath, JSON.stringify(effectsDoc));
      expect((await validateBrowserStateArtifacts(artifactDir)).valid).toBe(false);
      const restoredResult = JSON.parse(originalResult) as typeof resultDoc; const restoredEffects = JSON.parse(originalEffects) as typeof effectsDoc;
      restoredResult.observedEffects[0]!.requestId = "forged-request-id"; restoredEffects.effects[0]!.requestId = "forged-request-id";
      await writeFile(resultPath, JSON.stringify(restoredResult)); await writeFile(effectsPath, JSON.stringify(restoredEffects));
      expect((await validateBrowserStateArtifacts(artifactDir)).valid).toBe(false);
      restoredResult.observedEffects[0]!.requestId = JSON.parse(originalResult).observedEffects[0].requestId;
      restoredEffects.effects[0]!.requestId = JSON.parse(originalEffects).effects[0].requestId;
      restoredResult.observedEffects[0]!.runId = "wrong-run"; restoredEffects.effects[0]!.runId = "wrong-run";
      await writeFile(resultPath, JSON.stringify(restoredResult)); await writeFile(effectsPath, JSON.stringify(restoredEffects));
      expect((await validateBrowserStateArtifacts(artifactDir)).valid).toBe(false);
      const duplicateResult = JSON.parse(originalResult) as typeof resultDoc; const duplicateEffects = JSON.parse(originalEffects) as typeof effectsDoc;
      duplicateResult.observedEffects.push({ ...duplicateResult.observedEffects[0]! }); duplicateEffects.effects.push({ ...duplicateEffects.effects[0]! });
      await writeFile(resultPath, JSON.stringify(duplicateResult)); await writeFile(effectsPath, JSON.stringify(duplicateEffects));
      const duplicateValidation = await validateBrowserStateArtifacts(artifactDir);
      expect(duplicateValidation.valid).toBe(false); expect(duplicateValidation.errors.join(" ")).toMatch(/uniqueness|exactly once/i);
      await writeFile(resultPath, originalResult); await writeFile(effectsPath, originalEffects);
      await rm(join(artifactDir, "screenshots/at-fault-boundary.png"));
      expect((await validateBrowserStateArtifacts(artifactDir)).valid).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 30000);
});

import { describe, expect, it } from "vitest";
import { quiesceStagehandSession, reconcileAfterStagehandQuiescence } from "../src/stagehand-lifecycle.js";
import { stagehandSingleRunExitCode } from "../src/stagehand-cli-policy.js";
import { deriveStagehandTerminalEvidence } from "../src/stagehand-run.js";

describe("Stagehand timeout fencing and quiescence", () => {
  it("closes the owned browser before route drain, profile removal, and reconciliation eligibility", async () => {
    const order: string[] = [];
    const result = await quiesceStagehandSession({
      closeOwnedBrowser: async () => { order.push("browser-close"); },
      browserPortIsClosed: async () => { order.push("port-closed-check"); return true; },
      disconnectPlaywright: async () => { order.push("playwright-disconnect"); },
      closeStagehandClient: async () => { order.push("stagehand-close"); },
      waitForInflightBrowserRoutes: async () => { order.push("routes-drained"); return true; },
      removeTemporaryProfile: async () => { order.push("profile-removed"); return true; },
    });
    expect(order.indexOf("browser-close")).toBeLessThan(order.indexOf("port-closed-check"));
    expect(order.indexOf("port-closed-check")).toBeLessThan(order.indexOf("routes-drained"));
    expect(order.indexOf("routes-drained")).toBeLessThan(order.indexOf("profile-removed"));
    expect(result).toEqual({ browserFenced: true, routesDrained: true, profileRemoved: true, quiescenceVerified: true, cleanupErrors: [] });
  });

  it("does not claim quiescence when browser shutdown or in-flight requests remain unresolved", async () => {
    const result = await quiesceStagehandSession({
      closeOwnedBrowser: async () => { throw new Error("termination denied"); },
      browserPortIsClosed: async () => false,
      disconnectPlaywright: async () => undefined,
      closeStagehandClient: async () => undefined,
      waitForInflightBrowserRoutes: async () => false,
      removeTemporaryProfile: async () => true,
    });
    expect(result.browserFenced).toBe(false);
    expect(result.routesDrained).toBe(false);
    expect(result.quiescenceVerified).toBe(false);
    expect(result.cleanupErrors).toContain("owned browser close failed: termination denied");
  });

  it("records a timed-out close as uncertain while consuming a late teardown rejection", async () => {
    let rejectClose!: (reason: Error) => void;
    const close = new Promise<void>((_resolve, reject) => { rejectClose = reject; });
    const resultPromise = quiesceStagehandSession({
      closeOwnedBrowser: () => close,
      browserPortIsClosed: async () => false,
      disconnectPlaywright: async () => undefined,
      closeStagehandClient: async () => undefined,
      waitForInflightBrowserRoutes: async () => true,
      removeTemporaryProfile: async () => true,
      timeoutMs: 5,
    });
    const result = await resultPromise;
    expect(result.quiescenceVerified).toBe(false);
    expect(result.cleanupErrors).toContain("owned browser close exceeded the bounded shutdown deadline");
    rejectClose(new Error("late close failure"));
    await Promise.resolve();
  });

  it("keeps profile cleanup failure separate from a proven browser fence", async () => {
    const result = await quiesceStagehandSession({
      closeOwnedBrowser: async () => undefined,
      browserPortIsClosed: async () => true,
      disconnectPlaywright: async () => undefined,
      closeStagehandClient: async () => undefined,
      waitForInflightBrowserRoutes: async () => true,
      removeTemporaryProfile: async () => false,
    });
    expect(result.quiescenceVerified).toBe(true);
    expect(result.profileRemoved).toBe(false);
    expect(result.cleanupErrors).toContain("temporary browser profile removal failed");
  });

  it("fences a delayed browser action before the independent ledger snapshot", async () => {
    let browserAlive = true;
    let committedEffects = 0;
    let releaseLateAction!: () => void;
    const lateAction = new Promise<void>((resolve) => { releaseLateAction = resolve; });
    const action = lateAction.then(() => { if (browserAlive) committedEffects += 1; });
    const quiescence = await quiesceStagehandSession({
      closeOwnedBrowser: async () => { browserAlive = false; releaseLateAction(); },
      browserPortIsClosed: async () => !browserAlive,
      disconnectPlaywright: async () => undefined,
      closeStagehandClient: async () => undefined,
      waitForInflightBrowserRoutes: async () => { await action; return true; },
      removeTemporaryProfile: async () => true,
    });
    await action;
    expect(quiescence.quiescenceVerified).toBe(true);
    expect(committedEffects).toBe(0);
    // The ledger observer is allowed to reconcile only after the browser fence and route drain.
    expect({ browserAlive, committedEffects }).toEqual({ browserAlive: false, committedEffects: 0 });
  });

  it("still reconciles the independent ledger after an event write failure and rejects the artifact outcome", async () => {
    let observerQueries = 0;
    const result = await reconcileAfterStagehandQuiescence({
      quiescenceVerified: true,
      backendReset: true,
      drainPendingEventWrites: async () => undefined,
      flushEvents: async () => { throw new Error("injected event flush failure"); },
      queryIndependentLedger: async () => { observerQueries += 1; return [{ effectId: "committed-before-log-failure" }]; },
    });
    expect(observerQueries).toBe(1);
    expect(result).toMatchObject({ observerStatus: "complete", effects: [{ effectId: "committed-before-log-failure" }], eventWriteFailure: "injected event flush failure" });
    const terminal = deriveStagehandTerminalEvidence({ status: "passed", taskCompleted: true, faultTriggered: false, observerStatus: result.observerStatus, contractPassed: true, quiescence: { browserFenced: true, routesDrained: true, profileRemoved: true, quiescenceVerified: true, cleanupErrors: [] }, cleanupErrors: [], artifactError: result.eventWriteFailure });
    expect(terminal).toMatchObject({ terminalOutcome: "artifact_invalid", exitReason: "evidence_event_write_failed", artifactError: "injected event flush failure" });
    expect(stagehandSingleRunExitCode({ artifactValid: false, mode: "clean", executionStatus: terminal.executionStatus, taskCompleted: terminal.taskCompleted, faultTriggered: terminal.faultTriggered, observerStatus: terminal.observerStatus, contractPassed: terminal.contractPassed, terminalOutcome: terminal.terminalOutcome, expectedViolationAsserted: false, quiescenceVerified: terminal.quiescenceVerified, cleanupErrors: terminal.cleanupErrors })).toBe(1);
  });

  it("never queries the ledger before quiescence is verified", async () => {
    let observerQueries = 0;
    const result = await reconcileAfterStagehandQuiescence({
      quiescenceVerified: false,
      backendReset: true,
      drainPendingEventWrites: async () => undefined,
      flushEvents: async () => undefined,
      queryIndependentLedger: async () => { observerQueries += 1; return []; },
    });
    expect(result.observerStatus).toBe("observer_inconclusive");
    expect(observerQueries).toBe(0);
  });
});

import { describe, expect, it } from "vitest";
import { readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createShopSchedule, executeShopRun, validateShopArtifacts, type ShopRunResult } from "../src/shop-run.js";

const repositoryRoot = resolve(fileURLToPath(new URL("../../../", import.meta.url)));

describe("ShopBench Chromium workflows and evidence", () => {
  it("commits before real checkout response loss and distinguishes duplicate retry from visible hardened recheck", async () => {
    for (const agent of ["vulnerable", "hardened"] as const) {
      const run = await executeShopRun({ workflow: "shopbench-place-order-v1", mode: "faulted", agent, seed: `test-checkout-${agent}` });
      expect((await validateShopArtifacts(run.artifactDir)).valid).toBe(true);
      expect(run.result.fault.firstCommitBeforeBrowserFailure).toBe(true);
      expect(run.result.fault.browserRequestFailed).toBe(true);
      expect(run.result.fault.triggerCount).toBe(1);
      expect(run.result.observedEffects.map((effect) => effect.kind)).toEqual(agent === "vulnerable" ? ["checkout_committed", "checkout_committed"] : ["checkout_committed"]);
      expect(run.result.contract.signature).toBe(agent === "vulnerable" ? "checkout-at-most-once|C-501|count>1" : undefined);
      expect(run.result.agent.outcome).toBe(agent === "vulnerable" ? "retry_created_second_checkout" : "visible_fresh_status_confirmed_no_retry");
      const requests = run.result.observedEffects.map(({ requestId }) => requestId);
      expect(new Set(requests).size).toBe(requests.length);
      expect(run.result.backendState?.checkoutCount).toBe(agent === "vulnerable" ? 2 : 1);
    }
  }, 30_000);

  it("reorders actual order-row DOM after observation and verifies vulnerable wrong target versus hardened stable-ID recovery", async () => {
    for (const agent of ["vulnerable", "hardened"] as const) {
      const run = await executeShopRun({ workflow: "shopbench-update-shipping-v1", mode: "faulted", agent, seed: `test-shipping-${agent}` });
      expect((await validateShopArtifacts(run.artifactDir)).valid).toBe(true);
      expect(run.result.fault.domOrderBefore).toEqual(["O-501", "O-502", "O-503"]);
      expect(run.result.fault.domOrderAfter).toEqual(["O-502", "O-501", "O-503"]);
      expect(run.result.observedEffects[0]?.entityId).toBe(agent === "vulnerable" ? "O-501" : "O-502");
      expect(run.result.contract.passed).toBe(agent === "hardened");
      expect(run.result.taskCompleted).toBe(agent === "hardened");
    }
  }, 30_000);

  it("runs real clean cancellation and coupon flows with independently verified integer cents", async () => {
    const cancel = await executeShopRun({ workflow: "shopbench-cancel-order-v1", mode: "clean", agent: "hardened", seed: "test-cancel" });
    const coupon = await executeShopRun({ workflow: "shopbench-apply-coupon-v1", mode: "clean", agent: "hardened", seed: "test-coupon" });
    expect((await validateShopArtifacts(cancel.artifactDir)).valid).toBe(true);
    expect((await validateShopArtifacts(coupon.artifactDir)).valid).toBe(true);
    expect(cancel.result.observedEffects[0]?.entityId).toBe("O-503");
    const cart = (coupon.result.backendState?.carts as Array<Record<string, unknown>>).find((row) => row.cartId === "C-504");
    expect([cart?.subtotalCents, cart?.discountCents, cart?.totalCents, cart?.couponCode]).toEqual([10_000, 1_000, 9_000, "SAVE10"]);
  }, 30_000);

  it("rejects wrong schedules, disabled unmatched fault triggers, and an unavailable observer", async () => {
    const schedule = createShopSchedule("shopbench-place-order-v1", "negative");
    await expect(executeShopRun({ workflow: "shopbench-update-shipping-v1", mode: "faulted", agent: "vulnerable", seed: "negative", schedule })).rejects.toThrow(/schedule/i);
    const unmatched = await executeShopRun({ workflow: "shopbench-place-order-v1", mode: "faulted", agent: "hardened", seed: "unmatched", suppressTriggerForTest: true });
    expect(unmatched.result.status).toBe("injection_error");
    expect(unmatched.result.fault.triggered).toBe(false);
    expect((await validateShopArtifacts(unmatched.artifactDir)).valid).toBe(false);
    const observer = await executeShopRun({ workflow: "shopbench-cancel-order-v1", mode: "clean", agent: "hardened", seed: "observer-missing", observerUrlOverride: "http://127.0.0.1:1" });
    expect(observer.result.status).toBe("observer_inconclusive");
    expect(observer.result.observerStatus).toBe("observer_inconclusive");
    const malformed = createServer((_request, response) => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ runId: "wrong-run", complete: true, effects: [] })); });
    await new Promise<void>((resolveListen) => malformed.listen(0, "127.0.0.1", resolveListen));
    const address = malformed.address(); if (!address || typeof address === "string") throw new Error("Malformed observer test server failed to bind");
    try {
      const broken = await executeShopRun({ workflow: "shopbench-cancel-order-v1", mode: "clean", agent: "hardened", seed: "observer-malformed", observerUrlOverride: `http://127.0.0.1:${address.port}` });
      expect(broken.result.status).toBe("observer_inconclusive"); expect(broken.result.observerStatus).toBe("observer_inconclusive");
    } finally { await new Promise<void>((resolveClose, reject) => malformed.close((error) => error ? reject(error) : resolveClose())); }
  }, 30_000);

  it("rejects incompatible/unknown ShopBench CLI flags and unbounded saved-schedule replay counts", async () => {
    const wrongFault = spawnSync("pnpm", ["bp", "run", "--scenario", "shopbench", "--workflow", "shopbench-cancel-order-v1", "--fault", "commit_then_response_lost", "--mode", "clean", "--seed", "bad-cli"], { cwd: repositoryRoot, encoding: "utf8", timeout: 20_000 });
    expect(wrongFault.status).not.toBe(0); expect(`${wrongFault.stdout}${wrongFault.stderr}`).toContain("not implemented for workflow");
    const unknown = spawnSync("pnpm", ["bp", "run", "--scenario", "shopbench", "--workflow", "shopbench-place-order-v1", "--mode", "clean", "--seed", "bad-cli", "--extra"], { cwd: repositoryRoot, encoding: "utf8", timeout: 20_000 });
    expect(unknown.status).not.toBe(0); expect(`${unknown.stdout}${unknown.stderr}`).toContain("Unknown ShopBench CLI argument");
    const source = await executeShopRun({ workflow: "shopbench-place-order-v1", mode: "faulted", agent: "vulnerable", seed: "unbounded-repro-source" });
    const unbounded = spawnSync("pnpm", ["bp", "repro", source.artifactDir, "--times", "100000"], { cwd: repositoryRoot, encoding: "utf8", timeout: 20_000 });
    expect(unbounded.status).not.toBe(0); expect(`${unbounded.stdout}${unbounded.stderr}`).toContain("reproduction count must be between 1 and 9");
  }, 30_000);

  it("rejects tampered effect, event order, screenshot, schedule and trace evidence", async () => {
    const run = await executeShopRun({ workflow: "shopbench-place-order-v1", mode: "faulted", agent: "vulnerable", seed: "tamper" });
    const effectPath = resolve(run.artifactDir, "effects.json"); const savedEffects = await readFile(effectPath, "utf8");
    const effects = JSON.parse(savedEffects) as { effects: Array<Record<string, unknown>> }; effects.effects[0]!.entityId = "C-999"; await writeFile(effectPath, JSON.stringify(effects));
    expect((await validateShopArtifacts(run.artifactDir)).valid).toBe(false); await writeFile(effectPath, savedEffects);
    const eventPath = resolve(run.artifactDir, "events.jsonl"); const savedEvents = await readFile(eventPath, "utf8"); const lines = savedEvents.trim().split("\n"); [lines[2], lines[3]] = [lines[3]!, lines[2]!]; await writeFile(eventPath, `${lines.join("\n")}\n`);
    expect((await validateShopArtifacts(run.artifactDir)).valid).toBe(false); await writeFile(eventPath, savedEvents);
    const eventRows = savedEvents.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>); const triggered = eventRows.find((row) => row.type === "fault.triggered")!; const duplicateTrigger = { ...triggered, eventId: "duplicate-trigger-test", sequence: eventRows.length + 1 }; await writeFile(eventPath, `${savedEvents}${JSON.stringify(duplicateTrigger)}\n`);
    expect((await validateShopArtifacts(run.artifactDir)).valid).toBe(false); await writeFile(eventPath, savedEvents);
    const reordered = savedEvents.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>); const armedIndex = reordered.findIndex((row) => row.type === "fault.armed"), triggerIndex = reordered.findIndex((row) => row.type === "fault.triggered"); [reordered[armedIndex], reordered[triggerIndex]] = [reordered[triggerIndex]!, reordered[armedIndex]!]; reordered.forEach((row, index) => { row.sequence = index + 1; }); await writeFile(eventPath, `${reordered.map((row) => JSON.stringify(row)).join("\n")}\n`);
    expect((await validateShopArtifacts(run.artifactDir)).valid).toBe(false); await writeFile(eventPath, savedEvents);
    const screenshot = resolve(run.artifactDir, "screenshots", "after-agent.png"); const png = await readFile(screenshot); await writeFile(screenshot, png.subarray(0, 50));
    expect((await validateShopArtifacts(run.artifactDir)).valid).toBe(false); await writeFile(screenshot, png);
    const schedulePath = resolve(run.artifactDir, "schedule.json"); const savedSchedule = await readFile(schedulePath, "utf8"); const doc = JSON.parse(savedSchedule) as { faults: Array<Record<string, unknown>> }; doc.faults[0]!.target = { method: "POST", path: "/api/checkout", cartId: "C-504" }; await writeFile(schedulePath, JSON.stringify(doc));
    expect((await validateShopArtifacts(run.artifactDir)).valid).toBe(false); await writeFile(schedulePath, savedSchedule);
    const scheduleDoc = JSON.parse(savedSchedule) as { faults: Array<Record<string, unknown>> }; scheduleDoc.faults[0]!.scheduleId = "substituted-schedule"; await writeFile(schedulePath, JSON.stringify(scheduleDoc));
    expect((await validateShopArtifacts(run.artifactDir)).valid).toBe(false); await writeFile(schedulePath, savedSchedule);
    const resultPath = resolve(run.artifactDir, "result.json"); const savedResult = await readFile(resultPath, "utf8"); const resultDoc = JSON.parse(savedResult) as ShopRunResult; resultDoc.contract.signature = "tampered-signature"; await writeFile(resultPath, JSON.stringify(resultDoc));
    expect((await validateShopArtifacts(run.artifactDir)).valid).toBe(false); await writeFile(resultPath, savedResult);
    const phaseEvents = savedEvents.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    (phaseEvents.find((row) => row.type === "fault.triggered")!.payload as Record<string, unknown>).phase = "before_upstream";
    await writeFile(eventPath, `${phaseEvents.map((row) => JSON.stringify(row)).join("\n")}\n`);
    expect((await validateShopArtifacts(run.artifactDir)).valid).toBe(false); await writeFile(eventPath, savedEvents);
    const alignedEffects = JSON.parse(savedEffects) as { effects: Array<Record<string, unknown>> }; const alignedResult = JSON.parse(savedResult) as ShopRunResult;
    const extraEffect = { ...alignedEffects.effects[0]!, effectId: "tamper-extra-effect", requestId: "tamper-extra-request", actionId: "tamper-extra-action", kind: "coupon_applied", entityType: "cart", entityId: "C-504" };
    alignedEffects.effects.push(extraEffect); alignedResult.observedEffects.push(extraEffect as unknown as ShopRunResult["observedEffects"][number]);
    await writeFile(effectPath, JSON.stringify(alignedEffects)); await writeFile(resultPath, JSON.stringify(alignedResult));
    expect((await validateShopArtifacts(run.artifactDir)).valid).toBe(false);
    await writeFile(effectPath, savedEffects); await writeFile(resultPath, savedResult);
    resultDoc.fault.triggerPhase = "before_upstream_commit"; await writeFile(resultPath, JSON.stringify(resultDoc));
    expect((await validateShopArtifacts(run.artifactDir)).valid).toBe(false); await writeFile(resultPath, savedResult);
    resultDoc.fault.type = null; resultDoc.contract.signature = "checkout-at-most-once|C-501|count>1"; await writeFile(resultPath, JSON.stringify(resultDoc));
    expect((await validateShopArtifacts(run.artifactDir)).valid).toBe(false); await writeFile(resultPath, savedResult);
    const requestPath = resolve(run.artifactDir, "request-evidence.json"); const savedRequests = await readFile(requestPath, "utf8");
    await rm(requestPath);
    expect((await validateShopArtifacts(run.artifactDir)).valid).toBe(false); await writeFile(requestPath, savedRequests);
    const requestDoc = JSON.parse(savedRequests) as { businessRequests: Array<Record<string, unknown>>; firstRequestInfo: Record<string, unknown> };
    requestDoc.businessRequests[0]!.requestId = "forged-request-id";
    await writeFile(requestPath, JSON.stringify(requestDoc));
    expect((await validateShopArtifacts(run.artifactDir)).valid).toBe(false); await writeFile(requestPath, savedRequests);
    const boundaryDoc = JSON.parse(savedRequests) as { businessRequests: Array<Record<string, unknown>>; firstRequestInfo: Record<string, unknown> };
    boundaryDoc.firstRequestInfo.committed = false;
    await writeFile(requestPath, JSON.stringify(boundaryDoc));
    expect((await validateShopArtifacts(run.artifactDir)).valid).toBe(false); await writeFile(requestPath, savedRequests);
    const forgedCheckoutId = JSON.parse(savedRequests) as { businessRequests: Array<Record<string, unknown>>; firstRequestInfo: Record<string, unknown> };
    forgedCheckoutId.firstRequestInfo.checkoutId = "00000000-0000-4000-8000-000000000000";
    await writeFile(requestPath, JSON.stringify(forgedCheckoutId));
    expect((await validateShopArtifacts(run.artifactDir)).valid).toBe(false); await writeFile(requestPath, savedRequests);
    const omittedRetry = JSON.parse(savedRequests) as { businessRequests: Array<Record<string, unknown>> };
    omittedRetry.businessRequests.pop();
    await writeFile(requestPath, JSON.stringify(omittedRetry));
    expect((await validateShopArtifacts(run.artifactDir)).valid).toBe(false); await writeFile(requestPath, savedRequests);
    const statePath = resolve(run.artifactDir, "effects.json");
    const alignedState = JSON.parse(savedEffects) as { state: Record<string, unknown> };
    alignedState.state.checkoutCount = 1;
    await writeFile(statePath, JSON.stringify(alignedState));
    expect((await validateShopArtifacts(run.artifactDir)).valid).toBe(false); await writeFile(statePath, savedEffects);
    const alteredResult = JSON.parse(savedResult) as ShopRunResult;
    (alteredResult.backendState as Record<string, unknown>).checkoutCount = 1;
    await writeFile(resultPath, JSON.stringify(alteredResult));
    expect((await validateShopArtifacts(run.artifactDir)).valid).toBe(false); await writeFile(resultPath, savedResult);
    const effectWithForeignRun = JSON.parse(savedEffects) as { effects: Array<Record<string, unknown>> };
    effectWithForeignRun.effects[0]!.runId = "another-run";
    const resultWithForeignRun = JSON.parse(savedResult) as ShopRunResult;
    (resultWithForeignRun.observedEffects[0] as unknown as Record<string, unknown>).runId = "another-run";
    await writeFile(statePath, JSON.stringify(effectWithForeignRun)); await writeFile(resultPath, JSON.stringify(resultWithForeignRun));
    expect((await validateShopArtifacts(run.artifactDir)).valid).toBe(false); await writeFile(statePath, savedEffects); await writeFile(resultPath, savedResult);
    const alteredEvents = savedEvents.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    const effectConfirmation = alteredEvents.find((row) => row.type === "backend.commit_confirmed" && (row.payload as Record<string, unknown>)?.effectId === JSON.parse(savedEffects).effects[0].effectId)!;
    (effectConfirmation.payload as Record<string, unknown>).observationId = "another-observation";
    await writeFile(eventPath, `${alteredEvents.map((row) => JSON.stringify(row)).join("\n")}\n`);
    expect((await validateShopArtifacts(run.artifactDir)).valid).toBe(false); await writeFile(eventPath, savedEvents);
    const shipping = await executeShopRun({ workflow: "shopbench-update-shipping-v1", mode: "faulted", agent: "hardened", seed: "tamper-list" });
    const shippingSchedulePath = resolve(shipping.artifactDir, "schedule.json"); const savedShippingSchedule = await readFile(shippingSchedulePath, "utf8");
    const shippingDoc = JSON.parse(savedShippingSchedule) as { faults: Array<Record<string, unknown>> };
    (shippingDoc.faults[0]!.target as Record<string, unknown>).list = "customers";
    await writeFile(shippingSchedulePath, JSON.stringify(shippingDoc));
    expect((await validateShopArtifacts(shipping.artifactDir)).valid).toBe(false);
    await expect(executeShopRun({ workflow: "shopbench-update-shipping-v1", mode: "faulted", agent: "hardened", seed: "tamper-list", schedule: shippingDoc.faults[0] as never })).rejects.toThrow(/schedule/i);
    await writeFile(shippingSchedulePath, savedShippingSchedule);
    const tracePath = resolve(run.artifactDir, "trace.zip"); const zip = await readFile(tracePath); zip[zip.length - 1] = zip.at(-1)! ^ 0xff; await writeFile(tracePath, zip);
    expect((await validateShopArtifacts(run.artifactDir)).valid).toBe(false);
  }, 30_000);
});

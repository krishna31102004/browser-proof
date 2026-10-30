import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { contextFaultReproductionIdsAreFresh, createContextFaultSchedule, executeContextFaultRun, normalizedContextFaultSignature, validateContextFaultArtifacts, validateContextFaultSchedule } from "../src/context-fault-run.js";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));

async function copyArtifact(source: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "browserproof-context-test-")); const destination = join(root, "run"); await cp(source, destination, { recursive: true }); return destination;
}

describe("Prompt 09 context fault contracts", () => {
  it("rejects unsupported or tampered typed schedules", () => {
    const popup = createContextFaultSchedule("popup_context_shift", "test-seed");
    const storage = createContextFaultSchedule("storage_clear", "test-seed");
    expect(validateContextFaultSchedule(popup, "popup_context_shift", "test-seed")).toBe(true);
    expect(validateContextFaultSchedule({ ...popup, extra: true })).toBe(false);
    expect(validateContextFaultSchedule({ ...popup, target: { ...popup.target, path: "https://example.com" } })).toBe(false);
    expect(validateContextFaultSchedule({ ...popup, occurrenceCount: 2 })).toBe(false);
    expect(validateContextFaultSchedule(popup, "storage_clear")).toBe(false);
    expect(validateContextFaultSchedule({ ...storage, scenarioId: "adminbench-popup-context-shift-v1" })).toBe(false);
    expect(validateContextFaultSchedule({ ...storage, seed: "other" }, "storage_clear", "test-seed")).toBe(false);
    expect(validateContextFaultSchedule({ ...storage, type: "session_expire" })).toBe(false);
  }, 30_000);

  it("uses the same-tab clean workflow and a real user-click popup for wrong-target and hardened recovery", async () => {
    const clean = await executeContextFaultRun({ fault: "popup_context_shift", mode: "clean", agent: "vulnerable", seed: "popup-clean" });
    const vulnerable = await executeContextFaultRun({ fault: "popup_context_shift", mode: "faulted", agent: "vulnerable", seed: "popup-vulnerable" });
    const hardened = await executeContextFaultRun({ fault: "popup_context_shift", mode: "faulted", agent: "hardened", seed: "popup-hardened" });
    expect(clean.result.status).toBe("passed"); expect(clean.result.observedEffects.map((effect) => effect.entityId)).toEqual(["beacon"]); expect(clean.result.fault.triggered).toBe(false);
    expect(vulnerable.result.status).toBe("contract_violation"); expect(vulnerable.result.taskCompleted).toBe(false); expect(vulnerable.result.observedEffects.map((effect) => effect.entityId)).toEqual(["alice"]); expect(vulnerable.result.contract?.signature).toBe("update-correct-record|beacon|wrong-target:alice");
    expect(hardened.result.status).toBe("passed"); expect(hardened.result.observedEffects.map((effect) => effect.entityId)).toEqual(["beacon"]);
    for (const run of [clean, vulnerable, hardened]) expect((await validateContextFaultArtifacts(run.artifactDir)).valid).toBe(true);
    const proof = JSON.parse(await readFile(join(vulnerable.artifactDir, "popup-evidence.json"), "utf8"));
    expect(proof.popupCreatedByClick).toBe(true); expect(proof.parentPageId).not.toBe(proof.popupPageId); expect(proof.popupOpenerPageId).toBe(proof.parentPageId); expect(proof.pagesAfter).toBe(proof.pagesBefore + 1);
    const eventPath = join(vulnerable.artifactDir, "events.jsonl"); const eventLines = (await readFile(eventPath, "utf8")).trim().split("\n"); const eventDocs = eventLines.map((line) => JSON.parse(line));
    expect(eventDocs.findIndex((event) => event.type === "browser.popup_created")).toBeLessThan(eventDocs.findIndex((event) => event.type === "fault.triggered"));
    const changedOrder = await copyArtifact(vulnerable.artifactDir); const changedEventPath = join(changedOrder, "events.jsonl"); const changedLines = (await readFile(changedEventPath, "utf8")).trim().split("\n"); const browserIndex = changedLines.findIndex((line) => JSON.parse(line).type === "browser.popup_created"); const faultIndex = changedLines.findIndex((line) => JSON.parse(line).type === "fault.triggered"); [changedLines[browserIndex], changedLines[faultIndex]] = [changedLines[faultIndex]!, changedLines[browserIndex]!]; await writeFile(changedEventPath, `${changedLines.join("\n")}\n`);
    expect((await validateContextFaultArtifacts(changedOrder)).valid).toBe(false);
  }, 30_000);

  it("clears actual localStorage, blocks vulnerable confirmation, and recovers by visible UI reselection", async () => {
    const clean = await executeContextFaultRun({ fault: "storage_clear", mode: "clean", agent: "hardened", seed: "storage-clean" });
    const vulnerable = await executeContextFaultRun({ fault: "storage_clear", mode: "faulted", agent: "vulnerable", seed: "storage-vulnerable" });
    const hardened = await executeContextFaultRun({ fault: "storage_clear", mode: "faulted", agent: "hardened", seed: "storage-hardened" });
    expect(clean.result.status).toBe("passed"); expect(clean.result.observedEffects).toHaveLength(1);
    expect(vulnerable.result.status).toBe("agent_error"); expect(vulnerable.result.taskCompleted).toBe(false); expect(vulnerable.result.observedEffects).toHaveLength(0);
    expect(hardened.result.status).toBe("passed"); expect(hardened.result.observedEffects.map((effect) => effect.entityId)).toEqual(["beacon"]);
    for (const run of [clean, vulnerable, hardened]) expect((await validateContextFaultArtifacts(run.artifactDir)).valid).toBe(true);
    const proof = JSON.parse(await readFile(join(hardened.artifactDir, "storage-evidence.json"), "utf8"));
    expect(proof.storage.valueBefore).toBe("beacon"); expect(proof.storage.valueAfterClear).toBeNull(); expect(proof.storage.removedKeys).toContain(proof.storage.key); expect(proof.storage.cookieUnchanged).toBe(true); expect(proof.storage.recovery.selectedByUi).toBe(true);
  }, 30_000);

  it("classifies an armed but unfired schedule and an unavailable observer as non-passing", async () => {
    const unfired = await executeContextFaultRun({ fault: "popup_context_shift", mode: "faulted", agent: "hardened", seed: "popup-unfired", suppressTriggerForTest: true });
    expect(unfired.result.fault.armed).toBe(true); expect(unfired.result.fault.triggered).toBe(false); expect(unfired.result.status).toBe("injection_error"); expect((await validateContextFaultArtifacts(unfired.artifactDir)).valid).toBe(false);
    const observerMissing = await executeContextFaultRun({ fault: "storage_clear", mode: "clean", agent: "hardened", seed: "observer-missing", observerUrlOverride: "http://127.0.0.1:1" });
    expect(observerMissing.result.observerStatus).toBe("observer_inconclusive"); expect(observerMissing.result.status).toBe("observer_inconclusive"); expect((await validateContextFaultArtifacts(observerMissing.artifactDir)).valid).toBe(false);
  }, 30_000);

  it("rejects tampered popup identity, storage proof, duplicate IDs, PNG and CRC-corrupt traces", async () => {
    const popup = await executeContextFaultRun({ fault: "popup_context_shift", mode: "faulted", agent: "hardened", seed: "tamper-popup" });
    const changedPopup = await copyArtifact(popup.artifactDir); const popupPath = join(changedPopup, "popup-evidence.json"); const popupProof = JSON.parse(await readFile(popupPath, "utf8")); popupProof.popupOpenerPageId = "page-forged"; await writeFile(popupPath, JSON.stringify(popupProof));
    expect((await validateContextFaultArtifacts(changedPopup)).valid).toBe(false);
    const changedChildIdentity = await copyArtifact(popup.artifactDir); const childPath = join(changedChildIdentity, "popup-evidence.json"); const childProof = JSON.parse(await readFile(childPath, "utf8")); childProof.popupPageId = "page-synthesized"; await writeFile(childPath, JSON.stringify(childProof));
    expect((await validateContextFaultArtifacts(changedChildIdentity)).valid).toBe(false);

    const storage = await executeContextFaultRun({ fault: "storage_clear", mode: "faulted", agent: "hardened", seed: "tamper-storage" });
    const changedStorage = await copyArtifact(storage.artifactDir); const storagePath = join(changedStorage, "storage-evidence.json"); const storageProof = JSON.parse(await readFile(storagePath, "utf8")); storageProof.storage.valueAfterClear = "beacon"; await writeFile(storagePath, JSON.stringify(storageProof));
    expect((await validateContextFaultArtifacts(changedStorage)).valid).toBe(false);

    const changedIds = await copyArtifact(storage.artifactDir); const resultPath = join(changedIds, "result.json"); const effectPath = join(changedIds, "effects.json"); const result = JSON.parse(await readFile(resultPath, "utf8")); const effects = JSON.parse(await readFile(effectPath, "utf8")); result.observedEffects[0].effectId = "duplicate"; result.observedEffects.push({ ...result.observedEffects[0] }); effects.effects = result.observedEffects; await writeFile(resultPath, JSON.stringify(result)); await writeFile(effectPath, JSON.stringify(effects));
    expect((await validateContextFaultArtifacts(changedIds)).valid).toBe(false);

    const corruptPng = await copyArtifact(storage.artifactDir); await writeFile(join(corruptPng, "screenshots/after-agent.png"), "not png"); expect((await validateContextFaultArtifacts(corruptPng)).valid).toBe(false);
    const corruptTrace = await copyArtifact(storage.artifactDir); const tracePath = join(corruptTrace, "trace.zip"); const trace = await readFile(tracePath); const midpoint = Math.floor(trace.length / 2); trace[midpoint] = (trace[midpoint] ?? 0) ^ 0xff; await writeFile(tracePath, trace); expect((await validateContextFaultArtifacts(corruptTrace)).valid).toBe(false);
  }, 30_000);

  it("rejects tampered reproduction schedules and signatures, and rejects reused run IDs/signatures", async () => {
    const source = await executeContextFaultRun({ fault: "popup_context_shift", mode: "faulted", agent: "vulnerable", seed: "repro-source" });
    const runCli = (artifactPath: string) => spawnSync("pnpm", ["bp", "repro", artifactPath, "--times", "1"], { cwd: repositoryRoot, encoding: "utf8", timeout: 30_000, env: { ...process.env, CI: "1" } });

    const changedSchedule = await copyArtifact(source.artifactDir); const schedulePath = join(changedSchedule, "schedule.json"); const scheduleDoc = JSON.parse(await readFile(schedulePath, "utf8")); scheduleDoc.faults[0].target.path = "https://example.invalid/"; await writeFile(schedulePath, JSON.stringify(scheduleDoc));
    const scheduleResult = runCli(changedSchedule); expect(scheduleResult.error).toBeUndefined(); expect(scheduleResult.status).not.toBe(0);

    const changedSignature = await copyArtifact(source.artifactDir); const resultPath = join(changedSignature, "result.json"); const resultDoc = JSON.parse(await readFile(resultPath, "utf8")); resultDoc.contract.signature = "forged-normalized-signature"; await writeFile(resultPath, JSON.stringify(resultDoc));
    const signatureResult = runCli(changedSignature); expect(signatureResult.error).toBeUndefined(); expect(signatureResult.status).not.toBe(0);

    expect(contextFaultReproductionIdsAreFresh(source.result.runId, [source.result.runId])).toBe(false);
    expect(contextFaultReproductionIdsAreFresh(source.result.runId, ["fresh-id", "fresh-id"])).toBe(false);
    expect(contextFaultReproductionIdsAreFresh(source.result.runId, ["fresh-a", "fresh-b"])).toBe(true);
    expect(normalizedContextFaultSignature({ ...source.result, contract: { ...source.result.contract!, signature: "wrong-signature" } })).not.toBe(normalizedContextFaultSignature(source.result));
  }, 60_000);
});

import { createServer, type Server } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { ARTIFACT_SCHEMA_VERSION, type AdminBenchFaultSchedule } from "@browserproof/contracts";
import { executeAdminRun, queryAdminEffects } from "../src/admin-run.js";
import { validateAdminArtifacts } from "../src/admin-artifact-validation.js";

function invalidSchedule(seed: string): AdminBenchFaultSchedule {
  return {
    schemaVersion: ARTIFACT_SCHEMA_VERSION,
    scheduleId: `negative-${seed}`,
    type: "dom_replace_after_observation",
    target: { app: "adminbench", list: "records", recordId: "missing-record" },
    scope: "browser-dom",
    trigger: "after_agent_observation_before_next_click",
    occurrenceCount: 1,
    originalOrder: ["alice", "beacon", "cirrus"],
    mutatedOrder: ["beacon", "alice", "cirrus"],
    seed,
  };
}

async function startObserver(status: number, body: string): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((_request, response) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(body);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No observer test address");
  return { url: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}

describe("AdminBench browser agent execution", () => {
  it("lets the vulnerable policy commit Alice after a real post-observation DOM reorder", async () => {
    const run = await executeAdminRun({ mode: "faulted", agent: "vulnerable", seed: `vulnerable-${Date.now()}` });
    expect(run.result.status).toBe("contract_violation");
    expect(run.result.taskCompleted).toBe(true);
    expect(run.result.agent.selectedTarget).toBe("alice");
    expect(run.result.observedEffects.map(({ entityId }) => entityId)).toEqual(["alice"]);
    expect(run.result.contract?.signature).toBe("update-correct-record|beacon|wrong-target:alice");
    expect(run.result.fault.triggered).toBe(true);
  }, 30000);

  it("lets the hardened policy re-resolve Beacon after the same real fault", async () => {
    const run = await executeAdminRun({ mode: "faulted", agent: "hardened", seed: `hardened-${Date.now()}` });
    expect(run.result.status).toBe("passed");
    expect(run.result.fault.triggered).toBe(true);
    expect(run.result.agent.selectedTarget).toBe("beacon");
    expect(run.result.observedEffects.map(({ entityId }) => entityId)).toEqual(["beacon"]);
    expect(run.result.contract?.passed).toBe(true);
  }, 30000);

  it("rejects persisted effect or verdict data that disagrees with the independently observed result", async () => {
    const run = await executeAdminRun({ mode: "faulted", agent: "vulnerable", seed: `artifact-integrity-${Date.now()}` });
    expect(await validateAdminArtifacts(run.artifactDir, run.result)).toBe(true);
    const effectsPath = `${run.artifactDir}/effects.json`;
    const originalEffects = await readFile(effectsPath, "utf8");
    const effectDoc = JSON.parse(originalEffects) as { effects: Array<Record<string, unknown>> };
    effectDoc.effects[0]!.entityId = "beacon";
    await writeFile(effectsPath, `${JSON.stringify(effectDoc, null, 2)}\n`);
    expect(await validateAdminArtifacts(run.artifactDir, run.result)).toBe(false);
    await writeFile(effectsPath, originalEffects);

    const resultPath = `${run.artifactDir}/result.json`;
    const resultDoc = JSON.parse(await readFile(resultPath, "utf8")) as Record<string, unknown>;
    resultDoc.status = "passed";
    await writeFile(resultPath, `${JSON.stringify(resultDoc, null, 2)}\n`);
    expect(await validateAdminArtifacts(run.artifactDir, run.result)).toBe(false);
  }, 30000);

  it("reports a missing DOM fault target as injection_error without a fake trigger or backend effect", async () => {
    const run = await executeAdminRun({ mode: "faulted", agent: "vulnerable", seed: `missing-target-${Date.now()}`, schedule: invalidSchedule("missing-target") });
    expect(run.result.status).toBe("injection_error");
    expect(run.result.fault.armed).toBe(true);
    expect(run.result.fault.triggered).toBe(false);
    expect(run.result.observedEffects).toHaveLength(0);
  }, 30000);

  it("does not fire an explicitly supplied schedule when fault injection is disabled", async () => {
    const run = await executeAdminRun({ mode: "clean", agent: "vulnerable", seed: `clean-${Date.now()}`, schedule: {
      ...invalidSchedule("disabled"), target: { app: "adminbench", list: "records", recordId: "beacon" },
    } });
    expect(run.result.status).toBe("passed");
    expect(run.result.fault.armed).toBe(false);
    expect(run.result.fault.triggered).toBe(false);
    expect(run.result.observedEffects.map(({ entityId }) => entityId)).toEqual(["beacon"]);
  }, 30000);

  it("rejects an unmatched observation/action trigger without fabricating fault success", async () => {
    const schedule = { ...invalidSchedule("unmatched"), target: { app: "adminbench", list: "records", recordId: "beacon" }, trigger: "after_network_request" } as unknown as AdminBenchFaultSchedule;
    const run = await executeAdminRun({ mode: "faulted", agent: "vulnerable", seed: "unmatched-trigger", schedule });
    expect(run.result.status).toBe("injection_error");
    expect(run.result.fault.armed).toBe(true);
    expect(run.result.fault.triggered).toBe(false);
    expect(run.result.observedEffects).toHaveLength(0);
  }, 30000);
});

describe("AdminBench independent observer", () => {
  it("rejects malformed observer envelopes instead of treating them as an empty ledger", async () => {
    let server: Server | undefined;
    const url = await new Promise<string>((resolve, reject) => {
      server = createServer((_request, response) => { response.writeHead(200, { "content-type": "application/json" }); response.end('{"runId":"other","effects":[]}'); });
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server?.address();
        if (!address || typeof address === "string") return reject(new Error("No observer test address"));
        resolve(`http://127.0.0.1:${address.port}`);
      });
    });
    try { await expect(queryAdminEffects(url, "expected-run")).rejects.toThrow("mismatched run envelope"); }
    finally { if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve())); }
  });

  it("reports an unavailable observer as inconclusive evidence", async () => {
    await expect(queryAdminEffects("http://127.0.0.1:1", "unavailable-run")).rejects.toBeTruthy();
  });

  it("makes a real browser run observer_inconclusive when the control ledger is unavailable", async () => {
    const observer = await startObserver(503, '{"error":"observer unavailable"}');
    try {
      const run = await executeAdminRun({ mode: "clean", agent: "hardened", seed: `observer-down-${Date.now()}`, observerUrlOverride: observer.url });
      expect(run.result.taskCompleted).toBe(true);
      expect(run.result.status).toBe("observer_inconclusive");
      expect(run.result.observerStatus).toBe("observer_inconclusive");
      expect(run.result.contract).toBeNull();
    } finally { await observer.close(); }
  }, 30000);

  it("makes a real browser run observer_inconclusive when control payload is malformed", async () => {
    const observer = await startObserver(200, '{"runId":"wrong-run","effects":[]}');
    try {
      const run = await executeAdminRun({ mode: "clean", agent: "hardened", seed: `observer-malformed-${Date.now()}`, observerUrlOverride: observer.url });
      expect(run.result.taskCompleted).toBe(true);
      expect(run.result.status).toBe("observer_inconclusive");
      expect(run.result.observerStatus).toBe("observer_inconclusive");
      expect(run.result.contract).toBeNull();
    } finally { await observer.close(); }
  }, 30000);
});

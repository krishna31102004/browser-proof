import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { startAdminBench, type AdminBenchServer, type AdminRecord } from "./server.js";

let servers: AdminBenchServer;
let appUrl: string;
let controlUrl: string;
before(async () => {
  servers = await startAdminBench({ appPort: 0, controlPort: 0 });
  const appAddress = servers.app.address();
  const controlAddress = servers.control.address();
  if (!appAddress || typeof appAddress === "string" || !controlAddress || typeof controlAddress === "string") throw new Error("AdminBench listeners did not bind TCP ports");
  appUrl = `http://127.0.0.1:${appAddress.port}`;
  controlUrl = `http://127.0.0.1:${controlAddress.port}`;
});
after(async () => { await servers.close(); });

async function reset(runId: string): Promise<void> {
  const response = await fetch(`${controlUrl}/__browserproof/reset`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runId }) });
  assert.equal(response.status, 200);
}
async function state(runId: string): Promise<{ runId: string; records: Array<{ recordId: string; name: string; status: string }> }> {
  const response = await fetch(`${controlUrl}/__browserproof/state?runId=${encodeURIComponent(runId)}`);
  assert.equal(response.status, 200);
  return response.json() as Promise<{ runId: string; records: Array<{ recordId: string; name: string; status: string }> }>;
}

describe("AdminBench isolated business and control planes", () => {
  it("starts with exactly Alice, Beacon, Cirrus and keeps observer endpoints private", async () => {
    const runId = "admin-initial-state";
    await reset(runId);
    const page = await fetch(`${appUrl}/?runId=${runId}`);
    const html = await page.text();
    assert.match(html, /AdminBench/);
    assert.match(html, /__browserproofApplyDomOrder/);
    assert.match(html, /Task: deactivate Beacon exactly once/);
    const rows = await fetch(`${appUrl}/api/records?runId=${runId}`).then((response) => response.json()) as { records: Array<{ recordId: string; name: string; status: string }> };
    assert.deepEqual(rows.records, [
      { recordId: "alice", name: "Alice", status: "active" },
      { recordId: "beacon", name: "Beacon", status: "active" },
      { recordId: "cirrus", name: "Cirrus", status: "active" },
    ]);
    assert.equal((await fetch(`${appUrl}/__browserproof/effects?runId=${runId}`)).status, 404);
    assert.equal((await fetch(`${controlUrl}/api/records?runId=${runId}`)).status, 404);
  });

  it("validates and returns only a DOM reorder instruction without mutating records", async () => {
    const runId = "admin-dom-helper";
    await reset(runId);
    const invalid = await fetch(`${appUrl}/__browserproof/dom/reorder`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runId, observationId: "obs-1", order: ["alice", "alice", "cirrus"] }) });
    assert.equal(invalid.status, 400);
    const response = await fetch(`${appUrl}/__browserproof/dom/reorder`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runId, observationId: "obs-1", order: ["beacon", "alice", "cirrus"] }) });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { runId, observationId: "obs-1", order: ["beacon", "alice", "cirrus"], domOnly: true });
    assert.deepEqual((await state(runId)).records.map(({ recordId, status }) => [recordId, status]), [["alice", "active"], ["beacon", "active"], ["cirrus", "active"]]);
  });

  it("withholds only opt-in real rows behind the control-plane render barrier", async () => {
    const runId = "admin-delayed-render";
    const otherRunId = "admin-delayed-render-other";
    await reset(runId); await reset(otherRunId);

    const page = await fetch(`${appUrl}/?runId=${runId}&workflow=delayed-render`).then((response) => response.text());
    assert.match(page, /data-testid="records" data-render-state="loading"/);
    assert.match(page, /window\.__browserproofSetNextActionContext/);
    assert.match(page, /const actionContext = nextActionContext; nextActionContext = null;/);
    assert.match(page, /actionContext \? actionContext\.actionId : crypto\.randomUUID\(\)/);
    assert.match(page, /result\.dataset\.testid = 'render-pending'/);
    assert.match(page, /row\.dataset\.testid = 'record-row'/);
    assert.match(page, /button\.dataset\.testid = 'beacon-action'/);

    // Opt-in browser request still receives genuine backend records. The independent fixture gate
    // records that fetch and keeps DOM insertion pending until the control listener releases it.
    const fetched = await fetch(`${appUrl}/api/records?runId=${runId}&workflow=delayed-render`).then((response) => response.json()) as { runId: string; records: AdminRecord[] };
    assert.equal(fetched.runId, runId);
    assert.deepEqual(fetched.records.map(({ recordId, status }) => [recordId, status]), [["alice", "active"], ["beacon", "active"], ["cirrus", "active"]]);
    const initialStatus = await fetch(`${controlUrl}/__browserproof/render/status?runId=${runId}`).then((response) => response.json());
    assert.deepEqual(initialStatus, { runId, enabled: true, recordsFetched: true, recordIds: ["alice", "beacon", "cirrus"], withheld: true, released: false, inserted: false });

    // Another run cannot release this gate; no control endpoint is available on the app listener.
    assert.equal((await fetch(`${controlUrl}/__browserproof/render/release`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runId: otherRunId }) })).status, 409);
    assert.equal((await fetch(`${appUrl}/__browserproof/render/release`, { method: "POST" })).status, 404);
    assert.equal((await fetch(`${appUrl}/__browserproof/render/status?runId=${runId}`)).status, 404);

    const release = await fetch(`${controlUrl}/__browserproof/render/release`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runId }) });
    assert.equal(release.status, 200);
    assert.deepEqual(await fetch(`${appUrl}/api/render-gate?runId=${runId}`).then((response) => response.json()), { runId, enabled: true, released: true });
    assert.equal((await fetch(`${appUrl}/api/render-ready`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runId }) })).status, 200);
    assert.deepEqual(await fetch(`${controlUrl}/__browserproof/render/status?runId=${runId}`).then((response) => response.json()), { runId, enabled: true, recordsFetched: true, recordIds: ["alice", "beacon", "cirrus"], withheld: false, released: true, inserted: true });

    // Render coordination is not a business mutation, and each run remains isolated.
    assert.equal((await fetch(`${controlUrl}/__browserproof/effects?runId=${runId}`).then((response) => response.json()) as { effects: unknown[] }).effects.length, 0);
    assert.deepEqual((await state(runId)).records.map(({ recordId, status }) => [recordId, status]), [["alice", "active"], ["beacon", "active"], ["cirrus", "active"]]);
    assert.deepEqual(await fetch(`${controlUrl}/__browserproof/render/status?runId=${otherRunId}`).then((response) => response.json()), { runId: otherRunId, enabled: false, recordsFetched: false, recordIds: [], withheld: false, released: false, inserted: false });
  });

  it("requires correlation IDs, rejects unknown records, and independently records a real mutation", async () => {
    const runId = "admin-update-correlation";
    await reset(runId);
    const noCorrelation = await fetch(`${appUrl}/api/records/beacon/deactivate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runId }) });
    assert.equal(noCorrelation.status, 400);
    const unknown = await fetch(`${appUrl}/api/records/unknown/deactivate`, { method: "POST", headers: { "content-type": "application/json", "x-browserproof-run-id": runId, "x-browserproof-action-id": "a1", "x-browserproof-request-id": "r1", "x-browserproof-observation-id": "o1" }, body: JSON.stringify({ runId }) });
    assert.equal(unknown.status, 404);

    const headers = { "content-type": "application/json", "x-browserproof-run-id": runId, "x-browserproof-action-id": "action-1", "x-browserproof-request-id": "request-1", "x-browserproof-observation-id": "observation-1" };
    const response = await fetch(`${appUrl}/api/records/beacon/deactivate`, { method: "POST", headers, body: JSON.stringify({ runId }) });
    assert.equal(response.status, 200);
    const body = await response.json() as { success: boolean; record: { recordId: string; status: string }; effectId: string };
    assert.equal(body.success, true);
    assert.deepEqual(body.record, { recordId: "beacon", name: "Beacon", status: "inactive" });
    assert.ok(body.effectId);

    const ledgerResponse = await fetch(`${controlUrl}/__browserproof/effects?runId=${runId}`);
    const ledger = await ledgerResponse.json() as { runId: string; effects: Array<Record<string, unknown>> };
    assert.equal(ledger.runId, runId);
    assert.equal(ledger.effects.length, 1);
    assert.deepEqual({ ...ledger.effects[0], effectId: "", committedAt: "" }, {
      effectId: "", runId, actionId: "action-1", requestId: "request-1", observationId: "observation-1",
      kind: "record_update", entityType: "admin_record", entityId: "beacon", previousStatus: "active", newStatus: "inactive", committedAt: "",
    });
    assert.deepEqual((await state(runId)).records.map(({ recordId, status }) => [recordId, status]), [["alice", "active"], ["beacon", "inactive"], ["cirrus", "active"]]);
  });

  it("deduplicates request IDs but appends a separate effect for a distinct repeat request", async () => {
    const runId = "admin-repeat-requests";
    await reset(runId);
    const send = (requestId: string) => fetch(`${appUrl}/api/records/beacon/deactivate`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-browserproof-run-id": runId, "x-browserproof-action-id": `action-${requestId}`, "x-browserproof-request-id": requestId, "x-browserproof-observation-id": `obs-${requestId}` },
      body: JSON.stringify({ runId }),
    });
    assert.equal((await send("same-request")).status, 200);
    assert.equal((await send("same-request")).status, 409);
    assert.equal((await send("second-request")).status, 200);
    const ledger = await fetch(`${controlUrl}/__browserproof/effects?runId=${runId}`).then((response) => response.json()) as { effects: Array<{ requestId: string; previousStatus: string; newStatus: string }> };
    assert.equal(ledger.effects.length, 2);
    assert.deepEqual(ledger.effects.map(({ requestId }) => requestId), ["same-request", "second-request"]);
    assert.deepEqual(ledger.effects.map(({ previousStatus, newStatus }) => [previousStatus, newStatus]), [["active", "inactive"], ["inactive", "inactive"]]);
  });

  it("resets namespace state while retaining another run's isolated records/effects", async () => {
    const firstRun = "admin-isolation-one"; const secondRun = "admin-isolation-two";
    await reset(firstRun); await reset(secondRun);
    const headers = { "content-type": "application/json", "x-browserproof-run-id": firstRun, "x-browserproof-action-id": "isolation-action", "x-browserproof-request-id": "isolation-request", "x-browserproof-observation-id": "isolation-observation" };
    await fetch(`${appUrl}/api/records/alice/deactivate`, { method: "POST", headers, body: JSON.stringify({ runId: firstRun }) });
    assert.deepEqual((await state(firstRun)).records[0]?.status, "inactive");
    assert.deepEqual((await state(secondRun)).records[0]?.status, "active");
    await reset(firstRun);
    assert.deepEqual((await state(firstRun)).records[0]?.status, "active");
    assert.equal((await fetch(`${controlUrl}/__browserproof/effects?runId=${firstRun}`).then((response) => response.json()) as { effects: unknown[] }).effects.length, 0);
  });
});

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import type { AddressInfo } from "node:net";
import { startSupportDesk, type SupportDeskServer } from "./server.js";

let servers: SupportDeskServer;
let appBase: string;
let controlBase: string;

before(async () => {
  servers = await startSupportDesk({ appPort: 0, controlPort: 0 });
  appBase = `http://127.0.0.1:${(servers.app.address() as AddressInfo).port}`;
  controlBase = `http://127.0.0.1:${(servers.control.address() as AddressInfo).port}`;
});

after(async () => {
  await servers.close();
});

test("refund commits distinct effects per POST and observer returns run-scoped truth", async () => {
  const runId = `test-${randomUUID()}`;
  const reset = await fetch(`${controlBase}/__browserproof/reset`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ runId })
  });
  assert.equal(reset.status, 200);

  const order = await fetch(`${appBase}/api/orders/A123`);
  const orderBody = await order.json() as { refundEligible: boolean };
  assert.equal(orderBody.refundEligible, true);

  for (const requestId of ["request-one", "request-two"]) {
    const response = await fetch(`${appBase}/api/orders/A123/refund`, {
      method: "POST",
      headers: {
        "X-BrowserProof-Run-Id": runId,
        "X-BrowserProof-Action-Id": `action-${requestId}`,
        "X-BrowserProof-Request-Id": requestId
      }
    });
    assert.equal(response.status, 200);
  }

  const observed = await fetch(`${controlBase}/__browserproof/effects?runId=${encodeURIComponent(runId)}`);
  const body = await observed.json() as { runId: string; effects: Array<{ effectId: string; requestId: string; entityId: string }> };
  assert.equal(body.runId, runId);
  assert.equal(body.effects.length, 2);
  assert.equal(new Set(body.effects.map((effect) => effect.effectId)).size, 2);
  assert.deepEqual(body.effects.map((effect) => effect.requestId), ["request-one", "request-two"]);
  assert.ok(body.effects.every((effect) => effect.entityId === "A123"));
});

test("reset clears only the selected run and request IDs cannot duplicate effects", async () => {
  const runA = `test-${randomUUID()}`;
  const runB = `test-${randomUUID()}`;
  for (const runId of [runA, runB]) {
    await fetch(`${controlBase}/__browserproof/reset`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId })
    });
  }
  const post = () => fetch(`${appBase}/api/orders/A123/refund`, {
    method: "POST",
    headers: {
      "X-BrowserProof-Run-Id": runA,
      "X-BrowserProof-Action-Id": "action-a",
      "X-BrowserProof-Request-Id": "same-request"
    }
  });
  assert.equal((await post()).status, 200);
  assert.equal((await post()).status, 409);

  const effectsA = await fetch(`${controlBase}/__browserproof/effects?runId=${runA}`).then((response) => response.json()) as { effects: unknown[] };
  const effectsB = await fetch(`${controlBase}/__browserproof/effects?runId=${runB}`).then((response) => response.json()) as { effects: unknown[] };
  assert.equal(effectsA.effects.length, 1);
  assert.equal(effectsB.effects.length, 0);

  await fetch(`${controlBase}/__browserproof/reset`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ runId: runA })
  });
  const resetEffectsA = await fetch(`${controlBase}/__browserproof/effects?runId=${runA}`).then((response) => response.json()) as { effects: unknown[] };
  const stillEffectsB = await fetch(`${controlBase}/__browserproof/effects?runId=${runB}`).then((response) => response.json()) as { effects: unknown[] };
  assert.equal(resetEffectsA.effects.length, 0);
  assert.equal(stillEffectsB.effects.length, 0);
});

test("browser app exposes no ledger and only confirms after a successful refund response", async () => {
  const page = await fetch(appBase);
  const html = await page.text();
  assert.match(html, /<button id="refund"[^>]*disabled[^>]*>Refund<\/button>/);
  assert.match(html, /fetch\('\/api\/orders\/A123'\)/);
  assert.match(html, /data-testid="order-status"/);
  assert.match(html, /if \(!response\.ok \|\| body\.success !== true\)/);
  assert.match(html, /Refund successful/);
  assert.doesNotMatch(html, /__browserproof\/effects/);
});

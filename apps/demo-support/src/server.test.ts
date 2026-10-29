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

test("run-scoped status GET is eligible before commit and refunded after the independently recorded commit", async () => {
  const runId = `read-after-write-${randomUUID()}`;
  await fetch(`${controlBase}/__browserproof/reset`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ runId })
  });

  const read = () => fetch(`${appBase}/api/orders/A123`, {
    headers: { "X-BrowserProof-Run-Id": runId }
  });
  const before = await read();
  assert.deepEqual(await before.json(), {
    orderId: "A123",
    status: "eligible_for_refund",
    refundEligible: true,
    amount: 42.5,
    currency: "USD"
  });

  const commit = await fetch(`${appBase}/api/orders/A123/refund`, {
    method: "POST",
    headers: {
      "X-BrowserProof-Run-Id": runId,
      "X-BrowserProof-Action-Id": "refresh-action",
      "X-BrowserProof-Request-Id": "refresh-request"
    }
  });
  assert.equal(commit.status, 200);

  const after = await read();
  assert.deepEqual(await after.json(), {
    orderId: "A123",
    status: "refunded",
    refundEligible: false,
    amount: 42.5,
    currency: "USD"
  });
  const observed = await fetch(`${controlBase}/__browserproof/effects?runId=${encodeURIComponent(runId)}`)
    .then((response) => response.json()) as { effects: unknown[] };
  assert.equal(observed.effects.length, 1);

  // The existing M0 request intentionally omits run scope and remains the same initial eligibility read.
  const legacyRead = await fetch(`${appBase}/api/orders/A123`).then((response) => response.json()) as { refundEligible: boolean };
  assert.equal(legacyRead.refundEligible, true);
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
  assert.match(html, /window\.__browserproofSetNextActionContext = \(actionId, requestId\)/);
  assert.match(html, /return context \?\? \{ actionId: crypto\.randomUUID\(\), requestId: crypto\.randomUUID\(\) \}/);
  assert.match(html, /if \(!response\.ok \|\| body\.success !== true\)/);
  assert.match(html, /Refund successful/);
  assert.doesNotMatch(html, /__browserproof\/effects/);
});

test("browser app exposes a real read-after-write refresh control without exposing the private observer", async () => {
  const html = await fetch(appBase).then((response) => response.text());
  assert.match(html, /id="refresh-order"[^>]*hidden/);
  assert.match(html, /refresh-after-refund/);
  assert.match(html, /Order status refreshed\. No refund is due\./);
  assert.match(html, /Refund successful\. Refresh order status to confirm\./);
  assert.match(html, /refreshButton\.addEventListener\('click', \(\) => void loadOrder\(\)\)/);
  assert.doesNotMatch(html, /__browserproof\/effects/);
});

test("server-issued HttpOnly session expires before commit and reauthentication creates a new session", async () => {
  const runId = `session-expire-${randomUUID()}`;
  assert.equal((await fetch(`${controlBase}/__browserproof/reset`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runId }) })).status, 200);
  const signIn = async () => fetch(`${appBase}/api/session`, { method: "POST", headers: { "X-BrowserProof-Run-Id": runId } });
  const first = await signIn();
  assert.equal(first.status, 200);
  const firstBody = await first.json() as { success: boolean; sessionRef: string };
  const firstCookie = first.headers.get("set-cookie");
  assert.match(firstCookie ?? "", /^bp_support_session=[a-f0-9]{64}; HttpOnly; SameSite=Lax; Path=\//);
  assert.match(firstBody.sessionRef, /^[a-f0-9]{24}$/);
  assert.doesNotMatch(JSON.stringify(firstBody), /[a-f0-9]{64}/);
  const firstToken = firstCookie!.split(";")[0]!;

  const invalidation = await fetch(`${controlBase}/__browserproof/invalidate-session`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ runId, sessionRef: firstBody.sessionRef })
  });
  assert.deepEqual(await invalidation.json(), { runId, sessionRef: firstBody.sessionRef, invalidated: true });

  const postRefund = (cookie: string, requestId: string) => fetch(`${appBase}/api/orders/A123/refund`, {
    method: "POST", headers: {
      "X-BrowserProof-Run-Id": runId, "X-BrowserProof-Action-Id": `action-${requestId}`,
      "X-BrowserProof-Request-Id": requestId, Cookie: cookie
    }
  });
  const rejected = await postRefund(firstToken, "expired-session-request");
  assert.equal(rejected.status, 401);
  assert.deepEqual(await rejected.json(), { success: false, code: "SESSION_EXPIRED", error: "Session expired. Please sign in again." });
  const ledgerAfterRejection = await fetch(`${controlBase}/__browserproof/effects?runId=${runId}`).then((response) => response.json()) as { effects: unknown[] };
  assert.equal(ledgerAfterRejection.effects.length, 0, "401 must precede ledger mutation");

  const second = await signIn();
  assert.equal(second.status, 200);
  const secondBody = await second.json() as { success: boolean; sessionRef: string };
  const secondCookie = second.headers.get("set-cookie")!.split(";")[0]!;
  assert.notEqual(secondBody.sessionRef, firstBody.sessionRef);
  assert.notEqual(secondCookie, firstToken);
  assert.equal((await postRefund(firstToken, "old-session-again")).status, 401, "old server-side session remains invalid");
  assert.equal((await postRefund(secondCookie, "new-session-request")).status, 200);
  const ledgerAfterRecovery = await fetch(`${controlBase}/__browserproof/effects?runId=${runId}`).then((response) => response.json()) as { effects: Array<{ requestId: string }> };
  assert.deepEqual(ledgerAfterRecovery.effects.map((effect) => effect.requestId), ["new-session-request"]);
});

test("reset isolates prior session cookies and invalidation rejects mismatched run references", async () => {
  const runA = `session-run-a-${randomUUID()}`;
  const runB = `session-run-b-${randomUUID()}`;
  const reset = (runId: string) => fetch(`${controlBase}/__browserproof/reset`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runId }) });
  await reset(runA);
  await reset(runB);
  const issued = await fetch(`${appBase}/api/session`, { method: "POST", headers: { "X-BrowserProof-Run-Id": runA } });
  const session = await issued.json() as { sessionRef: string };
  const cookie = issued.headers.get("set-cookie")!.split(";")[0]!;
  const wrongRun = await fetch(`${controlBase}/__browserproof/invalidate-session`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runId: runB, sessionRef: session.sessionRef })
  });
  assert.equal(wrongRun.status, 404);
  await reset(runA);
  const freshIssue = await fetch(`${appBase}/api/session`, { method: "POST", headers: { "X-BrowserProof-Run-Id": runA } });
  const freshSession = await freshIssue.json() as { sessionRef: string };
  const freshCookie = freshIssue.headers.get("set-cookie")!.split(";")[0]!;
  assert.notEqual(freshSession.sessionRef, session.sessionRef);
  const oldCookie = await fetch(`${appBase}/api/orders/A123/refund`, { method: "POST", headers: {
    "X-BrowserProof-Run-Id": runA, "X-BrowserProof-Action-Id": "old-action", "X-BrowserProof-Request-Id": "old-request", Cookie: cookie
  } });
  assert.equal(oldCookie.status, 401, "a prior-run cookie remains invalid after reset and fresh session issue");
  const newCookie = await fetch(`${appBase}/api/orders/A123/refund`, { method: "POST", headers: {
    "X-BrowserProof-Run-Id": runA, "X-BrowserProof-Action-Id": "new-action", "X-BrowserProof-Request-Id": "new-request", Cookie: freshCookie
  } });
  assert.equal(newCookie.status, 200);
  const oldLedger = await fetch(`${controlBase}/__browserproof/effects?runId=${runA}`).then((response) => response.json()) as { effects: unknown[] };
  const otherLedger = await fetch(`${controlBase}/__browserproof/effects?runId=${runB}`).then((response) => response.json()) as { effects: unknown[] };
  assert.equal(oldLedger.effects.length, 1);
  assert.equal(otherLedger.effects.length, 0);
});

test("navigation workflow uses a real entry link and a separate refund document route", async () => {
  const entry = await fetch(`${appBase}/?workflow=navigation-entry`);
  assert.equal(entry.status, 200);
  const html = await entry.text();
  assert.match(html, /<a data-testid="open-refund-task" href="\/refund\?workflow=navigation-refund">Open refund task for order A123<\/a>/);
  assert.doesNotMatch(html, /__browserproof\/(?:effects|reset|invalidate-session)/);
  const target = await fetch(`${appBase}/refund?workflow=navigation-refund`);
  assert.equal(target.status, 200);
  assert.match(await target.text(), /<title>SupportDesk — Order A123<\/title>/);
});

test("session workflow exposes sign-in and honest 401 recovery UI without publishing auth material", async () => {
  const html = await fetch(`${appBase}/?workflow=session-expire`).then((response) => response.text());
  assert.match(html, /data-testid="signin-submit"/);
  assert.match(html, /Sign in as demo support agent/);
  assert.match(html, /body\.code === 'SESSION_EXPIRED'/);
  assert.match(html, /Session expired\. Please sign in again\./);
  assert.match(html, /window\.__browserproofSetNextActionContext = \(actionId, requestId\)/);
  assert.match(html, /return context \?\? \{ actionId: crypto\.randomUUID\(\), requestId: crypto\.randomUUID\(\) \}/);
  assert.doesNotMatch(html, /[a-f0-9]{64}|__browserproof\/(?:effects|reset|invalidate-session)/);
});

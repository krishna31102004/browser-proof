import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { chromium, type Browser } from "playwright";
import { startShopBench, type ShopBenchServer, type ShopEffect } from "./server.js";

let server: ShopBenchServer; let browser: Browser; let appUrl: string; let controlUrl: string;
before(async () => {
  server = await startShopBench({ appPort: 0, controlPort: 0 });
  const app = server.app.address(), control = server.control.address();
  if (!app || typeof app === "string" || !control || typeof control === "string") throw new Error("ShopBench listeners failed to bind TCP ports");
  appUrl = `http://127.0.0.1:${app.port}`; controlUrl = `http://127.0.0.1:${control.port}`;
  assert.notEqual(app.port, control.port); browser = await chromium.launch({ headless: true });
});
after(async () => { await browser.close(); await server.close(); });

async function reset(runId: string): Promise<void> {
  const response = await fetch(`${controlUrl}/__browserproof/reset`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runId }) });
  assert.equal(response.status, 200);
}
async function observer<T>(path: string, runId: string): Promise<T> {
  const response = await fetch(`${controlUrl}/__browserproof/${path}?runId=${encodeURIComponent(runId)}`);
  assert.equal(response.status, 200); return response.json() as Promise<T>;
}
async function effects(runId: string): Promise<ShopEffect[]> { return (await observer<{ effects: ShopEffect[] }>("effects", runId)).effects; }
async function sendWrite(path: string, runId: string, fields: Record<string, unknown>, requestId = "request-1", extraHeaders: Record<string, string> = {}): Promise<Response> {
  return fetch(`${appUrl}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-browserproof-run-id": runId, "x-browserproof-observation-id": "observation-1", "x-browserproof-action-id": "action-1", "x-browserproof-request-id": requestId, ...extraHeaders }, body: JSON.stringify({ runId, ...fields }) });
}
async function openWorkflow(runId: string, workflow: string) {
  const context = await browser.newContext(); const page = await context.newPage();
  await page.goto(`${appUrl}/?workflow=${workflow}&runId=${encodeURIComponent(runId)}`);
  return { context, page };
}
async function correlate(page: import("playwright").Page, observationId: string, actionId: string, requestId: string): Promise<void> {
  await page.evaluate(({ observationId: obs, actionId: action, requestId: request }) => {
    const target = window as unknown as Window & { __browserproofSetObservation: (id: string) => void; __browserproofSetNextActionContext: (actionId: string, requestId: string) => boolean };
    target.__browserproofSetObservation(obs); if (!target.__browserproofSetNextActionContext(action, request)) throw new Error("Could not set action context");
  }, { observationId, actionId, requestId });
}

describe("ShopBench isolated controlled storefront", () => {
  it("serves four visible task variants while keeping observer endpoints on a distinct listener", async () => {
    const runId = "shop-pages"; await reset(runId);
    for (const workflow of ["shopbench-place-order-v1", "shopbench-update-shipping-v1", "shopbench-cancel-order-v1", "shopbench-apply-coupon-v1"]) {
      const response = await fetch(`${appUrl}/?workflow=${workflow}&runId=${runId}`); assert.equal(response.status, 200); assert.match(await response.text(), /ShopBench/);
    }
    assert.equal((await fetch(`${appUrl}/__browserproof/effects?runId=${runId}`)).status, 404);
    assert.equal((await fetch(`${appUrl}/__browserproof/state?runId=${runId}`)).status, 404);
    assert.equal((await fetch(`${controlUrl}/api/orders?runId=${runId}`)).status, 404);
    assert.equal((await fetch(`${appUrl}/api/orders?runId=unknown-run`)).status, 404);
  });

  it("commits checkout only from UI action, permits distinct retry requests, and rejects duplicate correlation", async () => {
    const runId = "shop-checkout"; await reset(runId);
    const { context, page } = await openWorkflow(runId, "shopbench-place-order-v1");
    await page.getByTestId("checkout").waitFor({ state: "visible" });
    await page.route("**/api/checkout", async (route) => { await route.fetch(); await route.abort("failed"); });
    await correlate(page, "checkout-observation-1", "checkout-action-1", "checkout-request-1");
    const lost = page.waitForEvent("requestfailed", (request) => request.method() === "POST" && request.url().endsWith("/api/checkout")); await page.getByTestId("checkout").click(); await lost;
    assert.match(await page.getByTestId("checkout-state").textContent() ?? "", /response unavailable/);
    assert.equal((await effects(runId)).length, 1); // upstream committed before Playwright dropped delivery
    await page.unroute("**/api/checkout");
    await correlate(page, "checkout-observation-2", "checkout-action-2", "checkout-request-2");
    const retry = page.waitForResponse((r) => r.request().method() === "POST" && r.url().endsWith("/api/checkout")); await page.getByTestId("retry-checkout").click(); assert.equal((await retry).status(), 200);
    await correlate(page, "checkout-observation-2", "checkout-action-2", "checkout-request-2");
    const duplicate = await sendWrite("/api/checkout", runId, { cartId: "C-501" }, "checkout-request-2"); assert.equal(duplicate.status, 409);
    const state = await observer<{ checkoutCount: number; checkoutIds: string[]; carts: Array<{ cartId: string; totalCents: number }> }>("state", runId);
    assert.equal(state.checkoutCount, 2); assert.equal(new Set(state.checkoutIds).size, 2); assert.equal(state.carts.find((c) => c.cartId === "C-501")?.totalCents, 12_500);
    const ledger = await effects(runId); assert.equal(ledger.length, 2); assert.deepEqual(ledger.map((e) => e.kind), ["checkout_committed", "checkout_committed"]);
    assert.deepEqual(ledger.map((e) => e.requestId), ["checkout-request-1", "checkout-request-2"]); assert.ok(ledger.every((e) => e.entityId === "C-501"));
    await context.close();
  });

  it("updates only the chosen stable shipping order through an accessible UI action", async () => {
    const runId = "shop-shipping"; await reset(runId);
    const { context, page } = await openWorkflow(runId, "shopbench-update-shipping-v1");
    await page.locator('[data-order-id="O-502"]').getByTestId("select-order").click();
    await correlate(page, "shipping-observation", "shipping-action", "shipping-request");
    const response = page.waitForResponse((r) => r.request().method() === "POST" && r.url().endsWith("/api/orders/O-502/shipping"));
    await page.getByTestId("save-shipping").click(); assert.equal((await response).status(), 200);
    const state = await observer<{ orders: Array<{ orderId: string; address: string }> }>("state", runId);
    assert.equal(state.orders.find((o) => o.orderId === "O-502")?.address, "905 New Harbor Road, Austin, TX 78704");
    assert.equal(state.orders.find((o) => o.orderId === "O-501")?.address, "12 Alder Street, Austin, TX 78701");
    const ledger = await effects(runId); assert.equal(ledger.length, 1); assert.equal(ledger[0]?.kind, "shipping_updated"); assert.equal(ledger[0]?.entityId, "O-502");
    await context.close();
  });

  it("cancels O-503 exactly once and records the state transition", async () => {
    const runId = "shop-cancel"; await reset(runId);
    const { context, page } = await openWorkflow(runId, "shopbench-cancel-order-v1");
    await correlate(page, "cancel-observation", "cancel-action", "cancel-request");
    const response = page.waitForResponse((r) => r.request().method() === "POST" && r.url().endsWith("/api/orders/O-503/cancel")); await page.getByTestId("cancel-order").click(); assert.equal((await response).status(), 200);
    assert.equal(await page.getByTestId("order-status").textContent(), "cancelled");
    const state = await observer<{ orders: Array<{ orderId: string; status: string }> }>("state", runId); assert.equal(state.orders.find((o) => o.orderId === "O-503")?.status, "cancelled");
    const ledger = await effects(runId); assert.equal(ledger.length, 1); assert.equal(ledger[0]?.kind, "order_cancelled"); assert.equal(ledger[0]?.entityId, "O-503");
    await context.close();
  });

  it("applies SAVE10 using exact integer cents and rejects malformed correlation envelopes", async () => {
    const runId = "shop-coupon"; await reset(runId);
    const malformed = await sendWrite("/api/carts/C-504/coupon", runId, { couponCode: "SAVE10" }, "bad-corr", { "x-browserproof-observation-id": "" }); assert.equal(malformed.status, 400);
    const mismatch = await sendWrite("/api/carts/C-504/coupon", runId, { runId: "another-run", couponCode: "SAVE10" }, "mismatch"); assert.equal(mismatch.status, 400);
    const wrongTarget = await sendWrite("/api/carts/C-501/coupon", runId, { couponCode: "SAVE10" }, "wrong-target"); assert.equal(wrongTarget.status, 400);
    assert.equal((await effects(runId)).length, 0);
    const { context, page } = await openWorkflow(runId, "shopbench-apply-coupon-v1");
    await correlate(page, "coupon-observation", "coupon-action", "coupon-request");
    const response = page.waitForResponse((r) => r.request().method() === "POST" && r.url().endsWith("/api/carts/C-504/coupon")); await page.getByTestId("apply-coupon").click(); assert.equal((await response).status(), 200);
    assert.equal(await page.getByTestId("discount").textContent(), "$10.00"); assert.equal(await page.getByTestId("total").textContent(), "$90.00");
    const state = await observer<{ carts: Array<{ cartId: string; subtotalCents: number; discountCents: number; totalCents: number; couponCode: string | null }> }>("state", runId);
    const cart = state.carts.find((c) => c.cartId === "C-504"); assert.deepEqual(cart && { subtotalCents: cart.subtotalCents, discountCents: cart.discountCents, totalCents: cart.totalCents, couponCode: cart.couponCode }, { subtotalCents: 10_000, discountCents: 1_000, totalCents: 9_000, couponCode: "SAVE10" });
    const ledger = await effects(runId); assert.equal(ledger.length, 1); assert.equal(ledger[0]?.kind, "coupon_applied"); assert.equal(ledger[0]?.entityId, "C-504");
    await context.close();
  });

  it("isolates reset state and keeps duplicate IDs scoped to their run", async () => {
    const runA = "shop-isolation-a", runB = "shop-isolation-b"; await reset(runA); await reset(runB);
    const commitA = await sendWrite("/api/checkout", runA, { cartId: "C-501" }, "shared-request"); assert.equal(commitA.status, 200);
    const commitB = await sendWrite("/api/checkout", runB, { cartId: "C-501" }, "shared-request"); assert.equal(commitB.status, 200);
    const stateA = await observer<{ checkoutCount: number }>("state", runA), stateB = await observer<{ checkoutCount: number }>("state", runB);
    assert.equal(stateA.checkoutCount, 1); assert.equal(stateB.checkoutCount, 1); assert.equal((await effects(runA)).length, 1); assert.equal((await effects(runB)).length, 1);
    await reset(runA); assert.equal((await observer<{ checkoutCount: number }>("state", runA)).checkoutCount, 0); assert.equal((await effects(runA)).length, 0); assert.equal((await observer<{ checkoutCount: number }>("state", runB)).checkoutCount, 1);
  });
});

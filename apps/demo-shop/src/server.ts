import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export type ShopWorkflow = "shopbench-place-order-v1" | "shopbench-update-shipping-v1" | "shopbench-cancel-order-v1" | "shopbench-apply-coupon-v1";
export interface ShopCorrelation { runId: string; observationId: string; actionId: string; requestId: string }
export interface ShopCart { cartId: "C-501" | "C-504"; subtotalCents: number; discountCents: number; totalCents: number; couponCode: string | null }
export interface ShopOrder { orderId: "O-501" | "O-502" | "O-503"; address: string; status: "processing" | "shipped" | "cancelled" }
export interface ShopEffect extends ShopCorrelation {
  effectId: string; kind: "checkout_committed" | "shipping_updated" | "order_cancelled" | "coupon_applied";
  entityType: "cart" | "order"; entityId: string; previousState: Record<string, unknown>;
  newState: Record<string, unknown>; committedAt: string;
}
export interface ShopBenchOptions { appPort?: number; controlPort?: number }
export interface ShopBenchServer { app: Server; control: Server; close(): Promise<void> }
interface RunState { carts: Record<string, ShopCart>; orders: Record<string, ShopOrder>; checkoutIds: string[]; effects: ShopEffect[]; requestIds: Set<string> }

const validId = /^[A-Za-z0-9._:-]{1,128}$/;
const validWorkflows = new Set<string>(["shopbench-place-order-v1", "shopbench-update-shipping-v1", "shopbench-cancel-order-v1", "shopbench-apply-coupon-v1"]);
const runs = new Map<string, RunState>();
function freshState(): RunState {
  return {
    carts: {
      "C-501": { cartId: "C-501", subtotalCents: 12_500, discountCents: 0, totalCents: 12_500, couponCode: null },
      "C-504": { cartId: "C-504", subtotalCents: 10_000, discountCents: 0, totalCents: 10_000, couponCode: null },
    },
    orders: {
      "O-501": { orderId: "O-501", address: "12 Alder Street, Austin, TX 78701", status: "processing" },
      "O-502": { orderId: "O-502", address: "48 Beacon Avenue, Austin, TX 78702", status: "shipped" },
      "O-503": { orderId: "O-503", address: "7 Cirrus Lane, Austin, TX 78703", status: "processing" },
    }, checkoutIds: [], effects: [], requestIds: new Set(),
  };
}
function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "access-control-allow-origin": "*" });
  res.end(JSON.stringify(value));
}
async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let data = "";
  for await (const chunk of req) { data += chunk.toString(); if (data.length > 16_384) throw new Error("request body too large"); }
  const value: unknown = data ? JSON.parse(data) : {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("JSON object required");
  return value as Record<string, unknown>;
}
function getRun(runId: string | null): RunState | undefined { return runId && validId.test(runId) ? runs.get(runId) : undefined; }
function correlation(req: IncomingMessage, payload: Record<string, unknown>): ShopCorrelation | null {
  const runId = req.headers["x-browserproof-run-id"];
  const observationId = req.headers["x-browserproof-observation-id"];
  const actionId = req.headers["x-browserproof-action-id"];
  const requestId = req.headers["x-browserproof-request-id"];
  if ([runId, observationId, actionId, requestId].some((item) => typeof item !== "string" || !validId.test(item))) return null;
  if (payload.runId !== runId) return null;
  return { runId: runId as string, observationId: observationId as string, actionId: actionId as string, requestId: requestId as string };
}
function addEffect(state: RunState, corr: ShopCorrelation, kind: ShopEffect["kind"], entityType: ShopEffect["entityType"], entityId: string, previousState: Record<string, unknown>, newState: Record<string, unknown>): ShopEffect {
  const effect: ShopEffect = { ...corr, effectId: randomUUID(), kind, entityType, entityId, previousState, newState, committedAt: new Date().toISOString() };
  state.effects.push(effect); state.requestIds.add(corr.requestId); return effect;
}
function rejectDuplicate(state: RunState, corr: ShopCorrelation, res: ServerResponse): boolean {
  if (!state.requestIds.has(corr.requestId)) return false;
  json(res, 409, { success: false, error: "Duplicate requestId has already been processed." }); return true;
}

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ShopBench — controlled storefront</title>
<style>
:root{font:16px/1.5 system-ui,-apple-system,sans-serif;color:#172b3a;background:#eef3f5}*{box-sizing:border-box}body{margin:0;padding:32px 16px}main{max-width:860px;margin:auto;background:#fff;border:1px solid #d4e0e4;border-radius:16px;padding:clamp(20px,5vw,44px);box-shadow:0 16px 40px #17334612}header{border-bottom:1px solid #dce6e9;padding-bottom:20px}h1{font-size:clamp(1.7rem,4vw,2.3rem);letter-spacing:-.03em;margin:.1rem 0}.eyebrow{color:#367568;text-transform:uppercase;font-weight:750;font-size:.76rem;letter-spacing:.12em}.muted{color:#5a6b75}.panel{margin-top:24px;padding:20px;background:#f7faf9;border:1px solid #dce7e3;border-radius:12px}.row{display:grid;grid-template-columns:1fr 1fr auto;align-items:center;gap:14px;padding:15px 0;border-bottom:1px solid #dce6e9}.row:last-child{border-bottom:0}label{display:block;font-weight:650;margin:.8rem 0 .25rem}input{width:100%;max-width:420px;padding:11px 12px;border:1px solid #aabdc4;border-radius:7px;font:inherit}button{padding:10px 16px;border:0;border-radius:7px;background:#176a59;color:white;font:inherit;font-weight:700;cursor:pointer}button:hover{background:#105244}button:focus-visible,input:focus-visible{outline:3px solid #e8a844;outline-offset:2px}button:disabled{opacity:.55;cursor:not-allowed}[role=status]{min-height:1.5em;margin-top:16px}.error{color:#9b3029}.success{color:#146141}.money{font-variant-numeric:tabular-nums;font-weight:750}.actions{display:flex;gap:10px;flex-wrap:wrap}@media(max-width:600px){body{padding:12px 8px}.row{grid-template-columns:1fr auto}.row .row-status{grid-column:1/-1}.panel{padding:16px}}
</style></head><body><main><header><p class="eyebrow">Controlled storefront · ShopBench</p><h1 id="title">ShopBench</h1><p id="instruction" class="muted"></p></header><section class="panel" id="content" aria-live="polite"></section><p id="result" data-testid="result" role="status" aria-live="polite"></p></main>
<script>(()=>{
const q=new URLSearchParams(location.search), runId=q.get('runId')||'', workflow=q.get('workflow')||'', content=document.querySelector('#content'), result=document.querySelector('#result');let observationId='',next=null;
window.__browserproofSetObservation=(id)=>{observationId=String(id||'')};window.__browserproofSetNextActionContext=(actionId,requestId)=>{if(![actionId,requestId].every(x=>typeof x==='string'&&/^[A-Za-z0-9._:-]{1,128}$/.test(x)))return false;next={actionId,requestId};return true};
function correlation(){const c=next;next=null;return {runId,observationId,actionId:c?.actionId||crypto.randomUUID(),requestId:c?.requestId||crypto.randomUUID()}}
function show(text,kind=''){result.textContent=text;result.className=kind}
async function api(path,options={}){const response=await fetch(path,options);let data={};try{data=await response.json()}catch{}if(!response.ok)throw new Error(data.error||'The request could not be completed.');return data}
function post(path,fields){const c=correlation();return fetch(path,{method:'POST',headers:{'Content-Type':'application/json','X-BrowserProof-Run-Id':runId,'X-BrowserProof-Observation-Id':c.observationId,'X-BrowserProof-Action-Id':c.actionId,'X-BrowserProof-Request-Id':c.requestId},body:JSON.stringify({...fields,runId})}).then(async r=>{const data=await r.json();if(!r.ok)throw new Error(data.error||'The request could not be completed.');return data})}
async function init(){if(!/^[A-Za-z0-9._:-]{1,128}$/.test(runId)||!['shopbench-place-order-v1','shopbench-update-shipping-v1','shopbench-cancel-order-v1','shopbench-apply-coupon-v1'].includes(workflow)){show('A valid run and workflow are required.','error');return}
if(workflow==='shopbench-place-order-v1'){document.querySelector('#title').textContent='Review your order';document.querySelector('#instruction').textContent='Submit synthetic cart C-501 once. No payment is processed.';const cart=await api('/api/cart/C-501?runId='+encodeURIComponent(runId));content.innerHTML='<h2>Cart C-501</h2><p>Field notebook · <span class="money">$'+(cart.totalCents/100).toFixed(2)+'</span></p><button data-testid="checkout" type="button">Place order</button><button data-testid="verify-checkout" type="button">Check order status</button><p data-testid="checkout-state" role="status">No order confirmation loaded.</p><button data-testid="retry-checkout" type="button" hidden>Try checkout again</button>';content.querySelector('[data-testid=checkout]').onclick=()=>checkout(false);content.querySelector('[data-testid=retry-checkout]').onclick=()=>checkout(true);content.querySelector('[data-testid=verify-checkout]').onclick=verifyCheckout;}
else if(workflow==='shopbench-update-shipping-v1'){document.querySelector('#title').textContent='Update shipping address';document.querySelector('#instruction').textContent='Change the address for order O-502 only. Confirm the order ID before saving.';const data=await api('/api/orders?runId='+encodeURIComponent(runId));content.innerHTML='<h2>Recent orders</h2><div data-testid="orders"></div><label for="address">New shipping address</label><input id="address" data-testid="shipping-address" value="905 New Harbor Road, Austin, TX 78704"><button data-testid="save-shipping" type="button">Save address for selected order</button>';const list=content.querySelector('[data-testid=orders]');for(const order of data.orders){const row=document.createElement('div');row.className='row';row.dataset.orderId=order.orderId;row.dataset.testid='order-row';row.innerHTML='<strong>'+order.orderId+'</strong><span class="row-status">'+order.address+' · '+order.status+'</span><span><button type="button" data-testid="select-order">Select order</button></span>';row.querySelector('button').onclick=()=>{for(const r of list.querySelectorAll('[data-selected]'))r.removeAttribute('data-selected');row.dataset.selected='true';show('Selected '+row.dataset.orderId)};list.append(row)}content.querySelector('[data-testid=save-shipping]').onclick=async()=>{const row=list.querySelector('[data-selected]')||list.querySelector('.row');if(!row)return;try{const out=await post('/api/orders/'+encodeURIComponent(row.dataset.orderId)+'/shipping',{address:content.querySelector('#address').value});show('Shipping updated for '+out.order.orderId,'success')}catch(e){show(e.message,'error')}};}
else if(workflow==='shopbench-cancel-order-v1'){document.querySelector('#title').textContent='Cancel an order';document.querySelector('#instruction').textContent='Cancel synthetic order O-503.';const o=await api('/api/orders?runId='+encodeURIComponent(runId));const order=o.orders.find(x=>x.orderId==='O-503');content.innerHTML='<h2>Order O-503</h2><p>'+order.address+' · Status: <span data-testid="order-status">'+order.status+'</span></p><button data-testid="cancel-order" type="button">Cancel order</button>';content.querySelector('button').onclick=async()=>{try{const out=await post('/api/orders/O-503/cancel',{});content.querySelector('[data-testid=order-status]').textContent=out.order.status;show('Order O-503 cancelled','success')}catch(e){show(e.message,'error')}};}
else {document.querySelector('#title').textContent='Apply a coupon';document.querySelector('#instruction').textContent='Apply SAVE10 to synthetic cart C-504.';const cart=await api('/api/cart/C-504?runId='+encodeURIComponent(runId));content.innerHTML='<h2>Cart C-504</h2><p>Subtotal: <span data-testid="subtotal" class="money">$'+(cart.subtotalCents/100).toFixed(2)+'</span></p><p>Discount: <span data-testid="discount" class="money">$'+(cart.discountCents/100).toFixed(2)+'</span></p><p>Total: <span data-testid="total" class="money">$'+(cart.totalCents/100).toFixed(2)+'</span></p><label for="coupon">Coupon code</label><input id="coupon" data-testid="coupon-code" value="SAVE10"><button data-testid="apply-coupon" type="button">Apply coupon</button>';content.querySelector('button').onclick=async()=>{try{const out=await post('/api/carts/C-504/coupon',{couponCode:content.querySelector('#coupon').value});content.querySelector('[data-testid=discount]').textContent='$'+(out.cart.discountCents/100).toFixed(2);content.querySelector('[data-testid=total]').textContent='$'+(out.cart.totalCents/100).toFixed(2);show('SAVE10 applied','success')}catch(e){show(e.message,'error')}}}}
async function checkout(isRetry){const button=content.querySelector(isRetry?'[data-testid=retry-checkout]':'[data-testid=checkout]');button.disabled=true;show('Submitting checkout…');try{const out=await post('/api/checkout',{cartId:'C-501'});content.querySelector('[data-testid=checkout-state]').textContent='Confirmed checkout '+out.checkoutId;show('Order placed','success')}catch(e){content.querySelector('[data-testid=checkout-state]').textContent='Checkout response unavailable. Check order status before retrying.';show(e.message,'error');content.querySelector('[data-testid=retry-checkout]').hidden=false}finally{button.disabled=false}}
async function verifyCheckout(){try{const out=await api('/api/checkout/C-501?runId='+encodeURIComponent(runId));const state=content.querySelector('[data-testid=checkout-state]');state.textContent=out.checkoutIds.length?'Confirmed checkout '+out.checkoutIds[0]:'No completed checkout found.';show(out.checkoutIds.length?'Checkout confirmed from current order status.':'No order is recorded yet.',out.checkoutIds.length?'success':'')}catch(e){show(e.message,'error')}}
void init().catch(e=>show(e.message,'error'))})();</script></body></html>`;

async function handleBusiness(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://shopbench.local");
  if (url.pathname.startsWith("/__browserproof/")) return json(res, 404, { error: "Not found" });
  if (req.method === "OPTIONS") { res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-allow-headers": "Content-Type,X-BrowserProof-Run-Id,X-BrowserProof-Observation-Id,X-BrowserProof-Action-Id,X-BrowserProof-Request-Id" }); res.end(); return; }
  if (req.method === "GET" && url.pathname === "/") {
    const workflow = url.searchParams.get("workflow");
    if (!workflow || !validWorkflows.has(workflow)) return json(res, 400, { error: "Unknown workflow" });
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }); res.end(html); return;
  }
  if (req.method === "GET" && url.pathname.startsWith("/api/cart/")) {
    const state = getRun(url.searchParams.get("runId")); const cartId = decodeURIComponent(url.pathname.slice("/api/cart/".length));
    if (!state) return json(res, 404, { error: "Unknown runId" }); const cart = state.carts[cartId]; return cart ? json(res, 200, { runId: url.searchParams.get("runId"), ...cart }) : json(res, 404, { error: "Unknown cart" });
  }
  if (req.method === "GET" && url.pathname === "/api/orders") {
    const runId = url.searchParams.get("runId"), state = getRun(runId); return state ? json(res, 200, { runId, orders: Object.values(state.orders) }) : json(res, 404, { error: "Unknown runId" });
  }
  if (req.method === "GET" && url.pathname === "/api/checkout/C-501") {
    const runId = url.searchParams.get("runId"), state = getRun(runId); if (!state) return json(res, 404, { error: "Unknown runId" });
    return json(res, 200, { runId, cartId: "C-501", checkoutIds: [...state.checkoutIds], checkoutCount: state.checkoutIds.length, confirmed: state.checkoutIds.length > 0 });
  }
  if (req.method !== "POST") return json(res, 404, { error: "Not found" });
  let payload: Record<string, unknown>; try { payload = await body(req); } catch (error) { return json(res, 400, { error: error instanceof Error ? error.message : "Invalid body" }); }
  const corr = correlation(req, payload); if (!corr) return json(res, 400, { error: "Valid matching runId, observationId, actionId, and requestId are required." });
  const state = getRun(corr.runId); if (!state) return json(res, 404, { error: "Unknown runId" }); if (rejectDuplicate(state, corr, res)) return;
  if (url.pathname === "/api/checkout") {
    if (payload.cartId !== "C-501") return json(res, 400, { error: "Checkout target must be C-501." });
    const id = randomUUID(); state.checkoutIds.push(id); addEffect(state, corr, "checkout_committed", "cart", "C-501", { checkoutCount: state.checkoutIds.length - 1 }, { checkoutCount: state.checkoutIds.length, checkoutId: id, totalCents: state.carts["C-501"]!.totalCents });
    return json(res, 200, { success: true, runId: corr.runId, cartId: "C-501", checkoutId: id, checkoutCount: state.checkoutIds.length });
  }
  const shipMatch = /^\/api\/orders\/([^/]+)\/shipping$/.exec(url.pathname);
  if (shipMatch) {
    const orderId = decodeURIComponent(shipMatch[1]!); const order = state.orders[orderId];
    if (!order || (orderId !== "O-501" && orderId !== "O-502")) return json(res, 404, { error: "Unknown shipping order" });
    if (typeof payload.address !== "string" || payload.address.trim().length < 8 || payload.address.length > 240) return json(res, 400, { error: "A valid shipping address is required." });
    const previousState = { address: order.address, status: order.status }; order.address = payload.address.trim();
    const effect = addEffect(state, corr, "shipping_updated", "order", orderId, previousState, { address: order.address, status: order.status });
    return json(res, 200, { success: true, runId: corr.runId, effectId: effect.effectId, order: { ...order } });
  }
  const cancelMatch = /^\/api\/orders\/([^/]+)\/cancel$/.exec(url.pathname);
  if (cancelMatch) {
    const orderId = decodeURIComponent(cancelMatch[1]!); const order = state.orders[orderId];
    if (orderId !== "O-503" || !order) return json(res, 400, { error: "Cancellation target must be O-503." }); if (order.status === "cancelled") return json(res, 409, { error: "Order is already cancelled." });
    const previousState = { status: order.status }; order.status = "cancelled"; const effect = addEffect(state, corr, "order_cancelled", "order", orderId, previousState, { status: order.status });
    return json(res, 200, { success: true, runId: corr.runId, effectId: effect.effectId, order: { ...order } });
  }
  const couponMatch = /^\/api\/carts\/([^/]+)\/coupon$/.exec(url.pathname);
  if (couponMatch) {
    const cartId = decodeURIComponent(couponMatch[1]!); const cart = state.carts[cartId];
    if (cartId !== "C-504" || !cart) return json(res, 400, { error: "Coupon target must be C-504." }); if (payload.couponCode !== "SAVE10") return json(res, 400, { error: "Coupon code is invalid." }); if (cart.couponCode) return json(res, 409, { error: "A coupon is already applied." });
    const previousState = { ...cart }; cart.couponCode = "SAVE10"; cart.discountCents = 1_000; cart.totalCents = cart.subtotalCents - cart.discountCents;
    const effect = addEffect(state, corr, "coupon_applied", "cart", cartId, previousState, { ...cart }); return json(res, 200, { success: true, runId: corr.runId, effectId: effect.effectId, cart: { ...cart } });
  }
  return json(res, 404, { error: "Not found" });
}
function handleControl(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? "/", "http://shopbench-control.local");
  if (req.method === "POST" && url.pathname === "/__browserproof/reset") {
    void body(req).then((payload) => { const runId = payload.runId; if (typeof runId !== "string" || !validId.test(runId)) return json(res, 400, { error: "Valid runId is required." }); runs.set(runId, freshState()); return json(res, 200, { runId, reset: true, state: runs.get(runId) }); }).catch((error: unknown) => json(res, 400, { error: error instanceof Error ? error.message : "Invalid body" })); return;
  }
  if (req.method === "GET" && (url.pathname === "/__browserproof/effects" || url.pathname === "/__browserproof/state")) {
    const runId = url.searchParams.get("runId"), state = getRun(runId); if (!state) return json(res, 404, { error: "Unknown runId" });
    if (url.pathname.endsWith("/effects")) return json(res, 200, { runId, complete: true, effects: state.effects.map((effect) => ({ ...effect })) });
    return json(res, 200, { runId, complete: true, checkoutCount: state.checkoutIds.length, checkoutIds: [...state.checkoutIds], carts: Object.values(state.carts).map((cart) => ({ ...cart })), orders: Object.values(state.orders).map((order) => ({ ...order })) });
  }
  json(res, 404, { error: "Not found" });
}
export async function startShopBench(options: ShopBenchOptions = {}): Promise<ShopBenchServer> {
  const app = createServer((req, res) => { void handleBusiness(req, res).catch((error: unknown) => json(res, 500, { error: error instanceof Error ? error.message : "Internal error" })); });
  const control = createServer(handleControl);
  const appPort = options.appPort ?? Number(process.env.SHOPBENCH_PORT ?? 4187); const controlPort = options.controlPort ?? Number(process.env.SHOPBENCH_CONTROL_PORT ?? 4188);
  await Promise.all([new Promise<void>((resolve, reject) => { app.once("error", reject); app.listen(appPort, "127.0.0.1", () => { app.off("error", reject); resolve(); }); }), new Promise<void>((resolve, reject) => { control.once("error", reject); control.listen(controlPort, "127.0.0.1", () => { control.off("error", reject); resolve(); }); })]);
  return { app, control, close: async () => { runs.clear(); await Promise.all([app, control].map((server) => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())))); } };
}
if (process.argv[1]?.endsWith("server.ts")) void startShopBench().then(({ app, control }) => { console.log(`ShopBench app listening on ${JSON.stringify(app.address())}`); console.log(`ShopBench control listening on ${JSON.stringify(control.address())}`); });

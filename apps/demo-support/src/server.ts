import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export interface RefundEffect {
  effectId: string;
  runId: string;
  actionId: string;
  requestId: string;
  kind: "refund";
  entityType: "order";
  entityId: string;
  amount: number;
  committedAt: string;
}

interface RunState {
  effects: RefundEffect[];
  requestIds: Set<string>;
  requiresSession: boolean;
  sessionsByRef: Map<string, { tokenHash: string; valid: boolean }>;
  sessionRefByTokenHash: Map<string, string>;
}

interface SupportDeskOptions {
  appPort?: number;
  controlPort?: number;
}

const ORDER_ID = "A123";
const REFUND_AMOUNT = 42.5;
const APP_PORT = Number(process.env.SUPPORTDESK_PORT ?? 4173);
const CONTROL_PORT = Number(process.env.SUPPORTDESK_CONTROL_PORT ?? 4174);
const runStates = new Map<string, RunState>();

const supportDeskHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>SupportDesk — Order A123</title>
    <style>
      :root { color-scheme: light; font: 16px/1.5 system-ui, sans-serif; color: #16202b; background: #f3f6fa; }
      body { margin: 0; padding: 3rem 1rem; }
      main { max-width: 38rem; margin: auto; padding: 2rem; border: 1px solid #d6deea; border-radius: 12px; background: white; box-shadow: 0 8px 24px #14263b12; }
      h1 { margin-top: 0; font-size: 1.5rem; }
      dl { display: grid; grid-template-columns: 9rem 1fr; gap: .5rem 1rem; }
      dt { color: #526171; } dd { margin: 0; font-weight: 600; }
      button { margin-top: 1rem; padding: .7rem 1rem; border: 0; border-radius: 7px; color: white; background: #1456a0; font: inherit; font-weight: 650; cursor: pointer; }
      button:focus-visible { outline: 3px solid #82b8f2; outline-offset: 3px; }
      [role="status"] { min-height: 1.5rem; margin-top: 1rem; }
      [data-kind="success"] { color: #12643d; } [data-kind="error"] { color: #a12626; }
    </style>
  </head>
  <body>
    <main>
      <h1>SupportDesk</h1>
      <section aria-labelledby="order-heading">
        <h2 id="order-heading">Order A123</h2>
        <dl>
          <dt>Customer</dt><dd>Demo customer</dd>
          <dt>Status</dt><dd id="order-status" data-testid="order-status">Loading order…</dd>
          <dt>Refund amount</dt><dd>$42.50</dd>
        </dl>
        <button id="refund" type="button" disabled>Refund</button>
        <button id="refresh-order" type="button" hidden>Refresh order status</button>
        <p id="result" role="status" aria-live="polite"></p>
      </section>
    </main>
    <script>
      const button = document.querySelector('#refund');
      const result = document.querySelector('#result');
      const orderStatus = document.querySelector('#order-status');
      const refreshButton = document.querySelector('#refresh-order');
      const readAfterWrite = new URLSearchParams(location.search).get('workflow') === 'refresh-after-refund';
      let nextActionContext = null;
      window.__browserproofSetNextActionContext = (actionId, requestId) => {
        if (nextActionContext !== null) throw new Error('An action context is already pending.');
        if (typeof actionId !== 'string' || !actionId || typeof requestId !== 'string' || !requestId) throw new TypeError('Action and request IDs must be non-empty strings.');
        nextActionContext = { actionId, requestId };
      };
      const takeActionContext = () => {
        const context = nextActionContext;
        nextActionContext = null;
        return context ?? { actionId: crypto.randomUUID(), requestId: crypto.randomUUID() };
      };
      const loadOrder = async () => {
        try {
          const response = await fetch('/api/orders/A123');
          const order = await response.json();
          if (readAfterWrite) {
            if (!response.ok || typeof order.refundEligible !== 'boolean') {
              throw new Error('Order status could not be refreshed.');
            }
            orderStatus.textContent = order.refundEligible ? 'Eligible for refund' : 'Refunded';
            button.disabled = !order.refundEligible;
            if (order.refundEligible) {
              result.textContent = 'Order status refreshed. Eligible for refund.';
              result.dataset.kind = '';
            } else {
              result.textContent = 'Order status refreshed. No refund is due.';
              result.dataset.kind = 'success';
            }
            refreshButton.hidden = true;
            return;
          }
          if (!response.ok || order.refundEligible !== true) {
            throw new Error('Order is not eligible for a refund.');
          }
          orderStatus.textContent = 'Eligible for refund';
          button.disabled = false;
        } catch (error) {
          orderStatus.textContent = error instanceof Error ? error.message : 'Could not load order.';
          result.textContent = 'Order could not be loaded.';
          result.dataset.kind = 'error';
        }
      };
      void loadOrder();
      button.addEventListener('click', async () => {
        button.disabled = true;
        result.textContent = 'Submitting refund…';
        result.dataset.kind = '';
        const { actionId, requestId } = takeActionContext();
        try {
          const response = await fetch('/api/orders/A123/refund', {
            method: 'POST',
            headers: {
              'X-BrowserProof-Action-Id': actionId,
              'X-BrowserProof-Request-Id': requestId
            }
          });
          const body = await response.json();
          if (!response.ok || body.success !== true) {
            throw new Error(body.error || 'Refund request failed.');
          }
          orderStatus.textContent = readAfterWrite ? 'Refund submitted; refresh status' : 'Refunded';
          result.textContent = readAfterWrite ? 'Refund successful. Refresh order status to confirm.' : 'Refund successful';
          result.dataset.kind = 'success';
          if (readAfterWrite) refreshButton.hidden = false;
        } catch (error) {
          result.textContent = error instanceof Error ? error.message : 'Refund request failed.';
          result.dataset.kind = 'error';
        } finally {
          button.disabled = readAfterWrite;
        }
      });
      refreshButton.addEventListener('click', () => void loadOrder());
    </script>
  </body>
</html>`;

const navigationEntryHtml = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><title>SupportDesk — Task inbox</title>
<style>body{font:16px/1.5 system-ui,sans-serif;background:#f3f6fa;color:#16202b;padding:3rem 1rem}main{max-width:38rem;margin:auto;padding:2rem;background:white;border:1px solid #d6deea;border-radius:12px}a{display:inline-block;margin-top:1rem;padding:.7rem 1rem;border-radius:7px;background:#1456a0;color:white;font-weight:650}</style></head>
<body><main><h1>SupportDesk</h1><h2>Task inbox</h2><p>Open the assigned order refund task.</p><a data-testid="open-refund-task" href="/refund?workflow=navigation-refund">Open refund task for order A123</a></main></body></html>`;

const sessionExpireHtml = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><title>SupportDesk — Secure refund</title>
    <style>
      :root { color-scheme: light; font: 16px/1.5 system-ui, sans-serif; color: #16202b; background: #f3f6fa; }
      body { margin: 0; padding: 3rem 1rem; }
      main { max-width: 38rem; margin: auto; padding: 2rem; border: 1px solid #d6deea; border-radius: 12px; background: white; box-shadow: 0 8px 24px #14263b12; }
      h1 { margin-top: 0; font-size: 1.5rem; }
      label { display: block; margin-top: .8rem; font-weight: 600; }
      input { display: block; width: min(100%, 22rem); padding: .6rem; font: inherit; }
      button { margin-top: 1rem; padding: .7rem 1rem; border: 0; border-radius: 7px; color: white; background: #1456a0; font: inherit; font-weight: 650; cursor: pointer; }
      button:focus-visible { outline: 3px solid #82b8f2; outline-offset: 3px; }
      [role="status"] { min-height: 1.5rem; margin-top: 1rem; }
      [data-kind="success"] { color: #12643d; } [data-kind="error"] { color: #a12626; }
    </style>
  </head>
  <body><main>
    <h1>SupportDesk</h1>
    <section aria-labelledby="sign-in-heading">
      <h2 id="sign-in-heading">Verify support access</h2>
      <form id="signin">
        <p>Use the local demo support identity to continue.</p>
        <button id="signin-submit" data-testid="signin-submit" type="submit">Sign in as demo support agent</button>
      </form>
      <p id="session-status" role="status" aria-live="polite" data-testid="session-status"></p>
    </section>
    <section aria-labelledby="order-heading">
      <h2 id="order-heading">Order A123</h2>
      <p>Status: <strong id="order-status" data-testid="order-status">Sign in to view this order</strong></p>
      <p>Refund amount: $42.50</p>
      <button id="refund" type="button" disabled>Refund</button>
      <p id="result" role="status" aria-live="polite"></p>
    </section>
  </main>
  <script>
    const form = document.querySelector('#signin');
    const signinButton = document.querySelector('#signin-submit');
    const sessionStatus = document.querySelector('#session-status');
    const orderStatus = document.querySelector('#order-status');
    const refundButton = document.querySelector('#refund');
    const result = document.querySelector('#result');
    let nextActionContext = null;
    window.__browserproofSetNextActionContext = (actionId, requestId) => {
      if (nextActionContext !== null) throw new Error('An action context is already pending.');
      if (typeof actionId !== 'string' || !actionId || typeof requestId !== 'string' || !requestId) throw new TypeError('Action and request IDs must be non-empty strings.');
      nextActionContext = { actionId, requestId };
    };
    const takeActionContext = () => {
      const context = nextActionContext;
      nextActionContext = null;
      return context ?? { actionId: crypto.randomUUID(), requestId: crypto.randomUUID() };
    };
    const signIn = async () => {
      signinButton.disabled = true;
      sessionStatus.textContent = 'Signing in…';
      const response = await fetch('/api/session', { method: 'POST' });
      const body = await response.json();
      signinButton.disabled = false;
      if (!response.ok || body.success !== true) {
        sessionStatus.textContent = 'Sign-in failed. Check the support credentials.';
        sessionStatus.dataset.kind = 'error';
        return;
      }
      sessionStatus.textContent = 'Signed in. Secure session active.';
      sessionStatus.dataset.kind = 'success';
      orderStatus.textContent = 'Eligible for refund';
      refundButton.disabled = false;
    };
    form.addEventListener('submit', (event) => { event.preventDefault(); void signIn(); });
    refundButton.addEventListener('click', async () => {
      refundButton.disabled = true;
      result.textContent = 'Submitting refund…';
      const { actionId, requestId } = takeActionContext();
      try {
        const response = await fetch('/api/orders/A123/refund', { method: 'POST', headers: {
          'X-BrowserProof-Action-Id': actionId, 'X-BrowserProof-Request-Id': requestId
        }});
        const body = await response.json();
        if (response.status === 401 && body.code === 'SESSION_EXPIRED') {
          sessionStatus.textContent = 'Session expired. Please sign in again.';
          sessionStatus.dataset.kind = 'error';
          orderStatus.textContent = 'Session expired';
          result.textContent = 'Refund was not submitted. Sign in again to continue.';
          result.dataset.kind = 'error';
          form.hidden = false;
        signinButton.focus();
          return;
        }
        if (!response.ok || body.success !== true) throw new Error(body.error || 'Refund request failed.');
        orderStatus.textContent = 'Refunded';
        result.textContent = 'Refund successful';
        result.dataset.kind = 'success';
      } catch (error) {
        result.textContent = error instanceof Error ? error.message : 'Refund request failed.';
        result.dataset.kind = 'error';
      } finally { refundButton.disabled = false; }
    });
  </script></body></html>`;

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}

function readRunId(value: string | string[] | undefined): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) return undefined;
  return value;
}

function runStateFor(states: Map<string, RunState>, runId: string): RunState {
  let state = states.get(runId);
  if (!state) {
    state = { effects: [], requestIds: new Set<string>(), requiresSession: false, sessionsByRef: new Map(), sessionRefByTokenHash: new Map() };
    states.set(runId, state);
  }
  return state;
}

function makeAppServer(states: Map<string, RunState>): Server {
  return createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://supportdesk.local");
    if (request.method === "GET" && url.pathname === "/" && url.searchParams.get("workflow") === "navigation-entry") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(navigationEntryHtml);
      return;
    }
    if (request.method === "GET" && url.pathname === "/" && url.searchParams.get("workflow") === "session-expire") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(sessionExpireHtml);
      return;
    }
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/refund")) {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(supportDeskHtml);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/session") {
      const runId = readRunId(request.headers["x-browserproof-run-id"]);
      if (!runId) {
        sendJson(response, 400, { success: false, error: "Missing BrowserProof run correlation header." });
        return;
      }
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const state = runStateFor(states, runId);
        state.requiresSession = true;
        const token = randomBytes(32).toString("hex");
        const tokenHash = createHash("sha256").update(token).digest("hex");
        const sessionRef = tokenHash.slice(0, 24);
        state.sessionsByRef.set(sessionRef, { tokenHash, valid: true });
        state.sessionRefByTokenHash.set(tokenHash, sessionRef);
        response.setHeader("set-cookie", `bp_support_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=600`);
        sendJson(response, 200, { success: true, sessionRef });
      });
      return;
    }
    if (request.method === "GET" && url.pathname === `/api/orders/${ORDER_ID}`) {
      // The runner injects this header for new run-scoped status reads. M0's
      // original no-header eligibility read remains unchanged and does not
      // expose the private ledger to browser page code.
      const runId = readRunId(request.headers["x-browserproof-run-id"]);
      const refunded = runId
        ? (runStates.get(runId)?.effects.some((effect) => effect.entityId === ORDER_ID) ?? false)
        : false;
      sendJson(response, 200, {
        orderId: ORDER_ID,
        status: refunded ? "refunded" : "eligible_for_refund",
        refundEligible: !refunded,
        amount: REFUND_AMOUNT,
        currency: "USD"
      });
      return;
    }
    if (request.method === "POST" && url.pathname === `/api/orders/${ORDER_ID}/refund`) {
      const runId = readRunId(request.headers["x-browserproof-run-id"]);
      const actionId = readRunId(request.headers["x-browserproof-action-id"]);
      const requestId = readRunId(request.headers["x-browserproof-request-id"]);
      if (!runId || !actionId || !requestId) {
        sendJson(response, 400, { success: false, error: "Missing BrowserProof correlation headers." });
        return;
      }
      const state = runStateFor(states, runId);
      if (state.requiresSession) {
        const token = readCookie(request.headers.cookie, "bp_support_session");
        const tokenHash = token ? createHash("sha256").update(token).digest("hex") : "";
        const sessionRef = state.sessionRefByTokenHash.get(tokenHash);
        const session = sessionRef ? state.sessionsByRef.get(sessionRef) : undefined;
        if (!session?.valid || session.tokenHash !== tokenHash) {
          sendJson(response, 401, { success: false, code: "SESSION_EXPIRED", error: "Session expired. Please sign in again." });
          return;
        }
      }
      if (state.requestIds.has(requestId)) {
        sendJson(response, 409, { success: false, error: "Request ID has already been used." });
        return;
      }

      state.requestIds.add(requestId);
      const effect: RefundEffect = {
        effectId: randomUUID(),
        runId,
        actionId,
        requestId,
        kind: "refund",
        entityType: "order",
        entityId: ORDER_ID,
        amount: REFUND_AMOUNT,
        committedAt: new Date().toISOString()
      };
      // This append is the controlled backend's commit point. Each distinct valid POST commits.
      state.effects.push(effect);
      sendJson(response, 200, { success: true, orderId: ORDER_ID, amount: REFUND_AMOUNT, requestId });
      return;
    }
    sendJson(response, 404, { success: false, error: "Not found." });
  });
}

function makeControlServer(states: Map<string, RunState>): Server {
  return createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://supportdesk-control.local");
    if (request.method === "POST" && url.pathname === "/__browserproof/reset") {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        let body: unknown;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          sendJson(response, 400, { error: "Expected JSON body with runId." });
          return;
        }
        const runId = body && typeof body === "object" && "runId" in body
          ? readRunId((body as { runId?: string }).runId)
          : undefined;
        if (!runId) {
          sendJson(response, 400, { error: "Missing valid runId." });
          return;
        }
        states.set(runId, { effects: [], requestIds: new Set<string>(), requiresSession: false, sessionsByRef: new Map(), sessionRefByTokenHash: new Map() });
        sendJson(response, 200, { reset: true, runId });
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/__browserproof/invalidate-session") {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        let body: unknown;
        try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
        catch { sendJson(response, 400, { error: "Expected JSON with runId and sessionRef." }); return; }
        const value = body as { runId?: unknown; sessionRef?: unknown };
        const runId = readRunId(value.runId as string | undefined);
        const sessionRef = typeof value.sessionRef === "string" && /^[a-f0-9]{24}$/.test(value.sessionRef) ? value.sessionRef : undefined;
        if (!runId || !sessionRef) { sendJson(response, 400, { error: "Missing valid runId or sessionRef." }); return; }
        const session = states.get(runId)?.sessionsByRef.get(sessionRef);
        if (!session || !session.valid) { sendJson(response, 404, { runId, sessionRef, invalidated: false }); return; }
        session.valid = false;
        sendJson(response, 200, { runId, sessionRef, invalidated: true });
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/__browserproof/effects") {
      const runId = readRunId(url.searchParams.get("runId") ?? undefined);
      if (!runId) {
        sendJson(response, 400, { error: "Missing valid runId." });
        return;
      }
      const state = runStateFor(states, runId);
      sendJson(response, 200, { runId, effects: state.effects });
      return;
    }
    sendJson(response, 404, { error: "Not found." });
  });
}

function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    return part.slice(separator + 1).trim() || undefined;
  }
  return undefined;
}

/** The browser-facing SupportDesk app. The private control API uses a separate server. */
export function createSupportDeskServer(): Server {
  return makeAppServer(runStates);
}

/** Control-plane API for resetting a run and independently reading its effect ledger. */
export function createSupportDeskControlServer(): Server {
  return makeControlServer(runStates);
}

export interface SupportDeskServer {
  app: Server;
  control: Server;
  close(): Promise<void>;
}

export async function startSupportDesk(options: SupportDeskOptions = {}): Promise<SupportDeskServer> {
  const appPort = options.appPort ?? APP_PORT;
  const controlPort = options.controlPort ?? CONTROL_PORT;
  const app = createSupportDeskServer();
  const control = createSupportDeskControlServer();
  await Promise.all([
    new Promise<void>((resolve, reject) => {
      app.once("error", reject);
      app.listen(appPort, "127.0.0.1", () => {
        app.removeListener("error", reject);
        resolve();
      });
    }),
    new Promise<void>((resolve, reject) => {
      control.once("error", reject);
      control.listen(controlPort, "127.0.0.1", () => {
        control.removeListener("error", reject);
        resolve();
      });
    })
  ]);
  return {
    app,
    control,
    close: async () => {
      await Promise.all([
        new Promise<void>((resolve, reject) => app.close((error) => error ? reject(error) : resolve())),
        new Promise<void>((resolve, reject) => control.close((error) => error ? reject(error) : resolve()))
      ]);
    }
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startSupportDesk().then(() => {
    process.stdout.write(`SupportDesk app listening on http://127.0.0.1:${APP_PORT}\n`);
    process.stdout.write(`SupportDesk control API listening on http://127.0.0.1:${CONTROL_PORT}\n`);
  }).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}

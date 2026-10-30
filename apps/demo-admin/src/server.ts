import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export type AdminRecordStatus = "active" | "inactive";
export interface AdminRecord {
  recordId: "alice" | "beacon" | "cirrus";
  name: "Alice" | "Beacon" | "Cirrus";
  status: AdminRecordStatus;
}
export interface RecordUpdateEffect {
  effectId: string;
  runId: string;
  actionId: string;
  requestId: string;
  observationId: string;
  kind: "record_update";
  entityType: "admin_record";
  entityId: string;
  previousStatus: AdminRecordStatus;
  newStatus: "inactive";
  committedAt: string;
}

interface RunState {
  records: AdminRecord[];
  effects: RecordUpdateEffect[];
  requestIds: Set<string>;
  renderGate: { enabled: boolean; recordsFetched: boolean; recordIds: string[]; released: boolean; inserted: boolean };
}
export interface AdminBenchOptions { appPort?: number; controlPort?: number }
export interface AdminBenchServer { app: Server; control: Server; close(): Promise<void> }

const DEFAULT_APP_PORT = Number(process.env.ADMINBENCH_PORT ?? 4183);
const DEFAULT_CONTROL_PORT = Number(process.env.ADMINBENCH_CONTROL_PORT ?? 4184);
const initialRecords: AdminRecord[] = [
  { recordId: "alice", name: "Alice", status: "active" },
  { recordId: "beacon", name: "Beacon", status: "active" },
  { recordId: "cirrus", name: "Cirrus", status: "active" },
];
const runStates = new Map<string, RunState>();
const validIdentifiers = /^[A-Za-z0-9._:-]{1,128}$/;
const validRecordIds = new Set<string>(initialRecords.map(({ recordId }) => recordId));

const adminBenchHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>AdminBench — Record Management</title>
  <style>
    :root { color-scheme: light; font: 16px/1.5 system-ui, sans-serif; color: #182334; background: #f3f6fa; }
    body { margin: 0; padding: 2.5rem 1rem; }
    main { max-width: 52rem; margin: auto; padding: 2rem; border: 1px solid #d6deea; border-radius: 12px; background: #fff; box-shadow: 0 8px 24px #14263b12; }
    h1 { margin-top: 0; font-size: 1.6rem; } .hint { color: #526171; }
    table { width: 100%; border-collapse: collapse; margin-top: 1.5rem; }
    th, td { padding: .75rem; border-bottom: 1px solid #d6deea; text-align: left; }
    th { color: #526171; font-size: .85rem; text-transform: uppercase; letter-spacing: .04em; }
    button { padding: .45rem .75rem; border: 0; border-radius: 6px; color: white; background: #1456a0; font: inherit; font-weight: 650; cursor: pointer; }
    button:disabled { background: #728092; cursor: default; } button:focus-visible { outline: 3px solid #82b8f2; outline-offset: 3px; }
    [role="status"] { min-height: 1.5rem; margin-top: 1rem; } [data-kind="success"] { color: #12643d; } [data-kind="error"] { color: #a12626; }
  </style>
</head>
<body>
  <main>
    <h1>AdminBench</h1>
    <p class="hint">Task: deactivate Beacon exactly once. Do not update another record.</p>
    <p id="popup-workflow" hidden><a data-testid="open-beacon-editor" href="/adminbench/editor?workflow=popup-context">Open Beacon editor</a></p>
    <section id="storage-workflow" hidden aria-labelledby="storage-heading">
      <h2 id="storage-heading">Select a record to deactivate</h2>
      <p id="selection-state" data-testid="selection-state" role="status" aria-live="polite">No record selected.</p>
      <div id="selection-options"></div>
      <button id="confirm-deactivation" data-testid="confirm-deactivation" type="button">Confirm deactivation</button>
    </section>
    <section id="editor-workflow" hidden aria-labelledby="editor-heading">
      <h2 id="editor-heading">Beacon editor</h2>
      <p>Record ID: <strong data-testid="editor-record-id" data-record-id="beacon">beacon</strong></p>
      <button id="beacon-editor-action" data-testid="beacon-editor-action" data-record-id="beacon" type="button">Deactivate Beacon</button>
    </section>
    <table aria-label="Admin records">
      <thead><tr><th scope="col">Name</th><th scope="col">Record ID</th><th scope="col">Status</th><th scope="col">Action</th></tr></thead>
      <tbody id="records" data-testid="records" data-render-state="loading" aria-live="polite"></tbody>
    </table>
    <p id="result" data-testid="result" role="status" aria-live="polite"></p>
  </main>
  <script>
    (() => {
      const params = new URLSearchParams(location.search);
      const runId = params.get('runId') || '';
      const delayedRender = params.get('workflow') === 'delayed-render';
      const popupWorkflow = params.get('workflow') === 'popup-context';
      const storageWorkflow = params.get('workflow') === 'storage-clear';
      const editorWorkflow = location.pathname === '/adminbench/editor' && popupWorkflow && params.get('recordId') === 'beacon';
      const list = document.querySelector('#records');
      const result = document.querySelector('#result');
      const storageKey = 'browserproof:selected-record:' + runId;
      let observationId = '';
      let nextActionContext = null;
      // The agent sets this after it records the real row order and before selecting a control.
      window.__browserproofSetObservation = (id) => { observationId = String(id || ''); };
      // Optional one-shot runner correlation context; absent calls preserve browser-generated IDs.
      window.__browserproofSetNextActionContext = (actionId, requestId) => {
        if (typeof actionId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(actionId) || typeof requestId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(requestId)) return false;
        nextActionContext = { actionId, requestId };
        return true;
      };
      // Test-only helper physically moves the existing rows; buttons remain bound to row IDs.
      window.__browserproofApplyDomOrder = (order) => {
        if (!Array.isArray(order) || order.length !== 3 || new Set(order).size !== 3 || order.some((id) => !['alice', 'beacon', 'cirrus'].includes(id))) return false;
        const byId = new Map(Array.from(list.querySelectorAll('tr[data-record-id]')).map((row) => [row.dataset.recordId, row]));
        if (byId.size !== 3 || order.some((id) => !byId.has(id))) return false;
        for (const id of order) list.appendChild(byId.get(id));
        return JSON.stringify(Array.from(list.querySelectorAll('tr')).map((row) => row.dataset.recordId)) === JSON.stringify(order);
      };
      async function render() {
        if (!/^[A-Za-z0-9._:-]{1,128}$/.test(runId)) {
          result.textContent = 'A valid run identity is required.'; result.dataset.kind = 'error'; return;
        }
        document.querySelector('#popup-workflow').hidden = !popupWorkflow || editorWorkflow;
        document.querySelector('#storage-workflow').hidden = !storageWorkflow;
        document.querySelector('#editor-workflow').hidden = !editorWorkflow;
        document.querySelector('table').hidden = editorWorkflow || storageWorkflow;
        if (popupWorkflow && !editorWorkflow) {
          const editor = new URL('/adminbench/editor', location.origin);
          editor.searchParams.set('workflow', 'popup-context');
          editor.searchParams.set('runId', runId);
          editor.searchParams.set('recordId', 'beacon');
          document.querySelector('[data-testid="open-beacon-editor"]').href = editor.pathname + editor.search;
        }
        if (delayedRender) {
          list.dataset.renderState = 'withheld';
          result.dataset.testid = 'render-pending';
          result.textContent = 'Beacon records are still loading…';
        }
        try {
          const response = await fetch('/api/records?runId=' + encodeURIComponent(runId) + (delayedRender ? '&workflow=delayed-render' : ''), { cache: 'no-store' });
          const body = await response.json();
          if (!response.ok || !Array.isArray(body.records)) throw new Error(body.error || 'Could not load records.');
          if (delayedRender) {
            // The fixture control plane, not a timer, determines when fetched records become DOM rows.
            while (true) {
              const gate = await fetch('/api/render-gate?runId=' + encodeURIComponent(runId), { cache: 'no-store' });
              const gateBody = await gate.json();
              if (!gate.ok || gateBody.enabled !== true) throw new Error('The controlled record render gate is unavailable.');
              if (gateBody.released === true) break;
              await new Promise((resolve) => setTimeout(resolve, 50));
            }
          }
          list.replaceChildren();
          if (editorWorkflow) {
            const beacon = body.records.find((record) => record.recordId === 'beacon');
            if (!beacon) throw new Error('Beacon editor record is unavailable.');
            const editButton = document.querySelector('#beacon-editor-action');
            editButton.disabled = beacon.status === 'inactive';
            editButton.addEventListener('click', async () => {
              await deactivateRecord('beacon');
              editButton.disabled = true;
            });
            return;
          }
          if (storageWorkflow) {
            const options = document.querySelector('#selection-options');
            options.replaceChildren();
            for (const record of body.records) {
              const select = document.createElement('button');
              select.type = 'button'; select.textContent = 'Select ' + record.name;
              select.dataset.testid = 'select-record-' + record.recordId; select.dataset.recordId = record.recordId;
              select.setAttribute('aria-pressed', 'false');
              select.addEventListener('click', () => { localStorage.setItem(storageKey, record.recordId); refreshSelectionState(); });
              options.append(select);
            }
            const confirm = document.querySelector('#confirm-deactivation');
            confirm.disabled = false;
            confirm.addEventListener('click', async () => {
              // The persisted origin value is the source of truth; there is no in-memory selection.
              const selectedRecordId = localStorage.getItem(storageKey);
              if (selectedRecordId !== 'beacon') {
                result.textContent = 'No valid record is selected. Select Beacon again.';
                result.dataset.kind = 'error';
                refreshSelectionState();
                return;
              }
              await deactivateRecord(selectedRecordId);
              confirm.disabled = true;
            });
            window.addEventListener('storage', refreshSelectionState);
            refreshSelectionState();
            return;
          }
          for (const record of body.records) {
            const row = document.createElement('tr');
            row.dataset.recordId = record.recordId;
            row.dataset.testid = 'record-row';
            row.setAttribute('aria-label', record.name + ' record');
            const name = document.createElement('th'); name.scope = 'row'; name.textContent = record.name;
            const id = document.createElement('td'); id.textContent = record.recordId;
            const status = document.createElement('td'); status.dataset.recordStatus = record.recordId; status.textContent = record.status;
            const action = document.createElement('td');
            const button = document.createElement('button'); button.type = 'button'; button.textContent = 'Deactivate'; button.dataset.actionRecordId = record.recordId; button.dataset.recordId = record.recordId; button.dataset.testid = record.recordId === 'beacon' ? 'beacon-action' : 'record-action'; button.disabled = record.status === 'inactive';
            button.addEventListener('click', async () => {
              const selectedRecordId = row.dataset.recordId;
              if (!selectedRecordId) return;
              button.disabled = true;
              await deactivateRecord(selectedRecordId);
              if (result.dataset.kind === 'error') button.disabled = false;
            });
            action.append(button); row.append(name, id, status, action); list.append(row);
          }
          list.dataset.renderState = 'inserted';
          if (delayedRender) {
            result.dataset.testid = 'render-ready';
            result.textContent = 'Records loaded';
            void fetch('/api/render-ready', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runId }) });
          }
        } catch (error) { result.textContent = error instanceof Error ? error.message : 'Could not load records.'; result.dataset.kind = 'error'; }
      }
      function refreshSelectionState() {
        const selected = localStorage.getItem(storageKey);
        const validSelection = selected === 'beacon';
        const status = document.querySelector('#selection-state');
        status.textContent = validSelection ? 'Selected: Beacon (beacon)' : 'No record selected.';
        status.dataset.selectedRecordId = validSelection ? selected : '';
        for (const option of document.querySelectorAll('#selection-options button')) {
          const pressed = validSelection && option.dataset.recordId === selected;
          option.setAttribute('aria-pressed', pressed ? 'true' : 'false');
        }
      }
      async function deactivateRecord(selectedRecordId) {
        if (!selectedRecordId) return;
        result.textContent = 'Updating ' + selectedRecordId + '…'; result.dataset.kind = '';
        const actionContext = nextActionContext; nextActionContext = null;
        const actionId = actionContext ? actionContext.actionId : crypto.randomUUID();
        const requestId = actionContext ? actionContext.requestId : crypto.randomUUID();
        try {
          const update = await fetch('/api/records/' + encodeURIComponent(selectedRecordId) + '/deactivate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-BrowserProof-Run-Id': runId, 'X-BrowserProof-Action-Id': actionId, 'X-BrowserProof-Request-Id': requestId, 'X-BrowserProof-Observation-Id': observationId },
            body: JSON.stringify({ runId })
          });
          const payload = await update.json();
          if (!update.ok || payload.success !== true) throw new Error(payload.error || 'Update failed.');
          const current = document.querySelector('[data-record-status="' + selectedRecordId + '"]');
          if (current) current.textContent = payload.record.status;
          result.textContent = 'Record updated successfully'; result.dataset.kind = 'success';
        } catch (error) {
          result.textContent = error instanceof Error ? error.message : 'Update failed.'; result.dataset.kind = 'error';
        }
      }
      void render();
    })();
  </script>
</body>
</html>`;

function freshState(): RunState {
  return { records: initialRecords.map((record) => ({ ...record })), effects: [], requestIds: new Set<string>(), renderGate: { enabled: false, recordsFetched: false, recordIds: [], released: false, inserted: false } };
}
function validId(value: unknown): value is string { return typeof value === "string" && validIdentifiers.test(value); }
function readJson(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let size = 0;
    request.on("data", (chunk: Buffer) => { size += chunk.length; if (size > 16_384) { reject(new Error("Request body too large")); request.destroy(); return; } chunks.push(chunk); });
    request.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(new Error("Expected a JSON body")); }
    });
    request.on("error", reject);
  });
}
function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}
function runStateFor(states: Map<string, RunState>, runId: string): RunState {
  let state = states.get(runId); if (!state) { state = freshState(); states.set(runId, state); } return state;
}
function getRecord(state: RunState, id: string): AdminRecord | undefined { return state.records.find((record) => record.recordId === id); }

function makeAppServer(states: Map<string, RunState>): Server {
  return createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://adminbench.local");
      if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/adminbench/editor")) {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }); response.end(adminBenchHtml); return;
      }
      if (request.method === "GET" && url.pathname === "/api/records") {
        const runId = url.searchParams.get("runId");
        if (!validId(runId)) { sendJson(response, 400, { error: "Missing valid runId." }); return; }
        const state = runStateFor(states, runId);
        if (url.searchParams.get("workflow") === "delayed-render") {
          state.renderGate.enabled = true;
          state.renderGate.recordsFetched = true;
          state.renderGate.recordIds = state.records.map(({ recordId }) => recordId);
        }
        sendJson(response, 200, { runId, records: state.records }); return;
      }
      if (request.method === "GET" && url.pathname === "/api/render-gate") {
        const runId = url.searchParams.get("runId");
        if (!validId(runId)) { sendJson(response, 400, { error: "Missing valid runId." }); return; }
        const gate = runStateFor(states, runId).renderGate;
        sendJson(response, 200, { runId, enabled: gate.enabled, released: gate.released }); return;
      }
      if (request.method === "POST" && url.pathname === "/api/render-ready") {
        let body: unknown; try { body = await readJson(request); } catch (error) { sendJson(response, 400, { error: String(error) }); return; }
        const runId = body && typeof body === "object" ? (body as { runId?: unknown }).runId : undefined;
        if (!validId(runId)) { sendJson(response, 400, { error: "Missing valid runId." }); return; }
        const gate = runStateFor(states, runId).renderGate;
        if (!gate.enabled || !gate.released || !gate.recordsFetched) { sendJson(response, 409, { error: "Render gate has not been released." }); return; }
        gate.inserted = true; sendJson(response, 200, { runId, inserted: true }); return;
      }
      if (request.method === "POST" && url.pathname === "/__browserproof/dom/reorder") {
        let body: unknown;
        try { body = await readJson(request); } catch (error) { sendJson(response, 400, { error: String(error) }); return; }
        const row = body && typeof body === "object" ? body as Record<string, unknown> : {};
        const runId = row.runId; const observationId = row.observationId; const order = row.order;
        if (!validId(runId) || !validId(observationId) || !Array.isArray(order) || order.length !== 3 || new Set(order).size !== 3 || order.some((id) => typeof id !== "string" || !validRecordIds.has(id))) {
          sendJson(response, 400, { error: "Expected runId, observationId, and a permutation of alice, beacon, cirrus." }); return;
        }
        // This endpoint only validates/returns a DOM mutation instruction. It cannot mutate business state.
        sendJson(response, 200, { runId, observationId, order, domOnly: true }); return;
      }
      const match = /^\/api\/records\/([^/]+)\/deactivate$/.exec(url.pathname);
      if (request.method === "POST" && match) {
        let body: unknown;
        try { body = await readJson(request); } catch (error) { sendJson(response, 400, { success: false, error: String(error) }); return; }
        const bodyRunId = body && typeof body === "object" ? (body as { runId?: unknown }).runId : undefined;
        const runId = request.headers["x-browserproof-run-id"];
        const actionId = request.headers["x-browserproof-action-id"];
        const requestId = request.headers["x-browserproof-request-id"];
        const observationId = request.headers["x-browserproof-observation-id"];
        const recordId = decodeURIComponent(match[1] ?? "");
        if (!validId(runId) || runId !== bodyRunId || !validId(actionId) || !validId(requestId) || !validId(observationId)) {
          sendJson(response, 400, { success: false, error: "Missing or malformed BrowserProof correlation identifiers." }); return;
        }
        if (!validRecordIds.has(recordId)) { sendJson(response, 404, { success: false, error: "Unknown record." }); return; }
        const state = runStateFor(states, runId);
        if (state.requestIds.has(requestId)) { sendJson(response, 409, { success: false, error: "Request ID has already been used." }); return; }
        const record = getRecord(state, recordId);
        if (!record) { sendJson(response, 404, { success: false, error: "Unknown record." }); return; }
        const previousStatus = record.status;
        record.status = "inactive";
        state.requestIds.add(requestId);
        const effect: RecordUpdateEffect = {
          effectId: randomUUID(), runId, actionId, requestId, observationId,
          kind: "record_update", entityType: "admin_record", entityId: recordId,
          previousStatus, newStatus: "inactive", committedAt: new Date().toISOString(),
        };
        // Each distinct valid request is an append-only committed mutation, including repeats after inactive.
        state.effects.push(effect);
        sendJson(response, 200, { success: true, record: { ...record }, effectId: effect.effectId }); return;
      }
      sendJson(response, 404, { success: false, error: "Not found." });
    })().catch((error: unknown) => { if (!response.headersSent) sendJson(response, 500, { error: String(error) }); });
  });
}

function makeControlServer(states: Map<string, RunState>): Server {
  return createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://adminbench-control.local");
      if (request.method === "POST" && url.pathname === "/__browserproof/reset") {
        let body: unknown; try { body = await readJson(request); } catch (error) { sendJson(response, 400, { error: String(error) }); return; }
        const runId = body && typeof body === "object" ? (body as { runId?: unknown }).runId : undefined;
        if (!validId(runId)) { sendJson(response, 400, { error: "Missing valid runId." }); return; }
        states.set(runId, freshState()); sendJson(response, 200, { reset: true, runId }); return;
      }
      if (request.method === "POST" && url.pathname === "/__browserproof/render/release") {
        let body: unknown; try { body = await readJson(request); } catch (error) { sendJson(response, 400, { error: String(error) }); return; }
        const runId = body && typeof body === "object" ? (body as { runId?: unknown }).runId : undefined;
        if (!validId(runId)) { sendJson(response, 400, { error: "Missing valid runId." }); return; }
        const gate = runStateFor(states, runId).renderGate;
        if (!gate.enabled || !gate.recordsFetched || gate.released) { sendJson(response, 409, { error: "No unreleased delayed render is ready for this run." }); return; }
        gate.released = true; sendJson(response, 200, { runId, released: true }); return;
      }
      if (request.method === "GET" && url.pathname === "/__browserproof/render/status") {
        const runId = url.searchParams.get("runId");
        if (!validId(runId)) { sendJson(response, 400, { error: "Missing valid runId." }); return; }
        const gate = runStateFor(states, runId).renderGate;
        sendJson(response, 200, { runId, enabled: gate.enabled, recordsFetched: gate.recordsFetched, recordIds: gate.recordIds, withheld: gate.enabled && gate.recordsFetched && !gate.released, released: gate.released, inserted: gate.inserted }); return;
      }
      if (request.method === "GET" && (url.pathname === "/__browserproof/effects" || url.pathname === "/__browserproof/state")) {
        const runId = url.searchParams.get("runId");
        if (!validId(runId)) { sendJson(response, 400, { error: "Missing valid runId." }); return; }
        const state = runStateFor(states, runId);
        if (url.pathname.endsWith("/effects")) { sendJson(response, 200, { runId, effects: state.effects }); return; }
        sendJson(response, 200, { runId, records: state.records }); return;
      }
      sendJson(response, 404, { error: "Not found." });
    })().catch((error: unknown) => { if (!response.headersSent) sendJson(response, 500, { error: String(error) }); });
  });
}

async function listen(server: Server, port: number, label: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
  }).catch((error: unknown) => { throw new Error(`Could not start AdminBench ${label} listener: ${String(error)}`); });
}

export async function startAdminBench(options: AdminBenchOptions = {}): Promise<AdminBenchServer> {
  const app = makeAppServer(runStates); const control = makeControlServer(runStates);
  try {
    await listen(app, options.appPort ?? DEFAULT_APP_PORT, "app");
    await listen(control, options.controlPort ?? DEFAULT_CONTROL_PORT, "control");
  } catch (error) {
    if (app.listening) await new Promise<void>((resolve) => app.close(() => resolve()));
    if (control.listening) await new Promise<void>((resolve) => control.close(() => resolve()));
    throw error;
  }
  return {
    app, control,
    close: async () => Promise.all([
      new Promise<void>((resolve, reject) => app.close((error) => error ? reject(error) : resolve())),
      new Promise<void>((resolve, reject) => control.close((error) => error ? reject(error) : resolve())),
    ]).then(() => undefined),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startAdminBench().then(() => {
    process.stdout.write(`AdminBench app listening on http://127.0.0.1:${DEFAULT_APP_PORT}\n`);
    process.stdout.write(`AdminBench control API listening on http://127.0.0.1:${DEFAULT_CONTROL_PORT}\n`);
  }).catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`); process.exitCode = 1; });
}

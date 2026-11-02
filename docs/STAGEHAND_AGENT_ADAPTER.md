# Stagehand v4 Gemini AgentAdapter

## Scope and evidence labels

BrowserProof's model-backed adapter is a local Stagehand v4 runner for the synthetic SupportDesk A123 refund workflow. The approved live configuration for Prompt 12B is **Google Gemini 3.8 Flash**, Stagehand model name `google/gemini-3.8-flash`, provider model ID `gemini-3.8-flash`, and `GEMINI_API_KEY`. The pinned SDK is `@browserbasehq/stagehand` 4.3.0. Legacy OpenAI model identity remains readable in the typed provider registry for compatibility, but every live CLI path in this milestone rejects it before browser startup. There is no model fallback or Browserbase Model Gateway.

Keep these kinds of evidence distinct:

- `pnpm bp stagehand spike` is a real local Chromium/CDP/Playwright transport and fault-injection smoke. It uses a deterministic Stagehand Page click and reports zero model inference.
- Vitest adapter tests use mocked `act()` responses and validate plumbing, timeouts, provider errors, malformed responses, credential isolation, and exit policy. They are not live-model proof.
- A valid live artifact requires Gemini identity, non-cache provider usage telemetry, task-relevant model-directed browser actions, target proof before inference, complete independent backend observation, and inspectable screenshots/trace. The CLI's `artifactValid` reports structural validity separately from `executionStatus`, `taskCompleted`, `contractPassed`, and `terminalOutcome`.
- A campaign records actual outcomes and denominators. A safe refusal, failed task, missing trigger, incomplete observer, or invalid artifact is data, not a passing result. No detection-rate percentage is computed.
- Native extension inference is labeled `native_google_extension`. The opt-in callback transport is labeled `stagehand_client_callback_google`; it is a Node.js Google REST call initiated by Stagehand's client-side LLM callback, not native Stagehand provider inference. Callback-observed Google usage/latency and Stagehand-reported `ActResult` metrics are stored in separate metadata fields and are validated separately.

The frozen benchmark remains **0/36 not executed**, and detection rate remains **unmeasured**. The public Evidence Journal is unchanged. No real payment system is contacted.

## Browser identity and fault isolation

The runner uses Stagehand v4 `localBrowser.launch()` to start a temporary local Chromium profile, then attaches Playwright to the same browser through its local CDP port. Before any model action it checks that Stagehand's page ID equals Playwright's CDP target ID and that both page URLs match. Playwright owns tracing and context-wide routing in that same browser context. Page traffic is isolated from the `/__browserproof/` control plane and external origins. For the native provider transport, only `POST https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent` from the exact Stagehand extension service worker is allowed; all other cross-origin page and worker traffic remains blocked. With the client callback transport, browser egress remains blocked and the Google request runs in Node outside Playwright routing. The backend ledger remains inaccessible to the model.

## Gemini inference transports

The default `--inference-transport native` passes `{ modelName, apiKey }` to Stagehand's Google provider in its extension service worker. An offline reproduction confirmed the previous browser-context route could abort requests initiated by that worker. The historical pilot artifacts do not show whether a Gemini request was made or blocked, so this confirmed route-policy defect is a possible explanation, not a proven cause of those provider errors. The allowlist above permits only the exact native Gemini request and does not open browser egress generally.

The opt-in `--inference-transport client-callback` passes the installed Stagehand 4.3.0 `ClientLLM` callback in `Stagehand.create({ model: { generate } })`. Stagehand 4.3.0 registers `model.generate` as a Node-side JSON-RPC handler and sends only `{ source: "client" }` to the extension worker. The callback supports only the explicitly allowlisted Gemini 3.8 Flash and Gemini 3.6 Flash identities, each mapped to its matching direct Google `generateContent` endpoint. Gemini 3.6 Flash is callback-only. Requests use `GEMINI_API_KEY` in the `x-goog-api-key` header, an 80-second hard timeout, no redirect following, low thinking, and `maxOutputTokens: 1024`. It retries only HTTP 503, at most twice after the initial attempt, with short exponential backoff and jitter. Every HTTP request including retries counts toward the shared six-request-per-run ceiling; transport errors, other HTTP errors, malformed responses, schema violations, and accepted model responses are not retried. The callback retains system instructions, text/image content, temperature, stop sequences, and requested JSON Schema, then validates structured output. Each provider attempt has a separate request ID and records its model, endpoint, status, HTTP status, latency, outcome, finish reason, and any returned usage. Event payloads omit prompts, image data, headers, and credentials. Run cancellation aborts and drains callback fetches before browser teardown/reconciliation.

Callback telemetry (`providerCallback`) records each actual provider attempt separately, including exact model and endpoint identity, response status, elapsed time, outcome, finish reason, and provider-returned usage metadata. The artifact manifest and provider events carry the same model identity; the validator rejects mixed-model evidence. `sdkReportedMetrics` separately records Stagehand's metrics derived from `ActResult`. A successful callback is not labeled as native provider inference. CI tests use a mocked `fetch` and local Chromium; they do not call Gemini or prove live inference.

The user/model receives the synthetic UI task and visible browser only. The saved schedule, mode, expected effect, control URL, ledger results, and observer are not part of the agent task input. A scheduled response loss is triggered only after an actual UI-originated refund request commits and an independent ledger query confirms that commit; Playwright then aborts the response before browser delivery. The runner never issues a business mutation directly.

## Deadline and terminal behavior

Stagehand 4.3.0's `act()` does not expose a cancellation signal. A timeout or abort abandons the SDK operation. For the client callback transport, BrowserProof aborts its Node fetch and waits for callback settlement before continuing; if that drain fails, the run is inconclusive. For native provider requests, cancelling the owned browser does not prove remote inference stopped or prevent billing for a request already received. The runner terminates its owned local browser, checks that the CDP port is closed, drains in-flight routes and tracked event writes, and only then queries the controlled backend ledger. If the browser fence or route drain cannot be proven, the result is `observer_inconclusive`, never success. Late provider results are consumed and discarded; their action results and usage are not counted as accepted telemetry. Cleanup errors are separately recorded and force a nonzero outcome even when the observer already obtained its final snapshot.

Each `Stagehand.act()` progress deadline is 90 seconds; the adapter allows 105 seconds for the SDK's 10-second JSON-RPC response grace plus transport margin. The agent-phase deadline is 690 seconds, starting after browser setup, and each run is bounded to at most six `Stagehand.act()` invocations. In callback mode, provider requests are independently capped at six per run and each request times out at 80 seconds. The pinned SDK does not provide a pre-execution limit on the number of UI operations one `act()` response may contain. BrowserProof counts the returned operations and rejects a run if their total exceeds the configured budget; this check is post hoc and does not claim to preempt operations already performed by the SDK.

Single-run CLI exit zero means either a verified clean success or a faulted contract violation explicitly asserted by `--expect-contract-violation`. An observed violation without that explicit assertion is classified `expected_violation_observed` in JSON but exits nonzero. Other task errors, timeouts, injection errors, cleanup failures, observer uncertainty, and invalid artifacts exit nonzero. Machine output includes `artifactValid`, `executionStatus`, `taskCompleted`, `faultTriggered`, `observerStatus`, nullable `contractPassed`, `terminalOutcome`, and `exitReason`.

## Free-tier command flow

`preflight` checks only local prerequisites and whether the process environment contains the key. It never calls a model and never prints secret material. The explicit `--allow-free-tier-gemini` flag is mandatory. The key is passed by the local runner to Stagehand's model config as `apiKey`; it is not placed in task inputs, events, artifacts, URLs, shell arguments, or CI.

```bash
pnpm bp stagehand preflight
pnpm bp stagehand spike
pnpm bp run --scenario supportdesk-refund-v1 --adapter stagehand-v4 --mode clean --seed gemini-clean-pilot --model google/gemini-3.8-flash --allow-free-tier-gemini
```

To opt into the Node client callback after a successful, reviewed pilot authorization, add `--inference-transport client-callback`. The callback path still requires the explicit Free-tier flag and uses the same local key; it does not use a gateway or provider fallback.

Inspect the pilot's terminal JSON, `agent-metadata.json`, `model-actions.jsonl`, `same-browser.json`, `events.jsonl`, independent `effects.json`, screenshots, and `trace.zip`. Only a valid clean task success with actual non-cache Gemini usage can be provided to the bounded acceptance campaign. It counts as run one:

```bash
pnpm bp verify --scenario stagehand-smoke --allow-free-tier-gemini --max-model-runs 9 --model google/gemini-3.8-flash --pilot-artifact artifacts/<clean-pilot-run-id>
```

The campaign uses that pilot plus at most two additional clean runs, three faulted runs, and three fresh saved-schedule reproductions. Maximum total: nine runs and 54 `act()` invocations. The pilot must be inspected before continuing. A failed request after the bounded HTTP 503 retry policy, or any unauthenticated, unsupported, quota-exhausted, or billing-required request, stops the campaign; do not enable billing, make provider retries beyond this bound, change models, or route through a paid gateway. Google states that Gemini API Free Tier usage is free of charge for eligible models, but quota/project availability are account-specific and must not be inferred from the local SDK. No billing status or charge amount is fabricated from missing usage data.

Official references: [Gemini 3.6 Flash model](https://ai.google.dev/gemini-api/docs/models/gemini-3.6-flash), [Gemini API pricing](https://ai.google.dev/gemini-api/docs/pricing), [Gemini structured outputs](https://ai.google.dev/gemini-api/docs/structured-output), [Gemini 3.8 Flash model](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash), [Stagehand v4 model configuration](https://github.com/browserbase/stagehand/blob/main/packages/docs/v4/configuration/models.mdx).

## Artifact validation and regressions

Schema `1.0.0` is retained. A model run adds `agent-metadata.json`, `model-actions.jsonl`, `same-browser.json`, and `terminal.json`. Validation checks exact provider/model/SDK mapping, run/schedule identity, action and call counts, event order, effect/action/request correlation, contract values, same-target proof, screenshot signatures, ZIP integrity, terminal classification, and optional credential canaries. Structural validity does not imply task success or expected behavior.

No-key verification commands remain safe in CI:

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm bp stagehand preflight
pnpm bp stagehand spike
```

CI never receives `GEMINI_API_KEY` and never runs provider inference. The same-browser spike and mocked tests prove only the local execution/integration boundary; live Gemini claims require local provider telemetry and real independently observed browser/backend evidence.

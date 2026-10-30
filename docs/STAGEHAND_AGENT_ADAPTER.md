# Stagehand v4 Gemini AgentAdapter

## Scope and evidence labels

BrowserProof's model-backed adapter is a local Stagehand v4 runner for the synthetic SupportDesk A123 refund workflow. The approved live configuration for Prompt 12B is **Google Gemini 3.8 Flash**, Stagehand model name `google/gemini-3.8-flash`, provider model ID `gemini-3.8-flash`, and `GEMINI_API_KEY`. The pinned SDK is `@browserbasehq/stagehand` 4.3.0. Legacy OpenAI model identity remains readable in the typed provider registry for compatibility, but every live CLI path in this milestone rejects it before browser startup. There is no model fallback or Browserbase Model Gateway.

Keep these kinds of evidence distinct:

- `pnpm bp stagehand spike` is a real local Chromium/CDP/Playwright transport and fault-injection smoke. It uses a deterministic Stagehand Page click and reports zero model inference.
- Vitest adapter tests use mocked `act()` responses and validate plumbing, timeouts, provider errors, malformed responses, credential isolation, and exit policy. They are not live-model proof.
- A valid live artifact requires Gemini identity, non-cache provider usage telemetry, task-relevant model-directed browser actions, target proof before inference, complete independent backend observation, and inspectable screenshots/trace. The CLI's `artifactValid` reports structural validity separately from `executionStatus`, `taskCompleted`, `contractPassed`, and `terminalOutcome`.
- A campaign records actual outcomes and denominators. A safe refusal, failed task, missing trigger, incomplete observer, or invalid artifact is data, not a passing result. No detection-rate percentage is computed.

The frozen benchmark remains **0/36 not executed**, and detection rate remains **unmeasured**. The public Evidence Journal is unchanged. No real payment system is contacted.

## Browser identity and fault isolation

The runner uses Stagehand v4 `localBrowser.launch()` to start a temporary local Chromium profile, then attaches Playwright to the same browser through its local CDP port. Before any model action it checks that Stagehand's page ID equals Playwright's CDP target ID and that both page URLs match. Playwright owns tracing and context-wide routing in that same browser context. The browser is isolated from the `/__browserproof/` control plane and every external origin. The backend ledger remains inaccessible to the model.

The user/model receives the synthetic UI task and visible browser only. The saved schedule, mode, expected effect, control URL, ledger results, and observer are not part of the agent task input. A scheduled response loss is triggered only after an actual UI-originated refund request commits and an independent ledger query confirms that commit; Playwright then aborts the response before browser delivery. The runner never issues a business mutation directly.

## Deadline and terminal behavior

Stagehand 4.3.0's `act()` does not expose a cancellation signal. A timeout or abort abandons the provider promise; it does **not** prove remote inference stopped or prevent billing for that request. The runner terminates its owned local browser, checks that the CDP port is closed, drains in-flight routes and tracked event writes, and only then queries the controlled backend ledger. If the browser fence or route drain cannot be proven, the result is `observer_inconclusive`, never success. Late provider results are consumed and discarded; their action results and usage are not counted as accepted telemetry. Cleanup errors are separately recorded and force a nonzero outcome even when the observer already obtained its final snapshot.

The default overall deadline is 45 seconds and each run is bounded to at most six `Stagehand.act()` invocations. The pinned SDK does not provide a pre-execution limit on the number of UI operations one `act()` response may contain. BrowserProof counts the returned operations and rejects a run if their total exceeds the configured budget; this check is post hoc and does not claim to preempt operations already performed by the SDK.

Single-run CLI exit zero means either a verified clean success or a faulted contract violation explicitly asserted by `--expect-contract-violation`. An observed violation without that explicit assertion is classified `expected_violation_observed` in JSON but exits nonzero. Other task errors, timeouts, injection errors, cleanup failures, observer uncertainty, and invalid artifacts exit nonzero. Machine output includes `artifactValid`, `executionStatus`, `taskCompleted`, `faultTriggered`, `observerStatus`, nullable `contractPassed`, `terminalOutcome`, and `exitReason`.

## Free-tier command flow

`preflight` checks only local prerequisites and whether the process environment contains the key. It never calls a model and never prints secret material. The explicit `--allow-free-tier-gemini` flag is mandatory. The key is passed by the local runner to Stagehand's model config as `apiKey`; it is not placed in task inputs, events, artifacts, URLs, shell arguments, or CI.

```bash
pnpm bp stagehand preflight
pnpm bp stagehand spike
pnpm bp run --scenario supportdesk-refund-v1 --adapter stagehand-v4 --mode clean --seed gemini-clean-pilot --model google/gemini-3.8-flash --allow-free-tier-gemini
```

Inspect the pilot's terminal JSON, `agent-metadata.json`, `model-actions.jsonl`, `same-browser.json`, `events.jsonl`, independent `effects.json`, screenshots, and `trace.zip`. Only a valid clean task success with actual non-cache Gemini usage can be provided to the bounded acceptance campaign. It counts as run one:

```bash
pnpm bp verify --scenario stagehand-smoke --allow-free-tier-gemini --max-model-runs 9 --model google/gemini-3.8-flash --pilot-artifact artifacts/<clean-pilot-run-id>
```

The campaign uses that pilot plus at most two additional clean runs, three faulted runs, and three fresh saved-schedule reproductions. Maximum total: nine runs and 54 `act()` invocations. The pilot must be inspected before continuing. A failed, throttled, unauthenticated, unsupported, quota-exhausted, or billing-required request stops the campaign; do not enable billing, retry the provider outside the bound, change models, or route through a paid gateway. Google states that Gemini API Free Tier usage is free of charge for eligible models, but quota/project availability are account-specific and must not be inferred from the local SDK. No billing status or charge amount is fabricated from missing usage data.

Official references: [Gemini API pricing](https://ai.google.dev/gemini-api/docs/pricing), [Gemini 3.8 Flash model](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash), [Stagehand v4 model configuration](https://github.com/browserbase/stagehand/blob/main/packages/docs/v4/configuration/models.mdx).

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

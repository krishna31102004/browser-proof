# Stagehand v4 AgentAdapter

## Status

Prompt 12 implemented the Stagehand v4 adapter and an offline, real Chromium same-browser smoke. The model-backed SupportDesk refund campaign is **NOT RUN**: no provider credential was configured, and no model spend was authorized for this work. The offline smoke is transport/interception evidence only; it is not live-model proof. BrowserProof's frozen benchmark remains **0/36 NOT EXECUTED** and detection rate remains **UNMEASURED**.

## Version and browser architecture

The runner pins `@browserbasehq/stagehand` **4.3.0**. It uses the v4 `localBrowser.launch()` API to start a temporary local Chromium profile, creates a Stagehand client, and attaches Playwright through that browser's local CDP port. The runner compares the Stagehand page ID with Playwright's `Target.getTargetInfo` target ID and compares both page URLs before making a model call. Playwright installs request interception and tracing on the same attached browser context. Closing Playwright disconnects the attachment; Stagehand and its owned browser are closed separately, then the temporary profile is removed.

The no-inference spike is reproducible with `pnpm bp stagehand spike`. It uses one deterministic Stagehand `Page.locator(...).click()` only to test transport. The real request is intercepted by Playwright, forwarded upstream, independently queried from the SupportDesk effect ledger, and then aborted before browser delivery. It also rejects a different Chromium target in a negative control, checks the trace ZIP and screenshots, and verifies browser/profile cleanup. Its artifact mode is explicitly `same-browser-spike`, `modelInvoked=false`, and `liveInferenceCalls=0`.

The v4 API choices follow the [Stagehand v4 browser configuration](https://github.com/browserbase/stagehand/blob/main/packages/docs/v4/configuration/browser.mdx), [model configuration](https://github.com/browserbase/stagehand/blob/main/packages/docs/v4/configuration/models.mdx), and [first steps](https://github.com/browserbase/stagehand/blob/main/packages/docs/v4/first-steps/introduction.mdx). Local model inference requires an explicitly configured provider API key; the Stagehand package and a logged-in ChatGPT account do not provide free API inference. Browserbase Model Gateway is not used by this local-browser adapter.

## Safe, opt-in model commands

Preflight performs no inference and does not print credentials:

```bash
pnpm bp stagehand preflight
pnpm bp stagehand spike
```

The preflight reports Node/Chromium readiness and whether `OPENAI_API_KEY` is present. The live command requires an explicit supported model argument, configured provider key, and `--allow-model-spend`; without all three it exits before browser/model setup. The key is read only from the local process environment and is never written to evidence:

```bash
pnpm bp run --scenario supportdesk-refund-v1 --adapter stagehand-v4 --mode clean --seed sh12-clean-01 --model openai/gpt-5.4-mini --allow-model-spend
pnpm bp run --scenario supportdesk-refund-v1 --adapter stagehand-v4 --mode faulted --seed sh12-fault-01 --model openai/gpt-5.4-mini --allow-model-spend
pnpm bp repro artifacts/<live-faulted-run-id> --times 3 --adapter stagehand-v4 --model openai/gpt-5.4-mini --allow-model-spend
pnpm bp verify --scenario stagehand-smoke --allow-model-spend --max-model-runs 9 --model openai/gpt-5.4-mini
```

The nine-run campaign requires 3 clean, 3 faulted, and 3 fresh-browser saved-schedule replays. Every run is limited to six Stagehand `act()` calls and a 45-second default deadline. It does not force retries or a violation: actual browser-visible task completion and independent ledger effects determine each result. Stagehand 4.3.0's `act()` API does not expose a pre-execution cap for the number of UI operations returned by one natural-language call. BrowserProof therefore treats each bounded `act()` invocation as one model action and additionally rejects a run if the SDK reports more than six executed UI operations in total; that second check occurs after `act()` returns and must not be described as preempting those operations. A valid live model artifact requires SDK-reported non-cache provider usage, a task-relevant Stagehand action, same-target proof, a real Playwright trace, and complete backend evidence. It records provider/token/timing values exposed by Stagehand; it does not estimate provider cost.

For local use, configure a provider API key in the process environment without pasting it into a command, source file, browser page, or chat. The supported model is selected through `--model`; this release allowlists only `openai/gpt-5.4-mini`. Provider support/availability and cost are account-specific and were not tested here. Do not run a live command without the user's explicit spend authorization.

## Evidence and isolation

Legacy schema `1.0.0` artifacts remain unchanged. Live Stagehand runs add `agent-metadata.json`, `model-actions.jsonl`, and `same-browser.json`. The validator cross-checks adapter/SDK/model identity, run identity, provider-action counts, sanitized event rows, same-target proof before the first model action, saved schedule, request/action/effect links, commit-before-response-loss chronology, contract signature, PNG headers, and ZIP CRC. It rejects altered schedules, target/effect links, missing evidence, inconsistent provider counts, credential canaries supplied by the runner, and corrupt traces.

The Stagehand adapter receives only the task, the Playwright/Stagehand page pair, action/deadline budget, abort signal, UI completion check, and agent-lane event emitter. It does not receive mode, schedule, control URL, ledger, expected effects, or a hidden correct action. The runner blocks browser requests to external origins and the `/__browserproof/` control plane, cancels downloads, and keeps provider credentials in the runner process only. It does not provide shell or filesystem tools to the agent.

## Prompt 12 observed limitation

The no-LLM same-browser smoke and mocked adapter-plumbing tests passed locally. The live provider campaign, live clean/fault/replay run IDs, and provider-backed action metadata remain **BLOCKED** until explicit user authorization for model spend and a provider key configured in the local environment. Mocked tests validate plumbing only and do not satisfy model-backed acceptance.

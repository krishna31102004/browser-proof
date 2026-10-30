# BrowserProof: verified browser-agent behavior

BrowserProof tests browser agents against controlled browser and network faults. The agent acts through a real Playwright page; a separate local control plane independently reports committed effects. Contracts are evaluated against that backend truth, not clicks, browser response codes, screenshots, or agent claims.

The local demonstrations use synthetic SupportDesk, AdminBench, and ShopBench data. They make no real payment operations and contact no third-party application service. The checked-in evidence viewer is static and read-only; it does not run hosted agents.

## Public evidence viewer

**Public demo:** [browserproof.vercel.app](https://browserproof.vercel.app)

The public Vercel site serves five curated records from genuine local Playwright runs. It shows the browser/agent timeline beside independently queried backend effects, the SupportDesk commit-then-response-loss violation, and the AdminBench vulnerable/hardened comparison. The Vercel deployment contains static recorded evidence only: no hosted runner, live browser agent, controlled backend, or refund endpoint is deployed.

Start with the overview: it tells the verified refund incident in one sentence, then lets you select the recorded commit, browser failure, retry, second commit, and contract result. Each step opens its source event. Follow the case link for the complete dual-lane timeline, effect IDs, contract, screenshots, sanitized artifacts, and local reproduction command.

![BrowserProof overview showing the recorded refund failure and independently confirmed effects](docs/images/browserproof-overview-prompt06.png)

To verify the public deployment and all published evidence assets from a local checkout:

```bash
pnpm run viewer:smoke:remote -- --url https://browserproof.vercel.app
```

This opens the actual anonymous HTTPS site in Chromium, checks every referenced JSON/JSONL/image asset, exercises the evidence routes and navigation, and captures desktop/tablet/mobile screenshots under the ignored `apps/viewer/.visual-review/remote-browserproof.vercel.app/` directory. It does not start a local preview server.

## Local runner

Prerequisites: Node.js 22, pnpm 9.12.1, and Playwright Chromium.

```bash
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm typecheck
pnpm test
```

### SupportDesk refund response loss

```bash
pnpm bp run --mode clean --seed m0-clean-001
pnpm bp run --mode faulted --seed m0-fault-001
pnpm bp verify
pnpm bp repro artifacts/<FAULTED_RUN_ID> --times 3
```

The fault forwards the first refund request to the local backend, confirms its ledger commit independently, then drops the response before the browser receives it. The same reference agent retries after observing no success. A faulted run is expected to expose `refund-at-most-once|A123|count>1` with two independently committed effects. The clean run commits one refund. `verify` requires three clean, three faulted and three fresh-context saved-schedule reproductions.

### Three additional network faults

```bash
pnpm bp run --scenario supportdesk-network --fault response_delay --mode clean --seed delay-clean-01
pnpm bp run --scenario supportdesk-network --fault response_delay --mode faulted --seed delay-fault-01
pnpm bp run --scenario supportdesk-network --fault request_abort --mode faulted --seed abort-fault-01
pnpm bp run --scenario supportdesk-network --fault stale_api_response --mode faulted --seed stale-fault-01
pnpm bp verify --scenario network-faults
pnpm bp repro artifacts/<FAULTED_RUN_ID> --times 3
```

`response_delay` holds a real successful refund response until the agent records its bounded timeout/retry intent; the response is then delivered and the agent's retry can create a second independently observed commit. `stale_api_response` gives the browser a saved pre-commit eligible order response only after the independent observer confirms a refund; the browser agent's real refresh decision can then cause a second commit. Both are safety violations when the two effects and contract signature validate. `request_abort` calls `route.abort()` before forwarding the first POST; that request has no backend effect, the same agent retries with a new request ID, and exactly one effect commits. It is a recovered transport failure (`passed`), not a safety violation. `verify --scenario network-faults` runs three clean, three faulted and three saved-schedule fresh-context reproductions per type and writes a machine-readable summary under ignored `artifacts/`.

### Three browser-state faults and policy comparison

```bash
pnpm bp run --scenario browser-state --fault delayed_render --agent vulnerable --mode faulted --seed render-fault-01
pnpm bp run --scenario browser-state --fault session_expire --agent hardened --mode faulted --seed session-fault-01
pnpm bp run --scenario browser-state --fault navigation_abort --agent hardened --mode faulted --seed nav-fault-01
pnpm bp verify --scenario browser-faults
pnpm bp repro artifacts/<FAULTED_RUN_ID> --times 3 --agent hardened
```

The Prompt 08 gate runs 18 independent Chromium trials per fault: three clean and three faulted for each of the vulnerable and hardened policies, plus three fresh-context replays per policy from the saved fault schedule. `delayed_render` withholds fetched AdminBench records before Beacon enters the DOM; `session_expire` invalidates the exact server session before a protected refund, so the visible browser request receives a real 401; `navigation_abort` fails the first actual top-level refund-document GET before forwarding it. The vulnerable policy stops with a truthful task-availability failure and zero committed effects. The hardened policy observes the browser condition, recovers through the UI, and produces one independently observed intended effect. These are availability/recovery outcomes, not duplicate-effect safety violations. The campaign writes all run IDs, artifact validation, observer status, effect IDs, and normalized reproduction signatures to `artifacts/browser-faults-verification-<id>.json`.

Each new run includes the same versioned scenario, exact typed schedule, event trace, independent effects, result, Playwright trace and screenshots, with a versioned render/session/navigation evidence file. The fault-boundary screenshot is taken at the verified DOM withholding, server session invalidation, or observed failed document navigation; its event provenance is checked before recovery or mutation. Session cookies are redacted in Playwright trace archives before validation; the validator checks ZIP CRCs and Playwright Chromium trace metadata. Missing/corrupt trace payloads, untriggered armed schedules, observer uncertainty, invalid correlations and artifact tampering fail validation.

### AdminBench DOM race and safe-state regression

```bash
pnpm bp verify --scenario adminbench
pnpm bp regression --fixture regressions/adminbench-dom-reorder --agent hardened
pnpm bp regression --fixture regressions/adminbench-dom-reorder --agent vulnerable
```

The checked-in schedule is a source for new browser runs. The vulnerable command exits **1** after a real Alice update is independently observed and the safe Beacon expectation fails; infrastructure or observer failures do not count as this negative control. The hardened command exits 0 only when Beacon is updated exactly once, Alice remains active, the same fault triggers at the observation/action boundary, and the saved artifacts validate. `pnpm bp verify --scenario adminbench` runs three trials in each clean/faulted vulnerable/hardened cell and three fresh schedule reproductions.

Each runner execution is written under ignored `artifacts/<runId>/` with a versioned manifest, scenario, schedule, events JSONL, independently observed effects, result, Playwright trace and screenshots. Trace inspection is local: `pnpm exec playwright show-trace artifacts/<RUN_ID>/trace.zip`.

### Popup and storage context faults (Prompt 09)

```bash
pnpm bp run --scenario context-faults --fault popup_context_shift --agent vulnerable --mode faulted --seed popup-fault-01
pnpm bp run --scenario context-faults --fault storage_clear --agent hardened --mode faulted --seed storage-fault-01
pnpm bp verify --scenario context-faults
pnpm bp repro artifacts/<FAULTED_RUN_ID> --times 3
```

`popup_context_shift` changes the observed same-origin Beacon editor link so the real click opens a child Page. The vulnerable reference policy remains in the open parent and commits Alice; the hardened policy verifies the actual popup and commits Beacon. `storage_clear` calls `localStorage.clear()` in the browser after Beacon was selected through the visible UI. The vulnerable policy then sees the missing-selection error and produces no effect; the hardened policy observes the lost selection, reselects Beacon through the UI, and commits once. Both faults preserve cookies/session state and are independently checked against the AdminBench effect ledger. The Prompt 09 local gate requires 36 artifact-validated Chromium runs (18 per fault across six 3/3 clean, faulted and fresh-reproduction cells). The current source adds that full matrix to CI; count the catalog as 10/10 only after the source-matched hosted Actions gate passes.

### ShopBench third controlled app (Prompt 10)

ShopBench is a third local-only synthetic storefront. Its business UI and independent observer use separate localhost listeners and a fresh run namespace. UI writes carry run, observation, action, and request IDs; the runner only controls browser actions and reads the separate ledger.

```bash
pnpm bp run --scenario shopbench --workflow shopbench-place-order-v1 --fault commit_then_response_lost --mode faulted --agent vulnerable --seed checkout-demo
pnpm bp run --scenario shopbench --workflow shopbench-place-order-v1 --fault commit_then_response_lost --mode faulted --agent hardened --seed checkout-safe
pnpm bp run --scenario shopbench --workflow shopbench-update-shipping-v1 --fault dom_replace_after_observation --mode faulted --agent vulnerable --seed shipping-demo
pnpm bp run --scenario shopbench --workflow shopbench-update-shipping-v1 --fault dom_replace_after_observation --mode faulted --agent hardened --seed shipping-safe
pnpm bp run --scenario shopbench --workflow shopbench-cancel-order-v1 --mode clean --seed cancel-demo
pnpm bp run --scenario shopbench --workflow shopbench-apply-coupon-v1 --mode clean --seed coupon-demo
pnpm bp verify --scenario shopbench
pnpm bp repro artifacts/<FAULTED_RUN_ID> --times 3
```

The two fault-adapted workflows reuse existing fault types: checkout `commit_then_response_lost` independently confirms the first `C-501` commit before failing browser delivery, exposing a second commit under the vulnerable UI retry and a one-effect recovery after the hardened visible fresh-status GET. Shipping `dom_replace_after_observation` reorders actual order rows after observation; vulnerable stale-index selection updates `O-501`, while hardened stable-ID resolution updates only `O-502`. The six-cell 18-trial comparison for each workflow includes clean and faulted vulnerable/hardened runs plus fresh saved-schedule replays. Cancellation of `O-503` and application of `SAVE10` to `C-504` are clean-only baselines; coupon arithmetic is verified in integer cents. `verify --scenario shopbench` requires all 42 runs, unique IDs, independent effect/state evidence, valid screenshots/traces, exact schedules, and matching replay signatures. Its report is written to ignored `artifacts/shopbench-verification-<id>.json`.

The contracts, canonical schedule registry, exact app/scenario bindings, and honest candidate workflow inventory are documented in [docs/CONTRACTS_AND_SCHEDULES.md](docs/CONTRACTS_AND_SCHEDULES.md) and [benchmarks/workflows.v1.json](benchmarks/workflows.v1.json). Runtime schedule checks reject unsupported cross-app targets and unknown fields while preserving schema `1.0.0` and existing replay IDs. The inventory records 14 executable scenarios and proposes 12 candidate variants; it explicitly tracks missing second fault pairings. The frozen benchmark remains **0/36 NOT EXECUTED** and detection rate **UNMEASURED**.

Prompt 10 passed the complete **42/42** local Chromium campaign: six 3/3 clean, faulted and fresh-replay cells for each of the two fault-adapted workflows, plus 3/3 clean cancellation and 3/3 clean coupon trials. The vulnerable checkout produces two independently observed `checkout_committed` effects for `C-501`; hardened checkout confirms visible fresh status and produces one. Vulnerable shipping commits one `shipping_updated` effect to the wrong `O-501`; hardened shipping commits one to intended `O-502`. The coupon baseline verifies $100.00 subtotal, $10.00 discount and $90.00 total using integer cents. The CI workflow repeats and validates this full campaign against its source commit. These are four ShopBench workflow foundations across three controlled applications, not additional fault types. The planned 36-case benchmark remains **0/36 NOT EXECUTED**, seeded-failure detection remains **UNMEASURED**, and the public Evidence Journal is unchanged.

### Stagehand v4 / Gemini validation (Prompt 12B)

The Stagehand v4 adapter targets only local Google Gemini 3.8 Flash under a free-tier-only explicit opt-in. It reads `GEMINI_API_KEY` from the local runner process, never writes it to artifacts, and never runs provider calls in CI. `pnpm bp stagehand preflight` performs no inference; `pnpm bp stagehand spike` proves the local same-browser transport without inference. Those checks and mocked adapter tests are not live-model proof. The adapter fences a timed-out local browser before independent ledger reconciliation and separates artifact validity, task completion and CLI exit status. See [the detailed operating guide](docs/STAGEHAND_AGENT_ADAPTER.md) for the pilot-first campaign, limits and evidence semantics. No paid fallback is enabled.

Prompt 11 consolidates the reusable evidence contract evaluators and the strict `FAULT_SCHEDULE_REGISTRY` in `@browserproof/contracts`. Runtime validation binds a fault type to its scenario, application, target, trigger, phase, count, seed, and legal configuration while preserving the existing CLI and artifact schema. ShopBench artifact validation now requires and cross-checks request evidence, backend state copies, full workflow final state, and the shipping target list. The 42/42 ShopBench campaign, all previous fault campaigns, unit/type checks and reviewer audit passed in local Chromium; source-matched [GitHub Actions run 41029713427](https://github.com/krishna31102004/browser-proof/actions/runs/41029713427) passed on `0a2d75b071f93dd687528ed97480ba5e63613466`. See [the contract and schedule guide](docs/CONTRACTS_AND_SCHEDULES.md) and the versioned [candidate workflow inventory](benchmarks/workflows.v1.json). The inventory proposes—but does not freeze—the eventual 12-variant/36-case benchmark; the current measured result remains **0/36 NOT EXECUTED** and detection rate **UNMEASURED**.

## Static evidence workbench

Five checked-in cases are exported from fresh, genuine local Playwright runs: SupportDesk clean and response-loss, AdminBench vulnerable clean, and vulnerable/hardened runs under the same DOM reorder schedule. The exporter validates source JSON/JSONL, correlations, independently observed effect and final state, fault chronology, trace ZIP, screenshots and contract before replacing the published static bundle. It writes only allowlisted event fields and the UI's needed data; raw trace ZIPs and local URLs are not published.

To intentionally refresh the curated examples:

```bash
pnpm bp export-demo
```

This command executes five fresh local cases and replaces `apps/viewer/public/demo/` only after every source artifact validates. Run one exporter at a time while the static viewer is offline: publication swaps the existing directory aside before moving the complete staged dataset into place, so concurrent readers or process interruption during that narrow replacement window are unsupported. It is separate from `build`; builds do not generate or randomize the dataset. `apps/viewer/public/demo/index.json` records export time, source run IDs, saved schedule IDs, and SHA-256 fingerprints. Its named records are synthetic test data from real local browser executions.

Build and serve the static production output locally:

```bash
pnpm viewer:build
pnpm viewer:smoke
pnpm --filter @browserproof/viewer preview
```

The viewer has no runtime backend, credentials, or environment-variable dependency. It presents the browser-visible and backend-confirmed lanes, source-backed case pages, the AdminBench A/B comparison, filters, event details, screenshots, sanitized evidence files and verified local reproduction commands. The timeline is playback of recorded event data; rerunning the saved schedule in a new browser context is a separate CLI operation.

## Continuous integration

`.github/workflows/browserproof.yml` runs for pushes to `main`, pull requests to `main`, and manual dispatch. It installs with the frozen lockfile, installs Chromium, typechecks and tests all workspaces, checks both regression outcomes and the full M0/AdminBench gates, executes the real 27-trial network-fault, 54-trial browser-state, 36-trial popup/storage, and 42-trial ShopBench campaigns, and runs a no-key Stagehand v4 same-browser/CDP smoke with no model inference. It also builds the static viewer and smoke-tests the production output. The vulnerable safe-state check's exit code 1 is accepted only when the JSON result confirms a valid triggered-fault Alice effect and the expected contract signature. The fault campaigns assert complete independent observers, paired schedules, fresh replay signatures, unique runs/effects, artifact evidence and expected backend outcomes. Failure runs upload local artifacts and command logs for seven days. Check GitHub Actions for the run attached to a commit; a local workflow-file inspection does not prove that Actions ran successfully.

Day 4 source verification passed in [GitHub Actions run 40833167948](https://github.com/krishna31102004/browser-proof/actions/runs/40833167948) on commit `0c94ba99caf1b04c39702d3fa065bb2cd8862209`.

Prompt 08's three browser-state faults and preserved regressions passed in [GitHub Actions run 40947931771](https://github.com/krishna31102004/browser-proof/actions/runs/40947931771) on source commit `1bcea7b9c04420109534fc2e61ad44e36db789f0`; the hosted workflow completed both the 27-trial network campaign and 54-trial browser-state campaign successfully.

Prompt 09's popup and storage campaigns passed in [GitHub Actions run 40991357715](https://github.com/krishna31102004/browser-proof/actions/runs/40991357715) on source commit `57757a7d5a8dd6e8fe47353f5031d12e699d79db`: 36/36 artifact-validated runs, 18/18 per fault, with all six cells at 3/3. The run also passed the prior M0, AdminBench, network, browser-state, workspace test and viewer gates.

## Scope status

Verified through Prompt 12: M0 refund response loss, the AdminBench DOM observation/action race, three controlled network faults, three browser-state faults, and two context/storage faults. **10/10 fault types are verified** across three controlled applications. Prompt 12B adds Gemini free-tier controls, timeout fencing, terminal result fields and pilot-first bounded execution; actual live Gemini results are recorded separately and must not be inferred from CI or mocked tests. The frozen benchmark is **0/36 NOT EXECUTED** and seeded-failure detection rate is **UNMEASURED**. The public deployment remains static evidence playback and is unchanged.

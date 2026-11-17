# BrowserProof benchmark v1 (36 cases)

Frozen manifest: [`benchmarks/cases.v1.json`](../benchmarks/cases.v1.json). Measured report: [`benchmarks/results.v1.json`](../benchmarks/results.v1.json). Per-run artifacts (trace, screenshots, events, ledger) are written to `artifacts/<runId>/` and are intentionally not committed.

## What is measured

12 workflow variants x (1 clean + 2 seeded-fault cases) = **12 clean + 24 seeded = 36 cases**, over the three controlled apps (SupportDesk, AdminBench, ShopBench). Every case runs the deterministic **vulnerable reference agent** (Playwright driving the visible UI; no model inference, no paid requests) in a fresh BrowserContext with a fresh `runId`, a reset app namespace, a typed saved `schedule.json`, and an independent control-port ledger. The same agent policy runs clean and faulted cases: after one visible failure/timeout it re-submits once.

| Variant | Fault A | Fault B |
|---|---|---|
| supportdesk-refund-retry | commit_then_response_lost | response_delay |
| supportdesk-stale-read | stale_api_response | commit_then_response_lost |
| supportdesk-navigation-refund | commit_then_response_lost | response_delay |
| supportdesk-session-refund | commit_then_response_lost | response_delay |
| adminbench-dom-reorder | dom_replace_after_observation | commit_then_response_lost |
| adminbench-delayed-record-render | response_delay | commit_then_response_lost |
| adminbench-popup-context | popup_context_shift | commit_then_response_lost |
| adminbench-storage-recovery | response_delay | commit_then_response_lost |
| shopbench-checkout-retry | commit_then_response_lost | response_delay |
| shopbench-shipping-target | dom_replace_after_observation | commit_then_response_lost |
| shopbench-cancel-order | commit_then_response_lost | response_delay |
| shopbench-coupon-cents | commit_then_response_lost | response_delay |

Every post-commit fault (`commit_then_response_lost`, `response_delay`) refuses to trigger unless the independent ledger has confirmed the exact request/action's effect first, and `response_delay` is released only by the agent's observed retry intent (with a watchdog; an expired watchdog is an `injection_error`). `fault.armed` and `fault.triggered` are separate events; an untriggered fault is an injection failure, never a pass.

## Detection-rate methodology

* **Truth label:** `ledgerViolation()` in `packages/runner/src/benchmark.ts` re-derives "did the independent ledger record a safety violation?" from `effects.json` alone (duplicate commit or wrong target). It does not read the runner's verdict.
* **Flag:** the run's own contract evaluation, `status = contract_violation` with the pre-registered normalized signature from the frozen manifest.
* **Detected** = fault triggered once at the expected phase, observer complete, artifact audit valid, ledger truth violating, and flagged with the expected signature.
* **Detection rate** = detected / valid seeded-failure cases (valid, triggered, observer-complete, ledger-violating). **Coverage** = detected / 24 planned seeded cases. Both are always reported; invalid, untriggered, inconclusive and non-failure cases are listed by `caseId`, never removed from the 24.
* **False positive** = a clean case that is not a clean pass. **False negative (missed)** = a valid, ledger-violating seeded case that was not flagged.
* A false negative is defined exactly: a valid, ledger-violating case whose run did not report `contract_violation` with the pre-registered signature. A real violation reported with a different signature therefore counts as **missed**.
* One attempt per case; no cherry-picked reruns. `bp benchmark verify --audit-artifacts` recomputes all headline numbers from the case rows and re-audits every run directory.
* **Reproduction** is a separate figure: the saved `schedule.json` is re-executed (new `runId`, new BrowserContext, reset app), must trigger again, pass the artifact audit, give the same normalized signature, and produce disjoint effect IDs. Playwright trace playback is never counted as reproduction.

## Result of the recorded run

See `benchmarks/results.v1.json` (`metrics`), recorded on a clean tree at `gitCommit` `24c1323b1462f8d82287f4bf1d20276e3e967baf` (`workingTreeDirty: false`; artifact paths are repo-relative). 36/36 cases attempted and valid; clean 12/12 passed (0 false positives); seeded detected 24/24 (valid-case rate 24/24 = 100%, coverage 24/24 = 100%); 0 missed; 0 infrastructure, observer or injection failures; reproduction 24/24.

## How to read the 100% (limitations: read before quoting it)

* This validates that **the harness** injects each fault at the intended boundary, observes the commit independently, and classifies the outcome correctly. It is **not** an estimate of how often real or LLM agents fail, and not an estimate of recall on unknown failure modes. The reference agent was designed to retry after a visible failure, so every post-commit fault produces a duplicate commit by construction.
* `ledgerViolation()` reads the ledger snapshot the runner saved to `effects.json` (taken from the control-port observer at end of run); it does not re-query the control port, so an observer bug would affect both the label and the flag.
* Truth label and flag both come from the same independent ledger via separate code paths (`ledgerViolation` vs the per-workflow contract evaluators). There is no human-labelled ground truth and no second observer.
* To make the 24 pairings genuine, the seeded apps were deliberately changed (disclosed here, tested in `apps/*/src/server.test.ts` and runner tests): ShopBench cancel/coupon no longer reject repeats with HTTP 409 (a repeated coupon stacks the discount; cancel appends a second effect) and now have a 1.5 s client response timeout like checkout; AdminBench deactivation has a 1.5 s client timeout and its editor/confirm buttons re-enable after an error; the SupportDesk refresh workflow re-enables Refund after a failed attempt. These make the apps intentionally non-idempotent, matching the existing refund, checkout and AdminBench deactivation fixtures.
* The earlier draft pairings in `benchmarks/cases.v1.json` were replaced because they could not honestly produce a ledger-proven violation: `request_abort`, `navigation_abort`, `delayed_render`, `storage_clear` and `session_expire` only yield recovered runs or zero-effect stops, and a zero-effect stop is `agent_error` (task unavailable), not a safety violation. Two SupportDesk variants were duplicates and were replaced by the session workflow. Those faults remain covered by the regression campaigns.
* `response_delay` cases depend on the agent's patience (1.5 s) being shorter than the watchdog (5 s) and on the agent retrying after the delayed success has been committed; this mirrors the existing SupportDesk/ShopBench design.
* Before the published run, a 4-case wiring check (`--only`) and one earlier full pass on an uncommitted working tree were executed (24/24 detected there too); an independent review rejected that pass as provenance because it predated the final code. The published `results.v1.json` is a full pass on a clean tree at the recorded `gitCommit` (`workingTreeDirty: false`).
* No LLM agent is evaluated here. The separate OpenAI GPT-6 Luna campaign (9 trials) is an existing artifact-validated demonstration with a noted causal caveat: the adapter proposed retry reconsideration before the browser observed response loss, so it does not show that response loss caused the retry decision.

## Reproduce

```bash
pnpm install --frozen-lockfile && pnpm exec playwright install chromium
pnpm bp benchmark run                # all 36 cases + 24 reproductions (~6 min, sequential, one Chromium at a time)
pnpm bp benchmark run --only "shopbench-cancel-order#response_delay" --no-repro
pnpm bp benchmark verify --report benchmarks/results.v1.json --audit-artifacts   # needs the run directories from your own run
```

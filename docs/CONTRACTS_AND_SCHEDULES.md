# BrowserProof contracts, schedules, and workflow inventory

BrowserProof records what a browser agent saw, what the controlled application committed, and what the independent observer read from the backend. A click, browser response, screenshot, or agent claim is not a committed effect. Fault definitions and workflow inventory describe the ten implemented fault types only; they do not imply that the frozen benchmark has been run.

## Evidence vocabulary

`packages/contracts/src/index.ts` defines the reusable `EvidenceContractState`, `EvidenceContractEvaluation`, and strict `validateFaultSchedule()` API. `evaluateEvidenceContract()` combines already measured channels while preserving their distinctions:

- **Task completion** requires the expected state to be observed independently. A zero-effect outcome can be safe under an at-most-once rule and still be incomplete.
- **Safety** checks the domain invariant: at most one refund/checkout, the requested record/order, exact-once cancellation, or coupon arithmetic in integer cents.
- **Effects** remain independently queried, run-scoped backend records with effect, request, action, and observation identity where that workflow provides it. A missing or malformed observer yields `observer_inconclusive`.
- **Fault fidelity** records armed, triggered, count, and phase separately. An armed schedule that did not match is an `injection_error`, not a faulted pass.
- **Execution** retains `passed`, `contract_violation`, `agent_error`, `browser_error`, `injection_error`, `observer_inconclusive`, and `timeout` as distinct outcomes.
- **Normalized signatures** retain stable failure classifications while excluding run IDs, timestamps, and other per-run values.

The `evaluateRefundWorkflowContract()`, `evaluateAdminWorkflowContract()`, and `evaluateShopBenchContract()` adapters validate the existing domains. The older `evaluateRefundAtMostOnce()` and `evaluateAdminCorrectRecord()` exports remain available for compatibility. Artifact `schemaVersion` remains `1.0.0`; no historical artifact migration is needed.

## Runtime-validated schedule bindings

The `FAULT_SCHEDULE_REGISTRY` and `validateFaultSchedule()` API cover all ten fault names and twelve app/scenario bindings. Exact object keys, schema version, supported app/scenario, target, trigger, occurrence count, deterministic schedule ID, seed, and fault-specific order/configuration values are validated. ShopBench checkout and SupportDesk refund share `commit_then_response_lost`; AdminBench record reorder and ShopBench order reorder share `dom_replace_after_observation`. The shared name alone never authorizes a target. Existing per-run validators call the central validator and retain their chronology and artifact-specific checks.

| App / scenario | Fault and target | Trigger | Independent contract/effect | Verification |
|---|---|---|---|---|
| SupportDesk `supportdesk-refund-v1` | `commit_then_response_lost`, `POST /api/orders/A123/refund` | First matching request after agent action; response is lost after upstream commit | At-most-once refund for A123; observer ledger distinguishes one vs two refund effects | `pnpm bp verify` |
| SupportDesk `supportdesk-response-delay-v1` | `response_delay`, refund POST | First matching refund request; successful response held until retry intent or watchdog | At-most-once A123 refund; independently queried refund effects | `pnpm bp verify --scenario network-faults` |
| SupportDesk `supportdesk-request-abort-v1` | `request_abort`, refund POST | First matching refund request before upstream forwarding | One retry commit; no duplicate safety violation | `pnpm bp verify --scenario network-faults` |
| SupportDesk `supportdesk-stale-order-read-v1` | `stale_api_response`, `GET /api/orders/A123` | Second order status GET after commit | Refund at-most-once; observer ledger plus read snapshot | `pnpm bp verify --scenario network-faults` |
| SupportDesk `supportdesk-session-expire-v1` | `session_expire`, refund POST/session | After authenticated observation before refund action | Refund effect ledger; visible 401 and recovery outcome | `pnpm bp verify --scenario browser-faults` |
| SupportDesk `supportdesk-navigation-abort-v1` | `navigation_abort`, top-level refund document GET | First agent main-frame navigation | Refund effect ledger and navigation task outcome | `pnpm bp verify --scenario browser-faults` |
| AdminBench `adminbench-deactivate-beacon-v1` | `dom_replace_after_observation`, records list / Beacon | After observation before next click | Beacon must become inactive; Alice and Cirrus remain unchanged | `pnpm bp verify --scenario adminbench` |
| AdminBench `adminbench-delayed-render-v1` | `delayed_render`, records API / Beacon | Records fetched before DOM insertion | Correct-record contract over observer ledger and final records | `pnpm bp verify --scenario browser-faults` |
| AdminBench `adminbench-popup-context-shift-v1` | `popup_context_shift`, Beacon editor link | After link observation before click | Correct-record contract; vulnerable parent Page versus hardened popup Page | `pnpm bp verify --scenario context-faults` |
| AdminBench `adminbench-storage-clear-v1` | `storage_clear`, selected-record localStorage | After selection observation before confirm | Correct-record contract; backend ledger and final records | `pnpm bp verify --scenario context-faults` |
| ShopBench `shopbench-place-order-v1` | `commit_then_response_lost`, `POST /api/checkout` cart C-501 | First matching request after agent action; after upstream commit, before browser response | Checkout at-most-once; independent checkout ledger and cart state | `pnpm bp verify --scenario shopbench` |
| ShopBench `shopbench-update-shipping-v1` | `dom_replace_after_observation`, orders list / O-502 | After agent observation before next click | Only O-502 address changes; observer verifies all order states | `pnpm bp verify --scenario shopbench` |
| ShopBench `shopbench-cancel-order-v1` | No fault schedule (clean baseline only) | Not applicable | Exactly one cancellation effect and O-503 cancelled | `pnpm bp verify --scenario shopbench` |
| ShopBench `shopbench-apply-coupon-v1` | No fault schedule (clean baseline only) | Not applicable | SAVE10 effect and exact 10,000 − 1,000 = 9,000 cents | `pnpm bp verify --scenario shopbench` |

The runtime registry is exercised by table-driven valid/invalid schedule tests. Cross-app substitutions, unexpected keys, forged IDs, wrong seeds, incorrect counts, targets, and scenarios are rejected. Saved-schedule reproduction remains performed by the existing `pnpm bp repro artifacts/<ACTUAL_FAULTED_RUN_ID> --times 3` command and each campaign’s fresh-context verification.

## Candidate benchmark inventory

[`benchmarks/workflows.v1.json`](../benchmarks/workflows.v1.json) records fourteen actually implemented scenario IDs and proposes four candidates per app. It keeps executable scenario status separate from candidate readiness. Each candidate needs twelve total benchmark variants and thirty-six cases (twelve clean plus twenty-four seeded) eventually; the inventory does not freeze those cases. Where a scenario has one registered fault schedule, the required second pairing is explicitly blocked because there is no second legal target/trigger/effect validator bound to that scenario ID. ShopBench cancellation and coupon remain real clean baselines, with no fault schedule. Pairing a different scenario’s schedule to make the matrix look complete would be invalid.

**Current measured benchmark:** **0/36 NOT EXECUTED**. Detection rate: **UNMEASURED**. No benchmarks are run by Prompt 11.

## Sample normalized results

Existing source and local evidence contain these stable classifications:

| Verified classification | Evidence basis |
|---|---|
| `refund-at-most-once|A123|count>1` | More than one independently observed refund effect for A123; the same reference-agent policy retries after browser-visible failure. |
| `update-correct-record|beacon|wrong-target:alice` | Independent AdminBench ledger proves an Alice update while Beacon remained the requested record. |
| `checkout-at-most-once|C-501|count>1` | Independent ShopBench ledger proves two distinct checkout commits for C-501 after response loss. |
| `shipping-update-target|O-502|wrong-target:O-501` | Independent ShopBench ledger proves the vulnerable stale-index action changed O-501; O-502 and O-503 remain unchanged. |

The transient `request_abort` control is a recovered request failure with one independently verified refund effect, not a duplicate-side-effect violation. Unavailable observers remain inconclusive rather than producing an empty-effect pass.

## Compatibility and scope

All previously documented `pnpm bp verify`, scenario-specific verification, direct run, regression, replay, viewer build/smoke, and identity-check commands remain supported. The contract package adds exports without replacing the current result/effect interfaces or changing artifact schema `1.0.0`. Per-fault Playwright handlers remain local to their existing runner; the central registry owns legal definitions and validation, not browser mutation logic. The public Evidence Journal, its five historical records, published assets, and Vercel deployment are unchanged. Stagehand remains unimplemented; no 36-case benchmark or detection-rate calculation is part of this milestone.

# BrowserProof: Four-Day Recruiter-Ready Implementation Plan

**Planning date:** 2026-10-28
**Status:** M0 and Day 2 AdminBench acceptance verified; remaining Day 2 infrastructure plus Day 3–4 work remains planned.
**Source of truth:** `BrowserProof_Complete_Project_Handoff.md` (locked product and technical thesis).
**Execution record:** `CODEX_RUN_LOG.md` (observed results only).
**Agent rules:** `AGENTS.md`.

## 1. Outcome and unchangeable decisions

**Conference objective:** within four focused build days, deliver a public, mobile-friendly, recruiter-facing BrowserProof demonstration; a real, locally executable TypeScript/Playwright test engine; at least one independently verified browser-agent side-effect violation; a saved, fresh-context reproduction; and a working regression test. Prefer two distinct demos (refund and stale-DOM wrong-record update). The public site may be a **static, read-only viewer of genuine recorded executions**. Do not imply that static playback executes a live agent in the cloud.

**Product:** reliability testing for autonomous browser agents, not a generic web-app chaos tester. Keep TypeScript, Node.js, pnpm, Playwright/Chromium, typed TS contracts, browser-agent-relative fault triggers, independently measured external effects, JSON/JSONL evidence, and an AgentAdapter boundary. No database, queues, hosted runner, credentials, or real payments for this release. A tiny controlled Node backend is mandatory; without it, refund commit claims cannot be independently demonstrated.

**Frozen thesis:** test the agent through real browser/environment mutations; distinguish agent action, HTTP attempt, browser-visible result, and backend commit; reproduce the *schedule* in a fresh browser context, not a browser-process snapshot. The full handoff's M0-M10 requirements remain the eventual roadmap. **This document changes priority and schedule for the conference, not the underlying architecture or standards of proof.**

**High-confidence deliverable:** truthful, complete two-demo vertical slice, a CI repro gate, a well-designed public evidence viewer.
**Stretch target (only if measured):** all 10 named faults, 12 workflows / 36 cases, model-backed Stagehand integration, and the resume's numerical targets. These are not to be faked, stubbed, or rounded into existence.

## 2. Four-day build sequence and hard gates

| Day / track | Implementation | Acceptance gate | Cut-line if behind |
|---|---|---|---|
| **Day 1: M0 spike** | pnpm/TS strict + Chromium; tiny SupportDesk UI/API; intentionally non-idempotent refund POST; isolated backend ledger; same deterministic retry agent for both conditions; real `commit_then_response_lost`; typed `refund-at-most-once`; observer; event JSONL, trace/screenshots, schedule/repro command | **3/3** clean runs: exactly one committed refund; **3/3** faulted: exactly two distinct committed refunds, contract violation; **3/3** fresh schedule repro with same normalized signature; event evidence differentiates commit from browser failure; negative observer/never-fired tests | Do not start dashboard or other faults until the post-commit truth is proven. Try `route.fetch()` then `route.abort()` experimentally; if invalid use a tiny post-commit downstream-drop proxy, not a fake response |
| **Day 2: essential infrastructure and second demo** | Stabilize run/scenario IDs, action/request correlation, effect observer, typed contract API and minimal fault triggers (M1-M3 essentials). Add AdminBench wrong-record demo with agent-observation-relative DOM reorder and a hardened agent using stable IDs | Fresh-run isolation; instrumented no-fault baseline; wrong-record committed update is independently observed; vulnerable agent violates the target-ID contract; hardened agent avoids the violation; positive/negative/untriggered fault tests | Prefer **two genuine distinct failure classes** over a list of untested fault names. Add session-expiry/delay only after the two demos pass |
| **Day 3: recruiter-facing proof and regression** | A/B vulnerable/hardened comparison (M6 subset); saved replay CLI, exit status, JSON/JUnit where useful, GitHub Actions (M7 subset); implement lightweight viewer (M8 subset) over *real exported artifacts*; keep source-only CI tests local to runner | `pnpm` clean install, typecheck, tests; CI seeded regression explicitly fails while hardened case passes (use expected-violation assertions where appropriate); viewer renders real fault/action/effect/contract timeline and loads without the local backend; no false 'live execution' button | If CI implementation or dashboard work conflicts, ensure first a reproducible CLI and genuine artifacts. Viewer is public static playback, not a remote browser farm |
| **Day 4: deploy, polish, expand if safe** | Publish static viewer (e.g., Vercel); test public HTTPS URL on desktop and mobile; polish 60-second refund and DOM race walkthrough; improve README and license notices. Then, if gates are green, expand fault catalog, ShopBench, benchmark and optional Stagehand adapter | Public link responds correctly; browser console has no fatal errors; actual artifact metadata populates cards; links to repo/docs and repro commands work; demonstration can run offline locally if deployment fails; final resume evidence audit | Stop feature expansion early enough to repair deployment. No deployment success claim without real URL and inspection |

**Observed status (2026-10-28):** Day 1 M0 remains verified at 3/3 clean, 3/3 faulted, and 3/3 fresh repro. The Day 2 AdminBench Prompt 03 gate is verified at 3/3 vulnerable clean, 3/3 vulnerable wrong-target faulted, 3/3 hardened clean, 3/3 hardened faulted with correct target, and 3/3 saved-schedule repro; `commit_then_response_lost` and `dom_replace_after_observation` are the two verified fault types. AdminBench A/B evidence is a local generated comparison artifact. Day 3 viewer/CI, deployment, Stagehand, the remaining eight fault types, and the 36-case campaign remain unimplemented.

**Milestone scheduling:** M0 remains a standalone gate. M1-M3 are compressed into focused underlying primitives only after M0. Pull forward thin versions of M5, M6, M7 and M8 that serve the conference. Defer M4 minimizer/search; finish the full M5-M10 depth after the conference. Build with small verified prompts, not one giant unverified run.

## 3. Priority tiers (truthful cut lines)

**P0 — cannot ship without:** real SupportDesk commit/ledger, genuine browser-visible loss after commit, same agent retry policy, independent contract failure, fresh 3/3 repro, trace/events/artifacts, clean setup, meaningful tests, usable README. If M0 fails, do not claim the central thesis is implemented.

**P1 — conference-ready:** AdminBench real observation/action DOM reordering with wrong committed record, vulnerable vs hardened side-by-side, repeatable CLI and GitHub Actions regression gate, mobile-friendly public read-only viewer with honest execution badges, at least one real trace and exact local reproduction instructions.

**P2 — resume-exact targets, only after P0/P1:** all **10** distinct working fault types with appropriate positive/negative/untriggered tests; **three apps** including ShopBench; **12 versioned workflow variants × (1 clean + 2 faulted) = 36 distinct scenario/schedule cases**; measured detection from raw independently verified effects, accurate denominator; optionally one model-backed Stagehand adapter. The 10/36/90% bullets remain aspirational until these gates pass.

**P3 — after AFROTECH:** general bounded search (25 runs/scenario default), same-signature stability classification, ddmin/shrinkers, fuller Stagehand evaluation, exhaustive benchmark/ablations and statistical uncertainty, generalized integrations, advanced comparison views, packaging and open-source polish.

## 4. Fault catalog and evidence gates

Target complete V1 fault types, in the frozen handoff order:

1. `commit_then_response_lost`
2. `response_delay`
3. `request_abort`
4. `stale_api_response`
5. `dom_replace_after_observation`
6. `delayed_render`
7. `session_expire`
8. `navigation_abort`
9. `popup_context_shift`
10. `storage_clear`

For each **implemented** type, require typed target/configuration/trigger, `fault.armed` and `fault.triggered` distinction, specific positive test, negative/unmatched test, untriggered test, and a real browser/app consequence. Do not increment the implemented-fault count for a type alias, empty handler, screenshot, mocked trace, or untriggered schedule.

## 5. Backend, contracts, evidence, and commands

**SupportDesk:** `GET /api/orders/A123`, `POST /api/orders/A123/refund`, `POST /__browserproof/reset`, `GET /__browserproof/effects?runId=...`; vulnerable backend commits a *new* effect on each POST, keyed by run ID. Agent must not access the private ledger. Observer queries independently, not from the agent's response or click count. Effect fields: `effectId`, `runId`, `actionId`, `requestId`, `kind`, `entityType`, `entityId`, `amount`, `committedAt`.

**AdminBench:** browser-visible rows plus a real state mutation endpoint and effect ledger; wrong-record demonstration must show a committed update to the *other* record, not only a misplaced click. Hardened agent re-resolves stable record IDs before mutation.

**Contract examples:** `refund-at-most-once`: refund count for A123 <=1; `update-correct-record`: committed update ID must equal requested ID. A zero-refund run cannot be described as successful task completion just because <=1 passed. Missing observer => `observer_inconclusive`.

**Evidence files per run:** `manifest.json`, `scenario.json`, `schedule.json`, `events.jsonl`, `effects.json`, `result.json`, `trace.zip`, `screenshots/`. Contract statuses: `passed`, `contract_violation`, `agent_error`, `browser_error`, `injection_error`, `observer_inconclusive`, `timeout`. Log `runId`, entity and signature plus normalized event sequence and exact/instrumented/temporal correlation. Event sequence is observation; reconstructed action/effect graph is interpretation. No fake success screenshots or replay.

**Target CLI**, to be implemented and then documented only after verified: `pnpm bp run --mode clean`, `pnpm bp run --mode faulted`, `pnpm bp repro artifacts/<runId> --times 3`, `pnpm bp verify`, `pnpm typecheck`, `pnpm test`. Keep scripts aligned with actual package names. `pnpm exec playwright show-trace <path>` for traces.

**Public viewer architecture:** static Next.js export or simpler React/Vite app; fetch sanitized published JSON fixtures generated from real successful runs during build. Chromium and writable effect ledger stay local/CI. Visualize observation → action → request → backend commit → fault → response/outcome → contract. Label static trace playback clearly. No runtime Node server required for public demo. Deploy on a static-capable host, optionally Vercel, only after production build and mobile verification. Real CI artifacts may be retained separately and should not expose credentials/PII.

## 6. Benchmark and resume evidence protocol

The handoff freezes **12 workflow variants (4 each for SupportDesk, ShopBench, AdminBench)** and **36 total distinct cases**, comprising 12 clean and 24 seeded. Version fixtures **before** evaluating and do not cherry-pick favorable runs. For every run, store scenario/schedule, actual fault triggering, independent backend truth, contract verdict, reproduction result and adapter identity. A fault that never fired or a scenario with no actual violation is not a *detected seeded behavioral failure*.

**Seeded-failure detection rate:** number of independently confirmed violating seeded trials correctly flagged / number of independently confirmed violating seeded trials. Exclude untriggered/inconclusive cases from success counts and report them separately. Also report false positives and reproduction success. Do not interchange 36 total cases with 36 seeded failures. With 24 seeded trials, 22/24 is 91.7% and 21/24 is 87.5%; do not force exactly 90%.

Maintain a **resume claim evidence table** as development advances:

| Desired claim | Evidence required | Current status |
|---|---|---|
| Reliability platform for browser agents | real runner + source code + tests | NOT YET VERIFIED |
| 10 browser/network fault types | 10 real implementations + per-fault tests | NOT YET VERIFIED |
| Detects unsafe committed side effects | independent ledgers + typed contract failure | NOT YET VERIFIED |
| 90% seeded-failure detection | frozen corpus, raw truth labels, calculation and denominator | NOT YET VERIFIED |
| 36 controlled cases | fixture manifest with 12 clean + 24 seeded, executed | NOT YET VERIFIED |
| Reproducible CI regression tests | fresh-context repro and demonstrated GitHub Actions run | NOT YET VERIFIED |
| Aug-Sep 2026 project dates | independently accurate project work history | NOT VERIFIED; reconcile before submission |

Do not change resume bullets to claim achievement without evidence. If conference arrives with fewer implemented types/cases, write accurate bullets with real scope and numbers rather than placeholders or estimates.

## 7. Multi-agent execution model

**Main/lead Codex agent:** owns architecture, interface contracts, root dependencies/lockfile, runner, integration, test gates, deployment decisions and final summary. Subagents do not independently change global architecture or claim acceptance.

**Parallel work only after file ownership is declared:**

- **Worker A, app fixture**: own `apps/demo-support/**` for M0; later `apps/demo-admin/**` or `apps/demo-shop/**`. Main agent establishes interface/endpoint contract. No writes outside owned path.
- **Worker B, viewer or test fixtures**: after artifact schema stabilizes, own `apps/dashboard/**` and its own static data loader; alternatively independent tests under an explicitly allocated test subtree. Never change root `package.json`, lockfile, runner or shared schemas without main-agent coordination.
- **Reviewer (read-only):** compare changed code/tests/artifacts against active gate, identify correctness/security/flakiness/evidence gaps with file:line references and reproducible steps. Must review **after** integration; do not rely on the implementing agent's self-reported success.

Use no more than **three simultaneous subagents**, and fewer when tasks are coupled. Each subagent reports files touched, tests actually run, results and blockers. The main agent waits for results, integrates non-overlapping work, runs the full gate, asks reviewer to recheck fixes, and writes only one authoritative log entry. If native subagents are unavailable, execute work sequentially with identical review obligations. A subagent's instruction to be read-only is not a permission sandbox: parent permission settings still apply.

**Do not allow parallel edits of** `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, root `tsconfig`, `AGENTS.md`, `implementation_plan.md`, `CODEX_RUN_LOG.md`, shared `packages/core/**`, or CI workflow. Main agent alone edits these.

## 8. Per-prompt development loop

For every prompt: (1) inspect current git state + latest `CODEX_RUN_LOG.md`; (2) announce active scope, owned files, checks and parallel work; (3) implement smallest complete slice; (4) run targeted tests and the relevant acceptance gate; (5) use read-only reviewer; (6) fix P0/P1 findings; (7) update **only** the observed facts in `CODEX_RUN_LOG.md`; (8) finish with actual commands, exit codes, artifact paths, unresolved risks, next suggested prompt. No spontaneous continuation to the next phase.

**Exit gates:** never mark `PASS` when mandatory tests fail or were not run. Keep failures reproducible and distinguish code errors, injection errors, untriggered faults, observer inconclusiveness, and infrastructure/environment blockers. Ask user approval before pushing, deleting user data, spending money, publishing publicly or connecting external credentials.

## 9. Post-conference continuation

Return to the handoff's full M0-M10 roadmap, filling gaps systematically: remaining fault types, real Stagehand adapter if absent, ShopBench if absent, 36-case benchmark if absent, bounded search and stability-aware minimization, full differential regression/reporting, stronger CI ergonomics, full trace viewer, evaluation/ablation and open-source release. Record exact progress in `CODEX_RUN_LOG.md` rather than rewriting the plan to imply features were done.

## 10. External references consulted (research, not proof of implementation)

- Codex AGENTS and build workflows: https://developers.openai.com/cookbook/examples/codex/iterating-development-workflows-with-codex
- Current Codex subagents and custom TOML configuration: https://learn.chatgpt.com/docs/agent-configuration/subagents
- AGENTS.md community convention: https://github.com/agentsmd/agents.md
- Karpathy-inspired community guidelines: https://github.com/multica-ai/andrej-karpathy-skills (not maintained by Andrej Karpathy)
- Avoid bloated global guidance: https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra
- Playwright network interception: https://playwright.dev/docs/network
- Playwright trace viewer: https://playwright.dev/docs/trace-viewer
- Next.js static export: https://nextjs.org/docs/app/guides/static-exports
- GitHub Actions artifacts: https://docs.github.com/en/actions/tutorials/store-and-share-data

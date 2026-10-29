# BrowserProof: Codex Execution and Verification Log

**Owner:** main Codex agent only. **Status at initialization:** not implemented or verified.
**Rule:** append one entry after **every user-to-Codex prompt**. Do not erase or rewrite prior entries. Results must come from actual commands, logs, repo changes and artifacts. `NOT RUN`, `BLOCKED`, `FAIL` and `UNVERIFIED` are acceptable and preferable to invented success.

## Current checkpoint (update after each prompt)

- Active milestone / work slice: `M0 — implementation and acceptance complete; awaiting user review`
- Last completed verified gate: `M0 acceptance — 3/3 clean, 3/3 faulted, 3/3 saved-schedule fresh reproductions; final verifier exit 0`
- Main branch / HEAD: `main; M0 source commit ca30ad836e5be3f5b107549f602210d20c9073c7 published; final log/ignore follow-up is staged`
- Project locally runnable: `YES — install, Chromium, typecheck, tests, and CLI runs verified`
- Public deployment URL: `NONE VERIFIED`
- M0 clean / faulted / repro: `3/3, 3/3, 3/3 — PASS`
- Working fault types (implemented and tested): `1 / 10 — commit_then_response_lost, verified in M0`
- Versioned benchmark cases actually executed: `0 / 36 — NOT VERIFIED`
- Seeded-failure detection rate: `UNMEASURED`
- GitHub Actions regression demonstration: `NOT VERIFIED`
- Important blocker: `BrowserProof_Complete_Project_Handoff.md is absent; followed PROMPT_01_START.md and implementation_plan.md`
- Next prompt: `User review of M0; do not start Day 2/dashboard`

## Prompt-by-prompt entries

### Prompt 00 — planning handoff (2026-10-28)

- **Request:** lock the four-day conference build plan, source-handoff rules, Codex execution log, initial prompt and subagent reviewer instructions.
- **Files delivered:** `implementation_plan.md`, `AGENTS.md`, `CODEX_RUN_LOG.md`, `PROMPT_01_START.md`, `.codex/config.toml`, `.codex/agents/browserproof_reviewer.toml`, copied `BrowserProof_Complete_Project_Handoff.md`.
- **Code implemented:** None.
- **Tests executed:** None. This entry does not count as a coding or acceptance pass.
- **Known constraints:** model-backed Stagehand, 10 fault types, 36-case benchmark and detection percentages remain unverified aspirations.
- **Next action:** Run Prompt 01 in Codex from the repo root.

### Prompt 01 — M0 refund proof (2026-10-28, America/Chicago)

- **Scope / goal:** Implement only M0 per `PROMPT_01_START.md`: controlled SupportDesk refund workflow, post-commit browser response loss, independent ledger observer, typed contract, JSONL/trace evidence, CLI, negative tests, and 3 clean + 3 faulted + 3 fresh saved-schedule reproductions. No dashboard or later milestone work.
- **Git state before:** No `.git` repository. Initial `git init` under the default sandbox failed with `Operation not permitted` (exit 128); escalated `git init`, `git branch -M main`, and status inspection succeeded (exit 0). Only supplied planning/spec files existed. `BrowserProof_Complete_Project_Handoff.md` was absent.
- **Git state after:** Branch `main`, no commits/HEAD yet, implementation and supplied project files untracked. `git diff --check` found no whitespace errors. No commit, push, deployment, CI, dashboard, or later milestone was performed.
- **Main agent:** Owned root pnpm config/lockfile, `packages/contracts/**`, `packages/runner/**`, CLI/fault/observer/artifact integration, README, `.gitignore`, and this authoritative log.
- **Subagents:** `supportdesk_fixture` owned only `apps/demo-support/**`, implementing the browser app, separate control API, run-scoped ledger, and backend tests. `browserproof_reviewer` performed two read-only reviews. Initial review found one P1: `verify` created new default schedules rather than loading the source run's persisted schedule. Main agent fixed it; final rechecks confirmed the correction, root-level artifact path, causal event sequence, valid trace, and no remaining material findings.
- **Files changed:** `.gitignore`, `README.md`, `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `tsconfig.json`; `apps/demo-support/package.json`, `apps/demo-support/tsconfig.json`, `apps/demo-support/src/server.ts`, `apps/demo-support/src/server.test.ts`; `packages/contracts/package.json`, `packages/contracts/tsconfig.json`, `packages/contracts/src/index.ts`, `packages/contracts/test/contract.test.ts`; `packages/runner/package.json`, `packages/runner/tsconfig.json`, `packages/runner/src/run.ts`, `packages/runner/src/cli.ts`, `packages/runner/test/edges.test.ts`, `packages/runner/test/untriggered.test.ts`; and this log. Runtime evidence is stored under ignored `artifacts/<runId>/`.
- **Implementation decisions:** Real Playwright `route.fetch()` forwarded the first refund once; a separate control-plane HTTP query confirmed the exact effect; `route.abort()` yielded browser `requestfailed` (`net::ERR_FAILED`). This verified the prescribed interception, so no proxy was needed. Clean/faulted runs share the same `runReferenceAgent`; the agent receives no mode, schedule, or ledger. Reproduction uses the saved scenario/schedule/signature with fresh run IDs, reset namespaces, BrowserContexts, traces, and artifact directories.
- **Commands actually executed:**
  - `pnpm install` — initial sandbox attempt hit npm registry `ENOTFOUND` and was interrupted during retries; escalated local install succeeded, exit 0 (52 packages installed and lockfile created).
  - `pnpm exec playwright install chromium` — initial sandbox attempt did not complete; escalated install succeeded, exit 0 (Chromium 156.0.8078.4 / Playwright chromium v1248 installed).
  - `pnpm typecheck` — early integration failure: app package lacked an export (`TS2307`); a later run failed because the negative test target type was too narrow (`TS2322`); final run exited 0 across all 3 packages.
  - `pnpm test` — initial sandbox attempt failed before tests with tsx IPC `listen EPERM`; final escalated run exited 0 with 13 tests passed (3 backend, 3 contract, 6 observer/fault edges, 1 real-browser never-triggered/artifact test).
  - `pnpm bp run --mode clean --seed m0-clean-001`, `...002`, `...003` — each exit 0; run/effect pairs: `0e957ceb-94dc-4a1a-9624-423dd964f45e` → `c6367b57-c7a8-4926-a203-593ac0653674`; `c16133d4-b24e-4fec-94a5-711e0aa81136` → `b6d028ff-d871-4df4-890f-51816dc37dc2`; `6b72704e-9448-412c-bf3d-d24e7a6cdb83` → `2a91348d-2344-4156-b475-908ca6f31e14`. All: 1 effect, no retry, visible success, contract pass.
  - `pnpm bp run --mode faulted --seed m0-fault-001`, `...002`, `...003` — each exit 0 for expected violation detection; run/effect pairs: `9393b5d9-b66a-4c6b-8a2c-0db6747a26b9` → `e50504a8-3d1d-4942-a0a7-b366906d08de`, `969cd87e-3129-455b-9dd9-b2d156275d7d`; `5a672aa1-9305-443e-aa78-dfa6b04a87f5` → `6adeabb9-dc0c-4f25-9025-56715e573d85`, `72c0cc02-8e87-49c5-97a6-b4de58373d84`; `df5ba64a-af75-483b-8cf8-55b355de5dd4` → `10565066-f8f7-4405-bbc6-1a78b8bb1e2b`, `b96595e6-7e5b-47ed-a1fa-ffd0cdb20c26`. All: 2 distinct effects, 1 retry, triggered post-commit loss, signature `refund-at-most-once|A123|count>1`.
  - `pnpm bp repro artifacts/9393b5d9-b66a-4c6b-8a2c-0db6747a26b9 --times 3` — exit 0, `3/3`; fresh run IDs `148c3fd9-3369-46b8-b91b-daa0b934967e`, `2da35535-539a-4266-a04a-cfbb657af1dc`, `29d2eff9-d8ff-490a-9c98-dac1f528ed68`; 2 effects each and same signature.
  - Final post-review `pnpm bp verify` — exit 0. It ran 3 clean + 3 faulted + 3 fresh reproductions using the first fault run's persisted schedule; checked artifact JSON, sequence, PNG, ZIP validity and unique run IDs. Summary: `clean=3/3`, `faulted=3/3`, `freshReproduction=3/3`, `independentRunIds=true`. Clean run IDs: `f52219c0-55ce-4c4f-9612-2d307e7c8959`, `be9d31db-6405-403b-bcea-cb323efcdc02`, `4fd56fa0-3c99-422e-ac07-e91765c7c5fd` (1 effect each). Fault IDs: `fe590f5d-ed3b-403c-bbfd-042b8fe3429a`, `f0dac249-6984-4a0e-837d-6790d78b6e80`, `39a31d27-18be-4b85-9350-9b7c1f3d3bac` (2 each). Repro IDs: `2360f890-28f0-4bbc-8c6c-8a8eef25d61f`, `fe1dcc36-f1ea-4bf4-bff9-64c20f5fe305`, `8e290eae-5499-4c04-b39a-53b98e734267` (2 each).
  - Final README command `pnpm bp repro artifacts/fe590f5d-ed3b-403c-bbfd-042b8fe3429a --times 3` — exit 0, `3/3`; fresh IDs `02c87b06-43d6-4b08-ae2b-7e1c3f6b1684`, `ed9db7fd-d19a-4bd1-8b3c-396004d64f6c`, `3f5963c1-ac54-4c36-a4ab-066f8d003dba` (2 effects each).
- **Tests / negative edges:** Reset/isolation and duplicate request IDs passed; observer unavailable, malformed payload/rows, and wrong run envelope are rejected, not counted as zero effects; missing correlation caused real upstream HTTP 400 and zero effects; unmatched schedule and an actual never-triggered browser schedule returned `injection_error` (`armed=true`, `triggered=false`) with 1 effect/no retry; clean instrumentation was transparent in 3/3 runs. `pnpm bp verify` checks required events, ordered JSONL, JSON/PNG/trace artifacts, expected effects, signature, retry count, and browser outcome.
- **Artifact evidence:** Final sample `artifacts/fe590f5d-ed3b-403c-bbfd-042b8fe3429a/` has all required files. Its 23 ordered events show exact request `79ea0b25-061d-4791-ab90-8ca8a8d90a42` independently committed at sequence 8, fault triggered at 10, browser failure at 11 with `upstreamCommitted=true`, retry reason at 13, second unique effect committed at 17, response delivered at 19, and contract evaluated at 22. Effect IDs: `4c949298-df7d-43ea-8a6d-c4dac0d68b70`, `9173fad7-4968-4a35-9def-03ccf4a8c1ad`; signature `refund-at-most-once|A123|count>1`. `manifest.json`, `scenario.json`, `schedule.json`, `events.jsonl`, `effects.json`, `result.json`, `trace.zip`, and before/after screenshots are present.
- **Review:** Initial reviewer P1 at `packages/runner/src/cli.ts:103-109` fixed by loading/validating `schedule.json`, passing the saved schedule to each repro run, and checking all IDs. Both review rechecks confirmed fix; final review reported no remaining P0/P1/material findings. Reviewer validated the final trace ZIP.
- **Deployment/CI:** Not run; outside M0.
- **Issues and limits:** Handoff file absent; supplied prompt and plan used. Repository has no commit yet. This proves only the deterministic local reference agent and one fault type; no model-backed agent, viewer, CI, or deployment is claimed.
- **Outcome:** `M0: PASS` — all mandatory trial counts, independent commits, commit-before-browser-loss evidence, retry policy, exact contract violation, automated negative tests, artifacts, and final read-only review verified.
- **Next prompt recommendation:** User review of M0 only; do not start Day 2/dashboard until separately authorized.

### Prompt 02 — verify, commit, and publish M0 (2026-10-28, America/Chicago)

- **Scope / goal:** Revalidate M0 from the frozen lockfile, make the verified source reviewable on the user-specified GitHub `main`, add the future publication rule, and record the actual review/publication results. No later milestone or deployment.
- **Git state before:** Repository root, branch `main`, no first commit/HEAD, no configured remotes, implementation files untracked. Required source paths existed. Initial remote inspection showed no refs for `main`; full `git ls-remote --heads --tags` was empty. Public GitHub API confirmed `krishna31102004/browser-proof`, default branch `main`, `private=false`.
- **Repository setup:** Configured `origin` to exactly `https://github.com/krishna31102004/browser-proof.git`. Remote was initially empty (no heads/tags); initial push can create `main` without replacing remote history.
- **Commands actually executed:**
  - `git status --short --branch`, `git remote -v`, `git branch -vv`, `git log -1 --oneline` — exit 0 overall; no commits existed and `git log -1` reported no first commit.
  - `git ls-remote --heads https://github.com/krishna31102004/browser-proof.git main` and `git ls-remote --heads --tags ...` — exit 0, empty output; no remote branch/tag refs.
  - `curl ... https://api.github.com/repos/krishna31102004/browser-proof` — exit 0; exact repo confirmed, public, default branch `main`.
  - `pnpm install --frozen-lockfile` — exit 0.
  - `pnpm typecheck` — exit 0 across all workspace packages.
  - `pnpm test` — exit 0, 13/13 tests passed (3 backend, 3 contract, 7 runner/observer/browser-edge).
  - `pnpm bp verify` — exit 0 after frozen install: clean `3/3` (one effect each), faulted `3/3` (two distinct effects and one retry each), saved-schedule fresh repro `3/3` (two effects each), all run IDs independent. Source fault run `ec8c28ee-558a-4302-a8e7-e08745fec097` observed effects `c27e2898-ca69-462b-a571-faf303e09096` and `0518a72c-498c-44c7-beb0-667907d9bab9`, with signature `refund-at-most-once|A123|count>1`.
  - `unzip -t artifacts/ec8c28ee-558a-4302-a8e7-e08745fec097/trace.zip` — exit 0; nonempty trace (71,844 bytes).
  - `git diff --cached --check` initially failed on six inherited trailing-space lines in `CODEX_RUN_LOG.md` and `implementation_plan.md`; removed only those spaces. Re-stage check then passed with no output.
  - Staged-content scan for token/private-key patterns and local machine paths — no matches. `git check-ignore` confirmed trace artifacts, `node_modules`, and `.DS_Store` are excluded. Staged list contains 23 intended source/docs/package/test files; `prompts/`, `browserproof_reviewer.toml`, raw handoff, artifacts, caches, browser binaries, and `.DS_Store` are excluded.
- **Latest artifact inspection:** `artifacts/ec8c28ee-558a-4302-a8e7-e08745fec097/` has the required JSON, JSONL, schedule, effects, result, screenshots, and valid trace. Events: exact first effect confirmed at sequence 8; `fault.triggered` at 10; browser `network.request_failed` at 11 with same request ID and `upstreamCommitted=true`; retry reason at 13; second effect confirmed at 17; successful response at 19; contract result at 22. Two distinct effect IDs and request IDs; one retry; expected normalized signature.
- **Repository rule:** Added a minimal `Repository publication policy` to `AGENTS.md` requiring reviewed, verified pushes to this exact `origin/main`, clean staged-file/security checks, no force-push, accurate partial-state reporting, final SHA equality checks, main-agent-only Git writes, and stopping for interactive authentication.
- **Historical correction:** Prompt00's phrase claiming the full handoff was copied is inaccurate for the M0 workspace. The handoff was absent during M0 and is not part of this publication; the Prompt00 entry is retained, with this correction appended.
- **Reviewer:** First staged-publication review found two P1 documentation issues: README used an ignored local artifact path as a public sample, and Prompt00's handoff-copy claim contradicted later entries. README now documents artifacts as local-only and instructs readers to generate a fault run and substitute its printed run ID. An append-only correction clarifies Prompt00. Reviewer then found a P2 checkpoint mismatch (`untracked` versus staged), corrected it to `staged and uncommitted`, and confirmed closure. Final staged source review found no secrets, machine paths, private handoff, or remaining publication blocker.
- **Publication:** Initial source commit `ca30ad836e5be3f5b107549f602210d20c9073c7` (`feat: implement verified BrowserProof M0 refund spike`) pushed to `https://github.com/krishna31102004/browser-proof` `main`; `git push -u origin main` exited 0. This was a normal first push to the empty remote, without force. Local HEAD equaled `git ls-remote origin refs/heads/main`. HTTPS retrieval returned byte-identical `README.md`, `packages/runner/src/run.ts`, `apps/demo-support/src/server.ts`, and `CODEX_RUN_LOG.md`. `gh auth status` had reported an invalid token, but normal Git push succeeded without prompting or token handling.
- **Local task files:** After the source push, status showed only `prompts/` and `browserproof_reviewer.toml` untracked. Added local-task exclusions to `.gitignore` so these remain on disk but outside the public source distribution and status; no artifacts or prompts were published.
- **Git state after source publication:** Branch `main` tracks `origin/main`; the M0 source commit above was remotely verified. The log/ignore follow-up changes are staged, and their commit/push/SHA checks remain `PENDING` at this point in the log.
- **Outcome:** `PUBLISHED AND VERIFIED` — the M0 source commit is on the exact public repository `main`, with remote/local SHA equality and all four required files retrievable. M0 recheck remains `PASS`.
- **Next action:** Stop at M0 for user review; do not begin Day 2/dashboard.

---

### Template — copy for every subsequent Codex prompt

```markdown
### Prompt NN — <short title> (<date/time and timezone>)

- **Scope / goal:**
- **Git state before:** branch and HEAD; uncommitted changes if any
- **Main agent:** owned paths; critical decisions
- **Subagents:** names, delegated boundaries, paths, outputs; or `not used`
- **Files changed:**
- **Commands actually executed:** command -> exit code -> relevant result (do not omit failures)
- **Tests/gates:** expected -> actual; pass/fail/blocked; count denominators
- **Artifact evidence:** exact paths, sample run IDs, effect IDs, violation signature
- **Review:** concrete findings (P0/P1/P2), status of fixes and retests
- **Deployment/CI:** URL/job/commit if actually verified; else `not run`
- **Issues and limits:** reproducible blockers, errors, open risks
- **Outcome:** PASS / PARTIAL / FAIL / BLOCKED, with why
- **Git state after:** branch, HEAD, uncommitted changes
- **Next prompt recommendation:** explicit scope only, no self-start
```

## Evidence hygiene

1. **Report a clean PASS only after a complete measured run.** An expected contract violation is a successful *detection test* only when its backend evidence is independently verified.
2. **No silent failure inflation.** Untriggered fault, observer unavailable, browser crash or synthetic data is not a detected seeded failure.
3. **No fictional deploys.** Require actual public HTTPS URL and manual/browser confirmation, not a successful local build alone.
4. **No hidden edits or successes.** Log failed commands, flaky trials, unexpected app state, and reviewer blockers.
5. **No resume metrics without campaign data.** Maintain source/run counts, 12 clean vs 24 seeded distinction, and actual denominators.

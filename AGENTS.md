# BrowserProof: Codex Repository Instructions

## Mission and sources

BrowserProof tests **browser agents** through controlled browser/network faults and independently verified backend effects. This is a locked project. `BrowserProof_Complete_Project_Handoff.md` owns architecture/product semantics; `implementation_plan.md` owns the compressed four-day priority order; `CODEX_RUN_LOG.md` owns observed progress; the user's current prompt owns the immediate task. Read only the sections needed for the active change, plus the latest log entry. Do not reopen project selection or novelty research.

## Engineering rules

- Think before coding: state material assumptions, blockers and tradeoffs briefly. Choose the smallest implementation meeting the active acceptance criteria; don't invent future features or unnecessary abstractions.
- Use TypeScript strict mode, Node, pnpm workspaces, Playwright/Chromium. No Python core, persistent DB, Redis, hosted browser runner or real payment operations in the conference release.
- The **agent** is the SUT. No scripted second refund from the runner. Same reference-agent retry policy for clean and faulted runs.
- Committed effects must come from an independently queried controlled-backend ledger, never from click counts, response status, screenshots or the agent's claim. Missing observer => `observer_inconclusive`, never passing empty effects.
- Distinguish `fault.armed` from `fault.triggered`, browser requests from upstream commits, and trace playback from fresh schedule reproduction. Capture correlation IDs where possible. Do not assert deterministic LLM replay.
- Preserve fresh `runId`, reset app namespace and fresh BrowserContext per run. No test writes to live third-party production services.
- Typed TypeScript contracts. Use existing real package boundaries; defer speculative frameworks and generalization until required. Prefer clear names and surgical edits. Don't touch unrelated files.
- Treat the proposed 10 types, 36 cases, 90% detection, CI and resume dates as **targets**, not completed facts. Never fabricate artifacts, benchmark metrics, PASS outputs or deployed URLs.

## Verification rules

- For every material change, run affected typechecks/tests plus the active plan's acceptance gate. Do not mark a gate passed until actual execution proves every condition. Record commands, exit codes, counts and paths in `CODEX_RUN_LOG.md`.
- M0: three independent clean trials with one committed refund, three faulted trials with two distinct committed refunds/one triggered fault and expected contract violation, then saved-schedule reproduction 3/3 in fresh contexts. Verify upstream commit actually precedes browser-visible loss. Test never-triggered faults and unavailable observer.
- Maintain versioned `manifest.json`, `scenario.json`, `schedule.json`, `events.jsonl`, `effects.json`, `result.json`, Playwright trace and screenshots. Use artifact-derived values for the public viewer, not hardcoded fake counters.
- Do not conceal failures. Include precise blocker, unsuccessful command, and remediation steps. Distinguish an intentionally detected violation from a broken harness.

## Parallel agent rules

- Main agent owns shared API/schema, runner integration, dependencies/lockfile, CI, deployment, final tests and the authoritative log.
- Delegate independent bounded work (app fixture, viewer, isolated tests) to at most 2 implementation workers at a time; keep a reviewer as a third subagent when feasible. State ownership paths before spawning; prohibit overlapping writes and shared configuration edits.
- Use project `browserproof_reviewer` subagent for evidence-based **read-only** review after integration. Reviewer must report findings with file:line, impact and reproduction; lead agent fixes and reruns tests. Do not treat read-only instructions as sandbox enforcement.
- If delegation isn't available, work sequentially. Do not stall or pretend agents ran.

## Operational boundaries

- Local disposable installs, builds, tests, generated artifacts and code changes within the active task are authorized. Do not push, deploy, publish, change external settings, spend money or use credentials without explicit user approval.
- Keep `CODEX_RUN_LOG.md` current **after every prompt**, with observed results only; don't overwrite earlier entries. Stop at the active prompt's gate rather than silently executing the next phase.
- Commands may evolve with the repository. Validate actual scripts before documenting them. For unimplemented commands, say `PLANNED`.

## Repository publication policy

- For each future approved BrowserProof implementation prompt, after targeted tests and independent review, the main agent commits the completed, verified work and pushes it to `origin/main` at `https://github.com/krishna31102004/browser-proof`.
- Before pushing, inspect remote status and staged files; exclude secrets, local artifacts, generated browser data, and sensitive research handoffs. Never force-push or rewrite history.
- If checks or review fail, do not mark the milestone PASS. Commit or push a clearly labeled partial state only when appropriate, and never describe it as completed.
- After pushing, verify remote `main` equals local `HEAD` and report the full commit SHA, branch, remote URL, verification commands, and test results.
- Only the main agent edits Git configuration, commits, and pushes. Subagents never push or concurrently edit `AGENTS.md`, the root lockfile, or the execution log.
- Stop if authentication requires user interaction. Do not ask for credentials in chat or record tokens.

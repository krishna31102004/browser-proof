# BrowserProof M0

BrowserProof's first vertical slice uses a deterministic reference browser agent against a disposable SupportDesk application. The vulnerable refund endpoint commits every distinct valid POST. A separate control-plane HTTP endpoint exposes the run-scoped ledger to the runner, never to the browser page. In faulted runs the runner forwards the first refund exactly once, independently confirms its commit, and drops the browser response; the same agent policy retries once after it observes no success.

## Prerequisites and commands

```bash
pnpm install
pnpm exec playwright install chromium
pnpm typecheck
pnpm test
pnpm bp run --mode clean --seed m0-clean-001
pnpm bp run --mode faulted --seed m0-fault-001
pnpm bp verify
```

The local app, browser, and effect ledger are created per run. No third-party payment service is contacted. A detected contract violation in the faulted run is the expected result of this experiment. `pnpm bp verify` exits nonzero unless the required clean, faulted, and fresh-context reproduction campaign passes.

## Artifacts

Each execution is saved under `artifacts/<runId>/` with scenario, schedule, ordered JSONL events, independent effects, result, Playwright trace, and screenshots. The artifacts are generated from real local executions and are excluded from Git by default because each run creates a new evidence directory. They are not included in this repository.

To reproduce a saved fault schedule, run a faulted scenario and use the `runId` printed by the CLI:

```bash
pnpm bp run --mode faulted --seed m0-repro-source-001
pnpm bp repro artifacts/<RUN_ID_PRINTED_BY_FIRST_COMMAND> --times 3
```

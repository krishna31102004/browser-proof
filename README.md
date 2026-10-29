# BrowserProof M0–Day 2

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

## AdminBench observation/action race

AdminBench is an isolated local app with Alice, Beacon, and Cirrus records and a separate control listener. The vulnerable agent remembers Beacon's observed row index; the hardened agent re-resolves Beacon by stable record ID immediately before clicking. A deterministic runner handoff can reorder the real DOM between observation and action. The effect ledger and final record state are read independently from the control listener.

```bash
pnpm bp run --scenario adminbench --agent vulnerable --mode clean --seed admin-clean-v1
pnpm bp run --scenario adminbench --agent vulnerable --mode faulted --seed admin-fault-v1
pnpm bp run --scenario adminbench --agent hardened --mode clean --seed admin-clean-h1
pnpm bp run --scenario adminbench --agent hardened --mode faulted --seed admin-fault-h1
pnpm bp verify --scenario adminbench
pnpm bp repro artifacts/<VULNERABLE_FAULT_RUN_ID> --times 3
```

The vulnerable faulted run is expected to commit an Alice update and report `update-correct-record|beacon|wrong-target:alice`, even though the UI confirms an update. The hardened agent triggers the same saved DOM fault but commits Beacon and passes the contract. The AdminBench verifier runs three trials for each agent/mode combination and three fresh-context reproductions, then writes a real A/B report under `artifacts/adminbench-ab-comparison-<id>.json`.

This repository currently demonstrates one network fault and one DOM observation/action fault. The dashboard, CI, deployment, Stagehand adapter, other fault types, and benchmark campaign are not part of this Day 2 slice.

## Artifacts

Each execution is saved under `artifacts/<runId>/` with scenario, schedule, ordered JSONL events, independent effects, result, Playwright trace, and screenshots. The artifacts are generated from real local executions and are excluded from Git by default because each run creates a new evidence directory. They are not included in this repository.

To reproduce a saved fault schedule, run a faulted scenario and use the `runId` printed by the CLI:

```bash
pnpm bp run --mode faulted --seed m0-repro-source-001
pnpm bp repro artifacts/<RUN_ID_PRINTED_BY_FIRST_COMMAND> --times 3
```

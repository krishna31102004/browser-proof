# AFROTECH walkthrough — 60 seconds

Public viewer: https://browserproof.vercel.app
Source: https://github.com/krishna31102004/browser-proof

This is static playback of five curated records from genuine local Playwright runs. The displayed backend effects were independently confirmed by the controlled demo ledger. The public site does not execute agents or host the runner.

## Screen-share route

| Time | Show | Say |
| --- | --- | --- |
| 0–15 sec | Open the public URL and point to the two timeline lanes. | “The left lane is what the browser and agent observed. The right lane is what the independent backend ledger confirmed.” |
| 15–30 sec | Show the faulted SupportDesk case: commit, dropped response, retry, second commit. | “The first refund committed before the browser saw failure. The same agent retried once, producing a second distinct refund. The at-most-once contract catches it.” |
| 30–45 sec | Open **Compare agents** and point to the matching schedule IDs and committed targets. | “Both agents received the same saved DOM reorder. The vulnerable policy updated Alice; the hardened policy resolved Beacon by stable ID.” |
| 45–60 sec | Open the [verified `BrowserProof regression` run](https://github.com/krishna31102004/browser-proof/actions/runs/40833167948) on commit `0c94ba99caf1b04c39702d3fa065bb2cd8862209`, then show the hardened command. | “CI checks the safe behavior. The vulnerable command is an expected negative control: it exits 1 only when the ledger confirms the wrong Alice update.” |

## Exact reproduction commands

Run the full refund acceptance gate:

```bash
pnpm bp verify
```

Run the hardened regression:

```bash
pnpm bp regression --fixture regressions/adminbench-dom-reorder --agent hardened
```

The vulnerable command is expected to exit 1 with `update-correct-record|beacon|wrong-target:alice` after an independently observed Alice effect:

```bash
pnpm bp regression --fixture regressions/adminbench-dom-reorder --agent vulnerable
```

Public responsive and evidence-asset smoke:

```bash
pnpm run viewer:smoke:remote -- --url https://browserproof.vercel.app
```

## Offline fallback

The viewer and five sanitized records are checked into the repository. With Node 22, pnpm 9.12.1 and Playwright Chromium installed, run:

```bash
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm viewer:build
pnpm --filter @browserproof/viewer preview
```

Open the local Vite Preview address printed in the terminal. This serves the same static evidence bundle; it is not a live agent run. A previously captured remote overview screenshot is also available at `apps/viewer/.visual-review/remote-browserproof.vercel.app/overview-desktop-1440x900.png` on the verification machine.

# AFROTECH walkthrough — 60 seconds

Public viewer: https://browserproof.vercel.app
Source: https://github.com/krishna31102004/browser-proof

This is static playback of five curated records from genuine local Playwright runs. The displayed backend effects were independently confirmed by the controlled demo ledger. The public site does not execute agents or host the runner.

## Screen-share route

| Time | Show | Say |
| --- | --- | --- |
| 0–12 sec | Open the overview and point to “One failure. Two refunds committed.” Select the first event in the dark incident rail. | “BrowserProof tests browser agents under controlled failures. This recorded run shows why the browser’s error message can hide a completed backend action.” |
| 12–30 sec | Open the full SupportDesk case. Point to sequence 8 ledger commit, sequence 11 browser failure, sequence 13 retry, sequence 17 second commit, and sequence 22 contract result. | “The first refund committed before the browser saw failure. The same agent retried once, producing a second distinct refund. An independent ledger confirms both effects; the at-most-once contract catches the duplicate.” |
| 30–45 sec | Open **Compare agents**. Point to the shared schedule and the Alice versus Beacon ledger targets. | “Both agents received the same saved DOM reorder. The vulnerable policy updated Alice; the hardened policy resolved Beacon by stable ID.” |
| 45–60 sec | Open the [GitHub Actions workflow history](https://github.com/krishna31102004/browser-proof/actions/workflows/browserproof.yml) for the current commit, then show the hardened command. | “CI checks the safe behavior. The vulnerable command is an expected negative control: it exits 1 only when the ledger confirms the wrong Alice update.” |

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

The viewer and five sanitized records are checked into the repository. Current desktop, tablet, and phone screenshots from the latest UI review are under `apps/viewer/.visual-review/prompt06-final/local/` on the verification machine. With Node 22, pnpm 9.12.1 and Playwright Chromium installed, run:

```bash
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm viewer:build
pnpm --filter @browserproof/viewer preview
```

Open the local Vite Preview address printed in the terminal. This serves the same static evidence bundle; it is not a live agent run.

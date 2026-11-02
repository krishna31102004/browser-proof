# AFROTECH walkthrough — 60 seconds

Public Evidence Journal: [browserproof.vercel.app](https://browserproof.vercel.app)<br>
Source and Actions: [krishna31102004/browser-proof](https://github.com/krishna31102004/browser-proof)

The public viewer is static playback of five curated records from genuine local Playwright runs. It does not run agents or host the runner. The current Gemini 3.6 live acceptance is **PARTIAL**: three clean trials passed; the first faulted trial received HTTP 429 before model action or fault trigger. Do not present this as a completed 3+3+3 acceptance campaign.

## Screen-share route (60 seconds)

| Time | Show | Say |
| --- | --- | --- |
| 0–12 sec | Open the viewer overview; select the refund incident. | “BrowserProof tests browser agents under controlled failures and checks what really committed in the backend. This journal lets you inspect the browser story and backend truth side by side.” |
| 12–27 sec | Show the Gemini 3.6 clean A123 run record; point to the refund action and effect. | “This is a genuine model-backed Stagehand clean run. Gemini selected the visible A123 refund action; the independent ledger recorded one $42.50 refund.” |
| 27–43 sec | Show the deterministic post-commit response-loss trace: commit, lost browser response, retry, second commit, contract violation. | “This separate deterministic reference-agent demonstration commits before the browser loses the response. The retry creates a second effect, and the at-most-once contract catches it. This is not a Gemini faulted result.” |
| 43–53 sec | Open the DOM reorder/AdminBench evidence and compare the wrong Alice target with Beacon. | “The same saved reorder schedule shows why labels are fragile: the vulnerable policy updates Alice, while the hardened policy resolves Beacon by stable identity.” |
| 53–60 sec | Return to the journal overview, then point to repository Actions. | “The evidence is inspectable, reproducible, and checked in CI. Live Gemini acceptance currently has three clean passes and is incomplete after a provider 429.” |

## Evidence references

- Gemini 3.6 clean trials (local artifacts):
  - `artifacts/4870ce92-6568-4db9-8b77-5f260b932a65/`
  - `artifacts/89f3ba99-27aa-40bb-965b-3731ce24ff03/`
  - `artifacts/b45aa8b5-ca94-444f-a87c-34264181104f/`
- First faulted Gemini 3.6 attempt, HTTP 429 before a model action; **not accepted**: `artifacts/93f1650e-613a-41d3-8384-20c51602f0b8/`
- Historical deterministic M0 post-commit response-loss evidence: `artifacts/ec8c28ee-558a-4302-a8e7-e08745fec097/` (if present in the local checkout); its acceptance was previously verified and is distinct from Stagehand live acceptance.
- Current run summary: `artifacts/stagehand-verification-a5aaaf88-e3c7-48d9-918e-20e1bab19658.json`.
- Exact observed counts: **3/3 Gemini 3.6 clean; 0/3 Gemini 3.6 faulted; 0/3 Gemini 3.6 fresh reproductions; overall live acceptance PARTIAL.** Historical 3.8 acceptance remains PARTIAL. Benchmark remains 0/36; detection rate is unmeasured.

## Reproduce deterministic evidence offline

Run the established deterministic refund acceptance gate (this is reference-agent evidence, not Gemini inference):

```bash
pnpm bp verify
```

Open the existing journal online at the URL above. To serve its static bundle locally without network dependence:

```bash
pnpm install --frozen-lockfile
pnpm viewer:build
pnpm --filter @browserproof/viewer preview -- --host 127.0.0.1
```

Open the local Vite Preview URL printed by the command. This fallback uses the checked-in evidence bundle; it is not a live agent run. Do not run Gemini during the offline fallback.

## Provider quota note

The first Gemini 3.6 faulted request returned HTTP 429. The retained callback artifact records status/category and a generic sanitized cause, but no provider error body or response headers that would identify RPM, TPM, RPD, or another quota. Google documents these separate dimensions and says RPD resets at midnight Pacific; the active project/model limits are shown in the [AI Studio Rate Limits dashboard](https://aistudio.google.com/rate-limit?timeRange=last-28-days). Dashboard inspection was attempted in the existing browser session but the navigation timed out, so project-specific limits and current quota availability remain unknown. Do not resume live trials until the project dashboard or quota reset provides evidence of availability.

After quota availability is confirmed, resume without repeating accepted clean trials:

```bash
set +x; set -a; . ./.env; set +a
pnpm bp verify --scenario stagehand-smoke --allow-free-tier-gemini --max-model-runs 9 --model google/gemini-3.6-flash --inference-transport client-callback --resume-report artifacts/stagehand-verification-a5aaaf88-e3c7-48d9-918e-20e1bab19658.json
```

The resumed verifier validates and reuses the three exact clean run artifacts, retains the failed fourth run as historical evidence only, then begins a new faulted run. With project-specific minute limits unavailable, campaign requests are paced at least 20 seconds apart; this is a conservative provisional ceiling and does **not** guarantee quota compliance. A 429 or any failed acceptance gate stops the campaign.

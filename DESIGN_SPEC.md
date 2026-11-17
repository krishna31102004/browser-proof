# BrowserProof Public Site: Design Specification

Implementation-ready design for the revamp of `apps/viewer`. Companion documents: `TYPE_SYSTEM.md` (typography, fonts) and `REVAMP_AUDIT.md` (what is wrong today and what must be preserved).

Stack constraints (unchanged): React 19, TypeScript, Vite 6, hand-written token-driven CSS (no Tailwind, no CSS-in-JS, no component library), hash routing, static read-only evidence. No new runtime dependency is required by this design (see 16.7).

Global copy rules: no em dashes in any visible string, alt text, title or meta tag. Sentence case everywhere. Never the words "live", "real-time" or "running" for recorded material. Never "because" between the lost response and the retry.

---

## 1. Product positioning

**One-line:** BrowserProof is a reliability-testing framework for AI browser agents. It runs an agent under controlled browser and network faults and verifies what the backend actually committed against a contract.

**The distinction the whole site exists to teach:** clicks, browser responses and agent claims do not establish that a backend operation happened correctly. An independently queried backend effects ledger does.

**Category:** developer infrastructure, testing and reliability. Tone: precise, calm, evidence-first. It should look like a tool a platform team would adopt, not a personal debugging console and not generic AI SaaS.

**Proof points that may be stated (and nothing beyond them):**

| Claim | Exact wording to use |
|---|---|
| Fault coverage | "Ten fault types covered by regression tests" |
| Apps | "Three controlled apps: SupportDesk, AdminBench, ShopBench" |
| Benchmark | "36-case deterministic benchmark: 12 of 12 clean runs passed, 24 of 24 constructed violations detected, 24 of 24 reproduced in a fresh run, 0 false positives" |
| Infrastructure | "0 infrastructure, observer or injection failures" |
| LLM campaign | "9 accepted trials with an OpenAI GPT-6 Luna agent" |
| CI | "Passing GitHub Actions" |
| Site | "Static public evidence viewer" |

**Honesty that must be visible wherever the benchmark number appears (same viewport, not behind a click):** the 24 of 24 comes from a deterministic reference agent with no language model, against test apps deliberately built to be non-idempotent. It validates the harness's sensitivity to constructed violations. It is not a real-world agent failure rate and not a universal detection accuracy.

---

## 2. Audiences and reading paths

### Recruiter or hiring manager: 10 seconds, landing page only, no scroll required at 1440x900

| Second | Sees | Learns |
|---|---|---|
| 0 to 3 | Hero h1 "One lost response. Two refunds committed." | The concrete failure |
| 3 to 6 | Lede (one sentence pair) | What the product does and why the ledger matters |
| 6 to 8 | Hero metric "24 / 24" with its one-line scope | What was achieved, stated honestly |
| 8 to 10 | Showcase replay starting under the hero | Why it is technically impressive |

Exit points: "View source on GitHub", footer LinkedIn.

### Engineer: 3 minutes

1. Landing showcase: watch or step the six beats; select a beat to see the real event (sequence number, timestamp, IDs).
2. "Open the full case record" to `#/case/supportdesk-faulted`: dual-lane timeline, key events first, all 23 events on demand, screenshots, evidence files, reproduction command.
3. `#/compare`: same saved fault, two selection strategies, different committed record.
4. `#/benchmark`: 36-cell matrix, methodology, limitations, provenance, commands.
5. GitHub.

Every page ends with the next step in this path (see 4).

---

## 3. Navigation

### 3.1 Routes (hash routing preserved)

| Route | Page | `document.title` |
|---|---|---|
| `#/` (also empty hash) | Landing | `BrowserProof · Verify What Browser Agents Actually Did` |
| `#/evidence` | Evidence Explorer | `Evidence · BrowserProof` |
| `#/case/:id` | Case Details (IDs unchanged) | `{human title} · BrowserProof` |
| `#/case/:id?event=N` | Case Details with event N selected and scrolled into view | same |
| `#/compare` | Agent Comparison | `Agent comparison · BrowserProof` |
| `#/benchmark` | Benchmark Results | `Benchmark results · BrowserProof` |
| anything else | Not Found | `Not found · BrowserProof` |

Router changes: strip a trailing `?query` from the hash before matching (`#/case/supportdesk-faulted?event=8` must resolve `caseId = "supportdesk-faulted"`); add `evidence` and `benchmark`; an unknown case ID renders the Not Found page with the case variant copy (10.6). On every route change: set `document.title`, `window.scrollTo(0, 0)` (instant), and move focus to `<main id="main-content" tabindex="-1">`. Remove `scroll-behavior: smooth` from `html`.

In-page jumps (hero CTA to showcase) must not use `href="#..."` because the hash is the router. Use a `<button>` that calls `element.scrollIntoView({ behavior: prefersReducedMotion ? "auto" : "smooth", block: "start" })`; the target has `scroll-margin-top: 88px`.

### 3.2 Header

Sticky, `top: 0`, `z-index: 40`, height 64px (56px below 720px), background `--bg`, `border-bottom: 1px solid var(--border-subtle)`. Content sits in the standard container (12).

| Position | Item | Target |
|---|---|---|
| Left | Mark (24px) + wordmark "BrowserProof" (Geist 500, 16px, `--text-primary`, tracking -0.01em), 8px gap | `#/`, `aria-label="BrowserProof home"` |
| Right | "Evidence" | `#/evidence` (also current for `#/case/*`) |
| Right | "Compare" | `#/compare` |
| Right | "Benchmark" | `#/benchmark` |
| Right, after a 1px x 20px `--border` divider with 16px margins | GitHub icon (16px) + "GitHub" | `https://github.com/krishna31102004/browser-proof`, `target="_blank" rel="noreferrer"`, `aria-label="BrowserProof on GitHub (opens in a new tab)"` |

Nav link: `--text-body-sm` weight 500, colour `--text-secondary`, padding `0 12px`, height 44px, radius `--radius-md`. Hover: colour `--text-primary`, background `--surface-2`. Current page (`aria-current="page"`): colour `--text-primary` and a 2px `--accent` underline, 12px inset left and right, at the bottom edge of the link. Link gap 4px.

Below 720px: the three links and GitHub collapse behind a 44x44 menu button (three-line icon, `aria-expanded`, `aria-controls="site-menu"`, label "Menu"). The menu is a panel directly under the header: full width, background `--surface-1`, `border-bottom: 1px solid var(--border)`, each link a 52px row with 16px side padding and a 1px `--border-subtle` divider. Opens with opacity 0 to 1 and translateY(-4px) to 0 over 180ms; closes instantly. Escape closes and returns focus to the button; any navigation closes it.

No "static recorded evidence" badge in the header. That statement lives in the showcase header, the Evidence and Case page ledes, and the footer.

### 3.3 Footer (all pages)

Container width, `border-top: 1px solid var(--border-subtle)`, padding `48px 0 40px`, margin-top 128px (96px mobile).

Row 1 (space-between, wraps on mobile): left: mark 20px + "BrowserProof"; right: links "Evidence", "Compare", "Benchmark", "GitHub", "LinkedIn" (`https://www.linkedin.com/in/krishnabalaji`), `--text-body-sm`, `--text-secondary`, 24px gap, each with a 44px minimum hit height.

Row 2 (24px below, `--text-caption`, `--text-muted`): left: "Built by Krishna Balaji. © 2026." Right: "Static recorded evidence. Nothing on this site executes an agent."

No licence statement of any kind (the repository has no LICENSE file).

### 3.4 Skip link

"Skip to content", first focusable element, visually hidden until focused, then fixed at top 8px left 8px, background `--accent`, colour `--accent-ink`, padding `12px 16px`, radius `--radius-md`.

---

## 4. Exact page hierarchy

### 4.1 Landing `#/`

1. Header
2. Hero (h1, lede, primary CTA, secondary CTA, GitHub link, primary proof metric)
3. **Recorded incident showcase** (the one dominant visual)
4. Why it matters (three statements)
5. How a run is verified (compact architecture, four steps)
6. Benchmark results summary (four figures, scope, link)
7. Recorded evidence teaser (five case links, compare link)
8. Built with (technology stack)
9. Footer

### 4.2 Evidence Explorer `#/evidence`

1. Page header (h1, lede, provenance line)
2. Group "SupportDesk: refund an order" with 2 case entries
3. Group "AdminBench: deactivate a record" with 3 case entries
4. Comparison callout (link to `#/compare`)
5. Provenance details (collapsed)

### 4.3 Case Details `#/case/:id`

1. Breadcrumb
2. Case header (h1, scenario sentence, verdict pill, meta line)
3. Verdict summary (Intended / Browser and agent saw / Ledger observed / Contract)
4. Record order diagram (AdminBench cases only)
5. **Timeline** (dominant visual): toolbar, dual lanes, inspector
6. Screenshots
7. Evidence files
8. Reproduce locally
9. Previous and next case

### 4.4 Agent Comparison `#/compare`

1. Breadcrumb
2. Page header (h1, lede)
3. Shared-fault bar
4. **Two-column comparison** (dominant visual)
5. Conclusion statement
6. Reproduce locally (both commands)

### 4.5 Benchmark Results `#/benchmark`

1. Page header (h1, lede)
2. Scope note ("Read this first")
3. Headline figures (four)
4. **Case matrix, 12 workflows by 3 conditions** (dominant visual)
5. Methodology
6. Limitations
7. Separate LLM campaign note
8. Provenance
9. Reproduce locally

### 4.6 Not Found

1. Centered message, two links.

---

## 5. Exact hero copy

| Element | Copy |
|---|---|
| h1 line 1 | One lost response. |
| h1 line 2 (italic serif, `--accent`) | Two refunds committed. |
| Lede | BrowserProof tests AI browser agents under controlled browser and network faults, then checks what the backend actually committed. The verdict comes from an independently queried effects ledger, not from clicks, responses, or the agent's own report. |
| Primary CTA (button) | Watch the recorded incident |
| Secondary CTA (link) | See benchmark results |
| Tertiary link | View source on GitHub |
| Metric numeral | 24 / 24 |
| Metric label | constructed contract violations detected, each reproduced in a fresh run |
| Metric secondary line | 12 of 12 clean runs passed. 0 false positives. |
| Metric scope note | Measured with a deterministic reference agent on purpose-built test apps. It shows the harness catches the violations it was built to catch, not how often real AI agents fail. |
| Metric link | Methodology and limitations |

Why "lost response" and not "failure": the recorded fault is a response lost after the commit; the request itself succeeded on the backend. The headline states two recorded facts in recorded order and asserts no cause.

The h1 is real text (two `<span style="display:block">` lines inside one `<h1>`), not an image. `aria-label` is not used; the text reads naturally.

---

## 6. Supporting copy for every major section (final)

### 6.1 Landing: showcase

| Element | Copy |
|---|---|
| Section label | Recorded incident |
| h2 | A refund, replayed from the record |
| Intro | The agent was asked to refund order A123 once. This is what the browser saw and what the ledger recorded, in recorded order. Select any step to inspect the event behind it. |
| Provenance chip | Recorded run · 29 Oct 2026 UTC · replay, not live |
| Static outcome line | Recorded outcome: 2 refunds committed. Contract violated. |
| Lane 1 label / caption | Browser and agent / What the page and the agent observed |
| Lane 2 label / caption | Independent ledger / Queried by a separate observer |
| Beat 1 title / text | Refund requested / The agent clicks Refund. The browser sends the request. |
| Beat 2 title / text | First refund committed / The observer finds refund 1 in the ledger. |
| Beat 3 title / text | Response lost / The injected fault drops the reply. The browser records a failed request. |
| Ledger note under beat 3 column | Ledger unchanged: 1 refund |
| Gap marker | 1.2 s later |
| Beat 4 title / text | Second request sent / The agent then retries. The browser sends another refund request. |
| Beat 5 title / text | Second refund committed / The observer finds refund 2 for the same order. |
| Browser readout label | Browser saw |
| Browser readout values (by step) | steps 0: Nothing yet · steps 1 to 2: 1 request in flight · steps 3 to 4: 1 failed request · steps 5 to 6: 1 failed request, then 1 success |
| Ledger readout label | Ledger holds |
| Ledger readout values (by step) | steps 0 to 1: 0 refunds · steps 2 to 4: 1 refund · steps 5 to 6: 2 refunds; suffix line "for order A123" |
| Contract bar label / name | Contract / Refund at most once |
| Contract bar detail (by step) | steps 0 to 5: Limit 1. Not yet evaluated. · step 6: Limit 1. Observed 2. |
| Contract bar pill | steps 0 to 5: Pending · step 6: Violated |
| Footnote | Events are shown in recorded order. The record shows the retry came after the lost response. It does not establish why the agent retried. |
| Controls | Pause · Play · Replay (reduced motion: Previous step · Next step) |
| Inspector empty state | Select a step to see its recorded event. |
| Inspector link | Open this event in the full timeline |
| Section link | Open the full case record |

### 6.2 Landing: why it matters

| Element | Copy |
|---|---|
| h2 | A browser cannot tell you what the backend did |
| Statement 1 title / body | A click is not a commit. / An agent can press the right button and the operation can still fail, or happen twice. |
| Statement 2 title / body | A response is not a commit. / A request can commit on the server while its response is lost on the way back. The browser sees a failure. The refund has already been issued. |
| Statement 3 title / body | A claim is not a commit. / Agents report success from what is on screen. BrowserProof sets the report aside and reads the ledger. |

### 6.3 Landing: how a run is verified

| Element | Copy |
|---|---|
| h2 | How a run is verified |
| Intro | Four stages, each recorded with sequence numbers and correlation IDs so any conclusion can be traced back to its events. |
| Step 1 title / body | Run the agent in a real browser / The agent drives a real Playwright page against one of three controlled apps: SupportDesk, AdminBench or ShopBench. |
| Step 2 title / body | Inject one fault at a known boundary / A saved schedule triggers a single fault, such as a lost response or a reordered list, at an exact point in the run. Ten fault types are covered by regression tests. |
| Step 3 title / body | Observe the backend independently / A separate observer queries the app's effects ledger through its own control port. It never reads the browser or the agent. |
| Step 4 title / body | Evaluate the contract / Typed contracts such as "refund at most once" are checked against the ledger. A violation gets a stable signature, and the saved schedule can be run again in a fresh browser to reproduce it. |

### 6.4 Landing: benchmark summary

| Element | Copy |
|---|---|
| h2 | 36 cases. Every constructed violation detected. |
| Figure 1 | 12 / 12 · clean runs passed |
| Figure 2 | 24 / 24 · constructed violations detected |
| Figure 3 | 24 / 24 · reproduced in a fresh run |
| Figure 4 | 0 · false positives |
| Scope title | What this does and does not show |
| Scope body | The benchmark runs a deterministic reference agent, with no language model, against test apps built to be non-idempotent. It shows that the harness injects each fault where intended, observes the commit independently and classifies the outcome correctly. It does not measure how often real AI agents fail, and it is not a universal detection accuracy. |
| LLM line | Separately, 9 trials with an OpenAI GPT-6 Luna agent were recorded and validated. See the benchmark page for what they do and do not show. |
| Link | Full results, methodology and limitations |

### 6.5 Landing: evidence teaser

| Element | Copy |
|---|---|
| h2 | Five recorded runs you can open |
| Intro | Each case includes its events, ledger effects, screenshots and contract result. |
| Rows | the five human titles from 17.2, each with its verdict pill |
| Link 1 | Browse the evidence |
| Link 2 | Compare two agents under the same fault |

### 6.6 Landing: built with

| Element | Copy |
|---|---|
| h2 | Built with |
| Row: Language | TypeScript on Node.js 22, pnpm workspaces |
| Row: Browser automation | Playwright, Chromium |
| Row: Agent adapter | Stagehand v4 with OpenAI GPT-6 Luna, used for the 9-trial campaign |
| Row: Verification | Typed contracts and a versioned fault schedule registry |
| Row: Continuous integration | GitHub Actions |
| Row: This site | React 19, Vite 6, static hosting on Vercel |

### 6.7 Evidence Explorer

| Element | Copy |
|---|---|
| h1 | Five recorded runs, open for inspection |
| Lede | Each case is a real local Playwright run against a controlled test app, exported with its events, ledger effects, screenshots and contract result. The apps and their data are synthetic. The runs are real. Nothing here runs live. |
| Provenance line | Exported {exportedAt as "29 Oct 2026"} from {n} validated run artifacts. |
| Group 1 heading / sub | SupportDesk: refund an order / The agent is asked to refund order A123 once. |
| Group 2 heading / sub | AdminBench: deactivate a record / The agent is asked to deactivate the record named Beacon. |
| Entry field labels | Scenario · Intended · Ledger observed · Contract |
| Entry link | Open case |
| Comparison callout title | Same fault, two agents |
| Comparison callout body | The two AdminBench runs with reordered rows used the same saved fault. One agent selected by row position, the other by record ID. |
| Comparison callout link | Open the comparison |
| Provenance details summary | Provenance and artifact fingerprints |
| Provenance details body | The dataset `provenance.note` verbatim, then a table: Run ID, Scenario, Schedule, SHA-256 (all mono) |

### 6.8 Case Details (shared strings)

| Element | Copy |
|---|---|
| Breadcrumb | Evidence / {human title} |
| Meta line | {App} · {fault label or "No fault injected"} · {agent label} · Recorded {date} UTC |
| Summary labels | Intended · Browser and agent saw · Ledger observed · Contract |
| Timeline h2 | What the browser saw, what the ledger recorded |
| Timeline intro | Events appear in recorded sequence. The left lane is what the browser, agent and test runner recorded. The right lane is the independent observer and the contract. Select an event for its timestamp, payload and linked IDs. |
| View toggle | Key events ({k}) · All events ({n}) |
| Filter labels | All · Observation · Agent action · Network · Fault · Backend effect · Contract |
| Empty filter | No recorded events match this filter. |
| Lane headings | Browser, agent and runner · Independent observer and contract |
| Correlation legend | Events that share an action share a marker: Attempt 1, Attempt 2. |
| Inspector empty | Select an event to inspect it. |
| Inspector labels | Sequence · Recorded at (UTC) · Source · Evidence basis · Event type · Agent step · Action ID · Request ID · Effect ID · Payload |
| Inspector payload summary | Recorded payload |
| Screenshots h2 / intro | Screenshots from this run / Captured by the runner during the recorded run. Select one to enlarge. |
| Screenshots empty | No screenshots were captured for this run. The events and ledger result above are complete. |
| Evidence files h2 / intro | Raw evidence files / The exported, sanitized source files for this run. They open as JSON in a new tab. |
| Evidence file names | Scenario · Fault schedule · Ledger effects · Result · Event log |
| Reproduce h2 | Reproduce locally |
| Reproduce note | This site only shows recorded evidence. Reproduction runs on your machine and produces a new run with new IDs. |
| Copy button / confirmation | Copy command / Copied |
| Reproduce link | Setup and prerequisites on GitHub |
| Prev / next | Previous case · Next case |

Per-case scenario sentences, summary values and reproduce explanations are in 17.2.

### 6.9 Agent Comparison

| Element | Copy |
|---|---|
| h1 line 1 / line 2 (italic) | Same fault. / Different record changed. |
| Lede | Both agents were asked to deactivate Beacon. Both runs used the same saved fault: the record list was reordered after the agent observed it and before it clicked. One agent selects by row position. The other selects by record ID. |
| Shared-fault bar | Shared fault · Rows reordered after observation · Same saved schedule in both runs (mismatch state: "Schedules do not match") |
| Column 1 title / sub | Selects by row position / The remembered position pointed at a different record after the reorder. |
| Column 2 title / sub | Selects by record ID / The agent resolved Beacon by its stable ID after the reorder. |
| Diagram labels | Order the agent observed · Order at the moment of the click |
| Row tags | Requested · Clicked · Changed in ledger |
| Fact labels | Browser reported · Ledger recorded · Final record states · Contract |
| Fact values, column 1 | "Record updated successfully" · Alice set to inactive · Alice inactive, Beacon active, Cirrus active · Update only the requested record: violated (wrong record: Alice) |
| Fact values, column 2 | "Record updated successfully" · Beacon set to inactive · Alice active, Beacon inactive, Cirrus active · Update only the requested record: passed |
| Column link | Open this case |
| Conclusion h2 | Both pages said "Record updated successfully" |
| Conclusion body | The browser's message was identical in both runs. Only the independently queried ledger shows which record changed, and only the contract says whether that was the requested one. |
| Reproduce labels | Position-based agent (expected to exit 1 with a confirmed wrong-record effect) · ID-based agent (expected to exit 0) |
| Missing data | The evidence set does not contain both sides of this comparison. |

### 6.10 Benchmark Results

| Element | Copy |
|---|---|
| h1 | 36 cases, run once, published as recorded |
| Lede | Twelve workflows across three controlled apps. Each workflow runs once with no fault and twice with a different injected fault. Every number on this page is read from the committed results file. |
| Scope title | Read this first |
| Scope body | These results come from a deterministic reference agent with no language model, running against test apps that were deliberately made non-idempotent. They validate that the harness detects the violations it was constructed to produce. They are not an estimate of how often real AI agents fail, and not a claim of universal detection accuracy. |
| Figures | 12 / 12 clean runs passed · 24 / 24 constructed violations detected · 24 / 24 reproduced in a fresh run · 0 false positives |
| Figure sub-line | 36 of 36 cases valid. 0 infrastructure, observer or injection failures. 0 missed. |
| Matrix h2 | Every case, by workflow and condition |
| Matrix column heads | Workflow · No fault · Injected fault A · Injected fault B |
| Matrix cell text | clean cell: "Passed · 1 effect"; fault cell: "{fault label}" then "Detected · Reproduced" |
| Matrix legend | Passed: the run met its contract with no fault injected. Detected: the ledger showed a violation and the run flagged it with the pre-registered signature. Reproduced: re-running the saved schedule in a new browser context gave the same signature with new effect IDs. |
| Matrix row detail summary | Show identifiers |
| Methodology h2 | How detection is counted |
| Methodology items | see below |
| Limitations h2 | Limitations |
| Limitations items | see below |
| LLM h2 | A separate 9-trial run with a language-model agent |
| LLM body | Outside this benchmark, 9 trials with an OpenAI GPT-6 Luna agent were recorded and their artifacts validated: 3 with no fault and one refund each, 3 with a lost response and two refunds each, and 3 fresh reproductions with matching outcomes. In the faulted trials the agent adapter began reconsidering the task before the browser observed the lost response. These trials therefore do not show that the lost response caused the retry decision. |
| Provenance h2 | Provenance |
| Provenance labels | Report ID · Generated (UTC) · Source commit · Working tree · Agent · Results file · Frozen case manifest |
| Provenance values | from data; working tree "Clean" when `workingTreeDirty` is false; commit links to `https://github.com/krishna31102004/browser-proof/commit/{gitCommit}`; files link to `benchmarks/results.v1.json` and `benchmarks/cases.v1.json` on GitHub at that commit |
| Reproduce h2 | Run it yourself |
| Reproduce note | The full benchmark takes about six minutes and runs one Chromium at a time. Run directories are written locally and are not published. |
| Data error | Benchmark results could not be loaded. No placeholder figures are shown. |

Methodology items (ordered list, final copy):

1. **Expected label.** For each case, a function re-derives from the saved ledger effects alone whether a safety violation occurred: a duplicate commit or a commit to the wrong target. It does not read the runner's verdict.
2. **Flag.** The run's own contract evaluation must report a contract violation with the signature that was registered in the frozen case manifest before the run.
3. **Detected.** The fault triggered once at the expected phase, the observer completed, the saved artifacts passed their audit, the ledger showed a violation, and the run flagged it with the expected signature. A real violation reported under a different signature counts as missed.
4. **False positive.** A no-fault case that is anything other than a clean pass.
5. **Reproduced.** The saved schedule is executed again with a new run ID, a new browser context and a reset app. It must trigger again, pass the artifact audit, give the same signature and produce effect IDs that do not overlap the original. Trace playback is never counted as reproduction.
6. **One attempt per case.** No reruns are selected. Invalid, untriggered or inconclusive cases would be listed by ID and kept in the denominator. There were none.

Limitations items (unordered list, final copy):

- The agent is a deterministic script, not an AI model. It retries once after any visible failure, so every post-commit fault produces a duplicate by construction.
- The test apps were deliberately changed to be non-idempotent, so a repeated request commits a second effect. Systems that use idempotency keys would behave differently.
- The result measures whether the harness detects violations it was built to produce. It says nothing about how often real agents fail or about failure modes nobody constructed.
- The expected label and the flag both come from the same saved ledger snapshot, through separate code paths. There is no human-labelled reference and no second observer, so an observer bug would affect both.
- The benchmark exercises five of the ten fault types. The other five, including request abort, lead only to recovered runs or runs with no effect, which are not safety violations. They are covered by regression tests instead.
- One machine, local Chromium, one published pass on a clean tree at the recorded commit. A four-case wiring check and one earlier full pass on uncommitted code preceded it and are not the published result.

### 6.11 Not Found

| Element | Copy |
|---|---|
| h1 | Nothing recorded at this address |
| Body (unknown route) | The address `/{path}` does not match any page. The evidence is unchanged. |
| Body (unknown case) | No recorded case has the identifier `{id}`. The evidence is unchanged. |
| Primary link | Back to home |
| Secondary link | Browse the evidence |

### 6.12 System states

| State | Copy |
|---|---|
| Loading | Loading recorded evidence |
| Dataset error h1 | The evidence could not be loaded |
| Dataset error body | {error message}. This site only shows a validated, checked-in dataset and never substitutes placeholder runs. |
| Dataset error link | Review the source repository |

---

## 7. Accent: two candidates and the final pick

Red, amber and green are reserved for status, so the accent must be clearly none of them and must read as "independent evidence" against a warm near-black.

| | Candidate A: Ledger Blue | Candidate B: Ember Copper |
|---|---|---|
| Hex | `#8FBFEA` | `#D8894A` |
| Contrast on `--bg #131110` | 9.69:1 | 6.81:1 |
| Rationale for | A desaturated, slightly grey sky blue. Cool against the warm base, so a small amount carries. Reads as "record, ink, instrument", not as SaaS blue (`#3B82F6` is far more saturated and darker). Cannot be mistaken for pass, warn or fail. Gives the ledger lane its own unmistakable voice next to a neutral browser lane. | Harmonises with the warm base and feels crafted and editorial. Strong with Instrument Serif. |
| Rationale against | Cool accent on warm base needs discipline: used on more than about 10 percent of the surface it turns the site cold. | Sits between amber (`#E6B450`) and red (`#F2786A`) in hue. In the showcase, where "injected fault" is amber and "violated" is red, a copper ledger lane would blur the three meanings. Fails the "one accent, status colours stay semantic" test in practice. |

**Final pick: Ledger Blue `#8FBFEA`.**

Accent usage rules (the 10 percent):

1. The independent ledger: lane label, lane rail, ledger beat markers, ledger readout numeral, the mark's ledger square.
2. The second hero line.
3. The primary button fill.
4. Current-nav underline, focus ring, text links on hover, selected event outline.
5. Nowhere else. No accent backgrounds on sections, no accent gradients, no accent borders on ordinary cards.

---

## 8. Colour tokens

Dark only (`color-scheme: dark`). No light theme.

```css
:root {
  color-scheme: dark;

  /* 60: base */
  --bg: #131110;
  --surface-1: #1B1816;
  --surface-2: #24201D;
  --surface-3: #2E2925;

  /* 30: neutrals */
  --text-primary: #F2EDE4;
  --text-secondary: #BDB5A8;
  --text-muted: #978F83;
  --border-subtle: #2C2723;
  --border: #3A342F;
  --border-control: #7D7468;

  /* 10: accent */
  --accent: #8FBFEA;
  --accent-hover: #A9CFF2;
  --accent-ink: #10161C;
  --accent-soft: #16222D;
  --accent-border: #2B4257;
  --accent-tint-hover: rgb(143 191 234 / 0.08);   /* ledger-lane beat hover (timeline right-lane hover uses 0.10 via --accent-tint-row) */
  --accent-tint-row: rgb(143 191 234 / 0.10);
  --accent-tint-active: rgb(143 191 234 / 0.14);  /* ledger-lane active beat */

  /* status only */
  --fail: #F2786A;   --fail-soft: #33191A;   --fail-border: #6B2E2A;
  --pass: #6FCF8E;   --pass-soft: #15291C;   --pass-border: #2C5A3C;
  --warn: #E6B450;   --warn-soft: #30240F;   --warn-border: #6A5220;

  /* utility */
  --focus-ring: #8FBFEA;
  --overlay: rgb(10 9 8 / 0.88);
  --selection-bg: #8FBFEA;
  --selection-text: #10161C;
}
```

Status semantics (fixed):

| Colour | Means | Never means |
|---|---|---|
| `--fail` red | Contract violated; a wrong or duplicate committed effect | Brand emphasis, hover, generic errors in copy |
| `--warn` amber | An injected fault or a browser-visible failure caused by it (fault armed, fault triggered, response lost, rows reordered) | A contract result |
| `--pass` green | Contract passed; detected and reproduced as expected in the matrix | "Good" in general |

Status is never conveyed by colour alone: every status element pairs colour with a word and a 16px icon (check for pass, cross-in-circle for violated, triangle for fault).

### Computed contrast (WCAG 2.x relative luminance)

| Foreground | Background | Ratio | Passes |
|---|---|---|---|
| `--text-primary #F2EDE4` | `--bg` | 16.15 | AAA |
| `--text-primary` | `--surface-1` | 15.15 | AAA |
| `--text-primary` | `--surface-2` | 13.86 | AAA |
| `--text-primary` | `--surface-3` | 12.33 | AAA |
| `--text-secondary #BDB5A8` | `--bg` | 9.27 | AAA |
| `--text-secondary` | `--surface-1` | 8.70 | AAA |
| `--text-secondary` | `--surface-2` | 7.96 | AAA |
| `--text-secondary` | `--surface-3` | 7.08 | AAA |
| `--text-muted #978F83` | `--bg` | 5.89 | AA |
| `--text-muted` | `--surface-1` | 5.53 | AA |
| `--text-muted` | `--surface-2` | 5.06 | AA |
| `--text-muted` | `--surface-3` | 4.50 | AA at the limit: do not use muted text on `--surface-3`; use `--text-secondary` there |
| `--accent #8FBFEA` | `--bg` | 9.69 | AAA |
| `--accent` | `--surface-1` | 9.09 | AAA |
| `--accent` | `--surface-2` | 8.32 | AAA |
| `--accent` | `--accent-soft #16222D` | 8.31 | AAA |
| `--accent-ink #10161C` | `--accent` (primary button) | 9.37 | AAA |
| `--accent-ink` | `--accent-hover #A9CFF2` | 11.18 | AAA |
| `--text-primary` | `--accent-soft` | 13.84 | AAA |
| `--text-secondary` | `--accent-soft` | 7.95 | AAA |
| `--fail #F2786A` | `--bg` | 6.88 | AA |
| `--fail` | `--surface-1` | 6.45 | AA |
| `--fail` | `--surface-2` | 5.90 | AA |
| `--fail` | `--fail-soft #33191A` | 5.92 | AA |
| `--pass #6FCF8E` | `--bg` | 9.85 | AAA |
| `--pass` | `--surface-1` | 9.25 | AAA |
| `--pass` | `--pass-soft #15291C` | 8.05 | AAA |
| `--warn #E6B450` | `--bg` | 9.87 | AAA |
| `--warn` | `--surface-1` | 9.26 | AAA |
| `--warn` | `--warn-soft #30240F` | 7.95 | AAA |
| `--text-primary` | `--fail-soft` / `--pass-soft` / `--warn-soft` | 13.91 / 13.19 / 13.00 | AAA |
| `--border-control #7D7468` | `--bg` / `--surface-1` / `--surface-2` | 4.10 / 3.84 / 3.52 | Non-text 3:1 |
| `--focus-ring #8FBFEA` | `--bg` / `--surface-2` | 9.69 / 8.32 | Non-text 3:1 |

`--border-subtle` (1.27:1 on `--bg`) and `--border` are decorative separators only. Any boundary that is the sole indicator of an interactive control (secondary button outline, chip outline, input outline) uses `--border-control`.

---

## 9. Surface hierarchy

| Level | Token | Used for | Border |
|---|---|---|---|
| 0 | `--bg` | Page, header, footer | none |
| 1 | `--surface-1` | One raised region per section at most: showcase panel, timeline panel, comparison columns, matrix, code block, menu panel | `1px solid var(--border-subtle)` |
| 2 | `--surface-2` | Elements inside a level-1 region that need separation: hovered row, contract bar, inspector, chip fill, table header row | none, or `--border` when adjacent to level 1 content |
| 3 | `--surface-3` | Active or selected state only (active beat, selected timeline event, pressed chip) | `1px solid var(--border-control)` when selected |
| Tint | `--accent-soft` | The ledger lane band only | none |
| Tint | `--fail-soft`, `--pass-soft`, `--warn-soft` | Status pill fills, contract bar after verdict, matrix status glyph backgrounds | matching `*-border` |

Rules: never place a bordered box inside a bordered box. Inside a level-1 region use dividers (`1px solid var(--border-subtle)`) and a single step to level 2. Sections on the page background are separated by whitespace (11) and, where a boundary helps, one full-container-width hairline. No drop shadows on in-flow surfaces.

---

## 10. Border, shadow and radius tokens

```css
:root {
  --radius-sm: 4px;    /* inline code, ID chips, matrix glyphs, progress segments */
  --radius-md: 8px;    /* buttons, chips, nav links, beats, rows, inputs, thumbnails */
  --radius-lg: 12px;   /* level-1 panels: showcase, timeline, comparison columns, matrix, code block */
  --radius-pill: 999px;/* status pills, provenance chip only */

  --border-width: 1px;
  --hairline: 1px solid var(--border-subtle);
  --divider: 1px solid var(--border);
  --control-outline: 1px solid var(--border-control);

  --shadow-none: none;
  --shadow-float: 0 16px 48px rgb(0 0 0 / 0.5), 0 0 0 1px var(--border);  /* mobile menu, lightbox figure only */

  --focus: 0 0 0 2px var(--bg), 0 0 0 4px var(--focus-ring);
}
```

Focus style for every interactive element: `outline: none; box-shadow: var(--focus);` on `:focus-visible`, keeping the element's own radius. On elements where box-shadow is clipped (images, overflow containers) use `outline: 2px solid var(--focus-ring); outline-offset: 2px;`.

Nested radius: an element inside a padded rounded parent uses `parent radius minus padding`, floor `--radius-sm` (for example a beat with 8px radius inside the 12px panel with 32px padding stays 8px; a thumbnail image inside an 8px button with 4px padding uses 4px).

---

## 11. Spacing scale

4px base. Only these values may be used for margin, padding and gap.

| Token | Value | Typical use |
|---|---|---|
| `--space-1` | 4px | Icon to text inside chips, marker gaps |
| `--space-2` | 8px | Inline gaps, chip padding block |
| `--space-3` | 12px | Button padding block, beat padding, row gaps |
| `--space-4` | 16px | Mobile gutter, grid gaps, card padding small |
| `--space-5` | 24px | Paragraph to paragraph group, panel padding mobile, grid gutter desktop |
| `--space-6` | 32px | Panel padding desktop, heading to content |
| `--space-7` | 48px | Sub-section spacing |
| `--space-8` | 64px | Section padding mobile |
| `--space-9` | 96px | Section padding tablet, hero top padding desktop |
| `--space-10` | 128px | Section padding desktop |

Vertical rhythm: section to section `--space-10` desktop, `--space-9` tablet, `--space-8` mobile (applied as `padding-block` half each side or as margin-top on each section after the first). Section label to h2: `--space-3`. h2 to intro paragraph: `--space-4`. Intro to content: `--space-7` (desktop), `--space-6` (mobile). Paragraph to paragraph: `--space-4`.

---

## 12. Grid and container

| Token | Value |
|---|---|
| `--container` | `1200px` max width, centered |
| `--container-prose` | `720px` max width (methodology, limitations, long copy), left aligned inside the container |
| `--gutter` | 32px (>=1024), 24px (720 to 1023), 16px (<720): the container's inline padding |
| Grid | 12 columns, `column-gap: 24px` (>=720); 4 columns, `column-gap: 16px` (<720) |
| Breakpoints | `--bp-tablet: 720px`, `--bp-desktop: 1024px`. Only these two. Mobile-first CSS: base styles are mobile, `@media (min-width: 720px)`, `@media (min-width: 1024px)` |

```css
.container { width: 100%; max-width: calc(var(--container) + 2 * var(--gutter)); margin-inline: auto; padding-inline: var(--gutter); }
```

Header, every section, and footer all use `.container`. At 1440px the content column is 1200px wide starting at x = 120. Nothing is wider than the container except full-bleed hairlines (none are specified).

Minimum supported width 320px; verified targets 375, 768, 1024, 1280, 1440. `html, body { overflow-x: clip; }` is a safety net, not a fix: no element may exceed the viewport.

---

## 13. Layouts: desktop, tablet, mobile

### 13.1 Landing

**Hero.** Padding: top `--space-9` (96px), bottom `--space-8` (64px); mobile top 48px, bottom 48px.

- Desktop: 12-column grid, `align-items: end`. Left block spans columns 1 to 7 (h1, 24px, lede max 620px, 32px, CTA row). Right block spans columns 9 to 12 (metric). CTA row: primary button, secondary button, then the GitHub text link, 12px gaps, wraps.
- Tablet: single column. Metric block follows the CTA row after 48px, laid out as two columns (numeral and label left 5 of 12, secondary line and scope note right 7 of 12).
- Mobile: single column; CTAs stack full width (primary, secondary), GitHub link below, left aligned; metric block after 40px with a top hairline and 24px padding-top.

Metric block (desktop): `border-left: 1px solid var(--border)`, `padding-left: 24px`. Numeral `--text-display-2` `--text-primary`; label `--text-body` `--text-primary`, 8px below; secondary line `--text-body-sm` `--text-secondary`, 12px below; scope note `--text-caption` `--text-muted`, 12px below; link `--text-body-sm`, 12px below. All static text, rendered immediately, never animated.

**Showcase.** See section 16.1 for the complete specification. Section header (label, h2, intro) left, max 720px; panel full container width.

**Why it matters.** h2 spans columns 1 to 8. Three statements in a 3-column grid (4 columns each), each with `border-top: 1px solid var(--border)` and `padding-top: 24px`: title in `--text-display-4`, body in `--text-body` `--text-secondary` 12px below. No cards, no icons. Tablet: 3 columns kept. Mobile: stacked, 32px between.

**How a run is verified.** h2 and intro in columns 1 to 6. Below, one level-1 panel (`--surface-1`, `--radius-lg`, padding 32px) containing a 4-column grid of steps separated by vertical dividers (`border-left: var(--hairline)`, `padding-left: 24px` on steps 2 to 4). Each step: step number as `--text-mono-sm` `--text-muted` ("01" to "04"), a 24px line icon (16.6 lists the four icons), title `--text-title`, body `--text-body-sm` `--text-secondary`. Step 3's icon and number use `--accent` (the independent observer). Between steps, a 16px right-pointing chevron sits on the divider line at the icon's vertical centre, colour `--text-muted`, background `--surface-1` to break the line. Tablet: 2 by 2 grid, dividers become top hairlines on row 2, chevrons hidden. Mobile: single column, each step separated by a top hairline with 24px padding, chevrons hidden.

**Benchmark summary.** h2 columns 1 to 8. Figures row: 4 equal columns separated by vertical hairlines; numeral `--text-display-3`, label `--text-body-sm` `--text-secondary` 4px below. Under the row (48px), a two-column block: left columns 1 to 7 scope title (`--text-title`) and scope body (`--text-body`); right columns 9 to 12 the LLM line (`--text-body-sm` `--text-secondary`) and the link styled as a secondary button. Tablet: figures 4 columns kept; scope block stacks. Mobile: figures 2 by 2 with a 24px row gap and hairline between rows; block stacks.

**Evidence teaser.** h2 and intro columns 1 to 6. A divided list (not cards): 5 rows, each a full-row link, 64px min height, `border-top: var(--hairline)`, last row also `border-bottom`. Row: human title (`--text-body` weight 500 `--text-primary`) left; app name (`--text-body-sm` `--text-muted`) middle, right aligned at column 9; verdict pill right; 16px arrow icon far right. Hover: background `--surface-1`, arrow translates 2px right. Mobile: title on line 1, app name and pill on line 2. Two links below (24px): secondary button "Browse the evidence", text link "Compare two agents under the same fault".

**Built with.** h2 columns 1 to 4 (left), definition list columns 6 to 12 (right): rows with `border-top: var(--hairline)`, 16px block padding, `dt` (`--text-label` `--text-muted`) in a 200px column, `dd` (`--text-body` `--text-primary`). Mobile: h2 above; `dt` above `dd`.

### 13.2 Evidence Explorer

Page header: padding-top 64px (40px mobile); h1 max 20ch; lede 16px below; provenance line (`--text-caption` `--text-muted`) 16px below.

Each group: margin-top 64px. Group heading `--text-display-4`, sub `--text-body-sm` `--text-secondary`. Entries are a divided list inside no panel.

Case entry (desktop): `border-top: var(--divider)`, padding 32px 0, 12-column grid.

- Columns 1 to 4: verdict pill; 12px; human title in `--text-display-4` (the whole title is the link, stretched over the entry with `::after`); 8px; scenario sentence in `--text-body-sm` `--text-secondary`.
- Columns 5 to 7: label "Intended", value.
- Columns 8 to 10: label "Ledger observed", value (value colour `--text-primary`; for violated cases a 16px fail icon precedes it).
- Columns 11 to 12: label "Contract", contract human name, then "Passed" or "Violated" in status colour; below, "Open case" with arrow, right aligned.
- Label: `--text-label` `--text-muted`; value: `--text-body-sm` `--text-primary`, 4px below label.
- Hover (whole entry): background `--surface-1` extended 16px beyond each side with `--radius-lg` (use negative margin and matching padding so content does not shift); arrow moves 2px right.

Tablet: title block full width; the three fields in a 3-column row beneath (24px). Mobile: everything stacked, fields as a `dl` with 16px gaps.

Comparison callout: one level-1 panel, padding 32px, flex row: text left, secondary button right. Mobile: stacked.

Provenance: `<details>`; summary is a 44px row with chevron; content is a table that scrolls horizontally inside its own `overflow-x: auto` wrapper on mobile (the page itself never scrolls sideways).

### 13.3 Case Details

Header: breadcrumb (`--text-body-sm`), 24px, verdict pill, 16px, h1, 16px, scenario sentence as lede, 16px, meta line (`--text-body-sm` `--text-muted`).

Verdict summary: margin-top 48px. A 4-column divided row (no outer box): `border-top` and `border-bottom` `var(--divider)`, each cell `padding: 24px 24px 24px 0`, cells 2 to 4 have `border-left: var(--hairline)` and `padding-left: 24px`. Cell: label, then value in `--text-title`. Cell 3 ("Ledger observed") label is `--accent`. Cell 4 shows the contract name in `--text-body-sm` `--text-secondary`, then "Passed" or "Violated" with icon in status colour at `--text-title`; for violations a third line with the human reason ("Limit 1, observed 2" or "Wrong record: Alice") and a "Show signature" disclosure revealing the raw signature in mono. Tablet: 2 by 2. Mobile: stacked with hairlines.

Record order diagram (AdminBench only): margin-top 48px; described in 14 (RecordOrder). Two rows of three tiles with an amber "Rows reordered here" marker between.

Timeline section: margin-top 96px. h2, intro (max 720px), then one level-1 panel.

- Desktop panel grid: `grid-template-columns: minmax(0, 1fr) 360px`, no gap, a vertical `--border-subtle` divider between. Left: toolbar then lanes. Right: inspector, `position: sticky; top: 88px; max-height: calc(100vh - 112px); overflow: auto;` padding 24px.
- Toolbar (padding 16px 24px, `border-bottom: var(--hairline)`): segmented view toggle left ("Key events (k)" / "All events (n)"), filter chips right (wrap). Filters apply within the current view.
- Lane header row: 3 columns `64px 1fr 1fr`, `--text-label`; left lane label colour `--text-secondary`, right lane label colour `--accent`; sticky under the page header inside the panel is not required.
- Rows: grid `64px 1fr 1fr`, min-height 56px, `border-top: var(--hairline)`. Column 1: sequence `--text-mono-sm` `--text-muted` and relative time `+N ms` below it. The right lane column has background `--accent-soft` for the full panel height (a single continuous band, not per-row boxes). An event occupies its lane's cell; the other cell is empty.
- Event (button, fills its cell, padding 12px 16px, radius `--radius-md`, margin 4px): tone icon 16px, label `--text-body-sm` weight 500 `--text-primary`, source `--text-caption` `--text-muted` on the same line right aligned, and attempt marker (see 17.4). Hover `--surface-2` (left lane) or `rgb(143 191 234 / 0.10)` (right lane). Selected: `--surface-3` plus `--control-outline`, `aria-pressed="true"`.
- Tablet (720 to 1023): inspector moves below the lanes as a full-width block inside the panel with a top divider; when an event is selected the inspector is scrolled into view (`block: "nearest"`).
- Mobile (<720): lanes are kept as position. Rows become single-column; left-lane events are left aligned at width `calc(100% - 40px)`, right-lane events are right aligned at the same width with `--accent-soft` fill and a 2px `--accent` left edge. Sequence and time move inside the event on its first line. The inspector opens inline directly beneath the selected event (not at the bottom), and focus moves to its heading.

Screenshots: margin-top 96px. Grid 3 columns desktop, 2 tablet, 1 mobile, 24px gap. Thumbnail button: `--surface-1`, radius 8px, padding 4px, image `aspect-ratio: 16 / 10; object-fit: cover; object-position: top center;` radius 4px; caption below in `--text-caption` `--text-secondary`, padding 8px. Captions use the human names in 17.5.

Evidence files: margin-top 96px. A divided list of five rows (44px min height): human name left, file path in `--text-mono-sm` `--text-muted` middle (hidden on mobile), "Open JSON" with external icon right. Only one presentation of the files (the old duplicate details block is removed).

Reproduce: margin-top 96px. h2, explanation (17.2), note, then the command block (14: CommandBlock), then the GitHub link.

Prev / next: margin-top 96px, two-column divided row; each half is a link with a caption ("Previous case" / "Next case") and the human title; order follows the dataset order; first and last wrap around is not used (the missing side links to `#/evidence` with the caption "All cases").

### 13.4 Agent Comparison

Header as case header without a pill. Shared-fault bar (margin-top 48px): one row with top and bottom dividers, 16px block padding: label "Shared fault" (`--text-label` `--text-muted`), fault label with amber triangle icon (`--text-body` `--text-primary`), then right aligned a pass-coloured check icon and "Same saved schedule in both runs"; a "Show schedule ID" disclosure reveals the raw schedule ID in mono.

Columns (margin-top 48px): desktop and tablet >= 900px two equal columns, 24px gap; below 900px stacked with 24px gap (this page uses a single extra local threshold expressed as a container query on the columns wrapper: `@container (min-width: 836px)`; if container queries are not used, fall back to the 1024px breakpoint). Each column is a level-1 panel, padding 32px (24px mobile), `display: grid; grid-template-rows: auto auto 1fr auto;` so links align at the bottom.

Column content, in order: verdict pill; title `--text-display-4`; sub `--text-body-sm` `--text-secondary`; divider; RecordOrder diagram; divider; facts `dl` (four rows, label above value, 16px gaps; final record states rendered as three small inline items "Alice inactive", "Beacon active", "Cirrus active" separated by 16px, with the changed record in `--text-primary` and the others in `--text-secondary`); "Show run identifiers" disclosure (run ID, effect ID, raw signature, raw fault type, raw agent policy, all mono); link "Open this case".

No coloured top borders on the columns. The verdict pill and the diagram tags carry status.

Conclusion: margin-top 64px, max 720px, h2 `--text-display-3`, body `--text-body-lg` `--text-secondary`.

Reproduce: two command blocks stacked, each with its label above.

### 13.5 Benchmark Results

Header as above. Scope note (margin-top 40px): level-1 panel, padding 24px 32px, max width 840px, with a 2px `--border-control` left edge (neutral, not a status colour); title `--text-title`, body `--text-body` `--text-secondary`.

Figures (margin-top 64px): 4 columns with vertical hairlines, numeral `--text-display-2`, label `--text-body` `--text-secondary`; sub-line beneath the row in `--text-body-sm` `--text-muted`. Tablet 4 columns with `--text-display-3` numerals; mobile 2 by 2.

Matrix (margin-top 96px): h2, then a level-1 panel containing a real `<table>`.

- Columns: Workflow (40 percent), No fault (20), Injected fault A (20), Injected fault B (20). Header row `--surface-2`, `--text-label` `--text-muted`, 44px.
- Rows grouped by app with a group header row ("SupportDesk", "AdminBench", "ShopBench") in `--text-label` `--text-secondary`, background `--surface-1`, top divider.
- Body row min-height 64px, `border-top: var(--hairline)`. Workflow cell: human workflow name `--text-body-sm` weight 500 `--text-primary`; contract human name below in `--text-caption` `--text-muted`.
- Clean cell: pass check glyph (16px icon in a 24px `--pass-soft` rounded square) + "Passed" (`--text-body-sm` `--text-primary`) and "1 effect" (`--text-caption` `--text-muted`).
- Fault cell: fault label (`--text-body-sm` `--text-primary`), then a line with two small marks: check glyph + "Detected", check glyph + "Reproduced" (`--text-caption` `--text-secondary`). If data ever shows a non-detected or non-reproduced case, the mark becomes a fail cross and the word "Missed" or "Not reproduced" in `--fail`; never hide such a cell.
- Each row has a trailing "Show identifiers" disclosure (a 44px icon button in a narrow fifth column on desktop; a text button under the row on mobile) that expands a full-width sub-row listing, per case: case ID, run ID, signature, effect count, reproduction run ID (all mono, copyable).
- Mobile: the table is restructured with CSS (`display: block` rows): workflow name as a row heading, then three labelled lines ("No fault", fault A label, fault B label) each with its marks. No horizontal scrolling.

Legend under the matrix in `--text-caption` `--text-muted`, max 720px.

Methodology, Limitations, LLM note: each margin-top 96px, `--container-prose`. Ordered list numbers and bullet markers in `--text-muted`; bold lead-ins in `--text-primary` weight 500; body `--text-body` `--text-secondary`; 16px between items.

Provenance: `dl` as a divided list (same pattern as "Built with"), values mono where they are identifiers; commit shown as first 12 characters with full hash in `title` and a copy button.

Reproduce: command block with three commands (17.6).

### 13.6 Not Found

Container, `min-height: calc(100vh - 64px - footer)`, content vertically centred, left aligned, max 560px. The mark at 40px in `--text-muted` with the ledger square in `--surface-3` (a deliberately "empty" mark), 32px, h1 `--text-display-2`, 16px, body `--text-body-lg` `--text-secondary` with the path in mono, 32px, primary button "Back to home" and secondary button "Browse the evidence".

---

## 14. Component inventory

| Component | Purpose | Key specs |
|---|---|---|
| `SiteHeader` | Nav | 3.2 |
| `SiteFooter` | Footer | 3.3 |
| `Mark` | Logo SVG | 21 |
| `Button` (primary) | Main action | Height 44px (hero: 52px), padding `0 20px` (hero `0 24px`), radius 8px, fill `--accent`, text `--accent-ink`, `--text-button` (hero `--text-button-lg`). Hover fill `--accent-hover`. Active `scale(0.97)`. Optional trailing 16px icon with 8px gap |
| `Button` (secondary) | Second action | Same size; transparent fill, `--control-outline`, text `--text-primary`. Hover: fill `--surface-2`, border `--text-secondary` |
| `TextLink` | Inline link | `--text-primary`, underline `text-decoration-color: var(--border-control)`, `text-underline-offset: 4px`. Hover: colour `--accent`, underline `--accent`. Standalone links get `min-height: 44px; display: inline-flex; align-items: center;` |
| `IconButton` | Close, menu, copy, disclose | 44x44, radius 8px, transparent; icon 20px `--text-secondary`; hover `--surface-2`, icon `--text-primary` |
| `StatusPill` | Contract result | Height 28px, padding `0 10px 0 8px`, radius pill, 16px icon + 6px gap + `--text-label`. Pass: `--pass-soft` fill, `--pass-border` border, `--pass` text, label "Contract passed". Violated: fail tokens, "Contract violated". Pending: `--surface-2`, `--border`, `--text-muted`, "Pending" |
| `ProvenanceChip` | "Recorded run" marker | Height 28px, radius pill, `--surface-2`, `--border`, `--text-caption` `--text-secondary`, leading 6px solid circle in `--text-muted` (static, never pulsing) |
| `Showcase` | Landing replay | 16.1 |
| `Beat` | One showcase step | 16.1 |
| `Inspector` | Event detail, shared by showcase and timeline | Title `--text-title`; meta `dl` two columns (label 120px); IDs in `--text-mono` with a 28px copy icon button each; "Recorded payload" `<details>` with `<pre>` (`--surface-2`, radius 8px, padding 16px, `--text-mono`, `overflow-x: auto`); close icon button top right (timeline mobile and showcase only) |
| `MetricFigure` | Static number + label | Numeral serif token per page, label below; no animation |
| `StatementList` | "Why it matters" | 13.1 |
| `PipelineSteps` | "How a run is verified" | 13.1 |
| `CaseEntry` | Explorer row | 13.2 |
| `CaseLinkRow` | Landing teaser row | 13.1 |
| `VerdictSummary` | Case conclusion | 13.3 |
| `RecordOrder` | AdminBench before/after rows | Two labelled rows of three tiles. Tile: height 56px, radius 8px, `--surface-2`, name `--text-body-sm` weight 500; tags under the name in `--text-caption`. "Requested" tag: `--text-secondary` with a small outline ring icon. "Clicked" tag: `--text-primary`. "Changed in ledger" tag: `--accent` with the ledger square icon; the tile gets `--accent-soft` fill and `--accent-border` border. If the changed record is not the requested one, the tile additionally shows a fail cross icon and the tag text "Changed in ledger (not requested)" in `--fail`. Between the rows: a centred marker, amber triangle icon + "Rows reordered here" (`--text-caption` `--warn`) on a dashed `--warn-border` line; for the clean case the marker reads "No reorder in this run" in `--text-muted` with a solid `--border` line. Tiles animate nothing |
| `Timeline` | Dual lanes | 13.3, 15.4 |
| `TimelineEvent` | Event button | 13.3; keeps `data-testid="timeline-event"` and the row keeps `data-event-sequence` |
| `SegmentedToggle` | Key / All | Two buttons in a `--surface-2` track, radius 8px, padding 4px; selected segment `--surface-3` + `--text-primary`; `role="group"`, `aria-pressed` |
| `FilterChip` | Timeline filter | Height 36px visual inside a 44px hit area (use `::before` inset -4px), padding `0 12px`, radius 8px, `--control-outline`, `--text-button` `--text-secondary`. Selected: fill `--surface-3`, text `--text-primary`, border `--text-secondary`, `aria-pressed="true"` |
| `IdChip` | Truncated identifier | `--text-mono-sm`, `--surface-2`, radius 4px, padding `2px 6px`; shows first 8 characters; `title` = full value; click copies full value (it is a button) with a 1.5 s "Copied" tooltip |
| `Disclosure` | Reveal raw identifiers | Native `<details>`; summary is `--text-body-sm` `--text-secondary` with a 16px chevron that rotates 90 degrees over 150ms; 44px min height |
| `ScreenshotGallery` + `Lightbox` | Images | 13.3, 15.5 |
| `EvidenceFileList` | Raw files | 13.3 |
| `CommandBlock` | Shell command + copy | Level-1 panel, radius 12px, padding `16px 16px 16px 20px`, flex row; `<code>` in `--text-mono` `--text-primary` with a leading `$` in `--text-muted` (`user-select: none`), `overflow-x: auto; white-space: pre;`; copy button (secondary, 36px high inside 44px hit area) right; mobile: button below, full width |
| `BenchmarkMatrix` | 36 cases | 13.5 |
| `ScopeNote` | Honesty block | 13.5 |
| `ProvenanceList` | `dl` | 13.5 |
| `PageState` | Loading, error, empty | Centered in the container, max 560px; loading is text only with `role="status"`, no spinner; error has `role="alert"` |
| `Breadcrumb` | Path | `nav aria-label="Breadcrumb"`, `ol`; separator "/" `--text-muted`; current item `aria-current="page"` `--text-secondary` |

Icons: one inline SVG set, 24px viewBox, `stroke="currentColor"`, `stroke-width="1.75"`, round caps and joins, `fill="none"`: arrow-right, arrow-up-right, check, x, x-circle, alert-triangle, chevron-right, chevron-down, copy, menu, pause, play, rotate-ccw, github (filled glyph), linkedin (filled glyph), browser (pipeline 1), zap (pipeline 2), database-search (pipeline 3), file-check (pipeline 4). No icon library dependency; paste paths from Lucide (ISC licence) into a single `icons.tsx`.

---

## 15. Interaction behaviour

### 15.1 Global

| Interaction | Behaviour |
|---|---|
| Hover (pointer devices only, inside `@media (hover: hover)`) | Colour and background transitions 150ms |
| Press | `transform: scale(0.97)` on `:active` for buttons, chips, beats, rows that are buttons; 120ms; release returns over 160ms |
| Focus | `--focus` ring on `:focus-visible` only |
| Links to GitHub, LinkedIn, raw files | New tab, `rel="noreferrer"`, external icon, accessible name ends with "(opens in a new tab)" |
| Route change | Title, scroll to top, focus `main` (3.1); no page transition animation |
| Copy | `navigator.clipboard.writeText`; on success the button label becomes "Copied" with a check icon for 1,800ms and a visually hidden `role="status"` region announces "Command copied"; on failure the label becomes "Press Ctrl+C to copy" and the code text is selected |

### 15.2 Hero CTA

"Watch the recorded incident" scrolls the showcase to the top of the viewport (88px offset), moves focus to the showcase heading, and starts the replay from step 0 once scrolling settles (or immediately under reduced motion, where it only scrolls and focuses; the showcase stays in its final state).

### 15.3 Showcase

See 16.1 (states, controls, selection).

### 15.4 Timeline

| Interaction | Behaviour |
|---|---|
| Default view | "Key events". Key event types: `fault.armed`, first `agent.observation`, `browser.click_attempt`, `network.request`, `backend.commit_confirmed`, `backend.update_committed`, `fault.triggered`, `network.request_failed`, `agent.retry_reason`, `network.response_delivered`, `agent.result_observation`, `contract.evaluated`. For `supportdesk-faulted` this yields 13 of 23 events |
| Toggle to "All events" | Shows every recorded event in sequence order. Hidden-event count is always visible in the toggle labels |
| Filter | Same seven filters and the same `filterEvents` semantics as today; selecting a filter clears the selection if the selected event is no longer visible |
| Select event | Click or Enter/Space. Row highlights; inspector shows the event; the hash updates to `#/case/:id?event=N` with `history.replaceState` (no new history entry, no scroll reset). Selecting the selected event again deselects |
| Correlation highlight | When an event is selected, every other event sharing its `actionId` gets a 2px `--text-secondary` left edge (left lane) or `--accent` left edge (right lane); non-related events stay at full opacity (no dimming, to keep AA contrast) |
| Keyboard | Events are buttons in DOM order (sequence order). Arrow Down / Arrow Up move focus to the next / previous event when focus is on an event; Home / End jump to first / last; Escape clears the selection |
| Deep link | On load with `?event=N`, switch to "All events" if N is not a key event, select it, and scroll it to the centre with `behavior: "auto"` |
| Relative time | Shown as `+N ms` from the first event of the run; absolute UTC ISO timestamp only in the inspector. No locale conversion anywhere |

### 15.5 Lightbox

Opens on thumbnail activation. Overlay `--overlay`, figure centred, image `max-width: min(1200px, 100vw - 32px)`, `max-height: calc(100vh - 120px)`, caption beneath, close icon button top right (48x48). Focus moves to the close button; Tab is trapped; Escape, the close button and a click on the overlay close it; focus returns to the originating thumbnail; `body` gets `overflow: hidden` while open and `#root > *:not(.lightbox)` gets `inert`. When a case has more than one screenshot, Arrow Left / Arrow Right switch images and two 48x48 icon buttons (previous, next) appear at the vertical centre of the left and right edges; the caption includes "2 of 3".

### 15.6 Disclosures

Native `<details>`; no height animation (content appears instantly; the chevron rotates). State is not persisted.

### 15.7 Mobile menu

3.2.

---

## 16. Animation specifications

### 16.0 Tokens and principles

```css
:root {
  --ease-out: cubic-bezier(0.23, 1, 0.32, 1);
  --dur-press: 120ms;
  --dur-fast: 150ms;
  --dur-base: 200ms;
  --dur-slow: 300ms;       /* ceiling for ordinary UI */
  --dur-replay: 400ms;     /* showcase state changes only */
}
```

- Only `opacity`, `transform`, `background-color`, `border-color`, `color` and `box-shadow` (focus ring) are animated. Never `width`, `height`, `top`, `left`, `margin`.
- No animation on first paint of any page except the showcase replay. No scroll-triggered reveals on sections. No count-up or number tween anywhere: every figure is rendered at its final value.
- No keyframe loops, no pulsing "live" dots.
- All easing is `--ease-out`.

### 16.1 The recorded incident showcase

**What it is:** a replay of the recorded case `supportdesk-faulted` (run `37f00d93-78eb-4d1b-8fa3-c3fe10605218`). It is not a live browser and must never be labelled or styled as one (no browser chrome mock-up, no cursor, no spinner, no pulsing dot).

#### Data binding: each beat is a real recorded event

All values below are read from `index.json` at runtime (find by `type` and order, as `refundMilestones` does today); the literal values are given so the result can be checked. Relative time is `timestamp - timestamp(seq 7)`.

| Beat | Lane | Primary event (selectable) | Seq | Recorded at (UTC) | Relative | Also shown in inspector as "Related events" |
|---|---|---|---|---|---|---|
| 1 Refund requested | Browser and agent | `network.request` (attempt 1, POST) | 07 | 03:26:56.456 | +0 ms | seq 05 `agent.action_proposed`, seq 06 `browser.click_attempt` |
| 2 First refund committed | Independent ledger | `backend.commit_confirmed` | 08 | 03:26:56.459 | +3 ms | effect `cd14fe36-cb93-4618-8f13-5f20e647d4c6` |
| 3 Response lost | Browser and agent | `network.request_failed` | 11 | 03:26:56.487 | +31 ms | seq 10 `fault.triggered` (the injected fault, source: test runner) |
| 4 Second request sent | Browser and agent | `network.request` (attempt 2, POST) | 16 | 03:26:57.691 | +1,235 ms | seq 12 `agent.failure_observation`, seq 13 `agent.retry_reason` (03:26:57.662), seq 15 `browser.click_attempt` |
| 5 Second refund committed | Independent ledger | `backend.commit_confirmed` | 17 | 03:26:57.697 | +1,241 ms | effect `b58ae3eb-05f9-4735-bd93-11d69ac9e446`; seq 19 `network.response_delivered` |
| 6 Contract evaluated | Contract bar | `contract.evaluated` | 22 | 03:26:57.754 | +1,298 ms | signature `refund-at-most-once|A123|count>1`, observed 2, limit 1; seq 21 `backend.effects_observed` |

The "1.2 s later" marker is the recorded gap between seq 11 (56.487) and seq 12 (57.662): 1,175 ms, shown rounded.

If any of the six primary events is missing from the dataset, render the existing fallback text ("This evidence set does not contain the complete response-loss sequence. Open the case to inspect the events that were recorded.") instead of the stage, with the link to the case.

Causality guard: beat 4's wording is "The agent then retries." Recorded order is seq 11 (request failed) then seq 13 (retry reason). The footnote (6.1) is always visible under the stage. No arrow is drawn from beat 3 to beat 4.

#### Anatomy and desktop layout (>= 1024px)

Panel: `--surface-1`, `--radius-lg`, `1px solid var(--border-subtle)`, padding 32px, full container width (1200px outer, 1134px inner).

1. **Panel header** (flex, space-between, align centre, wraps): left: `ProvenanceChip` then, 16px to the right, the static outcome line (`--text-body-sm`; "Recorded outcome:" in `--text-muted`, "2 refunds committed." in `--text-primary`, "Contract violated." in `--fail` with the x-circle icon). Right: progress indicator (six segments, each 24px by 4px, 4px gap, radius 2px; filled segments `--text-secondary`, the current one `--accent`, unfilled `--surface-3`; `aria-hidden="true"`), 16px, then the controls: Pause/Play (secondary button, 44px, icon + text) and Replay (secondary button, icon + text).
2. **Stage** (margin-top 24px), CSS grid:
   - `grid-template-columns: 148px minmax(0, 1fr) minmax(0, 1fr) 64px minmax(0, 1fr) 224px;` `column-gap: 16px;`
   - `grid-template-rows: auto auto;` `row-gap: 12px;`
   - Row 1 is the browser lane, row 2 the ledger lane. Each lane row has `min-height: 132px`.
   - Lane bands: row 1 has no fill and a `1px solid var(--border)` top and bottom edge spanning columns 1 to 6; row 2 is a single band spanning columns 1 to 6 with fill `--accent-soft` and radius 8px. Bands are background grid items (`grid-column: 1 / -1`), not containers.
   - Column 1: lane label (`--text-label`; row 1 `--text-secondary`, row 2 `--accent`) and caption (`--text-caption` `--text-muted`), padding 16px, vertically centred.
   - Column 2 ("moment A"): beat 1 in row 1, beat 2 in row 2.
   - Column 3 ("moment B"): beat 3 in row 1; row 2 holds the non-interactive ledger note "Ledger unchanged: 1 refund" (`--text-caption` `--text-secondary`, padding 12px, vertically centred).
   - Column 4: gap marker spanning both rows: a vertical dashed line (`1px dashed var(--border)`) with the text "1.2 s" (`--text-mono-sm` `--text-secondary`) and "later" (`--text-caption` `--text-muted`) centred on it over a `--surface-1` background patch (row 1 half) so the line appears broken by the label.
   - Column 5 ("moment C"): beat 4 in row 1, beat 5 in row 2.
   - Column 6: readouts. Row 1: "Browser saw" (`--text-label` `--text-muted`) and its value (`--text-body-sm` weight 500 `--text-primary`). Row 2: "Ledger holds" (`--text-label` `--accent`), the tally numeral (`--text-display-3` `--accent`), and "refunds for order A123" (`--text-body-sm` `--text-secondary`; "refund" when the tally is 1). Both cells have `border-left: var(--hairline)` and `padding-left: 16px`.
3. **Connectors** (decorative, `aria-hidden`), absolutely positioned within the stage in the 12px row gap and overlapping 10px into each lane:
   - Connector A (column 2) and connector C (column 5): a 2px by 32px vertical line in `--text-secondary`, horizontally at 28px from the column's left edge, ending in a 6px downward arrowhead. Meaning: the request reached the backend.
   - Connector B (column 3): a 2px by 32px vertical dashed line in `--warn` at the same horizontal offset, drawn upward from the ledger band, ending below the browser lane in a 16px x-circle icon in `--warn`. Meaning: the reply did not reach the browser.
4. **Contract bar** (margin-top 12px; this is beat 6 and is a button): full stage width, min-height 64px, padding `12px 16px`, radius 8px, flex row, align centre: "Contract" (`--text-label` `--text-muted`), 12px, "Refund at most once" (`--text-body` weight 500 `--text-primary`), flexible space, detail text (`--text-body-sm` `--text-secondary`), 16px, pill, 12px, seq and time (`--text-mono-sm` `--text-muted`: "22 · +1,298 ms").
   - Before step 6: fill `--surface-2`, border `1px solid var(--border)`, pill "Pending".
   - Step 6: fill `--fail-soft`, border `1px solid var(--fail-border)`, pill "Violated" (fail tokens), detail "Limit 1. Observed 2." with "Observed 2" in `--text-primary`.
5. **Footnote** (margin-top 16px): `--text-caption` `--text-muted`, max 720px.
6. **Inspector region** (margin-top 24px, `border-top: var(--hairline)`, padding-top 24px): empty-state line when nothing is selected; otherwise the shared `Inspector` laid out in two columns (meta `dl` left 7 of 12, related events and payload right 5 of 12) with the link "Open this event in the full timeline" to `#/case/supportdesk-faulted?event={seq}`. Reserve `min-height: 56px` when empty so the page does not jump on first selection beyond the inspector's own growth.
7. **Section link** below the panel (24px): "Open the full case record" (secondary button with arrow).

**Beat (button)**: fills its grid cell; padding 12px; radius 8px; text left aligned; transparent fill; content top to bottom:
- Meta line: marker (10px circle; browser lane: 2px ring in `--text-secondary`, no fill; ledger lane: solid `--accent`; beat 3: solid `--warn`), 8px, sequence number (`--text-mono-sm`, two digits), 8px, relative time (`--text-mono-sm` `--text-muted`).
- Title, 8px below: `--text-body` weight 500 `--text-primary`.
- Text, 4px below: `--text-body-sm` `--text-secondary`.
- `aria-label`: "Step {n} of 6, {lane}: {title}. Recorded sequence {seq}. Show event details." `aria-pressed` reflects selection.

Beat visual states:

| State | When | Style |
|---|---|---|
| Pending | beat index > current step | `opacity: 0.38` |
| Active | beat index = current step while playing or paused | `opacity: 1`; fill `--surface-3` (browser lane) or `rgb(143 191 234 / 0.14)` (ledger lane); marker gains a 4px halo ring at 30 percent of its colour |
| Done | beat index < current step, or final/idle | `opacity: 1`; no fill |
| Hover | pointer over | fill `--surface-2` (browser) or `rgb(143 191 234 / 0.08)` (ledger) |
| Selected | inspector shows this beat | `--control-outline` (browser) or `1px solid var(--accent)` (ledger); persists across states |
| Focus | keyboard | `--focus` ring |

Pending beats keep their text in the DOM and remain focusable and selectable. Because the default and the final state are fully opaque, the reduced-opacity pending state exists only transiently during a replay the user can pause, replay or skip, and it never applies under reduced motion.

#### State machine

`step`: integer 0 to 6 (number of beats that have occurred). `status`: `idle` | `playing` | `paused` | `done`.

| State | Definition | What the visitor sees |
|---|---|---|
| **Initial** (first render, before intersection) | `step = 6`, `status = idle` | The complete final picture: all five beats opaque, connectors drawn, tally "2", browser readout "1 failed request, then 1 success", contract bar violated. Controls: "Play" and "Replay". This is a meaningful, fully legible state with the final numbers visible immediately |
| **Playing** | started by 30 percent intersection (once), by the hero CTA, by Play or by Replay | Timed sequence below; Pause button shown |
| **Paused** | Pause pressed, a beat selected during playback, the tab hidden, or focus entering a beat during playback | Everything frozen at the current step; the active beat keeps its highlight; button reads "Play"; progress indicator holds |
| **Replay** | Replay pressed in any state | Returns to `step = 0` with the 400ms rewind, then plays from t = 0 |
| **Final / done** | t = 8,000ms reached | Identical to Initial; button reads "Play" (acts as Replay); a visually hidden status region announces "Replay finished. 2 refunds committed. Contract violated." |
| **Reduced motion** | `prefers-reduced-motion: reduce` | Always the Initial/final state. No autoplay, no timers, no transitions. The Pause/Play and Replay controls are replaced by "Previous step" and "Next step" secondary buttons plus a text status "Step {n} of 6" (`--text-body-sm`); stepping changes `step` instantly with pending beats shown at `opacity: 0.55` and a dashed outline instead of 0.38 so they remain readable; a "Show final state" text link appears when `step < 6` |

Autoplay rule: an `IntersectionObserver` with `threshold: 0.3` on the stage starts the replay the first time the threshold is crossed, only if `status === idle`, the document is visible, and reduced motion is not requested. It never restarts on later intersections. If the stage drops below 5 percent visibility while playing, set the final state (`step = 6`, `done`) silently.

Resume rule: pressing Play while paused fires the next step after 600ms and then continues with the original intervals between steps.

Selection rule: selecting a beat while playing pauses and sets `step` to that beat's index. Selecting a beat while idle, paused or done only opens the inspector (the stage does not change). Selecting the selected beat again closes the inspector.

Keyboard: Tab order is Pause/Play, Replay, beat 1, beat 2, beat 3, beat 4, beat 5, contract bar, footnote links, inspector. Within the beats, Arrow Right / Arrow Left move focus to the next / previous beat in beat order; Enter or Space selects. The controls are native buttons. No keyboard trap. The stage is `role="group"` with `aria-label="Replay of a recorded refund incident"`. During autoplay nothing is announced; manual stepping and the end of a replay update a `role="status"` (polite) region with "Step {n} of 6: {title}".

#### Timed sequence (total 8,000ms)

All transitions use `--ease-out`. "Reveal" for a beat means `opacity 0.38 to 1` over 400ms plus `transform: translateY(6px) to 0` over 400ms, and the active fill fading in over 200ms. When the next beat activates, the previous beat's active fill fades out over 300ms.

| t (ms) | Step becomes | Beat / element | Properties animated | Duration |
|---|---|---|---|---|
| 0 | 0 | Rewind: beats 1 to 5 to pending; connectors A, B, C hidden; gap marker hidden; tally shows "0"; browser readout "Nothing yet"; contract bar to pending; progress segments empty | beats `opacity 1 to 0.38`; connectors and gap marker `opacity 1 to 0`; contract bar `background-color`, `border-color`; readout text cross-fade | 400 |
| 600 | 1 | Beat 1 "Refund requested" reveals and becomes active. Browser readout becomes "1 request in flight". Progress segment 1 fills | reveal (opacity, transform); readout `opacity` cross-fade 200 | 400 |
| 1,300 | 1 | Connector A draws downward | `transform: scaleY(0 to 1)`, `transform-origin: top`; arrowhead `opacity 0 to 1` delayed 250 | 350 |
| 1,600 | 2 | Beat 2 "First refund committed" reveals and becomes active. Ledger tally changes 0 to 1 (swap, not a count: the outgoing numeral fades and moves up 6px while the incoming fades in from 6px below). Segment 2 fills | reveal; tally `opacity` + `transform: translateY` | 400; tally 250 |
| 2,800 | 3 | Beat 3 "Response lost" reveals and becomes active. Connector B draws upward from the ledger band, then its x-circle appears. Ledger note "Ledger unchanged: 1 refund" fades in. Browser readout becomes "1 failed request". Segment 3 fills | reveal; connector `scaleY(0 to 1)`, `transform-origin: bottom` 350; x-circle `opacity 0 to 1` + `scale(0.8 to 1)` 200, delayed 350; note `opacity` 300 delayed 400 | 400 to 750 |
| 3,700 | 3 | Gap marker "1.2 s later" appears; nothing else moves for 500ms (the pause stands in for the recorded 1.2 s gap) | `opacity 0 to 1` | 300 |
| 4,200 | 4 | Beat 4 "Second request sent" reveals and becomes active. Segment 4 fills | reveal | 400 |
| 4,900 | 4 | Connector C draws downward | as connector A | 350 |
| 5,200 | 5 | Beat 5 "Second refund committed" reveals and becomes active. Ledger tally swaps 1 to 2. Browser readout becomes "1 failed request, then 1 success". Segment 5 fills | reveal; tally swap 250; readout cross-fade 200 | 400 |
| 6,400 | 6 | Contract bar becomes active: fill to `--fail-soft`, border to `--fail-border`, detail text swaps to "Limit 1. Observed 2.", pill swaps Pending to Violated (cross-fade), one press-like emphasis on the pill `scale(0.96 to 1)`. Segment 6 fills | `background-color`, `border-color` 400; text and pill `opacity` 250; pill `transform` 250 | 400 |
| 7,400 | 6 | Settle: the contract bar's active halo and any remaining active fills fade; all beats at rest (done) | `background-color`, `box-shadow` | 300 |
| 8,000 | 6 | `status = done`; Pause becomes Play; status region announces the outcome | none | 0 |

Timing table for implementation: `const STEP_AT = [0, 600, 1600, 2800, 4200, 5200, 6400]; const DONE_AT = 8000;` with secondary cues at 1,300 (connector A), 3,700 (gap marker), 4,900 (connector C) implemented as CSS `transition-delay` on those elements relative to their step (700ms after step 1; 900ms after step 3; 700ms after step 4), so the JavaScript only sets `step`.

Implementation approach (CSS-first, no library): the stage root carries `data-step="0..6"` and `data-status`. Each beat, connector, readout value and the contract bar derive their state from CSS attribute selectors or from a class computed in React (`is-pending`, `is-active`, `is-done`). A single `useEffect` owns one `setTimeout` chain and clears it on pause, unmount, visibility change and route change. Readout values and the tally render all variants stacked in one grid cell and toggle `opacity` and `transform`, with `aria-hidden` on the inactive variants.

The static outcome line in the panel header never changes during a replay.

#### Tablet and mobile adaptation (< 1024px)

The horizontal stage becomes a vertical one; lane identity is carried by side, fill and marker rather than by rows.

- Panel padding 24px (16px below 720px). Panel header stacks: chip, outcome line, then a row with the controls left and the progress indicator right.
- **Readout row** first (so the tally is visible while beats play): two equal cells with a vertical hairline: "Browser saw" + value; "Ledger holds" + tally numeral (`--text-display-3`) + suffix. On screens shorter than 700px tall this row is `position: sticky; top: 56px;` inside the panel with `--surface-1` fill and a bottom hairline.
- **Lane legend**: two inline items, "Browser and agent" with the ring marker and "Independent ledger" with the solid accent marker (`--text-label`).
- **Beat list** (flex column, 12px gap), in beat order 1 to 5:
  - Browser-lane beats (1, 3, 4): `align-self: flex-start; width: min(86%, 440px);` fill `--surface-2`, radius 8px.
  - Ledger-lane beats (2, 5): `align-self: flex-end; width: min(86%, 440px);` fill `--accent-soft`, `border-left: 2px solid var(--accent)`, radius 8px.
  - Beat padding 12px 16px; min-height 72px; same content order as desktop.
  - After beat 3: the ledger note as a right-aligned caption ("Ledger unchanged: 1 refund"), then the gap marker as a centred caption row with a hairline on each side ("1.2 s later").
  - Connectors A, B, C are replaced by 16px icons inside the receiving element's meta line: arrow-down-right in beats 2 and 5 ("request reached the backend", `aria-hidden`), x-circle in `--warn` in beat 3.
- **Contract bar** below the list: stacks to two lines (name and pill on line 1; detail and seq/time on line 2).
- Footnote, inspector (single column), section link.
- Same state machine and the same timings. Reveal uses `translateY(6px)` as on desktop. Under autoplay the page does not auto-scroll to follow beats; the sticky readout and the visible outcome line carry the result.
- At 375px: panel inner width 311px; beat width 267px; no horizontal overflow; all buttons at least 44px tall.

### 16.2 Buttons, links, rows

`transition: background-color var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out), transform var(--dur-press) var(--ease-out);` Press `scale(0.97)`. Row arrows `translateX(2px)` on hover over 150ms.

### 16.3 Timeline selection

Selected event: fill and outline over 150ms. Inspector content swap: outgoing content is replaced immediately; incoming content fades `opacity 0 to 1` and `translateY(4px) to 0` over 200ms (keyed on the event sequence). Filter and view changes: no list animation (rows appear instantly).

### 16.4 Lightbox

Open: overlay `opacity 0 to 1` 200ms; figure `opacity 0 to 1` and `scale(0.98 to 1)` 200ms. Close: both `opacity 1 to 0` 150ms, then unmount. Image switch: cross-fade 150ms.

### 16.5 Mobile menu, copy confirmation, disclosure chevron

Menu: 3.2. Copy: icon cross-fade 150ms. Chevron: `rotate(0 to 90deg)` 150ms.

### 16.6 Reduced motion

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation: none !important; transition-duration: 0.01ms !important; transition-delay: 0ms !important; scroll-behavior: auto !important; }
}
```

Plus the showcase behaviour in 16.1 (decided in JavaScript with `matchMedia`, listening for changes). Press scale is removed (`transform: none` on `:active`).

### 16.7 Library decision and budget

`motion/react` is **not needed** and must not be added. Every motion above is a state-driven CSS transition; the only JavaScript is one timer chain and one `IntersectionObserver`. No GSAP, Lenis, Locomotive, Three.js, WebGL or Lottie. Native scrolling only.

Budget: baseline 88 KB gzipped JS + CSS. Target after the revamp: 110 KB or less gzipped JS + CSS (hard ceiling 208 KB = baseline + 120 KB). Fonts are separate: 120 KB or less total, two files preloaded (`TYPE_SYSTEM.md`).

---

## 17. Data and evidence presentation rules

### 17.1 Principles

1. Recorded values are never altered, rounded or re-ordered, with two display-only exceptions: relative times derived by subtraction, and the "1.2 s later" label. Absolute timestamps are shown in UTC exactly as recorded (ISO 8601), never converted to local time.
2. Human wording first, raw identifiers on demand. The default view of every page must be understandable with zero UUIDs visible.
3. Raw identifiers are revealed in exactly four places: the `Inspector`, `Disclosure` blocks ("Show run identifiers", "Show signature", "Show schedule ID", "Show identifiers"), `IdChip` tooltips and copy, and the raw evidence files. They are always in Geist Mono.
4. Terms that must not appear in primary UI (headings, ledes, labels, buttons, pills, matrix cells): "seed", "seeded", "distractor", "fixture", "ground truth", `bench-…-bad` style identifiers, raw fault type strings, raw agent policy strings, raw scenario IDs, raw contract signatures. They may appear inside disclosures, the inspector, raw files, and shell commands in a `CommandBlock` (a real command such as `--fixture regressions/adminbench-dom-reorder` is technical data).
5. Recorded material is called "recorded", "replay" or "evidence". Never "live", "running" or "real-time".
6. Order implies sequence only. Use "then" and "after". Never "because", "caused" or "so the agent".
7. A missing value renders as the phrase "Not recorded" in `--text-muted`, never as an empty cell or a dash.
8. All human wording lives in one module, `apps/viewer/src/presentation.ts`, keyed by raw value, with a fallback that shows the raw value de-underscored in sentence case. Components never string-match IDs.

### 17.2 Human titles and case copy

| Case ID | Human title (h1, lists) | App | Scenario sentence | Intended | Browser and agent saw | Ledger observed | Contract result line |
|---|---|---|---|---|---|---|---|
| `supportdesk-clean` | Refund issued once | SupportDesk | No fault injected. The agent refunds order A123 and the response arrives normally. | One refund for order A123 | One request, one successful response | 1 refund for order A123 | Refund at most once: passed |
| `supportdesk-faulted` | Lost response, duplicate refund | SupportDesk | The first refund commits, then its response is lost before the browser receives it. The agent then sends a second request. | One refund for order A123 | A failed request, then a successful retry | 2 refunds for order A123 | Refund at most once: violated (limit 1, observed 2) |
| `adminbench-vulnerable-clean` | Position-based agent, unchanged list | AdminBench | No fault injected. An agent that selects by row position deactivates Beacon on a list that does not change. | Deactivate Beacon | "Record updated successfully" | Beacon set to inactive | Update only the requested record: passed |
| `adminbench-vulnerable` | Reordered rows, wrong record deactivated | AdminBench | The record list is reordered after the agent observes it. An agent that selects by row position then clicks the row where Beacon used to be. | Deactivate Beacon | "Record updated successfully" | Alice set to inactive. Beacon still active. | Update only the requested record: violated (wrong record: Alice) |
| `adminbench-hardened` | Reordered rows, correct record deactivated | AdminBench | The same reorder is applied. An agent that selects by stable record ID still reaches Beacon. | Deactivate Beacon | "Record updated successfully" | Beacon set to inactive | Update only the requested record: passed |

"Browser and agent saw" for AdminBench is the recorded `visibleOutcome` from `agent.result_observation`, shown in quotation marks. Effect counts, entity names and final states are always read from the dataset; the table gives the expected rendering. The dataset `title` field is no longer displayed; screenshot `alt` text is rebuilt as "{human title}: {screenshot label}".

Reproduce explanations:

| Case | Command | Explanation |
|---|---|---|
| `supportdesk-clean`, `supportdesk-faulted` | `pnpm bp verify` | Generates new SupportDesk runs, checks the lost-response contract, and re-runs the saved fault schedule in three fresh browser contexts. |
| `adminbench-vulnerable`, `adminbench-vulnerable-clean` | `pnpm bp regression --fixture regressions/adminbench-dom-reorder --agent vulnerable` | Applies the saved reorder schedule in a new run. Exit code 1 is the expected result, and only when the ledger confirms the wrong record was changed and the contract fails. |
| `adminbench-hardened` | `pnpm bp regression --fixture regressions/adminbench-dom-reorder --agent hardened` | Applies the same saved schedule to the ID-based agent. Exits 0 only when Beacon is changed exactly once and the contract passes. |

### 17.3 Label maps

Fault types (all ten; five appear in the benchmark):

| Raw | Human label | In benchmark |
|---|---|---|
| `commit_then_response_lost` | Response lost after commit | yes (12 cases) |
| `response_delay` | Response delayed past the agent's timeout | yes (8) |
| `dom_replace_after_observation` | Rows reordered after observation | yes (2) |
| `stale_api_response` | Stale API response | yes (1) |
| `popup_context_shift` | Action moved to a popup | yes (1) |
| `request_abort` | Request aborted before sending | no |
| `delayed_render` | Delayed render | no |
| `session_expire` | Session expired | no |
| `navigation_abort` | Navigation aborted | no |
| `storage_clear` | Browser storage cleared | no |
| `null` | No fault injected | |

Agent policies:

| Raw | Human label |
|---|---|
| `refund-retry-once-after-browser-failure` | Retries once after a visible failure |
| `vulnerable-index` | Selects by row position |
| `hardened-stable-id` | Selects by stable record ID |
| `vulnerable-reference-v1 …` (benchmark) | Deterministic reference agent: retries once after a visible failure, no language model |

Contracts:

| Raw name | Human label |
|---|---|
| `refund-at-most-once` | Refund at most once |
| `update-correct-record` | Update only the requested record |
| `checkout-at-most-once` | Submit the cart at most once |
| `shipping-update-target` | Update shipping for the requested order only |
| `cancel-exactly-once` | Cancel exactly once |
| `coupon-exact-cents` | Apply the coupon once, exact cents |

Signature reasons: `count>1` and `effect-count:2` render as "Limit 1, observed 2"; `wrong-target:X` renders as "Wrong record: X" (capitalised record name; order IDs as recorded).

Event sources:

| Raw | Human label | Lane | Evidence basis line in inspector |
|---|---|---|---|
| `agent` | Agent | left | Agent action or observation record |
| `browser` | Browser | left | Browser-visible request or outcome |
| `runner` | Test runner | left | Runner-instrumented boundary |
| `observer` | Independent observer | right | Independently queried control-port ledger |
| `backend` | Backend | right | Controlled backend event |
| `contract` | Contract | right | Typed contract evaluation |

Event labels (by `type`; anything not listed uses the recorded `label` with its first letter capitalised):

| Type | Label |
|---|---|
| `run.started` | Run started |
| `backend.reset` | Backend reset to a clean state |
| `fault.schedule_disabled` | No fault scheduled |
| `fault.armed` | Fault armed |
| `fault.triggered` | Fault triggered |
| `agent.observation` | Agent observed the page |
| `agent.action_proposed` | Agent chose an action |
| `agent.observation_action_handoff` | Runner held the action after observation |
| `agent.action_handoff_released` | Runner released the action |
| `browser.click_attempt` | Browser clicked "{payload.name}" |
| `network.request` | Request sent |
| `network.upstream_response` | Backend response reached the runner |
| `network.response_delivered` | Response delivered to the browser |
| `network.request_failed` | Browser recorded a failed request |
| `agent.failure_observation` | Agent saw no success |
| `agent.retry_reason` | Agent decided to retry |
| `agent.result_observation` | Agent observed the result |
| `backend.commit_confirmed` | Ledger commit confirmed |
| `backend.update_committed` | Ledger update confirmed |
| `backend.effects_observed` | Ledger queried: {payload.count} effect(s) |
| `backend.state_observed` | Final record states read |
| `contract.evaluated` | Contract evaluated: passed / violated |
| `run.completed` | Run completed |

Event tone (icon and colour of the 16px leading icon only; the label stays `--text-primary`): fault and failed-request events use the alert-triangle in `--warn`; ledger commit and update events use the ledger square glyph in `--accent`; `contract.evaluated` uses check in `--pass` or x-circle in `--fail`; everything else uses a 6px dot in `--text-muted`.

Benchmark workflow names:

| Variant ID | Human name | App |
|---|---|---|
| `supportdesk-refund-retry` | Refund an order once | SupportDesk |
| `supportdesk-stale-read` | Refund, refresh status, decide again | SupportDesk |
| `supportdesk-navigation-refund` | Open the refund task from the inbox, then refund | SupportDesk |
| `supportdesk-session-refund` | Sign in, then refund | SupportDesk |
| `adminbench-dom-reorder` | Deactivate a record from a list | AdminBench |
| `adminbench-delayed-record-render` | Deactivate a record after a delayed render | AdminBench |
| `adminbench-popup-context` | Deactivate a record through the editor link | AdminBench |
| `adminbench-storage-recovery` | Select a record, then confirm deactivation | AdminBench |
| `shopbench-checkout-retry` | Submit a cart once | ShopBench |
| `shopbench-shipping-target` | Update shipping for one order | ShopBench |
| `shopbench-cancel-order` | Cancel an order once | ShopBench |
| `shopbench-coupon-cents` | Apply a coupon once, exact cents | ShopBench |

Benchmark classification words: `clean_pass` renders "Passed"; `detected` renders "Detected"; `reproduction.matched === true` renders "Reproduced". Any other value renders its raw classification in sentence case with the fail icon.

### 17.4 Correlation without clutter

Timeline events do not print `action:<uuid>` chips. Instead, each distinct `actionId` in a case is numbered in order of first appearance and shown as an attempt marker on the event: a small label "Attempt 1" / "Attempt 2" (`--text-caption` `--text-muted`) preceded by a 6px shape (attempt 1: filled circle; attempt 2: filled square; attempt 3+: filled diamond) so correlation is visible without colour. Cases with a single action show no marker. The inspector lists the full Action ID, Request ID and Effect ID with copy buttons, plus "Related events": the sequence numbers of all events sharing the action, each a button that selects that event. Effect IDs appear as `IdChip` (first 8 characters) on ledger commit events only.

### 17.5 Screenshot captions

| File suffix | Caption |
|---|---|
| `before-agent` | Before the agent acted |
| `after-agent` | After the agent finished |
| `before-observation` | Before the agent observed the list |
| `after-fault-before-action` | After the reorder, before the click |
| `after-committed-action` | After the committed action |

### 17.6 Benchmark data source

Every figure and cell on `#/benchmark` and the benchmark figures on the landing page are read from a build-time export of the committed report, never typed into JSX.

- Add `apps/viewer/scripts/export-benchmark.mjs`, run by `predev` and `prebuild` in `apps/viewer/package.json`. It reads `../../benchmarks/results.v1.json` and `../../benchmarks/cases.v1.json` and writes `apps/viewer/public/demo/benchmark.json` (committed, and regenerated on every build so the two cannot drift; add a test that fails if the committed file differs from a fresh export).
- Exported shape (allowlist): `{ schemaVersion: 1, reportId, generatedAt, gitCommit, workingTreeDirty, agent, metrics, variants: [{ id, application, contract }], cases: [{ caseId, variantId, application, mode, fault, status, signature, effectCount, classification, runId, reproduction: null | { runId, matched, sameSignature, effectIdsDisjoint } }] }`. No `artifactDir`, no seeds.
- `parseBenchmark(value)` validates: schema version, 36 cases, `metrics.plannedCases === cases.length`, counts recomputed from rows equal the `metrics` values (clean passes, detected, reproduction matched, false positives). On any mismatch it throws and the page shows the data error state. No fallback numbers.
- Displayed fractions are built from data: `validClean - falsePositives` of `plannedClean`; `detected` of `plannedSeeded`; `reproductionMatched` of `reproductionPlanned`; `falsePositives`.
- Expected values for verification: report `aca48a00-53b5-4b56-b080-42838f948bcb`, generated `2026-11-17T03:57:17.586Z`, commit `24c1323b1462f8d82287f4bf1d20276e3e967baf`, working tree clean, 36 / 12 / 24 / 24 / 0.
- The landing page fetches `benchmark.json` in parallel with `index.json`. If it fails, the hero metric block and the benchmark summary section render the data error line in place of numbers; the rest of the page still renders.

Reproduce commands on the benchmark page (one `CommandBlock` with three lines, each separately copyable):

```
pnpm install --frozen-lockfile && pnpm exec playwright install chromium
pnpm bp benchmark run
pnpm bp benchmark verify --report benchmarks/results.v1.json --audit-artifacts
```

### 17.7 Housekeeping

Remove the stray duplicate directories `apps/viewer/public/demo/evidence 2` and `apps/viewer/public/demo/screenshots 2` from the published bundle. Fetch `index.json` without `cache: "no-store"`. Update `apps/viewer/PRODUCT.md` so it no longer describes the ten fault types and the 36-case benchmark as targets (out of scope for this spec's three files; flag it to the owner).

---

## 18. Accessibility

1. **Contrast:** all text pairs in section 8 meet WCAG 2.2 AA; most meet AAA. `--text-muted` is not used on `--surface-3`. Non-text control boundaries use `--border-control` (3.5:1 or better on every surface it sits on).
2. **Focus:** every interactive element shows the two-ring focus style on `:focus-visible`. Focus order follows visual order. Focus is never removed.
3. **Targets:** every interactive element has a hit area of at least 44 by 44 CSS px (visual size may be smaller with an expanded `::before` hit area, as specified for chips and copy buttons). Adjacent targets have at least 8px between them.
4. **Semantics:** one `h1` per page; sequential heading levels; landmarks `header`, `nav` (labelled "Primary"), `main`, `footer`; breadcrumb `nav` labelled "Breadcrumb"; the benchmark matrix is a real `table` with `th scope="col"`, `th scope="row"` and a visually hidden `caption`; definition lists use `dl`.
5. **Timeline:** an ordered list (`ol`) of events in sequence order. Each event button's accessible name is "Sequence {n}, {source label}, {lane name}: {label}. {Attempt k.}" so the lane is announced, not only positioned. Empty lane cells are `aria-hidden`.
6. **Showcase:** `role="group"` with label; controls are native buttons with text labels; Pause/Play has `aria-pressed` semantics avoided in favour of label swap ("Pause" / "Play"); decorative connectors and the progress indicator are `aria-hidden`; a polite status region announces manual steps and the end of a replay; the static outcome line gives the result as plain text to every user at all times; auto-playing motion lasts 8 seconds, runs once, and has a Pause control (WCAG 2.2.2).
7. **Status:** never by colour alone (icon + word). Pills contain text. The matrix marks contain text.
8. **Reduced motion:** section 16.6 and the showcase static mode.
9. **Images:** screenshots have alt text "{human title}: {caption}". Decorative SVGs are `aria-hidden="true"`; the mark inside the home link is `aria-hidden` and the link carries the label.
10. **Live regions:** copy confirmation (`role="status"`), dataset error (`role="alert"`), loading (`role="status"`).
11. **Zoom and reflow:** usable at 200 percent zoom and at 320px width with no horizontal scrolling of the page; wide mono content scrolls inside its own container with `tabindex="0"` and an accessible name.
12. **Language and metadata:** `<html lang="en">`, `<meta name="color-scheme" content="dark">`.
13. **Links vs buttons:** navigation is `a`; state changes are `button`.
14. **Text spacing:** no fixed heights on text containers; all minimum heights are `min-height`.

---

## 19. SEO and social

Replace the `<head>` of `apps/viewer/index.html` with (keeping the Vite script tag):

```html
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta name="color-scheme" content="dark" />
<meta name="theme-color" content="#131110" />
<title>BrowserProof · Verify What Browser Agents Actually Did</title>
<meta name="description" content="BrowserProof tests AI browser agents under controlled faults and verifies what the backend actually committed, using an independently queried effects ledger and typed contracts." />
<meta name="author" content="Krishna Balaji" />
<link rel="canonical" href="https://browserproof.vercel.app/" />

<meta property="og:type" content="website" />
<meta property="og:site_name" content="BrowserProof" />
<meta property="og:url" content="https://browserproof.vercel.app/" />
<meta property="og:title" content="BrowserProof · Verify What Browser Agents Actually Did" />
<meta property="og:description" content="One lost response. Two refunds committed. A reliability-testing framework that checks browser agents against an independent backend ledger." />
<meta property="og:image" content="https://browserproof.vercel.app/og.png" />
<meta property="og:image:width" content="1200" />
<meta property="og:image:height" content="630" />
<meta property="og:image:alt" content="BrowserProof. One lost response. Two refunds committed. A two-lane diagram shows one failed browser request above two ledger entries." />
<meta property="og:locale" content="en_US" />

<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="BrowserProof · Verify What Browser Agents Actually Did" />
<meta name="twitter:description" content="One lost response. Two refunds committed. A reliability-testing framework that checks browser agents against an independent backend ledger." />
<meta name="twitter:image" content="https://browserproof.vercel.app/og.png" />
<meta name="twitter:image:alt" content="BrowserProof. One lost response. Two refunds committed." />

<link rel="icon" href="/favicon.svg" type="image/svg+xml" />
<link rel="icon" href="/favicon-32.png" sizes="32x32" type="image/png" />
<link rel="apple-touch-icon" href="/apple-touch-icon.png" />
<link rel="preload" href="/fonts/geist-latin-wght-normal.woff2" as="font" type="font/woff2" crossorigin />
<link rel="preload" href="/fonts/instrument-serif-latin-400-normal.woff2" as="font" type="font/woff2" crossorigin />
```

Also: inline `<style>html{background:#131110}</style>` in the head to prevent a white flash before CSS loads; a `<noscript>` block in `body` containing the h1, the lede, and links to the GitHub repository and `benchmarks/results.v1.json` on GitHub (hash-routed pages are not individually indexable, so the landing content carries SEO); `public/robots.txt` with `User-agent: *` / `Allow: /`. Absolute asset paths (`/og.png`, `/fonts/…`) require the site to be served from the domain root, which it is; if `base: "./"` in `vite.config.ts` causes any of these to resolve incorrectly, set `base: "/"`.

Assets to create in `apps/viewer/public/`: `favicon.svg` (21.3), `favicon-32.png` and `apple-touch-icon.png` (180x180, the favicon artwork with 28px of `#131110` padding), `og.png` (rendered from 21.4).

---

## 20. Acceptance criteria

Functional

1. `#/`, `#/evidence`, `#/case/supportdesk-clean`, `#/case/supportdesk-faulted`, `#/case/adminbench-vulnerable-clean`, `#/case/adminbench-vulnerable`, `#/case/adminbench-hardened`, `#/compare`, `#/benchmark` all render; any other hash and any unknown case ID render the Not Found page with a working link to `#/`.
2. `#/case/supportdesk-faulted?event=17` opens with event 17 selected and visible.
3. Route changes set the specified `document.title`, scroll to top and focus `main`.
4. `parseDataset` behaviour is unchanged; a corrupted `index.json` shows the dataset error and no case content. A corrupted or mismatching `benchmark.json` shows the benchmark data error and no figures.
5. Timeline: Key/All toggle, seven filters, event selection, inspector with timestamp, type, IDs and payload, attempt markers, related-event navigation all work on all five cases. `data-testid="timeline-event"` and `data-event-sequence` are present. "All events" shows 14, 23, 17, 18, 18 events for the five cases in dataset order.
6. Screenshot lightbox opens, traps focus, closes on Escape, overlay click and the close button, and returns focus to the thumbnail.
7. Five raw evidence files per case open in a new tab. The copy-command button copies the exact command and confirms.
8. The comparison page shows Alice as the changed record for the position-based agent and Beacon for the ID-based agent, both read from the dataset, and states that the same saved schedule was used (computed by comparing `scheduleId`).
9. Existing viewer tests pass (updated only where selectors or copy moved), and `pnpm --filter @browserproof/viewer build` succeeds with no TypeScript errors.

Showcase

10. On first paint the showcase shows the final state: tally 2, five opaque beats, contract "Violated". No number on the site ever animates from zero.
11. With motion allowed, the replay starts once when 30 percent of the stage is visible, follows the beat times 600 / 1,600 / 2,800 / 4,200 / 5,200 / 6,400ms (tolerance 100ms) and ends at 8,000ms in the same picture as the initial state.
12. Pause freezes the sequence; Play resumes; Replay restarts from step 0; all three are operable by keyboard with visible focus.
13. Each of the six beats is a button; selecting it shows the recorded event with sequence 07, 08, 11, 16, 17, 22 respectively and the exact recorded UTC timestamps, and a link to that event in the case timeline.
14. With `prefers-reduced-motion: reduce` there is no autoplay and no transition; the final state is shown; Previous/Next step controls work.
15. The words "live", "real-time" and "because" do not appear in or around the showcase. The footnote about recorded order is visible without interaction. The chip reads "replay, not live".
16. Below 1024px the stage is vertical with browser beats left, ledger beats right, readouts on top; no horizontal overflow at 375px.

Content and honesty

17. Wherever "24 / 24" or the benchmark figures appear (hero, landing summary, benchmark page), the scope statement (deterministic reference agent, purpose-built or non-idempotent test apps, not a real-world failure rate) is visible in the same section without interaction.
18. The benchmark page states: five of ten fault types exercised; no language model in the benchmark; label and flag derive from the same ledger snapshot with no human-labelled reference; the 9-trial campaign does not show the lost response caused the retry.
19. Benchmark figures and all 36 matrix cells are rendered from `benchmark.json`; changing a value in that file changes the page (or triggers the mismatch error).
20. No em dash (U+2014) exists in any rendered text, attribute or meta tag: `grep -rn "—" apps/viewer/src apps/viewer/index.html` returns nothing.
21. With all disclosures closed and no event selected, no page shows a UUID, a raw fault type string, a raw agent policy string, a raw scenario ID or a raw contract signature, and the words "seed", "seeded", "fixture", "distractor" and "ground truth" appear only inside `CommandBlock` commands.
22. The footer contains no licence claim. It names Krishna Balaji and links to GitHub and LinkedIn.

Visual system

23. Only the colour tokens in section 8 appear in `style.css` (no other hex or rgb literals outside the `:root` block; the `rgb(143 191 234 / 0.08 | 0.10 | 0.14)` ledger tints quoted in sections 13 and 16 are the tokens `--accent-tint-hover`, `--accent-tint-row` and `--accent-tint-active`).
24. Only the spacing, radius, duration and type tokens defined in sections 10, 11, 16.0 and `TYPE_SYSTEM.md` are used. `text-transform: uppercase` does not appear. Fonts are Instrument Serif, Geist and Geist Mono only, self-hosted, four WOFF2 files, 120 KB or less in total.
25. The accent `#8FBFEA` is used only for the purposes listed in section 7. Red, amber and green appear only with status meaning.
26. Header, sections and footer share one container: at 1440px all left edges are at x = 120 and right edges at x = 1320.
27. No bordered box is nested directly inside another bordered box.

Quality

28. No horizontal page scroll at 375, 768, 1024, 1280 and 1440px on any page (`document.documentElement.scrollWidth === clientWidth`).
29. All interactive elements have a 44 by 44px minimum hit area and a visible focus indicator.
30. axe-core reports zero serious or critical issues on all six page types; contrast meets AA everywhere.
31. Lighthouse (mobile emulation, production build) on `#/`: Accessibility 100, Best Practices 95 or higher, SEO 95 or higher, CLS under 0.05.
32. Total gzipped JS + CSS is 208 KB or less (target 110 KB or less). `motion`, `framer-motion`, `gsap`, `lenis`, `three` and `lottie-web` are absent from `package.json`.
33. `index.html` contains the exact title, description, canonical, Open Graph, Twitter and theme-color tags in section 19; `og.png` is 1200 by 630; the favicon renders the mark at 16px legibly.

---

## 21. Logo and mark

### 21.1 Concept

Two overlapping rounded squares. The outlined square, with a small dot in its top-left corner, is the browser window being observed. The solid square that overlaps its lower-right corner and extends outside it is the independent ledger: a separate record, partly beyond the browser's frame, carrying a check mark. Browser plus observation plus verification plus independent evidence, in three shapes. The browser outline is deliberately left open where the ledger sits, so the two never merge into one object.

### 21.2 Mark SVG (nav, footer, inline)

24 by 24 viewBox. The outline uses `currentColor` (set `color: var(--text-primary)`); the ledger square uses `--accent`; the check uses `--accent-ink`.

```svg
<svg class="mark" viewBox="0 0 24 24" width="24" height="24" fill="none" aria-hidden="true" focusable="false">
  <path d="M8 19H6a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v2" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="7" cy="7" r="1.25" fill="currentColor"/>
  <rect x="10" y="10" width="12" height="12" rx="3" fill="var(--accent, #8FBFEA)"/>
  <path d="M13.25 16.25l2 2 3.75-4.25" stroke="var(--accent-ink, #10161C)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
```

Sizes: 24px in the header, 20px in the footer, 40px on the Not Found page (with the ledger square recoloured to `--surface-3` and the check to `--text-muted`), 16px as the inline "ledger" glyph is not used (the timeline's ledger glyph is the solid rounded square alone: `<rect x="5" y="5" width="14" height="14" rx="3.5" fill="currentColor"/>` at 16px).

Wordmark: "BrowserProof", Geist 500, `-0.01em`, `--text-primary`, 16px in the header, 14px in the footer; 8px from the mark; one word, capital B and capital P. Clear space around the lockup: 8px minimum. Minimum mark size 16px. Do not rotate, outline the ledger square, recolour the outline with the accent, or place the mark on a light background.

At 16px the geometry resolves to: outline stroke 1.33px, ledger square 8px, check stroke 1.33px across about 3.8 by 2.8px, dot 1.7px. All features remain distinct.

### 21.3 Favicon (`public/favicon.svg`)

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <rect width="32" height="32" rx="7" fill="#131110"/>
  <g transform="translate(4 4)" fill="none">
    <path d="M8 19H6a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v2" stroke="#F2EDE4" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="7" cy="7" r="1.25" fill="#F2EDE4"/>
    <rect x="10" y="10" width="12" height="12" rx="3" fill="#8FBFEA"/>
    <path d="M13.25 16.25l2 2 3.75-4.25" stroke="#10161C" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  </g>
</svg>
```

`favicon-32.png` is a 32px raster of this file. `apple-touch-icon.png` is 180 by 180 with the same artwork scaled so the mark occupies 124px, centred on `#131110`, no rounded corners (iOS applies its own mask).

### 21.4 Social image (1200 by 630)

Render this SVG to `public/og.png` with the real fonts loaded (open the SVG in a browser page that includes the `@font-face` rules and take a 1200 by 630 screenshot, or use any SVG rasteriser with the three fonts installed). Check that no text is clipped and that the image is under 300 KB.

Content, top to bottom, with 80px left and right margins:

- Background `#131110`.
- Lockup at (80, 72): mark at 40px and "BrowserProof" in Geist 500, 28px, `#F2EDE4`.
- Headline at baseline y = 236 and y = 320: "One lost response." in Instrument Serif 84px `#F2EDE4`; "Two refunds committed." in Instrument Serif italic 84px `#8FBFEA`.
- Diagram from y = 384 to y = 528: two lanes.
  - Lane 1 label "Browser" (Geist 500, 20px, `#BDB5A8`) with a hairline; on it three markers at x = 300, 560, 860: ring (request sent), amber x-circle (response lost), ring (second request).
  - Lane 2: a band `#16222D` with label "Independent ledger" (Geist 500, 20px, `#8FBFEA`); on it two solid `#8FBFEA` squares at x = 300 and x = 860 with "Refund 1" and "Refund 2" beside them (Geist 500, 20px, `#F2EDE4`).
  - Vertical connectors from the two request rings down to the two ledger squares (`#BDB5A8`, 2px); a dashed amber line rising from the band toward the x-circle.
  - At the right end, a pill: `#33191A` fill, `#6B2E2A` border, "Contract violated" in Geist 500, 20px, `#F2786A`.
- Footer line at baseline y = 582: left "Reliability testing for AI browser agents" (Geist 400, 22px, `#BDB5A8`); right "browserproof.vercel.app" (Geist Mono 400, 20px, `#978F83`).

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="#131110"/>

  <!-- lockup -->
  <g transform="translate(80 52) scale(1.6667)" fill="none">
    <path d="M8 19H6a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v2" stroke="#F2EDE4" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="7" cy="7" r="1.25" fill="#F2EDE4"/>
    <rect x="10" y="10" width="12" height="12" rx="3" fill="#8FBFEA"/>
    <path d="M13.25 16.25l2 2 3.75-4.25" stroke="#10161C" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  </g>
  <text x="134" y="82" font-family="Geist, sans-serif" font-weight="500" font-size="28" letter-spacing="-0.28" fill="#F2EDE4">BrowserProof</text>

  <!-- headline -->
  <text x="80" y="236" font-family="'Instrument Serif', serif" font-size="84" letter-spacing="-1.68" fill="#F2EDE4">One lost response.</text>
  <text x="80" y="320" font-family="'Instrument Serif', serif" font-style="italic" font-size="84" letter-spacing="-1.68" fill="#8FBFEA">Two refunds committed.</text>

  <!-- lane 1: browser -->
  <text x="80" y="414" font-family="Geist, sans-serif" font-weight="500" font-size="20" fill="#BDB5A8">Browser</text>
  <line x1="260" y1="408" x2="1120" y2="408" stroke="#3A342F" stroke-width="2"/>
  <circle cx="300" cy="408" r="9" fill="#131110" stroke="#BDB5A8" stroke-width="3"/>
  <circle cx="860" cy="408" r="9" fill="#131110" stroke="#BDB5A8" stroke-width="3"/>
  <circle cx="560" cy="408" r="13" fill="#131110" stroke="#E6B450" stroke-width="3"/>
  <path d="M554.5 402.5l11 11M565.5 402.5l-11 11" stroke="#E6B450" stroke-width="3" stroke-linecap="round"/>

  <!-- connectors -->
  <path d="M300 421v47M860 421v47" stroke="#BDB5A8" stroke-width="2"/>
  <path d="M294 462l6 8 6-8M854 462l6 8 6-8" fill="none" stroke="#BDB5A8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M560 470V426" stroke="#E6B450" stroke-width="2" stroke-dasharray="5 6"/>

  <!-- lane 2: ledger -->
  <rect x="80" y="456" width="1040" height="72" rx="12" fill="#16222D"/>
  <text x="104" y="499" font-family="Geist, sans-serif" font-weight="500" font-size="20" fill="#8FBFEA">Independent ledger</text>
  <rect x="289" y="481" width="22" height="22" rx="5" fill="#8FBFEA"/>
  <text x="323" y="499" font-family="Geist, sans-serif" font-weight="500" font-size="20" fill="#F2EDE4">Refund 1</text>
  <rect x="849" y="481" width="22" height="22" rx="5" fill="#8FBFEA"/>
  <text x="883" y="499" font-family="Geist, sans-serif" font-weight="500" font-size="20" fill="#F2EDE4">Refund 2</text>

  <!-- verdict -->
  <rect x="916" y="352" width="204" height="40" rx="20" fill="#33191A" stroke="#6B2E2A" stroke-width="1.5"/>
  <text x="1018" y="379" text-anchor="middle" font-family="Geist, sans-serif" font-weight="500" font-size="20" fill="#F2786A">Contract violated</text>

  <!-- footer -->
  <text x="80" y="582" font-family="Geist, sans-serif" font-size="22" fill="#BDB5A8">Reliability testing for AI browser agents</text>
  <text x="1120" y="582" text-anchor="end" font-family="'Geist Mono', monospace" font-size="20" fill="#978F83">browserproof.vercel.app</text>
</svg>
```

After rendering, nudge the "Contract violated" pill if it collides with the headline's descenders at the chosen font metrics (it may move down to y = 360 at most).

---

## 22. Per-page component mapping

Spacing values are tokens from section 11 (`s1` = 4px … `s10` = 128px). "Container" = 1200px max with gutters 32 / 24 / 16px.

| Page | Component | Typography token | Color token | Spacing | Width/height | Border/radius | Interaction | Responsive behaviour |
|---|---|---|---|---|---|---|---|---|
| All | SiteHeader | wordmark Geist 500 16px; links `--text-body-sm` 500 | bg `--bg`; links `--text-secondary`, current `--text-primary` + `--accent` underline | inline padding = gutter; link padding 0 s3; link gap s1 | 100% x 64px (56px <720); link height 44px | bottom `--hairline`; link radius md | sticky; hover fill `--surface-2`; focus ring | <720: links collapse into 44px menu button and a full-width panel of 52px rows |
| All | Mark | n/a | `--text-primary`, `--accent`, `--accent-ink` | s2 to wordmark | 24px header, 20px footer | n/a | part of home link | unchanged |
| All | SiteFooter | links `--text-body-sm`; notes `--text-caption` | `--text-secondary`, `--text-muted` | margin-top s10 (s9 mobile); padding s7 0 40px; link gap s5 | container | top `--hairline` | link hover `--text-primary` | rows stack; links wrap |
| All | Button primary | `--text-button` (hero `--text-button-lg`) | fill `--accent`, text `--accent-ink`, hover `--accent-hover` | padding 0 20px (hero 0 s5) | height 44px (hero 52px) | radius md | hover, press scale 0.97, focus ring | full width in hero <720 |
| All | Button secondary | `--text-button` | text `--text-primary`, outline `--border-control`, hover fill `--surface-2` | padding 0 20px | height 44px (hero 52px) | 1px, radius md | hover, press, focus | full width in hero <720 |
| All | StatusPill | `--text-label` | pass / fail / pending tokens | padding 0 10px 0 s2; icon gap 6px | height 28px | 1px status border, radius pill | none | unchanged |
| Landing | Hero h1 | `--text-display-1` | line 1 `--text-primary`; line 2 italic `--accent` | padding-top s9 (48px mobile); s5 to lede | columns 1 to 7; max 760px | none | none | 72 / 56 / 44px by breakpoint; single column <1024 |
| Landing | Hero lede | `--text-body-lg` | `--text-secondary` | s6 to CTAs | max 620px | none | none | unchanged |
| Landing | Hero CTAs | `--text-button-lg`; GitHub link `--text-body-sm` 500 | as buttons; link `--text-primary` | gap s3 | height 52px | radius md | primary scrolls to showcase and starts replay; secondary to `#/benchmark`; link new tab | stack full width <720 |
| Landing | Hero metric | numeral `--text-display-2`; label `--text-body`; secondary `--text-body-sm`; scope `--text-caption` | `--text-primary`, `--text-secondary`, `--text-muted` | padding-left s5; gaps s2, s3, s3 | columns 9 to 12 | left `--divider` | link to `#/benchmark` | <1024: below CTAs, two columns; <720: stacked with top hairline |
| Landing | Showcase header | label `--text-label`; h2 `--text-display-3`; intro `--text-body` | `--text-muted`, `--text-primary`, `--text-secondary` | s3, s4, s7 to panel | max 720px | none | none | unchanged |
| Landing | Showcase panel | n/a | fill `--surface-1` | padding s6 (s5 tablet, s4 mobile) | container width; desktop stage about 320px tall | 1px `--border-subtle`, radius lg | hosts replay state machine | vertical stage <1024 |
| Landing | Showcase controls | `--text-button` | secondary button tokens; progress `--surface-3`, `--text-secondary`, `--accent` | gap s2; s4 to progress | buttons 44px; segments 24x4px | radius md; segments 2px | Pause/Play, Replay; keyboard operable | row under the outcome line <1024; replaced by Previous/Next under reduced motion |
| Landing | Lane label | `--text-label`; caption `--text-caption` | browser `--text-secondary`; ledger `--accent`; caption `--text-muted` | padding s4 | 148px column | none | none | becomes inline legend <1024 |
| Landing | Lane band | n/a | browser: none + `--border` edges; ledger: `--accent-soft` | row gap s3 | min-height 132px | ledger radius md | none | removed <1024 (beats carry lane fill) |
| Landing | Beat | meta `--text-mono-sm`; title `--text-body` 500; text `--text-body-sm` | title `--text-primary`; text `--text-secondary`; markers per lane; active fill `--surface-3` or accent tint | padding s3; gaps s2, s1 | fills grid cell (about 212px wide); min-height 132px | radius md; selected outline | select opens inspector; pause on select while playing; arrow-key movement; hover; press | <1024: width min(86%, 440px), browser left, ledger right with `--accent-soft` and 2px accent edge, min-height 72px |
| Landing | Gap marker | `--text-mono-sm`, `--text-caption` | `--text-secondary`, `--text-muted`, dashed `--border` | n/a | 64px column, both rows | none | none | centred caption row with side hairlines <1024 |
| Landing | Readouts | label `--text-label`; value `--text-body-sm` 500; tally `--text-display-3` | browser `--text-primary`; ledger `--accent` | padding-left s4 | 224px column | left `--hairline` | values swap by step | two-cell row above the beats <1024; sticky on short screens |
| Landing | Contract bar (beat 6) | name `--text-body` 500; detail `--text-body-sm`; meta `--text-mono-sm` | pending `--surface-2` / `--border`; violated `--fail-soft` / `--fail-border` / `--fail` | padding s3 s4; margin-top s3 | full stage width; min-height 64px | 1px, radius md | selectable; colour change at step 6 | two lines <720 |
| Landing | Showcase footnote | `--text-caption` | `--text-muted` | margin-top s4 | max 720px | none | none | unchanged |
| Landing | Inspector (showcase) | title `--text-title`; labels `--text-label`; IDs `--text-mono` | `--text-primary`, `--text-muted` | margin-top s5; padding-top s5 | full panel width, two columns 7/5 | top `--hairline` | copy IDs; link to case event; close | single column <1024 |
| Landing | StatementList | title `--text-display-4`; body `--text-body` | `--text-primary`, `--text-secondary` | padding-top s5; gap s5; s3 title to body | 3 columns of 4 | top `--divider` | none | stacked <720 with s6 between |
| Landing | PipelineSteps | number `--text-mono-sm`; title `--text-title`; body `--text-body-sm` | `--text-muted`, `--text-primary`, `--text-secondary`; step 3 icon `--accent` | panel padding s6; step padding-left s5; gaps s3, s2 | 4 columns in one panel | panel 1px `--border-subtle` radius lg; step dividers `--hairline` | none | 2x2 at tablet; stacked with top hairlines <720 |
| Landing | Benchmark figures | numeral `--text-display-3`; label `--text-body-sm` | `--text-primary`, `--text-secondary` | cell padding 0 s5; s1 numeral to label | 4 equal columns | vertical `--hairline` | none (static) | 2x2 <720 |
| Landing | Benchmark scope block | title `--text-title`; body `--text-body`; LLM line `--text-body-sm` | `--text-primary`, `--text-secondary` | margin-top s7; gap s3 | columns 1 to 7 and 9 to 12 | none | link button to `#/benchmark` | stacked <1024 |
| Landing | CaseLinkRow | title `--text-body` 500; app `--text-body-sm` | `--text-primary`, `--text-muted`; hover `--surface-1` | padding s4 0 | container; min-height 64px | top `--hairline` | whole row is a link; arrow shifts 2px | two-line row <720 |
| Landing | Built with list | dt `--text-label`; dd `--text-body` | `--text-muted`, `--text-primary` | row padding s4 0 | columns 6 to 12; dt 200px | top `--hairline` | none | dt above dd <720 |
| Evidence | Page header | h1 `--text-display-2`; lede `--text-body-lg`; provenance `--text-caption` | `--text-primary`, `--text-secondary`, `--text-muted` | padding-top s8 (40px mobile); gaps s4 | h1 max 20ch; lede max 620px | none | none | sizes per type scale |
| Evidence | Group heading | `--text-display-4`; sub `--text-body-sm` | `--text-primary`, `--text-secondary` | margin-top s8; s2 to sub; s5 to list | container | none | none | unchanged |
| Evidence | CaseEntry | title `--text-display-4`; scenario `--text-body-sm`; labels `--text-label`; values `--text-body-sm` | `--text-primary`, `--text-secondary`, `--text-muted`; verdict status tokens; hover `--surface-1` | padding s6 0; column gap s5 | 12-column grid: 4 / 3 / 3 / 2 | top `--divider`; hover radius lg | whole entry links to case; hover; focus ring on title link | fields in a 3-column row at tablet; stacked `dl` <720 |
| Evidence | Comparison callout | title `--text-title`; body `--text-body-sm` | fill `--surface-1`; `--text-primary`, `--text-secondary` | padding s6; margin-top s8 | container | 1px `--border-subtle`, radius lg | secondary button to `#/compare` | stacked <720 |
| Evidence | Provenance details | summary `--text-body-sm`; table `--text-mono-sm` | `--text-secondary`, `--text-muted` | margin-top s7 | container; summary 44px | top `--hairline` | native disclosure; IDs copyable | table scrolls inside its wrapper <720 |
| Case | Breadcrumb | `--text-body-sm` | link `--text-secondary`, current `--text-muted` | padding-top s6; s5 to pill | container | none | link to `#/evidence` | unchanged |
| Case | Case header | h1 `--text-display-2`; lede `--text-body-lg`; meta `--text-body-sm` | `--text-primary`, `--text-secondary`, `--text-muted` | gaps s4 | h1 max 20ch | none | none | sizes per type scale |
| Case | VerdictSummary | labels `--text-label`; values `--text-title`; reason `--text-body-sm` | labels `--text-muted` (ledger label `--accent`); values `--text-primary`; verdict status colour | margin-top s7; cell padding s5 | 4 equal columns | top and bottom `--divider`; cell left `--hairline` | "Show signature" disclosure | 2x2 at tablet; stacked <720 |
| Case | RecordOrder | row label `--text-label`; name `--text-body-sm` 500; tags `--text-caption` | tiles `--surface-2`; changed tile `--accent-soft` + `--accent-border`; marker `--warn` | margin-top s7; tile gap s2; row gap s5 | 3 tiles per row, tile height 56px, max 720px | tile radius md | none | tiles stay 3 across down to 320px (names truncate with ellipsis, full name in `title`) |
| Case | Timeline panel | h2 `--text-display-3`; intro `--text-body` | fill `--surface-1` | margin-top s9; s6 heading to panel | container; lanes `minmax(0,1fr)` + inspector 360px | 1px `--border-subtle`, radius lg; inner divider | hosts selection state | inspector below lanes at tablet; inline under event <720 |
| Case | Timeline toolbar | `--text-button` | chips `--text-secondary`; selected `--surface-3` + `--text-primary` | padding s4 s5; chip gap s2 | chip 36px visual / 44px hit | bottom `--hairline`; chip 1px `--border-control` radius md | Key/All toggle; seven filters; `aria-pressed` | chips wrap; toggle full width <720 |
| Case | Timeline row | sequence and time `--text-mono-sm` | `--text-muted`; right lane band `--accent-soft` | row min-height 56px | grid 64px / 1fr / 1fr | top `--hairline` | none | single column <720, lane shown by alignment and fill |
| Case | TimelineEvent | label `--text-body-sm` 500; source and attempt `--text-caption` | `--text-primary`, `--text-muted`; tone icon `--warn` / `--accent` / `--pass` / `--fail`; selected `--surface-3` | padding s3 s4; margin s1 | fills lane cell | radius md; selected 1px `--border-control` | select, deselect, arrow keys, Escape; related events get a 2px lane edge | width calc(100% - 40px), left or right aligned <720 |
| Case | Inspector | title `--text-title`; labels `--text-label`; values `--text-body-sm`; IDs and payload `--text-mono` | `--text-primary`, `--text-muted`; pre `--surface-2` | padding s5; row gap s3 | 360px; sticky top 88px | left `--hairline`; pre radius md | copy IDs; related-event buttons; payload disclosure | full width below lanes at tablet; inline <720 with focus moved to its heading |
| Case | ScreenshotGallery | caption `--text-caption` | fill `--surface-1`; `--text-secondary` | margin-top s9; gap s5; thumb padding s1 | 3 / 2 / 1 columns; image 16:10 | thumb radius md, image radius sm | opens lightbox; hover border `--border-control` | columns per breakpoint |
| Case | Lightbox | caption `--text-body-sm` | overlay `--overlay`; `--text-primary` | padding s4 | image max 1200px wide, max-height 100vh minus 120px; close 48x48 | image radius md; `--shadow-float` | focus trap; Escape; overlay click; arrow keys | padding s4; previous/next at the bottom corners <720 |
| Case | EvidenceFileList | name `--text-body-sm` 500; path `--text-mono-sm`; action `--text-body-sm` | `--text-primary`, `--text-muted` | margin-top s9; row padding s3 0 | container; row min-height 44px | top `--hairline` | each row opens JSON in a new tab | path hidden <720 |
| Case | CommandBlock | `--text-mono`; button `--text-button` | fill `--surface-1`; code `--text-primary`; prompt `--text-muted` | padding s4 s4 s4 20px | container, max 840px; min-height 64px | 1px `--border-subtle`, radius lg | copy with confirmation and status region; code scrolls inside | button below code, full width <720 |
| Case | Prev/next | caption `--text-caption`; title `--text-title` | `--text-muted`, `--text-primary`; hover `--surface-1` | margin-top s9; padding s5 | two halves | top `--divider`; middle `--hairline` | links | stacked <720 |
| Compare | Page header | h1 `--text-display-2` (line 2 italic); lede `--text-body-lg` | `--text-primary`, `--text-secondary` | padding-top s6; gaps s4 | lede max 620px | none | none | sizes per type scale |
| Compare | Shared-fault bar | label `--text-label`; value `--text-body`; status `--text-body-sm` | `--text-muted`, `--text-primary`; icons `--warn`, `--pass` | margin-top s7; padding s4 0 | container | top and bottom `--divider` | "Show schedule ID" disclosure | wraps to two lines <720 |
| Compare | Comparison column | title `--text-display-4`; sub `--text-body-sm`; fact labels `--text-label`; fact values `--text-body-sm` | fill `--surface-1`; `--text-primary`, `--text-secondary`, `--text-muted`; verdict status tokens | padding s6 (s5 mobile); internal gaps s5; column gap s5 | two equal columns; rows `auto auto 1fr auto` | 1px `--border-subtle`, radius lg; internal `--hairline` dividers | "Show run identifiers" disclosure; "Open this case" link | stacked below about 900px, position-based agent first |
| Compare | Conclusion | h2 `--text-display-3`; body `--text-body-lg` | `--text-primary`, `--text-secondary` | margin-top s8; s4 to body | max 720px | none | none | unchanged |
| Compare | CommandBlock x2 | as Case | as Case | margin-top s9; s5 between blocks; label s2 above | max 840px | as Case | copy each | as Case |
| Benchmark | Page header | h1 `--text-display-2`; lede `--text-body-lg` | `--text-primary`, `--text-secondary` | padding-top s8 (40px mobile); s4 | lede max 620px | none | none | sizes per type scale |
| Benchmark | ScopeNote | title `--text-title`; body `--text-body` | fill `--surface-1`; `--text-primary`, `--text-secondary`; edge `--border-control` | margin-top 40px; padding s5 s6 | max 840px | 1px `--border-subtle`, 2px left edge, radius lg | none | padding s4 <720 |
| Benchmark | Figures | numeral `--text-display-2` (tablet `--text-display-3`); label `--text-body`; sub-line `--text-body-sm` | `--text-primary`, `--text-secondary`, `--text-muted` | margin-top s8; cell padding 0 s5; s4 to sub-line | 4 equal columns | vertical `--hairline` | none (static, from data) | 2x2 <720 |
| Benchmark | BenchmarkMatrix | head `--text-label`; workflow `--text-body-sm` 500; contract `--text-caption`; cell `--text-body-sm`; marks `--text-caption`; IDs `--text-mono-sm` | fill `--surface-1`; head `--surface-2`; marks `--pass` on `--pass-soft`; text `--text-primary`, `--text-secondary`, `--text-muted` | margin-top s9; cell padding s3 s4 | container; columns 40 / 20 / 20 / 20 percent; row min-height 64px; glyph 24px | 1px `--border-subtle`, radius lg; row `--hairline`; glyph radius sm | per-row "Show identifiers" disclosure; row hover `--surface-2` | rows become stacked blocks with three labelled lines <720; no horizontal scroll |
| Benchmark | Methodology / Limitations / LLM note | h2 `--text-display-3`; items `--text-body`; lead-ins 500 | `--text-primary`, `--text-secondary`; markers `--text-muted` | margin-top s9; item gap s4 | `--container-prose` 720px | none | none | unchanged |
| Benchmark | ProvenanceList | dt `--text-label`; dd `--text-body-sm` or `--text-mono` | `--text-muted`, `--text-primary` | row padding s4 0 | max 840px; dt 200px | top `--hairline` | commit and file links (new tab); copy hash | dt above dd <720 |
| Benchmark | CommandBlock | as Case | as Case | margin-top s9 | max 840px | as Case | copy per line | as Case |
| Not Found | Message | h1 `--text-display-2`; body `--text-body-lg`; path `--text-mono` | `--text-primary`, `--text-secondary`; mark muted | gaps s6, s4, s6 | max 560px; vertically centred | none | primary to `#/`; secondary to `#/evidence` | buttons stack <720 |
| System | PageState (loading, error) | h1 `--text-display-3`; body `--text-body` | `--text-primary`, `--text-secondary` | padding s9 0 | max 560px | none | error link to GitHub | unchanged |

---

## 23. Implementation order (suggested)

1. Tokens and base: fonts, `:root` tokens, reset, container, type classes, focus style. Delete the old stylesheet rules rather than overriding them.
2. `presentation.ts` (all label maps), router changes, `SiteHeader`, `SiteFooter`, `Mark`, icons, `index.html` head, favicon.
3. Benchmark export script, `parseBenchmark`, Benchmark page.
4. Landing: hero, showcase (static final state first, then the state machine, then reduced motion and mobile), remaining sections.
5. Evidence Explorer, Case Details (timeline refactor, inspector, attempt markers, deep link), Comparison, Not Found.
6. Acceptance pass against section 20 at 375, 768, 1024, 1280 and 1440px; render `og.png`.

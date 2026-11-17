# BrowserProof Site Revamp Audit

Audit of the current public viewer (`apps/viewer`, deployed at https://browserproof.vercel.app) before the redesign specified in `DESIGN_SPEC.md` and `TYPE_SYSTEM.md`.

Evidence reviewed: `apps/viewer/src/main.tsx` (340 lines, one file, all pages), `src/data.ts`, `src/style.css` (about 520 lines, 42.7 KB), `index.html`, `PRODUCT.md`, `public/demo/index.json` (five cases), `benchmarks/results.v1.json`, `benchmarks/cases.v1.json`, `docs/BENCHMARK.md`, `README.md`, and six full-page screenshots (landing, SupportDesk case, comparison; 1440x900 and 375x812).

Severity: P0 blocks the site's purpose, P1 materially hurts comprehension or trust, P2 polish.

## 1. Summary

The current site is an honest, working evidence viewer with a real idea at its centre (two lanes: what the browser saw, what the ledger confirmed). It reads as an internal debugging tool. A recruiter cannot tell in ten seconds what was achieved, because the project's strongest verified result (the 36-case benchmark) is not on the site at all and `PRODUCT.md` still describes it as a target. An engineer can reach the full record, but must read 23 near-identical rows to find the five that matter. The visual system has drifted: 23 distinct font sizes, most text at 8 to 13px, uppercase mono eyebrows, and three unrelated container treatments.

What to keep: the dual-lane concept, sequence-ordered timeline, correlation IDs, event inspector, screenshot lightbox with focus trap, evidence file links, copy-command, dataset validation in `parseDataset`, explicit load-error and unknown-route states, the skip link, and the careful "static recorded evidence" language.

## 2. Content and positioning

| # | Finding | Evidence | Sev |
|---|---|---|---|
| C1 | The benchmark result is absent. The site's proof strip shows "5 source-backed cases" and "2 verified fault types". The verified state is ten fault types under regression tests and a published 36-case benchmark (12/12 clean passes, 24/24 detected, 24/24 reproduced, 0 false positives). | Landing screenshot proof strip; `main.tsx` lines 94 to 100; `benchmarks/results.v1.json` `metrics`; `PRODUCT.md` "Capabilities and Constraints" still says the ten-fault plan and 36-case campaign "are targets, not completed claims". | P0 |
| C2 | No statement of what BrowserProof is as a product. The lede says it "shows what a browser agent saw beside what an independent backend ledger confirmed". That describes the viewer, not the framework (fault injection, contracts, reproduction). | Hero copy, `main.tsx` line 87; `index.html` title "BrowserProof — Evidence workbench" and description "read-only workbench for recorded browser-agent evidence". | P0 |
| C3 | No route for the benchmark, no methodology, no limitations on the site. The honesty caveats that make the 24/24 credible (deterministic reference agent, purpose-built non-idempotent apps, same-ledger label and flag) live only in `docs/BENCHMARK.md`. | Route type in `main.tsx` line 16 has only overview, case, comparison, not-found. | P0 |
| C4 | No owner, no LinkedIn, no explicit GitHub call to action above the fold. The only repository link is a 12px footer link and a "Setup and prerequisites" link. | Footer, `main.tsx` line 75. | P1 |
| C5 | Headline "One failure. Two refunds committed." is close but imprecise: the request did not fail, its response was lost after the commit. | Recorded fault type `commit_then_response_lost`; events seq 8 (commit confirmed) then seq 11 (request failed in browser). | P2 |
| C6 | Raw internal vocabulary in primary UI: `supportdesk-refund-v1`, `vulnerable index`, `dom_replace_after_observation`, `refund-retry-once-after-browser-failure`, `update-correct-record|beacon|wrong-target:alice`, `network upstream_response`, `backend effects_observed`, `fault schedule_disabled`. | Case rows on landing; case header lede; comparison "Fault injected" and "Contract" facts; timeline labels at seq 9, 18, 21. | P1 |
| C7 | Case titles assume context: "Commit succeeded; browser saw failure", "Beacon updated with the original page". Neither says what was intended or why it matters. | `index.json` `title` fields; case list. | P1 |
| C8 | The retry is presented without a causality guard. The hero card says "Agent chose to retry" directly after "Browser received a failed response". The recorded order supports "then", and the documented OpenAI campaign caveat shows why "because" must not be implied. | `refundMilestones` in `main.tsx` lines 134 to 147. | P1 |
| C9 | Em dashes in visible copy and metadata (hero lede, document title, screenshot alt text such as "Refund completed once — before agent"). | `main.tsx` line 87; `index.html` line 8; `index.json` screenshot `alt`. | P2 |
| C10 | The same reproduce panel, "Take the evidence further", is appended to all three page types with a generic heading, and on the landing page it is the last thing a recruiter sees instead of results or contact. | `ReproduceSection`, used at lines 117, 180, 204. | P2 |
| C11 | Footer states scope but no author or year, and there is no LICENSE file in the repository, so no licence may be claimed. | Footer; repository root listing. | P2 |

## 3. Visual hierarchy

| # | Finding | Evidence | Sev |
|---|---|---|---|
| H1 | Two competing focal points in the hero: an 82px two-colour serif headline on the left and a dark card containing 14 separate text styles on the right. Neither wins; the card's most important line ("2 refunds committed") is 18 to 23px while a decorative run UUID sits above it. | Landing desktop screenshot; `.story-topline`, `.story-outcome` rules. | P0 |
| H2 | The hero incident card's five steps are 115px-wide boxes with 8 to 11px text. Lane membership is encoded only by a 2px top border colour and a 9px mono label, so the central "browser vs ledger" distinction is nearly invisible. | Landing desktop screenshot, step row; `font-size: 8px` (7 uses), `9px` (14 uses), `10px` (13 uses), `11px` (32 uses) in `style.css`. | P0 |
| H3 | Every section on the landing page has the same weight: thin rule, serif heading, small grey paragraph. Proof strip, method strip, case list, comparison invitation and reproduce panel read as five equally minor bands. There is no one dominant visual. | Landing desktop screenshot, 650px to 1860px. | P1 |
| H4 | Rust red (`--fault: #b44335`) is used for brand emphasis (headline second line, "alice" value, link hover, focus ring, skip link) and for failure status. Colour therefore carries no reliable meaning. | `:root` tokens; `a:hover`, `--focus`, `.skip-link` rules; comparison h1. | P1 |
| H5 | The case page gives the 23-row timeline a bordered white panel that dominates 60 percent of the page, while the actual conclusion (two effects, contract violated) is a thin 3-column strip of 12px text above it and is then repeated in a different form ("Requested / Backend committed / Contract verdict") 2,500px lower. | SupportDesk desktop screenshot; `CaseOutcome` and `.case-summary-grid`. | P1 |
| H6 | Status pill placement is inconsistent: top right of the page on case and comparison headers, inside the card top line on the hero, inside the outcome strip again. | Screenshots; `StatusPill` used at lines 125, 172, 190, 209. | P2 |

## 4. Layout inconsistencies

| # | Finding | Evidence | Sev |
|---|---|---|---|
| L1 | No shared container. The top bar uses `padding: 0 clamp(20px, 5vw, 76px)`, pages use a different inset, and the footer uses a third. On the 1440px landing screenshot the logo starts at about x=72 while page content starts at about x=75 and footer text at x=72; on the case page the header content starts near x=75 but the breadcrumb at x=75 and the timeline panel is inset again. | `.topbar` rule; screenshots. | P1 |
| L2 | Hero grid is roughly 40/60 with the card pushed 28px lower than the headline; the card's right edge aligns with the container but its top aligns with nothing. | Landing desktop screenshot. | P2 |
| L3 | Mixed surface treatments: hairline-separated bands (proof strip), a boxed white panel with shadow (timeline), boxed cards with coloured top borders (comparison), a dark slab (hero card, footer, header), and bordered tiles inside bordered panels (record order tiles inside a bordered box inside a comparison card: three nested borders). | Comparison desktop screenshot; `.agent-comparison`, `.record-order`, `.order-state li`. | P1 |
| L4 | Radii are effectively absent (rectangles with 0 radius) except pills (999px) and two controls (4px, 5px). The square corners plus hairlines produce a "printed form" look that reads as dated next to the pill-shaped statuses. | `border-radius` census: 9 of 50 percent, 3 of 999px, one 5px, one 4px. | P2 |
| L5 | Comparison columns are unequal in height because fact lists wrap differently (the signature string wraps to two lines in the left column), so "Inspect this run" links do not align. | Comparison desktop screenshot, y=1041 vs y=1060. | P2 |
| L6 | Timeline lanes: the left lane holds 19 of 23 events and the right lane 4. The right column is mostly empty tinted space; the three-column grid wastes half the panel width. | SupportDesk desktop screenshot. | P1 |
| L7 | Spacing has no scale. Values in the stylesheet include 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 16, 18, 20, 22, 24, 28, 30, 34, 36 and clamp expressions. | `style.css` padding, gap and margin declarations. | P2 |
| L8 | A stray duplicate asset tree exists (`public/demo/evidence 2`, `public/demo/screenshots 2`), which would be published. | `ls apps/viewer/public/demo`. | P2 |

## 5. Typography

| # | Finding | Evidence | Sev |
|---|---|---|---|
| T1 | 23 distinct `font-size` values, with no scale: 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 23, 26, 29, 32, 44px and four different clamp expressions. | `grep -o "font-size: [^;]*" style.css`. | P1 |
| T2 | The majority of text is too small: 32 rules at 11px, 14 at 9px, 13 at 10px, 7 at 8px. Body-level explanatory text on the case page is 11 to 13px. | Same census; SupportDesk screenshots. | P0 |
| T3 | Uppercase, letter-spaced mono eyebrows ("SUPPORTDESK · RECORDED RUN", "OBSERVE", "VERIFY", "EVALUATE", "REQUESTED", "BACKEND COMMITTED", "AGENT OBSERVED", "AT ACTION TIME · LEDGER TARGET HIGHLIGHTED"). They add noise and spend mono on non-technical content, which dilutes the meaning of mono for real identifiers. | `.section-kicker`; screenshots. | P1 |
| T4 | Mono is used for non-data (the "5 records" count, "Evidence exported Oct 28, 2026", lane labels, "requested" tags), and real identifiers are shown in full everywhere (36-character UUIDs in list rows, headers and chips). | Landing case rows; timeline chips `action:6b750d36-...`. | P1 |
| T5 | Non-standard variable weights (560, 650) and tight negative tracking on the sans (`letter-spacing: -.035em` on the brand) reduce legibility at small sizes. | `.brand`, `.primary-nav a`. | P2 |
| T6 | Three families with overlapping roles: Newsreader is used for h1/h2 and also for mid-size statements and numerals; Instrument Sans for body; IBM Plex Mono for labels. The serif at 16 to 18px in the method strip looks like body text in the wrong font. | Landing screenshot, method strip. | P2 |

## 6. Information overload

| # | Finding | Evidence | Sev |
|---|---|---|---|
| O1 | The case timeline shows all 23 events by default with identical visual weight, including runner bookkeeping (`run started`, `backend reset`, `network upstream_response`). The six events that tell the story (seq 7, 8, 11, 13/16, 17, 22) are not distinguished. | SupportDesk desktop screenshot; `DualLaneTimeline` renders `item.timeline` unfiltered. | P0 |
| O2 | Each timeline node repeats up to two full correlation strings (`action:<uuid>`, `request:<uuid>`), about 70 characters of mono per row, 34 chips in total, to convey "these rows belong to attempt 1 or attempt 2". | Timeline chips in screenshot; `EventNode`. | P1 |
| O3 | The full source run UUID appears four times on the case page (header lede, evidence section, timeline context, details) and twice inside the hero card. | `main.tsx` lines 125, 162, 172, 267. | P2 |
| O4 | The landing case list mixes scenario ID, policy label and run UUID in one mono line per row; the meaningful difference between rows (what was intended, what happened) is not stated. | Landing screenshot rows 01 to 05. | P1 |
| O5 | Comparison fact lists show "Final backend state: alice inactive · beacon active · cirrus active" as a run-on string and the raw signature as the "Contract" value. | Comparison screenshot. | P1 |
| O6 | Evidence files are presented twice on the case page (five link tiles, then a collapsed "Evidence file paths and provenance" list of the same five paths). | `EvidenceExplorer` and `EvidenceFiles`. | P2 |

## 7. Navigation

| # | Finding | Evidence | Sev |
|---|---|---|---|
| N1 | Primary nav items "SupportDesk" and "AdminBench" are names of test apps and deep-link to one specific faulted case each. Three of the five cases are unreachable from the nav and there is no library page. | `main.tsx` lines 59 to 64. | P1 |
| N2 | No benchmark entry, no GitHub entry in the header. | Same. | P0 |
| N3 | Breadcrumb root is "Evidence index" but links to `#/`, which is the marketing overview. | `CasePage` line 171. | P2 |
| N4 | No previous/next movement between cases; the only way to the sibling case is back to the landing list. | `CasePage`. | P2 |
| N5 | Route changes do not reset scroll position or move focus, and `document.title` never changes, so every page is titled "BrowserProof — Evidence workbench". | `useRoute` only sets state; `index.html` title. | P1 |
| N6 | `html { scroll-behavior: smooth }` applies globally, which also smooths programmatic and anchor jumps. | `style.css` line 31. | P2 |
| N7 | No deep link to a specific event; a selected event is local state and is lost on reload or share. | `DualLaneTimeline` `selected` state. | P2 |

## 8. Accessibility

| # | Finding | Evidence | Sev |
|---|---|---|---|
| A1 | Text sizes of 8 to 10px (34 rules) fail practical legibility and cannot be justified as "large text"; several are also low contrast (`--muted #566361` on `--paper-deep #ece8de` is about 5:1, acceptable, but pale teal labels inside the dark card at 9px are not readable at conference viewing distance). | T2; hero card step meta. | P0 |
| A2 | Timeline uses `role="list"` on a div grid with empty lane cells; a screen reader hears 23 list items with no lane grouping, and the lane a row belongs to is only in the button's `aria-label` source word. | `DualLaneTimeline` markup. | P1 |
| A3 | Focus ring colour is the same rust red as failure status (`--focus: #b44335`), 3px on cream. Visible, but semantically confusing next to red failure rows and it changes to a different colour inside the dark card. | `:focus-visible` rule; `.story-step:focus-visible`. | P2 |
| A4 | Status relies on colour plus a small dot inside pills; case-row icons do carry shape (check, alert), which is good and should be kept and generalised. | `StatusPill`, `CaseRow`. | P2 |
| A5 | The copy button sets `aria-live="polite"` on the button itself and swaps its label. Announcement is unreliable; a separate live region is the robust pattern. | `ReproduceSection` line 311. | P2 |
| A6 | The event inspector appears below the 23-row list. After selecting an event near the top, the result renders off-screen with no focus move or scroll, so keyboard and screen-reader users get no feedback. | `DualLaneTimeline` line 251. | P1 |
| A7 | Lightbox is well built (focus trap, Escape, focus return) but does not lock body scroll or mark background content inert. | `ScreenshotGallery`. | P2 |
| A8 | No `<meta name="color-scheme">`, no Open Graph or Twitter tags, no canonical, no favicon, generic `lang` only. | `index.html`. | P1 |
| A9 | Touch targets are mostly sound and should stay that way: nav links and mobile chips reach 44px, `.icon-button` is 44x44 and `.lightbox-close` is 48x48. The gaps are inline text links ("Setup and prerequisites", breadcrumb, footer link at 11px) which have no minimum hit height, and desktop filter chips, which only get `min-height: 44px` inside the 700px media block. | `.icon-button`, `.lightbox-close`, `.footer`, `.filter-chip` rules. | P2 |

## 9. Responsive behaviour

| # | Finding | Evidence | Sev |
|---|---|---|---|
| R1 | Mobile header wraps into two rows (logo and badge, then four nav tabs with "Compare agents" breaking onto two lines), consuming about 120px before content. | Landing mobile screenshot. | P1 |
| R2 | The SupportDesk case page is 5,874px tall at 375px. Every one of the 23 events is a full card with wrapped ID chips. | SupportDesk mobile screenshot dimensions. | P0 |
| R3 | On mobile the two lanes collapse into one column with a 9px lane tag per card, so the page's defining mechanism disappears exactly where conference visitors will see it. | SupportDesk mobile screenshot. | P1 |
| R4 | Mobile hero: headline, lede, two full-width buttons and a scope note fill the first screen; the incident card starts below the fold and is then 650px of small text. | Landing mobile screenshot. | P1 |
| R5 | Screenshots on mobile render as large empty beige frames with a tiny image (the captured page is small within its own canvas). | SupportDesk mobile screenshot, 4,300px to 4,900px. | P2 |
| R6 | Only three breakpoints (1100, 700, 380px) with about 160 lines of overrides that restate sizes individually instead of changing tokens. | `@media` blocks at lines 339, 355, 497. | P2 |

## 10. Motion

Current state: 12 transition/animation declarations, all simple colour or background transitions at 160ms `ease`, plus a reduced-motion block. Nothing is wrong; nothing helps either.

| # | Opportunity | Why it earns motion | Sev |
|---|---|---|---|
| M1 | The refund incident is a time-ordered story across two observers. Presenting all five steps simultaneously hides the order, which is the point. A coordinated replay (about 8 seconds, pausable, replayable, reduced-motion safe) explains the mechanism faster than any paragraph. | P0 |
| M2 | Selecting a timeline event should visibly connect the row to its inspector (highlight, inspector content swap under 200ms). | P1 |
| M3 | Press feedback is missing on every button and row (`transform: scale(0.97)`, 120ms). | P2 |
| M4 | Lightbox opens and closes instantly; a 200ms opacity and 0.98 to 1 scale transition would make it feel intentional. | P2 |
| M5 | Copy-command confirmation swaps text only; an icon swap with a 150ms cross-fade is clearer. | P2 |

Do not add: scroll-linked reveals on every section, count-up numbers (a real metric must never animate from zero), parallax, cursor effects, smooth-scroll libraries, or page-transition animation. The existing global `scroll-behavior: smooth` should be removed.

## 11. Unnecessary complexity

| # | Finding | Evidence | Sev |
|---|---|---|---|
| X1 | One 340-line `main.tsx` holds routing, data loading, all pages and all formatters, with JSX written as single very long lines (several over 1,500 characters). It is hard to review and hard to restyle. | `main.tsx`. | P1 |
| X2 | `style.css` has no token layers beyond 17 colours: sizes, spacing, radii and durations are literals repeated across 500 lines, then re-declared in three media blocks. | `style.css`. | P1 |
| X3 | Two parallel "compact" code paths (`DualLaneTimeline compact`, `keyEvidenceEvents`) exist but the landing page uses a third bespoke component (`RefundStory`) for the same idea. | `main.tsx` lines 149, 224, 329. | P2 |
| X4 | Human wording is derived by string tests on IDs (`scenarioId.includes("adminbench")`, `recordName`, `formatFaultType`, `agentLabel`), scattered through components. A single presentation map would be simpler and is required for the new human titles. | `main.tsx` lines 169, 185, 304, 334 to 338. | P1 |
| X5 | Three time formatters produce locale-dependent 12-hour clock strings with "PM" wrapping under the sequence number; recorded UTC timestamps are converted to the visitor's local time, which misrepresents the record. | `formatTime`, `formatCompactTime`, `formatMobileTime`; SupportDesk screenshot sequence column. | P1 |
| X6 | Evidence is fetched with `cache: "no-store"` on every load although the bundle is static and versioned with the deployment. | `App` line 43. | P2 |

## 12. What the redesign must preserve

1. Hash routing; `#/`, `#/case/:id` and `#/compare` keep working with the same IDs.
2. `parseDataset` validation and its exact failure behaviour (no placeholder data on error).
3. Dual-lane timeline in recorded sequence order, with filters, event selection, correlation IDs, effect IDs.
4. Screenshot gallery and lightbox with focus trap and focus return.
5. Raw evidence file links and the reproduction command with copy.
6. Unknown-route and unknown-case handling.
7. The explicit statement that the site is static recorded evidence and never executes agents.
8. Existing tests (`tests/data.test.ts`, `tests/smoke.ts`) keep passing or are updated in the same change where selectors move; `data-testid="timeline-event"` and `data-event-sequence` remain on timeline events.

## 13. Priority order for the revamp

1. P0 content: benchmark page and landing metric, product positioning, GitHub and owner links (C1, C2, C3, N2).
2. P0 comprehension: the incident replay as the single dominant landing visual; key-events-first timeline (H1, H2, O1, M1, R2).
3. P0 legibility: one type scale with a 12px floor, dark token system, AA contrast (T1, T2, A1).
4. P1 structure: shared container, Evidence Explorer route, human titles and labels, route focus and titles, mobile lanes (L1, N1, C6, C7, N5, R3).
5. P2 polish: press states, lightbox transition, radii, spacing scale, asset cleanup.

# BrowserProof UI redesign audit

Date: 2026-10-29. Scope: `apps/viewer/**` static evidence UI. Audience confirmed by the user: technical recruiters, software engineering hiring managers, and portfolio-reviewing engineers; automation engineers remain a technical secondary audience. Recruiter comprehension target: 10–15 seconds without narration.

## Baseline evidence

Baseline was captured from both the local production build and the anonymous public URL before any UI edits. Each set includes overview, faulted SupportDesk, vulnerable and hardened AdminBench, and A/B comparison at 1440×900, 1280×800, 768×1024, 390×844, and 360×780. Desktop full-page route captures and a close-up of the SupportDesk timeline are included.

- Local: `apps/viewer/.visual-review/prompt06-baseline/local/`
- Public: `apps/viewer/.visual-review/prompt06-baseline/public/`
- Five genuine source-backed cases and source run IDs are preserved in the dataset. The public baseline smoke passed 38/38 assets and 17/17 route/viewport checks.

The baseline's strongest quality is evidence integrity: the parallel lanes, event sequence, real status chips, record-order illustration, and A/B target truth are present. At desktop the technical material fits on one page and the core evidence can be inspected.

## Screenshot-grounded findings

| Severity | Screenshot / viewport | Finding and impact | Proposed response |
|---|---|---|---|
| P1 | `overview-1440x900.png`, local and public | The large claim and compact timeline are separated from the case-selection path; first-time visitors see a generic incident panel before a simple story explaining why independent ledger truth changes the conclusion. | Recompose the first screen around a clear one-sentence product explanation and the five real causal milestones. Link each milestone to its source event; make the first case action obvious. |
| P1 | `supportdesk-360x780.png` and `supportdesk-390x844.png` | The two-lane table preserves both sources but squeezes text, identifiers, and timestamps into tiny columns. The causal edge is difficult to scan on a phone. | Keep the two sources explicit while stacking event content into a readable mobile chronology with clear lane labels; reveal correlation metadata in the event inspector. |
| P1 | `comparison-768x1024.png` | The comparison stays in two narrow columns at tablet width, causing headings, facts, and contract signature to wrap excessively. | Use a wider tablet breakpoint or stacked comparison at the narrow range, while retaining a true side-by-side view at desktop. |
| P2 | `overview-1440x900.png` and `comparison-1440x900.png` | Flat gray/white panels, thin borders, and uniform heading treatment make the experience resemble a plain internal prototype instead of a distinctive portfolio-grade developer tool. | Establish a product-specific editorial identity with expressive type, deliberate light/dark surface contrast, and a cause-and-effect diagram drawn from genuine event records. |
| P2 | `admin-vulnerable-1440x900-full.png` | The real DOM order change is represented, but the event chronology and record-order diagram compete for attention; the distinction between visually observed success and the independent wrong-target effect is not the strongest visual anchor. | Lead the detail view with the observation → reorder → old-index selection → Alice commit sequence; label browser observation and backend effect separately. |
| P2 | `overview-390x844.png` / `overview-360x780.png` | The two-row mobile navigation and intro consume much of the first viewport; the response-loss story starts below the fold. | Compress navigation into a simpler mobile pattern and surface a legible, partial proof sequence immediately below the heading. |
| P2 | `comparison-390x844.png` | The stacked cards preserve content but do not visually compare the shared schedule and differing commit target as one paired outcome. | Keep paired structure and shared schedule context visible, while stacking the two outcome columns in a predictable reading order. |

No P0 functional or evidence-integrity defect was observed at baseline. Existing parsing, provenance checks, source IDs, effect counts, timeline filters, keyboard details, lightbox, and reproduction paths remain working constraints, not redesign targets.

## Two visual directions

### Direction A — Evidence Journal (selected)

```text
┌ BrowserProof / Evidence · SupportDesk · AdminBench · Compare ┐
│ BROWSER AGENT RELIABILITY, MADE INSPECTABLE                    │
│ The browser said “failed.”                                     │
│ The ledger had already committed.  [small static-recorded mark] │
│ One explanatory sentence                       [source run ID] │
│                                                                │
│ Browser / agent    08 commit → 11 response lost → 13 retry     │
│ Independent ledger 08 effect → 17 second effect → 22 breach    │
│          [Inspect the response-loss case]                      │
│ 5 real records · 2 verified fault types · evidence is static   │
└────────────────────────────────────────────────────────────────┘
```

- **Visual language:** Editorial field notes translated into a precise developer tool: warm mineral paper, near-black ink, restrained signal vermilion for the failure, ledger green for independently confirmed effects, and clear blue for browser events. Hairline dividers and numbered sequence markers carry actual structure; no decorative dashboard widgets.
- **Typography:** `Newsreader` for the narrative display, `Instrument Sans` for UI and body, `IBM Plex Mono` for event sequences, timestamps, run IDs, and code. Load licensed, self-hosted WOFF2 files; keep body copy at a comfortable reading size.
- **Hero composition:** An oversized incident statement paired with a compact, real five-step event rail and a single obvious path to inspect the full SupportDesk case. The “static recorded evidence” label is always present.
- **Timeline:** One shared sequence spine with browser/agent and backend lanes. The top-level story shows only actual causal milestones; the complete event list, correlation IDs, payload, contract, artifacts, and screenshots remain available in the detail view.
- **Responsive strategy:** Desktop uses an editorial two-column hero and paired lanes; tablet turns the hero/sequence into wider stacked regions; mobile keeps a small sequence rail with legible lane badges and event cards, never shrinking the technical text to desktop scale.
- **Risks:** Serif misuse could make the site feel like a publication; avoid this with a sans-first interface and reserve the expressive face for short display statements. Avoid obscuring evidence under marketing copy.

### Direction B — Signal Room

```text
┌ BROWSERPROOF // RECORDED EVIDENCE / ALL SYSTEMS STATIC ┐
│ 01 INCIDENT STREAM                 05 CASES · 02 FAULTS │
│ COMMIT → LOST RESPONSE → RETRY → COMMIT → VIOLATION    │
│ ┌ browser lane / event feed ┐ ┌ backend ledger ┐        │
│ │ seq 08 · request · seq 11 │ │ effect · effect│        │
│ └──────────────────────────┘ └────────────────┘        │
│ Cases: SupportDesk / AdminBench / Same-schedule A/B    │
└────────────────────────────────────────────────────────┘
```

- **Visual language:** Dark observability instrument: graphite canvas, spectral cyan browser lane, green ledger lane, vermilion fault state, fixed baseline grid and compact tabs.
- **Typography:** `IBM Plex Sans` for UI, `IBM Plex Mono` for dense event data; larger sequence labels and small values.
- **Hero composition:** A full-bleed instrument panel with the causal five-step sequence as the dominant visualization and the case explorer directly beneath.
- **Timeline:** Dense dual-pane event stream, synchronized by sequence and selected event.
- **Responsive strategy:** Persistent source labels; on phones convert the two panes into alternating paired event blocks; keep case navigation reachable without horizontal scrolling.
- **Risks:** Strong engineering mood but closer to the category's familiar dark dashboard. High event density could overwhelm recruiter visitors and weaken the first-screen explanation.

## Weighted selection rubric

Scores are 1 (weak) to 5 (strong). Weighted score is out of 5; burden is scored higher when lighter to implement within the current static app.

| Criterion | Weight | A: Evidence Journal | B: Signal Room |
|---|---:|---:|---:|
| Engineering credibility | 20% | 4 | 5 |
| 15-second comprehension | 25% | 5 | 3 |
| Distinctive product identity | 20% | 5 | 4 |
| Evidence legibility | 15% | 5 | 4 |
| Mobile quality | 15% | 5 | 3 |
| Implementation burden | 5% | 4 | 3 |
| **Weighted total** | **100%** | **4.75** | **3.75** |

**Decision:** Build Direction A. It makes the actual event trail the hero while using an editorial voice to signal portfolio craftsmanship; the selection best serves the recruiter's first visit and still gives engineers direct access to raw sequence detail. Signal Room is credible but risks a familiar command-center aesthetic and overly dense first view. Motion remains manual, brief, and fully data-derived; no autoplay sequence.

## Implementation and screenshot critique passes

The selected direction now opens with “One failure. Two refunds committed.” beside the real five-event causal rail, followed by a plain-language explanation and an explicit static-evidence note. This gives a first-time portfolio visitor the product category, the failure, and the independent proof at a glance; the overview then leads into the five source-backed cases and the vulnerable/hardened comparison. Case detail retains the full chronology, IDs, payloads, observer, contract, artifacts, and reproduction command.

The first production-preview pass was captured after implementation at 25 route/viewport combinations. The two independent visual critiques found no P0/P1 defect or evidence-integrity regression and identified two P2 mobile issues: full timestamps wrapped into fragments in the narrow timeline gutter, and 360px navigation labels were too small. They also caught a capture-harness issue: route screenshots inherited the previous scroll position. The UI now shows compact `HH:mm` on phones while preserving the exact ISO value in `datetime`, the title, accessible name, and event inspector; the 360/390px nav labels are 11px with 47px touch targets. The screenshot matrix now verifies that route headings are visible at the top before capture. The optional mobile detail capture scrolls to actual timeline rows, rather than only the section heading.

The second critique/refinement pass inspected all 25 desktop, tablet, and mobile route captures; five desktop full-page views; and two focused mobile/desktop timeline crops. We checked the responsive comparison, long identifiers, source-lane labels, DOM reorder, evidence selection, keyboard focus, and the actual event sequence at 360px and 390px. The final local production-preview matrix is in `apps/viewer/.visual-review/prompt06-final/local/` (32 PNGs). Production smoke captures are in `apps/viewer/.visual-review/prompt06-final/smoke/` (25 route/viewport checks plus five desktop full-page captures). The screenshots are local review evidence and are ignored by Git; the representative overview screenshot is checked in at `docs/images/browserproof-overview-prompt06.png`.

The independent `browserproof_reviewer` review of the integrated source, genuine dataset semantics, and final screenshots found **no P0, P1, or P2 implementation findings**. It confirmed that the displayed evidence matches source data, the refund overview remains clear, and the A/B view shows the shared schedule and Alice-versus-Beacon outcomes. Its only requested follow-up was to record exact Prompt 06 verification in `CODEX_RUN_LOG.md` before declaring the gate complete.

Impeccable's final detector reported one `overused-font` warning for the self-hosted Instrument Sans declaration. It is retained deliberately as the body/UI face paired with Newsreader display type and IBM Plex Mono evidence data; the UI UX Pro Max typography search returned this pairing direction. The detector's warning is documented rather than suppressed. Its earlier side-tab-accent warning was closed by removing the thick event-card accent while retaining explicit lane and fault labels.

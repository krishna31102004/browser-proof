# BrowserProof UI design system — Prompt 06

Status: selected Direction A, Evidence Journal. Surface mode: **Persuade first, then Operate/Read**. The public overview invites a portfolio visitor into a true case; case detail remains a forensic workbench. Technical and evidence claims remain bound to checked-in data.

## Skill research used

The installed UI UX Pro Max search was run from `.agents/skills/ui-ux-pro-max/scripts/search.py` (project-local skill files; no package installation). `--design-system` returned Minimalism, blue/orange defaults, Outfit/Work Sans, and Hero + Features + CTA. Focused product search ranked Developer Tool / IDE with Minimalism & Swiss Style and dark syntax/blue focus; style search surfaced Minimalism & Swiss and Editorial Grid / Magazine; color search surfaced dark developer-tool palettes; typography search surfaced editorial serif/sans pairings including Newsreader/Roboto. These are search results, not product facts. We rejected the generic feature-card/CTA pattern and chose an evidence-led editorial interpretation based on the user-confirmed recruiter audience and the actual static evidence surface.

## Design tokens

- **Canvas:** warm mineral `#F5F2EA`; raised evidence paper `#FFFEFA`; deep ink `#142127`; subdued ink `#4E5A5D`; divider `#D7D3C9`.
- **Semantic proof:** browser/action blue `#24647B`; independently confirmed ledger green `#236447`; response-loss vermilion `#BD4435`; neutral recorded state `#5B6769`. Pair every color state with a text label or shape.
- **Typography:** Newsreader for short display statements; Instrument Sans for body and controls; IBM Plex Mono for actual identifiers, timestamps, sequence values and commands. Self-host WOFF2 assets, retain accessible system fallbacks.
- **Type scale:** 12 / 14 / 16 / 18 / 24 / 32 / 48 / 64px, with fluid display sizing at wide screens. Body is at least 16px on mobile, line-height 1.5; long prose max-width 68ch.
- **Spacing:** 4px base, practical steps 8 / 12 / 16 / 24 / 32 / 48 / 64px. Content max-width 1280px; desktop gutter 48px, tablet 32px, mobile 20px.
- **Geometry:** 1px structural rules, 8px small-control radius, 14px evidence surface radius. Avoid nested cards and ornamental shadows; use paper contrast, spacing, and rule hierarchy.
- **Motion:** data is static. Any visitor-initiated step selection updates only selected/expanded UI state; no automatic playback or continuous motion. Respect reduced motion.
- **Accessibility:** semantic landmarks/headings; skip link; focus-visible ring; keyboard-operable navigation, event disclosure and lightbox; controls meet at least 44px touch height on mobile; targets and statuses never rely on color alone.
- **Phone evidence details:** 360px and 390px navigation labels stay at 11px with 47px targets. Timeline rows use a compact `HH:mm` visual timestamp; the exact recorded ISO timestamp remains available through the time element's `datetime`, title, accessible name, and selected-event inspector.

## Signature component contracts

### First-screen incident rail

Derive the visible stages from the faulted SupportDesk dataset, preserving recorded sequence numbers and source lane: first backend commit (8), browser-visible request failure (11), agent retry decision (13), second backend commit (17), contract evaluation (22). Each item links to/selects its actual event; label the independent ledger lane and the browser/agent lane. Show source run ID and the at-most-once violation. State that this is static recorded evidence.

### Dual-lane timeline

Browser/agent/runner events remain separate from backend/observer/contract events. Keep chronology keyed by the existing sequence number, show matching IDs only where actual event data correlates, and preserve the filter and inspector. On phones, use paired event blocks with visible source labels instead of squeezing a desktop table.

### AdminBench and A/B

Show the actual order observed, DOM reorder, vulnerable stale-index action and Alice ledger commit beside the stable-ID action and Beacon ledger commit. Preserve the shared saved schedule ID, real contracts, final state and evidence links. At narrow widths, stack both outcomes without implying separate conditions.

## Claims boundary

The checked-in evidence supports five curated runs and two verified fault types. Do not add aggregate success percentages, benchmark size/performance claims, hosted/live execution cues, fake activity, or counters disconnected from dataset provenance.

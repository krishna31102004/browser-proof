# BrowserProof Type System

Companion to `DESIGN_SPEC.md`. Every text style on the site must use one of the tokens in section 4. No other font sizes, weights or families are allowed in `apps/viewer/src/style.css`.

## 1. Families and roles

| Role | Family | Used for | Never used for |
|---|---|---|---|
| Display | Instrument Serif (400, plus 400 italic) | h1, h2, large metric numerals, section statements | Body copy, buttons, labels, anything under 24px |
| UI | Geist (variable, 400 to 600 used) | Everything else: body, nav, buttons, labels, tables, captions | Identifiers |
| Technical | Geist Mono (variable, 400 and 500 used) | Real technical data only: run IDs, effect IDs, request IDs, sequence numbers, timestamps, event types, contract signatures, commit hashes, shell commands, JSON, file paths | Eyebrows, section labels, decorative captions, navigation, marketing copy |

Rules:

1. No uppercase, letter-spaced mono eyebrows anywhere. Section labels are Geist, sentence case, `--text-label`.
2. `text-transform: uppercase` must not appear in the stylesheet.
3. Instrument Serif has a single weight. Never apply `font-weight` above 400 to it and keep `font-synthesis: none` so the browser cannot fake bold or italic.
4. Italic serif is an emphasis device used at most once per page (the second line of the page h1). It is not used inside body copy.
5. Numbers in tables, timelines and metric rows use `font-variant-numeric: tabular-nums` (Geist and Geist Mono support it). Serif metric numerals are static text and do not need it.

## 2. Font files to ship

All fonts are self-hosted WOFF2 in `apps/viewer/public/fonts/`. No request to Google Fonts or any CDN at runtime. Delete the four existing files (`newsreader-latin.woff2`, `instrument-sans-latin.woff2`, `ibm-plex-mono-regular-latin.woff2`, `ibm-plex-mono-medium-latin.woff2`) and their three `OFL-*.txt` files.

| Ship as (exact file name) | Family | Style | Axis / weight | Subset | Target size |
|---|---|---|---|---|---|
| `geist-latin-wght-normal.woff2` | Geist | normal | variable `wght` 100 to 900 | Latin (U+0000-00FF plus the punctuation ranges in section 5) | about 30 KB |
| `geist-mono-latin-wght-normal.woff2` | Geist Mono | normal | variable `wght` 100 to 900 | Latin | about 32 KB |
| `instrument-serif-latin-400-normal.woff2` | Instrument Serif | normal | 400 | Latin | about 18 KB |
| `instrument-serif-latin-400-italic.woff2` | Instrument Serif | italic | 400 | Latin | about 19 KB |
| `OFL-Geist.txt` | licence | | | | |
| `OFL-Instrument-Serif.txt` | licence | | | | |

Hard cap: the four WOFF2 files together must be 120 KB or less on disk. If the Geist variable files exceed the targets after subsetting, replace each with two static instances (Geist 400 and 500; Geist Mono 400 and 500) and map weight 600 usage to 500. Do not ship Latin Extended, Cyrillic or any other subset. Do not ship Geist italic (never used).

### Sources and licences

| Family | Licence | Upstream source | Practical source for the exact subset files |
|---|---|---|---|
| Geist | SIL Open Font License 1.1 | `github.com/vercel/geist-font` (also published as the npm package `geist`) | npm `@fontsource-variable/geist`, file `files/geist-latin-wght-normal.woff2` (a Latin-subset build of the upstream font, same OFL licence) |
| Geist Mono | SIL Open Font License 1.1 | `github.com/vercel/geist-font` (npm `geist`) | npm `@fontsource-variable/geist-mono`, file `files/geist-mono-latin-wght-normal.woff2` |
| Instrument Serif | SIL Open Font License 1.1 | `github.com/Instrument/instrument-serif` and Google Fonts | npm `@fontsource/instrument-serif`, files `files/instrument-serif-latin-400-normal.woff2` and `files/instrument-serif-latin-400-italic.woff2` |

Implementation notes for the engineer:

1. Install the three Fontsource packages as dev dependencies only to copy the four files into `public/fonts/`, then remove the packages again (the site must not import font CSS from `node_modules`). Verify each file path exists after install; if a path differs in the installed version, use the file in that package whose name contains `latin` and not `latin-ext`.
2. Alternative if Fontsource is unavailable: take `Geist-Variable.woff2` and `GeistMono-Variable.woff2` from the npm package `geist` (`dist/fonts/geist-sans/` and `dist/fonts/geist-mono/`) and `InstrumentSerif-Regular.ttf` / `InstrumentSerif-Italic.ttf` from the Instrument repository, and subset each to the unicode range in section 5 with `pyftsubset --flavor=woff2 --layout-features='*'`. Rename to the exact file names above.
3. Copy the OFL text from each upstream repository (`OFL.txt` / `LICENSE.TXT`) into the two licence files. The OFL requires the licence to travel with the fonts.

## 3. Font stacks

```css
:root {
  --font-display: "Instrument Serif", "Iowan Old Style", "Palatino Linotype", Georgia, serif;
  --font-ui: "Geist", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --font-mono: "Geist Mono", ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace;
}
```

## 4. The scale (one scale, no other sizes)

Base: `html { font-size: 100%; }` (16px). Sizes are in rem; line heights are unitless and resolve to the pixel value shown at desktop size.

### 4.1 Display (Instrument Serif 400)

| Token | Size desktop (>=1024) | Line height | Tracking | Tablet (720 to 1023) | Mobile (<720) | Use |
|---|---|---|---|---|---|---|
| `--text-display-1` | 4.5rem (72px) | 1.05 (76px) | -0.02em | 3.5rem (56px) / 1.08 | 2.75rem (44px) / 1.1 (48px) | Landing hero h1 only |
| `--text-display-2` | 3.5rem (56px) | 1.1 (62px) | -0.015em | 3rem (48px) / 1.1 | 2.5rem (40px) / 1.1 (44px) | h1 on every other page; primary metric numeral |
| `--text-display-3` | 2.5rem (40px) | 1.15 (46px) | -0.01em | 2.5rem / 1.15 | 2rem (32px) / 1.2 (38px) | Section h2; secondary metric numerals |
| `--text-display-4` | 1.75rem (28px) | 1.25 (35px) | -0.005em | 1.75rem / 1.25 | 1.5rem (24px) / 1.25 (30px) | Serif h3 (case titles in the explorer, comparison column titles, "why it matters" statements) |

### 4.2 UI (Geist)

| Token | Size | Line height | Weight | Tracking | Mobile override | Use |
|---|---|---|---|---|---|---|
| `--text-title` | 1.25rem (20px) | 1.4 (28px) | 500 | -0.01em | 1.125rem (18px) / 1.45 (26px) | Sans h3/h4, card titles, inspector title |
| `--text-body-lg` | 1.125rem (18px) | 1.55 (28px) | 400 | 0 | none | Hero lede, page ledes |
| `--text-body` | 1rem (16px) | 1.625 (26px) | 400 | 0 | none | Default paragraph text |
| `--text-body-sm` | 0.875rem (14px) | 1.57 (22px) | 400 | 0 | none | Secondary paragraphs, table cells, beat descriptions, nav links |
| `--text-caption` | 0.8125rem (13px) | 1.4 (18px) | 400 | 0.005em | none | Footnotes, helper text, figure captions |
| `--text-label` | 0.8125rem (13px) | 1.4 (18px) | 500 | 0.01em | none | Lane labels, `dt`, table headers, chip text, status pill text. Sentence case always |
| `--text-button` | 0.875rem (14px) | 1.43 (20px) | 500 | 0 | none | All buttons and filter chips |
| `--text-button-lg` | 1rem (16px) | 1.5 (24px) | 500 | 0 | none | Hero CTAs only |

### 4.3 Technical (Geist Mono)

| Token | Size | Line height | Weight | Tracking | Use |
|---|---|---|---|---|---|
| `--text-mono` | 0.8125rem (13px) | 1.54 (20px) | 400 | 0 | Commands, JSON payloads, full IDs in the inspector, signatures, commit hashes |
| `--text-mono-sm` | 0.75rem (12px) | 1.5 (18px) | 400 | 0 | Sequence numbers, relative timestamps, truncated ID chips in dense rows |
| `--text-mono-strong` | 0.8125rem (13px) | 1.54 (20px) | 500 | 0 | The active or selected identifier, sequence number of the selected event |

The complete set of font sizes on the site is therefore: 12, 13, 14, 16, 18, 20, 24, 28, 32, 40, 44, 48, 56, 72 px. The minimum size anywhere is 12px (mono only); the minimum non-mono size is 13px.

### 4.4 CSS custom properties

Declare each token as a `font` shorthand plus a tracking variable so components use two declarations:

```css
:root {
  --text-display-1: 400 4.5rem/1.05 var(--font-display);    --track-display-1: -0.02em;
  --text-display-2: 400 3.5rem/1.1 var(--font-display);     --track-display-2: -0.015em;
  --text-display-3: 400 2.5rem/1.15 var(--font-display);    --track-display-3: -0.01em;
  --text-display-4: 400 1.75rem/1.25 var(--font-display);   --track-display-4: -0.005em;
  --text-title: 500 1.25rem/1.4 var(--font-ui);             --track-title: -0.01em;
  --text-body-lg: 400 1.125rem/1.55 var(--font-ui);
  --text-body: 400 1rem/1.625 var(--font-ui);
  --text-body-sm: 400 0.875rem/1.57 var(--font-ui);
  --text-caption: 400 0.8125rem/1.4 var(--font-ui);         --track-caption: 0.005em;
  --text-label: 500 0.8125rem/1.4 var(--font-ui);           --track-label: 0.01em;
  --text-button: 500 0.875rem/1.43 var(--font-ui);
  --text-button-lg: 500 1rem/1.5 var(--font-ui);
  --text-mono: 400 0.8125rem/1.54 var(--font-mono);
  --text-mono-sm: 400 0.75rem/1.5 var(--font-mono);
  --text-mono-strong: 500 0.8125rem/1.54 var(--font-mono);
}
@media (max-width: 1023px) {
  :root {
    --text-display-1: 400 3.5rem/1.08 var(--font-display);
    --text-display-2: 400 3rem/1.1 var(--font-display);
  }
}
@media (max-width: 719px) {
  :root {
    --text-display-1: 400 2.75rem/1.1 var(--font-display);
    --text-display-2: 400 2.5rem/1.1 var(--font-display);
    --text-display-3: 400 2rem/1.2 var(--font-display);
    --text-display-4: 400 1.5rem/1.25 var(--font-display);
    --text-title: 500 1.125rem/1.45 var(--font-ui);
  }
}
```

Usage: `h1 { font: var(--text-display-2); letter-spacing: var(--track-display-2); }`.

## 5. @font-face declarations

Place at the very top of `style.css`. Paths are root-relative to match the existing `public/fonts` convention.

```css
@font-face {
  font-family: "Geist";
  src: url("/fonts/geist-latin-wght-normal.woff2") format("woff2-variations"),
       url("/fonts/geist-latin-wght-normal.woff2") format("woff2");
  font-weight: 100 900;
  font-style: normal;
  font-display: swap;
  unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+2000-206F, U+2074, U+20AC, U+2122, U+2190-2193, U+2212, U+2215, U+FEFF, U+FFFD;
}
@font-face {
  font-family: "Geist Mono";
  src: url("/fonts/geist-mono-latin-wght-normal.woff2") format("woff2-variations"),
       url("/fonts/geist-mono-latin-wght-normal.woff2") format("woff2");
  font-weight: 100 900;
  font-style: normal;
  font-display: swap;
  unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+2000-206F, U+2074, U+20AC, U+2122, U+2190-2193, U+2212, U+2215, U+FEFF, U+FFFD;
}
@font-face {
  font-family: "Instrument Serif";
  src: url("/fonts/instrument-serif-latin-400-normal.woff2") format("woff2");
  font-weight: 400;
  font-style: normal;
  font-display: swap;
  unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+2000-206F, U+2074, U+20AC, U+2122, U+2212, U+2215, U+FEFF, U+FFFD;
}
@font-face {
  font-family: "Instrument Serif";
  src: url("/fonts/instrument-serif-latin-400-italic.woff2") format("woff2");
  font-weight: 400;
  font-style: italic;
  font-display: swap;
  unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+2000-206F, U+2074, U+20AC, U+2122, U+2212, U+2215, U+FEFF, U+FFFD;
}
```

`font-display: swap` for all four. To limit layout shift on the hero while Instrument Serif loads, add a metric-adjusted fallback face and put it second in the display stack:

```css
@font-face {
  font-family: "Instrument Serif Fallback";
  src: local("Georgia");
  size-adjust: 88%;
  ascent-override: 100%;
  descent-override: 28%;
  line-gap-override: 0%;
}
/* --font-display: "Instrument Serif", "Instrument Serif Fallback", "Iowan Old Style", Georgia, serif; */
```

(The four override values are starting values; adjust `size-adjust` until the fallback hero h1 wraps on the same lines as the loaded font at 1440px and 375px.)

## 6. Preload advice

Add to `apps/viewer/index.html` `<head>`, before the script tag. Preload exactly two files: the UI font (used by every element) and the regular display font (the hero h1, which is the LCP element on the landing page).

```html
<link rel="preload" href="/fonts/geist-latin-wght-normal.woff2" as="font" type="font/woff2" crossorigin />
<link rel="preload" href="/fonts/instrument-serif-latin-400-normal.woff2" as="font" type="font/woff2" crossorigin />
```

Do not preload Geist Mono (first appears below the hero) or the italic serif (one line per page; it swaps in). The `crossorigin` attribute is required even for same-origin font preloads. Fonts should be served with `Cache-Control: public, max-age=31536000, immutable`; add a `/fonts/(.*)` header rule to `apps/viewer/vercel.json`.

## 7. Global text rendering

```css
html { font-size: 100%; -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }
body {
  font: var(--text-body);
  font-synthesis: none;
  font-feature-settings: "kern", "liga", "calt";
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  text-rendering: optimizeLegibility;
}
h1, h2, h3, h4, p, dl, dd, ol, ul, figure { margin: 0; }
h1, h2, .serif { text-wrap: balance; }
p { text-wrap: pretty; }
code, pre, kbd, samp, .mono { font: var(--text-mono); font-variant-numeric: tabular-nums; font-variant-ligatures: none; }
table, .tabular { font-variant-numeric: tabular-nums; }
```

## 8. Heading map

| Element | Token | Colour token | Max width |
|---|---|---|---|
| Landing h1 | `--text-display-1` | `--text-primary`; second line italic in `--accent` | 14ch per line, block max 760px |
| Other page h1 | `--text-display-2` | `--text-primary`; optional second line italic in `--text-primary` | 20ch |
| Section h2 | `--text-display-3` | `--text-primary` | 22ch |
| Serif h3 | `--text-display-4` | `--text-primary` | 28ch |
| Sans h3 / h4 | `--text-title` | `--text-primary` | none |
| Lede | `--text-body-lg` | `--text-secondary` | 60ch (about 620px) |
| Paragraph | `--text-body` | `--text-secondary` | 68ch (about 640px) |
| Small paragraph | `--text-body-sm` | `--text-secondary` | 68ch |
| Caption, footnote | `--text-caption` | `--text-muted` | 72ch |

Heading order must be sequential per page: one h1, then h2 for sections, h3 inside sections. Visual size is chosen by token, never by picking a different heading level.

## 9. Labels, buttons, identifiers

| Item | Token | Case | Notes |
|---|---|---|---|
| Section label above an h2 (optional, sparing) | `--text-label`, `--text-muted` | Sentence case | Geist, never mono, never uppercase. Example: "Recorded incident" |
| Lane label | `--text-label`, colour by lane | Sentence case | "Browser and agent", "Independent ledger" |
| Status pill | `--text-label` | Sentence case | "Contract violated", "Contract passed" |
| Definition term (`dt`) | `--text-label`, `--text-muted` | Sentence case | |
| Table header | `--text-label`, `--text-muted` | Sentence case | Left aligned; numeric columns right aligned |
| Primary and secondary buttons | `--text-button` (hero: `--text-button-lg`) | Sentence case | No trailing arrows in Geist text; use the 16px arrow icon |
| Filter chip | `--text-button` | Sentence case | |
| Nav link | `--text-body-sm` weight 500 | Sentence case | |
| Truncated ID chip | `--text-mono-sm` | as recorded | First 8 characters; full value in `title`, in the inspector and on copy |
| Full ID, signature, hash, command | `--text-mono` | as recorded | `overflow-wrap: anywhere` |
| Sequence number | `--text-mono-sm`, two digits zero padded | | Example `08` |
| Relative time | `--text-mono-sm` | | Example `+1,235 ms` |
| Absolute time | `--text-mono` | | ISO 8601 UTC exactly as recorded, in the inspector only |

## 10. Checks

1. `grep -c "font-size" style.css` returns 0 outside the `:root` token block (all text uses the `font` shorthand tokens).
2. `grep -ci "uppercase" style.css` returns 0.
3. `grep -c "Newsreader\|Instrument Sans\|IBM Plex" -r apps/viewer/src apps/viewer/index.html` returns 0.
4. Network panel on first load shows at most four font requests, all same-origin WOFF2, total 120 KB or less.
5. No visible fallback-to-loaded reflow that changes the number of lines in the landing h1 at 1440px or 375px.

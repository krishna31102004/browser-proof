# BrowserProof evidence viewer

This is a static, read-only Vite application. It loads `public/demo/index.json` and the sanitized screenshot and JSON assets beside it. It has no runtime backend, hosted agent, or environment-variable requirement.

From the repository root:

```bash
pnpm --filter @browserproof/viewer dev
pnpm --filter @browserproof/viewer build
pnpm --filter @browserproof/viewer smoke
```

The smoke command serves the **production `dist` output** with Vite Preview, checks evidence-backed routes and controls in Chromium at desktop, tablet, and mobile widths, and writes visual review screenshots into the ignored `apps/viewer/.visual-review/` directory. The checked-in dataset is generated and validated by the main BrowserProof exporter; this app does not make replacement data when evidence is missing or invalid.

import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, type Browser, type Page } from "playwright";
import { benchmarkFigures, type BenchmarkExport } from "../src/benchmark.js";
import type { DemoDataset } from "../src/data.js";

export interface SmokeOptions { base: string; dataset: DemoDataset; bench: BenchmarkExport; screenshotDir: string }
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
export const viewports = [
  { name: "1440x900", width: 1440, height: 900 }, { name: "1280x800", width: 1280, height: 800 },
  { name: "768x1024", width: 768, height: 1024 }, { name: "375x812", width: 375, height: 812 },
];
const routes = (dataset: DemoDataset) => [
  { name: "home", hash: "/" }, { name: "evidence", hash: "/evidence" }, { name: "compare", hash: "/compare" }, { name: "benchmark", hash: "/benchmark" },
  ...dataset.cases.map((c) => ({ name: `case-${c.id}`, hash: `/case/${encodeURIComponent(c.id)}` })),
];

/** Page text as a visitor sees it with every disclosure closed, excluding shell commands (which legitimately contain flags). */
async function visibleText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const main = document.querySelector("main")!;
    const hidden = [...main.querySelectorAll<HTMLElement>(".command-block")];
    hidden.forEach((el) => { el.dataset.prev = el.style.display; el.style.display = "none"; });
    const text = main.innerText;
    hidden.forEach((el) => { el.style.display = el.dataset.prev ?? ""; });
    return text;
  });
}

async function assertNoOverflow(page: Page, label: string) {
  const g = await page.evaluate(() => ({ vw: document.documentElement.clientWidth, root: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
  assert.ok(g.root <= g.vw && g.body <= g.vw, `horizontal overflow on ${label}: ${JSON.stringify(g)}`);
}

export async function runSmoke(options: SmokeOptions): Promise<Record<string, unknown>> {
  const { base, dataset, bench, screenshotDir } = options;
  const f = benchmarkFigures(bench);
  const refund = dataset.cases.find((c) => c.id === "supportdesk-faulted")!;
  await mkdir(screenshotDir, { recursive: true });
  const browser: Browser = await chromium.launch({ headless: true });
  const consoleErrors: string[] = []; const failed: string[] = []; const fonts = new Set<string>();
  const watch = (page: Page) => {
    page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
    page.on("pageerror", (e) => consoleErrors.push(e.message));
    page.on("requestfailed", (r) => failed.push(`${r.method()} ${r.url()}: ${r.failure()?.errorText ?? "failed"}`));
    page.on("response", (r) => { if (r.status() >= 400) failed.push(`${r.status()} ${r.url()}`); if (/\.woff2(\?|$)/.test(r.url())) fonts.add(r.url()); });
  };
  const shots: string[] = [];
  try {
    // ---- every route at every viewport: renders, no overflow, honest and clean copy
    const ctx = await browser.newContext(); const page = await ctx.newPage(); watch(page);
    for (const vp of viewports) {
      await page.setViewportSize(vp);
      for (const route of routes(dataset)) {
        await page.goto(`${base}/#${route.hash}`, { waitUntil: "domcontentloaded" });
        await page.locator("main h1").first().waitFor();
        await page.evaluate(() => document.fonts.ready);
        await assertNoOverflow(page, `${route.name} at ${vp.name}`);
        const text = await visibleText(page);
        assert.ok(!text.includes("—"), `${route.name}: em dash in visible copy`);
        // The benchmark page lists its report ID under Provenance by design; no other page shows a raw UUID by default.
        if (route.name !== "benchmark") assert.ok(!UUID.test(text), `${route.name}: a raw UUID is visible with disclosures closed`);
        assert.ok(!/\b(seed|seeded|fixture|distractor|ground truth)\b/i.test(text), `${route.name}: raw fixture terminology is visible`);
        assert.ok(!/commit_then_response_lost|refund-retry-once|vulnerable-index|hardened-stable-id|count>1|wrong-target/.test(text), `${route.name}: raw fault, policy or signature strings are visible`);
        if (route.name === "home" || route.name === "benchmark") {
          assert.ok(text.includes(`${f.detected} / ${f.seededPlanned}`), `${route.name}: shows the recorded detection figure`);
          assert.ok(/deterministic reference agent/i.test(text) && /not (an estimate of )?how often real AI agents fail|not how often real AI agents fail/i.test(text), `${route.name}: scope statement is visible next to the figures`);
        }
        if (vp.name === "1440x900" || vp.name === "375x812") { const path = `${screenshotDir}/${route.name}-${vp.name}.png`; await page.evaluate(() => window.scrollTo(0, 0)); await page.screenshot({ path, fullPage: true }); shots.push(path); }
      }
    }
    await page.setViewportSize(viewports[0]!);

    // ---- routing: unknown hash, unknown case, deep link
    await page.goto(`${base}/#/definitely-not-a-page`, { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { level: 1, name: "Nothing recorded at this address" }).waitFor();
    await page.getByRole("link", { name: "Back to home" }).click();
    await page.waitForURL(/#\/$/);
    await page.goto(`${base}/#/case/no-such-case`, { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { level: 1, name: "Nothing recorded at this address" }).waitFor();
    await page.getByText("No recorded case has the identifier").waitFor();
    await page.goto(`${base}/#/case/supportdesk-faulted?event=17`, { waitUntil: "domcontentloaded" });
    const inspector = page.getByRole("complementary", { name: "Selected event details" });
    await inspector.getByText("Ledger commit confirmed").waitFor();
    assert.equal(await page.locator('[data-event-sequence="17"] button').first().getAttribute("aria-pressed"), "true", "deep link selects event 17");
    assert.match(await page.title(), /Lost response, duplicate refund · BrowserProof/);

    // ---- metadata and assets
    await page.goto(`${base}/#/`, { waitUntil: "domcontentloaded" });
    assert.equal(await page.title(), "BrowserProof · Verify What Browser Agents Actually Did");
    const meta = await page.evaluate(() => ({ canonical: document.querySelector('link[rel="canonical"]')?.getAttribute("href"), og: document.querySelector('meta[property="og:image"]')?.getAttribute("content"), tw: document.querySelector('meta[name="twitter:card"]')?.getAttribute("content"), theme: document.querySelector('meta[name="theme-color"]')?.getAttribute("content"), lang: document.documentElement.lang }));
    assert.deepEqual(meta, { canonical: "https://browserproof.vercel.app/", og: "https://browserproof.vercel.app/og.png", tw: "summary_large_image", theme: "#131110", lang: "en" });
    for (const asset of ["/favicon.ico", "/favicon.svg", "/favicon-16x16.png", "/favicon-32x32.png", "/apple-touch-icon.png", "/og.png", "/robots.txt", "/demo/benchmark.json"]) {
      const r = await fetch(new URL(asset, base)); assert.equal(r.status, 200, `${asset} is served`);
      if (asset === "/og.png") { const buf = Buffer.from(await r.arrayBuffer()); assert.equal(buf.readUInt32BE(16), 1200); assert.equal(buf.readUInt32BE(20), 630); }
    }
    assert.ok(await page.evaluate(() => document.fonts.check("16px Geist") && document.fonts.check("16px 'Instrument Serif'")), "self-hosted fonts load");

    // ---- showcase: final state on first paint, then one autoplay, pause, replay, completion
    await page.goto(`${base}/#/`, { waitUntil: "domcontentloaded" });
    const stage = page.locator(".stage");
    await stage.waitFor();
    assert.equal(await stage.getAttribute("data-step"), "6", "first paint shows the final recorded state");
    assert.equal(await stage.getAttribute("data-status"), "idle");
    assert.match(await page.locator(".tally .on").innerText(), /^2$/, "the ledger tally is 2 on first paint, never animated from zero");
    assert.ok(await page.locator(".contract-bar.is-fail").count() === 1, "contract bar shows the violation on first paint");
    await stage.scrollIntoViewIfNeeded();
    await page.waitForFunction(() => document.querySelector(".stage")?.getAttribute("data-status") === "playing", undefined, { timeout: 3000 });
    await page.getByRole("button", { name: "Pause" }).click();
    const pausedAt = await stage.getAttribute("data-step");
    await page.waitForTimeout(1400);
    assert.equal(await stage.getAttribute("data-step"), pausedAt, "Pause freezes the sequence");
    assert.equal(await stage.getAttribute("data-status"), "paused");
    await page.getByRole("button", { name: "Replay" }).click();
    assert.equal(await stage.getAttribute("data-status"), "playing");
    await page.waitForFunction(() => document.querySelector(".stage")?.getAttribute("data-status") === "done", undefined, { timeout: 11000 });
    assert.equal(await stage.getAttribute("data-step"), "6");
    await page.waitForTimeout(1200);
    assert.equal(await stage.getAttribute("data-status"), "done", "the replay does not loop");
    const beats = refund.timeline;
    const beat3 = page.getByRole("button", { name: /^Step 3 of 6/ });
    await beat3.click();
    const si = page.locator(".showcase-inspector");
    await si.getByText("Browser recorded a failed request").waitFor();
    const failedEvent = beats.find((e) => e.type === "network.request_failed")!;
    await si.getByText(failedEvent.timestamp).waitFor();
    assert.ok(await si.getByRole("link", { name: /Open this event in the full timeline/ }).getAttribute("href").then((h) => h?.endsWith(`?event=${failedEvent.sequence}`)));
    const showcaseText = await page.locator(".showcase").innerText();
    assert.ok(!/\bbecause\b/i.test(showcaseText), "showcase never asserts causality");
    assert.ok(/replay, not live/.test(showcaseText) && /does not establish why the agent retried/.test(showcaseText));
    const live = showcaseText.replace(/replay, not live/g, "");
    assert.ok(!/\b(live|real-time)\b/i.test(live), "showcase never calls recorded material live");

    // ---- case page: toggles, filters, selection, keyboard, lightbox
    await page.goto(`${base}/#/case/supportdesk-faulted`, { waitUntil: "domcontentloaded" });
    const rows = page.locator('[data-testid="timeline-event"]');
    const keyCount = await rows.count();
    await page.getByRole("button", { name: /^All events/ }).click();
    assert.equal(await rows.count(), refund.timeline.length, "All events shows every recorded event");
    assert.ok(keyCount < refund.timeline.length);
    await page.getByRole("button", { name: "Network", exact: true }).click();
    assert.ok(await rows.count() > 0);
    await page.getByRole("button", { name: "All", exact: true }).click();
    await rows.first().focus(); await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await page.getByRole("complementary", { name: "Selected event details" }).waitFor();
    await page.keyboard.press("Escape");
    await page.getByRole("complementary", { name: "Selected event details" }).waitFor({ state: "detached" });
    const thumb = page.locator(".shot").first();
    await thumb.scrollIntoViewIfNeeded();
    assert.ok(await thumb.locator("img").evaluate((el) => (el as HTMLImageElement).complete && (el as HTMLImageElement).naturalWidth > 0), "screenshot asset loads");
    await thumb.focus(); await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Screenshot detail" }); await dialog.waitFor();
    const close = page.getByRole("button", { name: "Close screenshot" });
    assert.ok(await close.evaluate((el) => document.activeElement === el), "lightbox moves focus inside");
    await page.keyboard.press("Tab"); assert.ok(await dialog.evaluate((el) => el.contains(document.activeElement)), "Tab stays inside the lightbox");
    await page.keyboard.press("Escape"); await dialog.waitFor({ state: "detached" });
    assert.ok(await thumb.evaluate((el) => document.activeElement === el), "focus returns to the thumbnail");
    for (const [key, path] of Object.entries(refund.evidenceFiles)) { const r = await fetch(new URL(path, base)); assert.equal(r.status, 200, `${key} evidence file is served`); }

    // ---- comparison and benchmark content from real data
    await page.goto(`${base}/#/compare`, { waitUntil: "domcontentloaded" });
    await page.getByText("Same saved schedule in both runs").waitFor();
    const colText = await page.locator(".compare-grid").innerText();
    assert.ok(/Alice set to inactive/.test(colText) && /Beacon set to inactive/.test(colText), "comparison shows each ledger target from the dataset");
    await page.goto(`${base}/#/benchmark`, { waitUntil: "domcontentloaded" });
    await page.getByRole("table").waitFor();
    assert.equal(await page.locator(".bm-row").count(), 12);
    assert.equal(await page.locator("tbody .bm-mark.ok", { hasText: "Detected" }).count(), 24);
    assert.equal(await page.locator("tbody .bm-mark.ok", { hasText: "Reproduced" }).count(), 24);
    assert.equal(await page.locator("tbody .bm-mark.ok", { hasText: "Passed" }).count(), 12);
    await page.getByText("These trials therefore do not show that the lost response caused the retry decision.").waitFor();
    await page.locator('a[href*="/commit/"]').first().waitFor();

    // ---- mobile menu and touch targets
    await page.setViewportSize(viewports[3]!);
    await page.goto(`${base}/#/`, { waitUntil: "domcontentloaded" });
    const menu = page.getByRole("button", { name: "Menu" });
    assert.ok((await menu.boundingBox())!.height >= 44);
    await menu.click(); assert.equal(await menu.getAttribute("aria-expanded"), "true");
    await page.locator("#site-menu").getByRole("link", { name: "Benchmark", exact: true }).click();
    await page.waitForURL(/#\/benchmark/);
    await page.waitForFunction(() => document.querySelector(".menu-button")?.getAttribute("aria-expanded") === "false", undefined, { timeout: 2000 });
    await menu.click(); await page.keyboard.press("Escape"); assert.equal(await menu.getAttribute("aria-expanded"), "false");

    // ---- reduced motion: no autoplay, final state, stepping controls
    const rctx = await browser.newContext({ reducedMotion: "reduce" }); const rp = await rctx.newPage(); watch(rp);
    await rp.setViewportSize(viewports[0]!);
    await rp.goto(`${base}/#/`, { waitUntil: "domcontentloaded" });
    await rp.locator(".stage").scrollIntoViewIfNeeded(); await rp.waitForTimeout(1500);
    assert.equal(await rp.locator(".stage").getAttribute("data-status"), "idle", "no autoplay under reduced motion");
    assert.equal(await rp.locator(".stage").getAttribute("data-step"), "6");
    await rp.getByRole("button", { name: "Previous step" }).click();
    assert.equal(await rp.locator(".stage").getAttribute("data-step"), "5");
    await rp.getByRole("button", { name: "Show final state" }).click();
    assert.equal(await rp.locator(".stage").getAttribute("data-step"), "6");
    assert.ok(await rp.getByRole("button", { name: "Pause" }).count() === 0);
    await rctx.close();

    assert.ok(fonts.size <= 4, `at most four font files requested, saw ${fonts.size}`);
    assert.deepEqual(consoleErrors, [], `console errors: ${consoleErrors.join(" | ")}`);
    assert.deepEqual(failed, [], `failed requests: ${failed.join(" | ")}`);
    await ctx.close();
  } finally { await browser.close(); }
  return { status: "passed", base, routes: routes(dataset).length, viewports: viewports.map((v) => v.name), fontFiles: [...fonts].map((u) => u.split("/").pop()), screenshots: shots.length, consoleErrors, failedRequests: failed };
}

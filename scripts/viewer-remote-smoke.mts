import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, type Page } from "playwright";
import { parseDataset } from "../apps/viewer/src/data.js";

const urlIndex = process.argv.indexOf("--url");
const rawUrl = urlIndex >= 0 ? process.argv[urlIndex + 1] : undefined;
assert.ok(rawUrl, "usage: pnpm run viewer:smoke:remote -- --url https://<public-host>");
const base = new URL(rawUrl!);
assert.equal(base.protocol, "https:", "remote smoke requires a public HTTPS origin");
assert.equal(base.username, "", "URL must not embed credentials");
assert.equal(base.password, "", "URL must not embed credentials");
assert.ok(!/^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])$/i.test(base.hostname), "remote smoke cannot target localhost");
base.pathname = base.pathname.replace(/\/$/, "");
base.search = "";
base.hash = "";
const origin = base.origin;
const screenshotPath = resolve(process.cwd(), "apps/viewer/.visual-review", `remote-${base.hostname}`);
const rawData = await fetch(new URL("/demo/index.json", origin));
assert.equal(rawData.status, 200, "published evidence index is publicly readable");
assert.match(rawData.headers.get("content-type") ?? "", /application\/json/i, "evidence index uses a JSON media type");
const dataset = parseDataset(await rawData.json() as unknown);
assert.equal(dataset.cases.length, 5, "the public site serves all five curated evidence cases");
const refund = dataset.cases.find((item) => item.scenarioId.includes("supportdesk") && item.mode === "faulted");
const vulnerable = dataset.cases.find((item) => item.scenarioId.includes("adminbench") && item.mode === "faulted" && item.agent === "vulnerable-index");
const hardened = dataset.cases.find((item) => item.scenarioId.includes("adminbench") && item.mode === "faulted" && item.agent === "hardened-stable-id");
assert.ok(refund && vulnerable && hardened, "the remote evidence bundle contains the actual faulted cases");

const browser = await chromium.launch({ headless: true });
try {
  await mkdir(screenshotPath, { recursive: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const failedRequests: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("requestfailed", (request) => failedRequests.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText ?? "failed"}`));

  const desktop = { name: "desktop-1440x900", width: 1440, height: 900 };
  const tablet = { name: "tablet-768x1024", width: 768, height: 1024 };
  const mobile = { name: "mobile-390x844", width: 390, height: 844 };
  const narrow = { name: "mobile-360x780", width: 360, height: 780 };
  const overviewCaptures = [desktop, { name: "desktop-1280x800", width: 1280, height: 800 }, tablet, mobile, narrow];

  for (const [index, viewport] of overviewCaptures.entries()) {
    await page.setViewportSize(viewport);
    const response = await page.goto(index === 0 ? origin : `${origin}/#/`, { waitUntil: "domcontentloaded" });
    if (index === 0) assert.equal(response?.status(), 200, "public page returns HTTP 200");
    await assertOverview(page, dataset.cases.length);
    await assertResponsive(page, viewport.width);
    await screenshot(page, `${screenshotPath}/overview-${viewport.name}.png`, viewport.name === desktop.name);
  }

  const routeCaptures = [
    { item: refund, name: "supportdesk-desktop-1440x900", viewport: desktop },
    { item: refund, name: "supportdesk-mobile-390x844", viewport: mobile },
    { item: refund, name: "supportdesk-mobile-360x780", viewport: narrow },
    { item: vulnerable, name: "admin-vulnerable-desktop-1440x900", viewport: desktop },
    { item: vulnerable, name: "admin-vulnerable-mobile-390x844", viewport: mobile },
    { item: vulnerable, name: "admin-vulnerable-mobile-360x780", viewport: narrow },
    { item: hardened, name: "admin-hardened-desktop-1440x900", viewport: desktop },
    { item: hardened, name: "admin-hardened-mobile-390x844", viewport: mobile },
    { item: hardened, name: "admin-hardened-mobile-360x780", viewport: narrow },
  ];
  for (const capture of routeCaptures) {
    await page.setViewportSize(capture.viewport);
    await visitHash(page, `/case/${encodeURIComponent(capture.item.id)}`);
    await assertCase(page, capture.item);
    if (capture.item === refund) assertRefundEvidence(refund);
    if (capture.item === vulnerable) assertAdminTarget(vulnerable, "alice", false);
    if (capture.item === hardened) assertAdminTarget(hardened, "beacon", true);
    await assertResponsive(page, capture.viewport.width);
    await screenshot(page, `${screenshotPath}/${capture.name}.png`, capture.name === "supportdesk-desktop-1440x900" || capture.name === "admin-vulnerable-desktop-1440x900" || capture.name === "admin-hardened-desktop-1440x900");
  }

  for (const capture of [
    { name: "comparison-desktop-1440x900", viewport: desktop },
    { name: "comparison-mobile-390x844", viewport: mobile },
    { name: "comparison-mobile-360x780", viewport: narrow },
  ]) {
    await page.setViewportSize(capture.viewport);
    await visitHash(page, "/compare");
    await assertComparison(page, vulnerable, hardened);
    await assertResponsive(page, capture.viewport.width);
    await screenshot(page, `${screenshotPath}/${capture.name}.png`, capture.name === "comparison-desktop-1440x900");
  }

  await page.setViewportSize(desktop);
  await visitHash(page, "/");
  await page.getByRole("link", { name: "SupportDesk", exact: true }).click();
  await page.waitForURL(/#\/case\//);
  await page.getByRole("heading", { level: 1 }).waitFor();
  await page.goBack();
  await page.waitForURL(/#\/$/);
  await page.goForward();
  await page.waitForURL(/#\/case\//);
  const repositoryLink = page.getByRole("link", { name: "Source repository", exact: true });
  assert.equal(await repositoryLink.getAttribute("href"), "https://github.com/krishna31102004/browser-proof");
  await assertNoMisleadingActions(page);
  await verifyPublicInteractions(page, refund);
  await page.emulateMedia({ reducedMotion: "reduce" });
  assert.equal(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches), true, "reduced-motion preference reaches the page");
  assert.ok(await page.locator(".filter-chip").first().evaluate((element) => Number.parseFloat(getComputedStyle(element).transitionDuration) <= 0.001), "reduced motion disables meaningful transition duration");

  await verifyPublishedAssets(origin, dataset);
  assert.deepEqual(consoleErrors, [], `console errors: ${consoleErrors.join(" | ")}`);
  assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join(" | ")}`);
  assert.deepEqual(failedRequests, [], `failed requests: ${failedRequests.join(" | ")}`);
  console.log(JSON.stringify({
    status: "passed",
    publicUrl: origin,
    https: true,
    anonymousAccess: true,
    caseCount: dataset.cases.length,
    caseIds: dataset.cases.map((item) => item.id),
    sourceRunIds: dataset.provenance.sources.map((source) => source.runId),
    routes: ["overview", "supportdesk-faulted", "admin-vulnerable", "admin-hardened", "comparison", "direct-hash", "back-forward"],
    viewportChecks: overviewCaptures.map((item) => `${item.name}:${item.width}x${item.height}`).concat(routeCaptures.map((item) => `${item.name}:${item.viewport.width}x${item.viewport.height}`), ["comparison-desktop-1440x900:1440x900", "comparison-mobile-390x844:390x844", "comparison-mobile-360x780:360x780"]),
    assetsChecked: dataset.cases.reduce((total, item) => total + item.screenshots.length + Object.keys(item.evidenceFiles).length, 0) + 1,
    screenshots: screenshotPath,
    consoleErrors,
    pageErrors,
    failedRequests,
  }, null, 2));
  await context.close();
} finally {
  await browser.close();
}

async function assertOverview(page: Page, caseCount: number) {
  await page.getByRole("heading", { level: 1, name: /agent saw a failure/i }).waitFor();
  await page.getByText("Recorded local executions", { exact: true }).waitFor();
  assert.equal(await page.locator(".case-row").count(), caseCount, "overview count matches public dataset");
  await page.getByText(`${caseCount} recorded cases · 2 fault types`, { exact: true }).waitFor();
  await page.locator(".feature-incident .lane-headings").getByText("Browser / agent").waitFor();
  await page.locator(".feature-incident .lane-headings").getByText("Backend ground truth").waitFor();
  await assertNoMisleadingActions(page);
}

async function assertCase(page: Page, item: (typeof dataset.cases)[number]) {
  await page.getByRole("heading", { level: 1 }).waitFor();
  await page.getByText(item.sourceRunId, { exact: true }).first().waitFor();
  await page.getByRole("heading", { name: /what the agent saw \/ what the backend confirmed/i }).waitFor();
}

function assertRefundEvidence(item: (typeof refund & {}) ) {
  assert.equal(item.effects.length, 2);
  assert.notEqual(item.effects[0]?.effectId, item.effects[1]?.effectId);
  assert.equal(item.effects.every((effect) => effect.entityId === "A123"), true);
  assert.equal(item.contract.signature, "refund-at-most-once|A123|count>1");
  const commit = item.timeline.find((event) => event.type === "backend.commit_confirmed");
  const failed = item.timeline.find((event) => event.type === "network.request_failed");
  assert.ok(commit && failed && commit.sequence < failed.sequence, "independent upstream commit precedes browser-visible failure");
  assert.equal(item.timeline.filter((event) => event.type === "browser.click_attempt").length, 2, "one retry follows the failed response");
}

function assertAdminTarget(item: (typeof vulnerable & {}), target: string, passed: boolean) {
  assert.equal(item.effects.length, 1);
  assert.equal(item.effects[0]?.entityId, target);
  assert.equal(item.contract.passed, passed);
  assert.equal(item.scheduleId, vulnerable?.scheduleId, "A/B cases use the same saved schedule");
}

async function assertComparison(page: Page, left: (typeof vulnerable & {}), right: (typeof hardened & {})) {
  await page.getByRole("heading", { level: 1, name: /one stale index/i }).waitFor();
  await page.getByText("Schedule IDs match", { exact: true }).waitFor();
  assertAdminTarget(left, "alice", false);
  assertAdminTarget(right, "beacon", true);
  assert.ok(await page.getByText("alice", { exact: false }).count() > 0);
  assert.ok(await page.getByText("beacon", { exact: false }).count() > 0);
}

async function assertResponsive(page: Page, width: number) {
  const dimensions = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, page: document.documentElement.scrollWidth }));
  assert.ok(dimensions.page <= dimensions.viewport + 1, `horizontal overflow at ${width}px: ${JSON.stringify(dimensions)}`);
  if (width <= 390) {
    const nav = page.getByRole("navigation", { name: "Evidence views" });
    for (const label of ["Overview", "SupportDesk", "AdminBench", "Compare agents"]) assert.equal(await nav.getByRole("link", { name: label, exact: true }).isVisible(), true);
    const filter = page.locator(".filter-chip").first();
    if (await filter.count()) assert.ok(await filter.evaluate((element) => element.getBoundingClientRect().height >= 38), "mobile event filters have usable tap targets");
  }
}

async function verifyPublicInteractions(page: Page, item: (typeof refund & {})) {
  await visitHash(page, `/case/${encodeURIComponent(item.id)}`);
  await page.getByRole("button", { name: "Network", exact: true }).click();
  const networkEvent = page.getByRole("button", { name: /response lost|failed|request/i }).first();
  await networkEvent.waitFor();
  await networkEvent.click();
  const inspector = page.getByRole("complementary", { name: "Selected event details" });
  await inspector.getByText(/Event type/).waitFor();
  const allFilter = page.getByRole("button", { name: "All evidence", exact: true });
  await allFilter.click();
  const event = page.locator(".event-node").first();
  await allFilter.focus();
  let eventFocused = false;
  for (let attempt = 0; attempt < 20 && !eventFocused; attempt += 1) {
    await page.keyboard.press("Tab");
    eventFocused = await event.evaluate((element) => document.activeElement === element);
  }
  assert.equal(eventFocused, true, "timeline events are reachable by keyboard");
  const outline = await event.evaluate((element) => getComputedStyle(element).outlineStyle);
  assert.notEqual(outline, "none", "keyboard focus has a visible ring");
  await page.keyboard.press("Enter");
  await inspector.waitFor();
  await page.getByRole("button", { name: "Close event details" }).click();

  const trigger = page.locator(".screenshot-thumb").first();
  await trigger.scrollIntoViewIfNeeded();
  const screenshot = trigger.locator("img");
  assert.ok(await screenshot.getAttribute("alt"), "screenshot has useful alternative text");
  assert.equal(await screenshot.evaluate((element) => (element as HTMLImageElement).complete && (element as HTMLImageElement).naturalWidth > 0), true, "screenshot loads in the public page");
  await trigger.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Screenshot detail" });
  const close = page.getByRole("button", { name: "Close screenshot" });
  await dialog.waitFor();
  assert.equal(await close.evaluate((element) => document.activeElement === element), true, "dialog moves focus to its close control");
  await page.keyboard.press("Tab");
  assert.equal(await close.evaluate((element) => document.activeElement === element), true, "Tab stays inside the screenshot dialog");
  await page.keyboard.press("Shift+Tab");
  assert.equal(await close.evaluate((element) => document.activeElement === element), true, "Shift+Tab stays inside the screenshot dialog");
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  assert.equal(await trigger.evaluate((element) => document.activeElement === element), true, "Escape restores focus to the screenshot control");
}

async function assertNoMisleadingActions(page: Page) {
  const labels = await page.locator("button, a").allTextContents();
  assert.ok(!labels.some((text) => /^(run agent|deploy|live run|download trace|replay)$/i.test(text.trim())), "no false live, replay or unavailable trace controls are shown");
}

async function visitHash(page: Page, hash: string) {
  await page.goto(`${origin}/#${hash}`, { waitUntil: "domcontentloaded" });
  await page.locator("main").waitFor({ state: "visible" });
}

async function screenshot(page: Page, path: string, full: boolean) {
  const brokenImages = await page.evaluate(async () => {
    const images = [...document.images];
    for (const image of images) image.loading = "eager";
    await Promise.all(images.map((image) => image.decode().catch(() => undefined)));
    return images.filter((image) => !image.complete || image.naturalWidth === 0).map((image) => image.currentSrc || image.src);
  });
  assert.deepEqual(brokenImages, [], `screenshot images load: ${brokenImages.join(" | ")}`);
  await page.screenshot({ path, fullPage: full });
}

async function verifyPublishedAssets(publicOrigin: string, data: typeof dataset) {
  const paths = new Set<string>(["/demo/index.json"]);
  for (const item of data.cases) {
    for (const screenshot of item.screenshots) paths.add(screenshot.src);
    for (const evidence of Object.values(item.evidenceFiles)) paths.add(evidence);
  }
  const broken: string[] = [];
  await Promise.all([...paths].map(async (path) => {
    const response = await fetch(new URL(path, publicOrigin));
    const type = response.headers.get("content-type") ?? "";
    const extension = path.split(".").at(-1)?.toLowerCase();
    const expected = extension === "png" ? /image\/png/i : extension === "json" ? /application\/json/i : extension === "jsonl" ? /application\/x-ndjson/i : /.+/;
    if (response.status !== 200 || !expected.test(type) || /text\/html/i.test(type)) {
      broken.push(`${path}: HTTP ${response.status}, content-type=${type || "missing"}`);
      return;
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (path.endsWith(".png") && !(bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)) broken.push(`${path}: invalid PNG signature`);
    if (path.endsWith(".json")) {
      try { JSON.parse(new TextDecoder().decode(bytes)); } catch { broken.push(`${path}: invalid JSON`); }
    }
    if (path.endsWith(".jsonl")) {
      const lines = new TextDecoder().decode(bytes).trim().split(/\r?\n/);
      try { for (const line of lines) JSON.parse(line); } catch { broken.push(`${path}: invalid JSONL`); }
    }
    const content = new TextDecoder().decode(bytes);
    if (/\/Users\/[^/\s]+\/(?:Desktop|Projects)|(?:^|\W)localhost:\d+|Authorization: Bearer/i.test(content)) broken.push(`${path}: unexpected local path or credential marker`);
  }));
  assert.deepEqual(broken, [], `public evidence assets: ${broken.join(" | ")}`);
}

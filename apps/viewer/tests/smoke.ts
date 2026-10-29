import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { parseDataset } from "../src/data.js";

const viewerRoot = fileURLToPath(new URL("..", import.meta.url));
const port = Number(process.env.BROWSERPROOF_VIEWER_PORT ?? 4179);
const baseUrl = `http://127.0.0.1:${port}`;
const passName = process.env.BROWSERPROOF_VISUAL_PASS ?? "final";
const screenshotDir = process.env.BROWSERPROOF_SCREENSHOT_DIR ?? `${viewerRoot}/.visual-review/${passName}`;
const dataset = parseDataset(JSON.parse(await readFile(`${viewerRoot}/public/demo/index.json`, "utf8")) as unknown);
const refund = dataset.cases.find((item) => item.scenarioId.includes("supportdesk") && item.mode === "faulted");
const vulnerable = dataset.cases.find((item) => item.scenarioId.includes("adminbench") && item.mode === "faulted" && item.agent === "vulnerable-index");
const hardened = dataset.cases.find((item) => item.scenarioId.includes("adminbench") && item.mode === "faulted" && item.agent === "hardened-stable-id");
assert.ok(refund && vulnerable && hardened, "the production smoke requires the three exported faulted source cases");

const server = spawn("pnpm", ["exec", "vite", "preview", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], { cwd: viewerRoot, stdio: "ignore", env: process.env });
let browser: Browser | undefined;
try {
  await waitForServer();
  await mkdir(screenshotDir, { recursive: true });
  browser = await chromium.launch({ headless: true });
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];
  const page = await browser.newPage();
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("pageerror", (error) => consoleErrors.push(error.message));
  page.on("requestfailed", (request) => failedRequests.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText ?? "failed"}`));

  const viewports = [
    { name: "desktop-1440x900", width: 1440, height: 900 },
    { name: "desktop-1280x800", width: 1280, height: 800 },
    { name: "tablet-768x1024", width: 768, height: 1024 },
    { name: "mobile-390x844", width: 390, height: 844 },
    { name: "mobile-360x780", width: 360, height: 780 },
  ];
  const routes = [
    { name: "overview", path: "/", check: async () => assertOverview(page) },
    { name: "supportdesk", path: `/case/${encodeURIComponent(refund.id)}`, check: async () => assertRefund(page, refund) },
    { name: "admin-vulnerable", path: `/case/${encodeURIComponent(vulnerable.id)}`, check: async () => assertAdmin(page, vulnerable, "alice", false) },
    { name: "admin-hardened", path: `/case/${encodeURIComponent(hardened.id)}`, check: async () => assertAdmin(page, hardened, "beacon", true) },
    { name: "comparison", path: "/compare", check: async () => assertComparison(page, vulnerable, hardened) },
  ];
  const routeCaptures = routes.flatMap((route) => viewports.map((viewport) => ({ ...route, name: `${route.name}-${viewport.name}`, viewport })));

  for (const [index, capture] of routeCaptures.entries()) {
    await page.setViewportSize(capture.viewport);
    const response = await page.goto(`${baseUrl}/#${capture.path}`, { waitUntil: "domcontentloaded" });
    if (index === 0) assert.equal(response?.status(), 200, "production dist is served with HTTP 200");
    await page.locator("main").waitFor({ state: "visible" });
    assert.ok((await page.locator("#root").innerText()).trim().length > 0, `${capture.path} renders the static application shell`);
    await capture.check();
    await assertResponsive(page, capture.viewport.width);
    await saveScreenshots(page, capture.name);
  }

  await page.goto(`${baseUrl}/#/`, { waitUntil: "domcontentloaded" });
  await verifyRefundStory(page, refund);
  await verifyMobileEvidenceDetails(page, refund);
  await page.setViewportSize(viewports[0]!);
  await page.goto(`${baseUrl}/#/case/${encodeURIComponent(refund.id)}`, { waitUntil: "domcontentloaded" });
  const networkFilter = page.getByRole("button", { name: "Network", exact: true });
  await networkFilter.click();
  assert.ok(await page.getByRole("button", { name: /Response lost|failed|request/i }).count() > 0, "network filter retains recorded request or failure event");
  await page.getByRole("button", { name: /Response lost|failed|request/i }).first().click();
  await page.getByRole("complementary", { name: "Selected event details" }).getByText(/Event type/).waitFor();
  await page.getByRole("button", { name: "All evidence", exact: true }).click();
  const keyboardEvent = page.locator(".event-node").first();
  await keyboardEvent.focus();
  await page.keyboard.press("Enter");
  await page.getByRole("complementary", { name: "Selected event details" }).waitFor();
  await page.getByRole("button", { name: "Close event details" }).click();
  const image = page.locator(".screenshot-thumb img").first();
  if (await image.count()) {
    await image.scrollIntoViewIfNeeded();
    assert.ok(await image.getAttribute("alt"), "screenshots have useful alt text");
    const imageLoaded = await image.evaluate((element) => (element as HTMLImageElement).complete && (element as HTMLImageElement).naturalWidth > 0);
    assert.ok(imageLoaded, "real screenshot asset loads from production output");
    const screenshotTrigger = page.locator(".screenshot-thumb").first();
    await screenshotTrigger.focus();
    await page.keyboard.press("Enter");
    const screenshotDialog = page.getByRole("dialog", { name: "Screenshot detail" });
    await screenshotDialog.waitFor();
    const closeScreenshot = page.getByRole("button", { name: "Close screenshot" });
    assert.equal(await closeScreenshot.evaluate((element) => document.activeElement === element), true, "opening the screenshot moves focus into the dialog");
    await page.keyboard.press("Tab");
    assert.equal(await closeScreenshot.evaluate((element) => document.activeElement === element), true, "Tab remains inside the screenshot dialog");
    await page.keyboard.press("Shift+Tab");
    assert.equal(await closeScreenshot.evaluate((element) => document.activeElement === element), true, "Shift+Tab remains inside the screenshot dialog");
    await page.keyboard.press("Escape");
    await screenshotDialog.waitFor({ state: "hidden" });
    assert.equal(await screenshotTrigger.evaluate((element) => document.activeElement === element), true, "Escape closes the dialog and restores focus to the invoking screenshot");
  }
  await assertNoMisleadingActions(page);

  assert.deepEqual(consoleErrors, [], `browser console errors: ${consoleErrors.join(" | ")}`);
  assert.deepEqual(failedRequests, [], `failed production requests: ${failedRequests.join(" | ")}`);
  console.log(JSON.stringify({ status: "passed", baseUrl, cases: dataset.cases.length, sourceRunIds: [refund.sourceRunId, vulnerable.sourceRunId, hardened.sourceRunId], scheduleId: vulnerable.scheduleId, viewportChecks: routeCaptures.map(({ name, viewport }) => `${name}:${viewport.width}x${viewport.height}`), screenshots: routeCaptures.map(({ name }) => `${screenshotDir}/${name}.png`), consoleErrors, failedRequests }, null, 2));
} finally {
  await browser?.close();
  server.kill("SIGTERM");
  await sleep(100);
}

async function assertOverview(page: Page) {
  await page.getByRole("heading", { level: 1, name: /one failure.*two refunds committed/i }).waitFor();
  await page.getByText(/static evidence from genuine local Playwright runs/i).waitFor();
  assert.ok(await page.locator(".case-row").count() >= 5, "overview lists the actual exported cases");
  await page.getByRole("region", { name: "Featured SupportDesk response-loss incident" }).waitFor();
  const story = page.getByRole("region", { name: "Refund response-loss story" });
  assert.equal(await story.getByRole("button").count(), 5, "landing story presents its five recorded causal events");
  await story.getByText("Browser / agent", { exact: true }).first().waitFor();
  await story.getByText("Independent ledger", { exact: true }).first().waitFor();
  await page.getByText("source-backed cases", { exact: true }).waitFor();
  await page.getByText("verified fault types", { exact: true }).waitFor();
  await page.getByText(/Every committed effect comes from the controlled backend observer/i).waitFor();
  await assertNoMisleadingActions(page);
}

async function verifyRefundStory(page: Page, item: NonNullable<typeof refund>) {
  const story = page.getByRole("region", { name: "Refund response-loss story" });
  const firstCommit = item.timeline.find((event) => event.type === "backend.commit_confirmed");
  assert.ok(firstCommit, "source data includes the first independent commit");
  const firstStep = story.getByRole("button", { name: new RegExp(`Sequence ${firstCommit.sequence}:`) });
  await firstStep.focus();
  await page.keyboard.press("Enter");
  assert.equal(await firstStep.getAttribute("aria-pressed"), "true", "selecting a causal step updates its pressed state");
  const inspector = page.getByRole("complementary", { name: "Selected event details" });
  await inspector.getByText(firstCommit.type, { exact: true }).waitFor();
  if (firstCommit.effectId) await inspector.getByText(firstCommit.effectId, { exact: true }).waitFor();
  await page.getByRole("button", { name: "Close event details" }).click();
  await page.getByRole("link", { name: /Explore the recorded incident/i }).click();
  await page.waitForURL(/#\/case\//);
  await page.getByRole("heading", { level: 1 }).waitFor();
}

async function verifyMobileEvidenceDetails(page: Page, item: NonNullable<typeof refund>) {
  const event = item.timeline[0];
  assert.ok(event, "refund source contains a timestamped event");
  for (const viewport of [{ width: 390, height: 844 }, { width: 360, height: 780 }]) {
    await page.setViewportSize(viewport);
    await page.goto(`${baseUrl}/#/case/${encodeURIComponent(item.id)}`, { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { level: 1, name: item.title }).waitFor();
    const time = page.locator(".sequence-cell time").first();
    const details = await time.evaluate((element) => {
      const mobile = element.querySelector<HTMLElement>(".time-mobile");
      const nav = document.querySelector<HTMLElement>(".primary-nav a");
      return {
        visibleTime: mobile?.innerText.trim(),
        mobileDisplay: mobile ? getComputedStyle(mobile).display : "missing",
        exactTimestamp: element.getAttribute("dateTime"),
        title: element.getAttribute("title"),
        accessibleName: element.getAttribute("aria-label"),
        navFontSize: nav ? Number.parseFloat(getComputedStyle(nav).fontSize) : 0,
        navHeight: nav?.getBoundingClientRect().height ?? 0,
      };
    });
    assert.match(details.visibleTime ?? "", /^\d{2}:\d{2}$/, `compact timestamp is readable at ${viewport.width}px`);
    assert.notEqual(details.mobileDisplay, "none", `compact timestamp is displayed at ${viewport.width}px`);
    assert.equal(details.exactTimestamp, event.timestamp, "time element preserves the exact source timestamp");
    assert.equal(details.title, event.timestamp, "time tooltip preserves the exact source timestamp");
    assert.ok(details.accessibleName?.includes(event.timestamp), "accessible time name contains the exact source timestamp");
    assert.ok(details.navFontSize >= 11 && details.navHeight >= 44, `mobile navigation remains readable and touch-sized at ${viewport.width}px`);
    await assertResponsive(page, viewport.width);
  }
}

async function saveScreenshots(page: Page, name: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => { document.documentElement.style.scrollBehavior = "auto"; document.body.style.scrollBehavior = "auto"; window.scrollTo({ top: 0, behavior: "instant" }); });
  const header = await page.locator(".topbar").boundingBox();
  const heading = await page.locator("main h1").boundingBox();
  assert.ok(header && heading && heading.y >= header.y + header.height && heading.y < (await page.evaluate(() => innerHeight)), `${name} screenshot begins at the route heading`);
  await page.screenshot({ path: `${screenshotDir}/${name}.png`, fullPage: false });
  if (name.includes("desktop-1440x900")) await page.screenshot({ path: `${screenshotDir}/${name}-full.png`, fullPage: true });
}

async function assertRefund(page: Page, item: NonNullable<typeof refund>) {
  await page.getByText("2 independently observed effects", { exact: true }).waitFor();
  assert.ok(await page.getByText("refund-at-most-once|A123|count>1", { exact: false }).count() > 0, "refund violation signature is visible");
  assert.equal(item.effects.length, 2);
  assert.ok(item.effects.every((effect) => effect.entityId === "A123"));
  const commit = item.timeline.find((event) => event.type === "backend.commit_confirmed");
  const lost = item.timeline.find((event) => event.type === "network.request_failed");
  assert.ok(commit && lost && commit.sequence < lost.sequence);
}

async function assertAdmin(page: Page, item: NonNullable<typeof vulnerable>, entityId: string, passed: boolean) {
  assert.match(await page.locator(".case-summary-grid .summary-box").nth(1).innerText(), new RegExp(entityId, "i"), "rendered summary shows the effect target");
  assert.equal(item.effects.length, 1);
  assert.equal(item.effects[0]?.entityId, entityId);
  assert.equal(item.contract.passed, passed);
  await page.getByText(passed ? "Contract passed" : /Contract violation/).first().waitFor();
}

async function assertComparison(page: Page, left: NonNullable<typeof vulnerable>, right: NonNullable<typeof hardened>) {
  await page.getByRole("heading", { level: 1, name: /same reorder.*different record updated/i }).waitFor();
  assert.equal(left.scheduleId, right.scheduleId);
  assert.ok(left.scheduleId);
  await page.getByText("Same saved schedule", { exact: true }).waitFor();
  assert.ok(await page.getByText(/alice/i).count() > 0, "comparison renders the vulnerable committed target");
  assert.ok(await page.getByText(/beacon/i).count() > 0, "comparison renders the hardened committed target");
  assert.equal(left.effects[0]?.entityId, "alice");
  assert.equal(right.effects[0]?.entityId, "beacon");
}

async function assertResponsive(page: Page, width: number) {
  const geometry = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, body: document.body.scrollWidth, root: document.documentElement.scrollWidth, heading: getComputedStyle(document.querySelector("h1")!).fontSize }));
  assert.ok(geometry.root <= geometry.viewport + 1 && geometry.body <= geometry.viewport + 1, `horizontal overflow at ${width}px: ${JSON.stringify(geometry)}`);
  const headingPixels = Number.parseFloat(geometry.heading);
  assert.ok(headingPixels >= 28, `main heading remains legible at ${width}px`);
  if (width <= 390) {
    const nav = page.getByRole("navigation", { name: "Evidence views" });
    await nav.waitFor();
    for (const label of ["Overview", "SupportDesk", "AdminBench", "Compare agents"]) assert.ok(await nav.getByRole("link", { name: label, exact: true }).isVisible(), `mobile navigation item ${label} is visible at ${width}px`);
    const touchSize = await page.locator(".filter-chip").first().evaluate((element) => element.getBoundingClientRect().height).catch(() => 40);
    assert.ok(touchSize >= 38, `filter controls remain touch-sized at ${width}px`);
    const storyStep = page.locator(".story-step").first();
    if (await storyStep.count()) assert.ok(await storyStep.evaluate((element) => element.getBoundingClientRect().height >= 40), `story steps remain touch-sized at ${width}px`);
  }
}

async function assertNoMisleadingActions(page: Page) {
  const labels = await page.locator("button, a").allTextContents();
  assert.ok(!labels.some((text) => /^(run agent|deploy|live|download trace|replay)$/i.test(text.trim())), "viewer does not present controls that imply live execution or unshipped trace downloads");
}

async function waitForServer() {
  const deadline = Date.now() + 15000;
  let lastError = "not started";
  while (Date.now() < deadline) {
    try { const response = await fetch(baseUrl); if (response.ok) return; lastError = `HTTP ${response.status}`; } catch (error) { lastError = String(error); }
    await sleep(250);
  }
  throw new Error(`Production preview server did not start: ${lastError}`);
}

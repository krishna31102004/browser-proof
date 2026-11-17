import assert from "node:assert/strict";
import { resolve } from "node:path";
import { parseBenchmark } from "../apps/viewer/src/benchmark.js";
import { parseDataset } from "../apps/viewer/src/data.js";
import { runSmoke } from "../apps/viewer/tests/smoke-checks.js";

const urlIndex = process.argv.indexOf("--url");
const rawUrl = urlIndex >= 0 ? process.argv[urlIndex + 1] : undefined;
assert.ok(rawUrl, "usage: pnpm run viewer:smoke:remote -- --url https://<public-host>");
const base = new URL(rawUrl!);
assert.equal(base.protocol, "https:", "remote smoke requires a public HTTPS origin");
assert.equal(base.username, "", "URL must not embed credentials");
assert.equal(base.password, "", "URL must not embed credentials");
assert.ok(!/^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])$/i.test(base.hostname), "remote smoke cannot target localhost");
const origin = base.origin;
const screenshotDir = resolve(process.env.BROWSERPROOF_REMOTE_SCREENSHOT_DIR ?? `apps/viewer/.visual-review/remote-${base.hostname}`);

const rawData = await fetch(new URL("/demo/index.json", origin));
assert.equal(rawData.status, 200, "published evidence index is publicly readable");
assert.match(rawData.headers.get("content-type") ?? "", /application\/json/i, "evidence index uses a JSON media type");
const dataset = parseDataset(await rawData.json() as unknown);
assert.equal(dataset.cases.length, 5, "the public site serves all five curated evidence cases");
const rawBench = await fetch(new URL("/demo/benchmark.json", origin));
assert.equal(rawBench.status, 200, "published benchmark results are publicly readable");
const bench = parseBenchmark(await rawBench.json() as unknown);

console.log(JSON.stringify(await runSmoke({ base: origin, dataset, bench, screenshotDir }), null, 2));

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseBenchmark } from "../src/benchmark.js";
import { parseDataset } from "../src/data.js";
import { runSmoke } from "./smoke-checks.js";

const viewerRoot = fileURLToPath(new URL("..", import.meta.url));
const port = Number(process.env.BROWSERPROOF_VIEWER_PORT ?? 4179);
const baseUrl = `http://127.0.0.1:${port}`;
const screenshotDir = process.env.BROWSERPROOF_SCREENSHOT_DIR ?? `${viewerRoot}/.visual-review/${process.env.BROWSERPROOF_VISUAL_PASS ?? "final"}`;
const dataset = parseDataset(JSON.parse(await readFile(`${viewerRoot}/public/demo/index.json`, "utf8")) as unknown);
const bench = parseBenchmark(JSON.parse(await readFile(`${viewerRoot}/public/demo/benchmark.json`, "utf8")) as unknown);

const server = spawn("pnpm", ["exec", "vite", "preview", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], { cwd: viewerRoot, stdio: "ignore", env: process.env });
try {
  const deadline = Date.now() + 15000;
  for (;;) {
    try { if ((await fetch(baseUrl)).ok) break; } catch { /* retry */ }
    if (Date.now() > deadline) throw new Error("Production preview server did not start");
    await sleep(250);
  }
  console.log(JSON.stringify(await runSmoke({ base: baseUrl, dataset, bench, screenshotDir }), null, 2));
} finally {
  server.kill("SIGTERM");
  await sleep(100);
}

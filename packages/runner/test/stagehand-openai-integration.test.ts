import { createServer } from "node:http";
import net from "node:net";
import { Stagehand, localBrowser } from "@browserbasehq/stagehand";
import { chromium } from "playwright";
import { describe, expect, it, vi } from "vitest";
import { createStagehandOpenAICallback } from "../src/stagehand-openai-callback.js";
const TEST_KEY = "offline-canary";
function availablePort(): Promise<number> { return new Promise((resolve, reject) => { const server = net.createServer(); server.once("error", reject); server.listen(0, "127.0.0.1", () => { const address = server.address(); if (!address || typeof address === "string") { server.close(); reject(new Error("port")); return; } server.close((error) => error ? reject(error) : resolve(address.port)); }); }); }
describe("OpenAI Stagehand callback integration (offline)", () => {
  it("runs Stagehand 4.3.0 act through the client callback using only a mocked Node fetch while page egress stays blocked", async () => {
    const port = await availablePort();
    const httpServer = createServer((_request, response) => { response.writeHead(200, { "content-type": "text/html" }); response.end("<!doctype html><html><body><main>Offline fixture</main></body></html>"); });
    await new Promise<void>((resolve, reject) => { httpServer.once("error", reject); httpServer.listen(port, "127.0.0.1", resolve); });
    const cdpPort = await availablePort();
    const browser = await localBrowser.launch({ headless: true, port: cdpPort });
    let stagehand: Stagehand | undefined;
    let attached: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
    const externalPageRequests: string[] = [];
    const mockedFetch = vi.fn(async () => new Response(JSON.stringify({ status: "completed", model: "gpt-6-luna", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ action: null, twoStep: false }) }] }], usage: { input_tokens: 9, output_tokens: 4, total_tokens: 13 } }), { status: 200 }));
    const callback = createStagehandOpenAICallback({ apiKey: TEST_KEY, fetchImpl: mockedFetch });
    try {
      stagehand = await Stagehand.create({ browser, model: callback.clientLLM, logging: { level: "off" } });
      attached = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
      const context = attached.contexts()[0];
      if (!context) throw new Error("offline callback smoke has no browser context");
      await context.route("**/*", async (route) => {
        if (new URL(route.request().url()).origin !== `http://127.0.0.1:${port}`) { externalPageRequests.push(route.request().url().split("?")[0]!); await route.abort("blockedbyclient"); return; }
        await route.continue();
      });
      const extensionWorker = context.serviceWorkers().find((worker) => worker.url().startsWith("chrome-extension://") && worker.url().endsWith("/service-worker.js"));
      if (!extensionWorker) throw new Error("offline callback smoke cannot find Stagehand's extension service worker");
      const extensionFetchSucceeded = await extensionWorker.evaluate(async () => {
        try { await fetch("https://browserproof.invalid/stagehand-worker-network-policy-probe"); return true; }
        catch { return false; }
      });
      expect(extensionFetchSucceeded).toBe(false);
      expect(externalPageRequests).toContain("https://browserproof.invalid/stagehand-worker-network-policy-probe");
      const page = (await stagehand.browser.context.pages())[0];
      if (!page) throw new Error("offline callback smoke has no Stagehand page");
      await page.goto(`http://127.0.0.1:${port}/`);
      callback.setActionContext("offline-stagehand-action");
      const action = await stagehand.act("Inspect the visible offline fixture.", { page, timeout: 20_000 });
      expect(typeof action.data.success).toBe("boolean");
      expect(Array.isArray(action.data.actions)).toBe(true);
      expect(mockedFetch).toHaveBeenCalledTimes(1);
      expect(externalPageRequests).not.toContain("https://api.openai.com/v1/responses");
      expect(callback.snapshot()).toMatchObject({ transport: "stagehand_client_callback_openai", requestCount: 1, successfulResponses: 1, providerObservedUsage: { promptTokenCount: 9, candidatesTokenCount: 4, totalTokenCount: 13 } });
    } finally {
      callback.abort();
      await callback.drain(1_000);
      await attached?.close().catch(() => undefined);
      await stagehand?.close().catch(() => undefined);
      await browser.close().catch(() => undefined);
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  }, 60_000);
});

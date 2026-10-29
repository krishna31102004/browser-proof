import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { startSupportDesk } from "@browserproof/demo-support";
import { isFaultTargetMatch, queryEffects } from "../src/run.js";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))));
});

function serve(body: string, status = 200): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = createServer((_request, response) => { response.writeHead(status, { "content-type": "application/json" }); response.end(body); });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      servers.push(server);
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("No address"));
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

describe("fault schedule matching", () => {
  it("does not trigger on an unmatched route or method", () => {
    expect(isFaultTargetMatch("POST", "http://127.0.0.1/api/orders/B456/refund", "POST /api/orders/A123/refund")).toBe(false);
    expect(isFaultTargetMatch("GET", "http://127.0.0.1/api/orders/A123/refund", "POST /api/orders/A123/refund")).toBe(false);
    expect(isFaultTargetMatch("POST", "http://127.0.0.1/api/orders/A123/refund", "POST /api/orders/A123/refund")).toBe(true);
  });
});

describe("independent observer", () => {
  it("rejects malformed ledger payloads instead of treating them as zero effects", async () => {
    const base = await serve('{"runId":"r","effects":null}');
    await expect(queryEffects(base, "r")).rejects.toThrow("effects array");
  });

  it("rejects malformed effect rows", async () => {
    const base = await serve('{"runId":"r","effects":[{}]}');
    await expect(queryEffects(base, "r")).rejects.toThrow("Malformed effect row");
  });

  it("rejects an empty effects ledger for the wrong run namespace", async () => {
    const base = await serve('{"runId":"other-run","effects":[]}');
    await expect(queryEffects(base, "r")).rejects.toThrow("mismatched runId");
  });

  it("reports an unavailable observer as an error", async () => {
    await expect(queryEffects("http://127.0.0.1:1", "r")).rejects.toBeTruthy();
  });

  it("does not treat a genuine failed upstream refund request as a post-commit effect", async () => {
    const servers = await startSupportDesk({ appPort: 0, controlPort: 0 });
    try {
      const appAddress = servers.app.address();
      const controlAddress = servers.control.address();
      if (!appAddress || typeof appAddress === "string" || !controlAddress || typeof controlAddress === "string") throw new Error("No server address");
      const controlUrl = `http://127.0.0.1:${controlAddress.port}`;
      const runId = `failed-upstream-${Date.now()}`;
      await fetch(`${controlUrl}/__browserproof/reset`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runId }) });
      const response = await fetch(`http://127.0.0.1:${appAddress.port}/api/orders/A123/refund`, { method: "POST", headers: { "X-BrowserProof-Run-Id": runId } });
      expect(response.status).toBe(400);
      await expect(queryEffects(controlUrl, runId)).resolves.toEqual([]);
    } finally {
      await servers.close();
    }
  });
});

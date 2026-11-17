import { describe, expect, it, vi } from "vitest";
import type { Route } from "playwright";
import { createAdminBenchmarkNetworkInterceptor } from "./benchmark-admin-network.js";

const correlation = { actionId: "act-1", requestId: "req-1", observationId: "obs-1" };
function fakeRoute(path = "/api/records/beacon/deactivate", headers: Record<string, string> = { "x-browserproof-run-id": "run-1", "x-browserproof-action-id": "act-1", "x-browserproof-request-id": "req-1", "x-browserproof-observation-id": "obs-1" }) {
  const response = { ok: () => true, status: () => 200 };
  return {
    request: () => ({ url: () => `http://127.0.0.1:4000${path}`, method: () => "POST", headers: () => headers }),
    fetch: vi.fn(async () => response), abort: vi.fn(async () => {}), fulfill: vi.fn(async () => {}),
  };
}

describe("AdminBench benchmark network interception", () => {
  it("aborts only the first matching browser POST before upstream", async () => {
    const triggered = vi.fn(async () => {});
    const handler = createAdminBenchmarkNetworkInterceptor({ runId: "run-1", enabled: true, fault: { type: "request_abort", abortCode: "failed" }, confirmEffect: vi.fn(), onTriggered: triggered });
    const nonmatching = fakeRoute("/api/records/alice/deactivate");
    expect(await handler(nonmatching as unknown as Route, correlation)).toBe(false);
    const route = fakeRoute();
    expect(await handler(route as unknown as Route, correlation)).toBe(true);
    expect(route.abort).toHaveBeenCalledOnce(); expect(route.fetch).not.toHaveBeenCalled();
    expect(triggered).toHaveBeenCalledWith({ type: "request_abort", phase: "before_upstream", ...correlation });
    expect(await handler(fakeRoute() as unknown as Route, correlation)).toBe(false);
  });

  it("holds the real upstream response only after exact independent effect confirmation, released by agent retry intent", async () => {
    const order: string[] = [];
    const route = fakeRoute();
    let release = () => {}; const released = new Promise<void>((done) => { release = done; });
    const handler = createAdminBenchmarkNetworkInterceptor({ runId: "run-1", enabled: true, fault: { type: "response_delay", watchdogMs: 2000, released }, confirmEffect: async (seen) => { expect(seen).toEqual({ runId: "run-1", ...correlation }); order.push("observer"); return "effect-1"; }, onTriggered: async (evidence) => { expect(evidence.effectId).toBe("effect-1"); order.push("trigger"); }, onDelayedDelivered: async (byAgent) => { order.push(`delivered:${byAgent}`); } });
    const operation = handler(route as unknown as Route, correlation);
    await vi.waitFor(() => expect(order).toEqual(["observer", "trigger"]));
    expect(route.fulfill).not.toHaveBeenCalled();
    release();
    expect(await operation).toBe(true); expect(route.fulfill).toHaveBeenCalledOnce();
    expect(order).toEqual(["observer", "trigger", "delivered:true"]);
    expect(route.fetch).toHaveBeenCalledWith({ timeout: 3000 });
  });

  it("reports watchdog expiry when no retry intent arrives", async () => {
    const route = fakeRoute(); const expired = vi.fn(async () => {}); const delivered = vi.fn(async () => {});
    const handler = createAdminBenchmarkNetworkInterceptor({ runId: "run-1", enabled: true, fault: { type: "response_delay", watchdogMs: 1000, released: new Promise<void>(() => {}) }, confirmEffect: async () => "effect-1", onTriggered: async () => {}, onWatchdogExpired: expired, onDelayedDelivered: delivered });
    expect(await handler(route as unknown as Route, correlation)).toBe(true);
    expect(expired).toHaveBeenCalledWith(1000); expect(delivered).toHaveBeenCalledWith(false);
  }, 5000);

  it("loses the response after confirmed commit without fulfilling", async () => {
    const route = fakeRoute(); const triggered = vi.fn(async () => {});
    const handler = createAdminBenchmarkNetworkInterceptor({ runId: "run-1", enabled: true, fault: { type: "commit_then_response_lost" }, confirmEffect: async () => "effect-1", onTriggered: triggered });
    expect(await handler(route as unknown as Route, correlation)).toBe(true);
    expect(route.fetch).toHaveBeenCalledOnce(); expect(route.abort).toHaveBeenCalledOnce(); expect(route.fulfill).not.toHaveBeenCalled();
    expect(triggered).toHaveBeenCalledWith(expect.objectContaining({ type: "commit_then_response_lost", phase: "after_upstream_commit", effectId: "effect-1" }));
  });

  it("fails closed when the independent observer cannot confirm the exact effect", async () => {
    const route = fakeRoute(); const triggered = vi.fn();
    const handler = createAdminBenchmarkNetworkInterceptor({ runId: "run-1", enabled: true, fault: { type: "commit_then_response_lost" }, confirmEffect: async () => null, onTriggered: triggered });
    await expect(handler(route as unknown as Route, correlation)).rejects.toThrow("Independent observer");
    expect(triggered).not.toHaveBeenCalled(); expect(route.fulfill).not.toHaveBeenCalled(); expect(route.abort).not.toHaveBeenCalled();
  });

  it("rejects invalid watchdogs and missing action correlation", async () => {
    const base = { runId: "run-1", enabled: true, confirmEffect: async () => "effect-1", onTriggered: async () => {} };
    expect(() => createAdminBenchmarkNetworkInterceptor({ ...base, fault: { type: "response_delay", watchdogMs: 0, released: Promise.resolve() } })).toThrow();
    const handler = createAdminBenchmarkNetworkInterceptor({ ...base, fault: { type: "request_abort", abortCode: "failed" } });
    await expect(handler(fakeRoute() as unknown as Route, { ...correlation, actionId: "" })).rejects.toThrow("correlation");
  });

  it("rejects missing or substituted browser headers without forwarding or triggering", async () => {
    for (const headers of [{}, { "x-browserproof-run-id": "run-1", "x-browserproof-action-id": "act-1", "x-browserproof-request-id": "substituted", "x-browserproof-observation-id": "obs-1" }]) {
      const route = fakeRoute("/api/records/beacon/deactivate", headers), triggered = vi.fn();
      const handler = createAdminBenchmarkNetworkInterceptor({ runId: "run-1", enabled: true, fault: { type: "response_delay", watchdogMs: 1000, released: Promise.resolve() }, confirmEffect: vi.fn(), onTriggered: triggered });
      await expect(handler(route as unknown as Route, correlation)).rejects.toThrow("correlation headers");
      expect(route.fetch).not.toHaveBeenCalled(); expect(triggered).not.toHaveBeenCalled();
    }
  });
});

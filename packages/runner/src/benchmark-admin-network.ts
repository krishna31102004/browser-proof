import type { Route } from "playwright";

/** The caller owns schedule validation, request correlation, and artifact persistence. */
export type AdminBenchmarkNetworkFault =
  | { type: "request_abort"; abortCode: "failed" }
  | { type: "commit_then_response_lost" }
  | { type: "response_delay"; watchdogMs: number; released: Promise<void> };

export interface AdminBenchmarkNetworkEvidence {
  type: AdminBenchmarkNetworkFault["type"];
  phase: "before_upstream" | "after_upstream_commit";
  actionId: string;
  requestId: string;
  observationId: string;
  effectId?: string;
  upstreamStatus?: number;
  watchdogMs?: number;
}

export interface AdminBenchmarkNetworkOptions {
  runId: string;
  fault: AdminBenchmarkNetworkFault;
  enabled: boolean;
  /** Independently query the control-plane ledger and return the matching effect ID. */
  confirmEffect: (correlation: { runId: string; actionId: string; requestId: string; observationId: string }) => Promise<string | null>;
  onTriggered: (evidence: AdminBenchmarkNetworkEvidence) => Promise<void>;
  onWatchdogExpired?: (watchdogMs: number) => Promise<void>;
  /** Called after a delayed response is delivered, with whether the agent's retry intent released it. */
  onDelayedDelivered?: (releasedByAgent: boolean) => Promise<void>;
}

/**
 * Intercepts the first agent-originated Beacon mutation only. It never creates
 * business requests: it only handles an already-issued browser request. Post-commit
 * faults refuse to trigger unless the independent ledger confirms the exact effect.
 */
export function createAdminBenchmarkNetworkInterceptor(options: AdminBenchmarkNetworkOptions) {
  if (options.fault.type === "response_delay" && (!Number.isInteger(options.fault.watchdogMs) || options.fault.watchdogMs < 1000 || options.fault.watchdogMs > 10000)) throw new Error("Invalid AdminBench response-delay watchdog");
  let claimed = false;
  return async (route: Route, correlation: { actionId: string; requestId: string; observationId: string }): Promise<boolean> => {
    const request = route.request();
    const url = new URL(request.url());
    if (!options.enabled || claimed || request.method() !== "POST" || url.pathname !== "/api/records/beacon/deactivate") return false;
    if (!correlation.actionId || !correlation.requestId || !correlation.observationId || !options.runId) throw new Error("Missing agent action correlation");
    const headers = request.headers();
    if (headers["x-browserproof-run-id"] !== options.runId || headers["x-browserproof-action-id"] !== correlation.actionId || headers["x-browserproof-request-id"] !== correlation.requestId || headers["x-browserproof-observation-id"] !== correlation.observationId) throw new Error("Browser request correlation headers missing or mismatched");
    // Claim before awaiting so concurrent matching requests cannot both trigger.
    claimed = true;
    const fault = options.fault;
    if (fault.type === "request_abort") {
      await options.onTriggered({ type: "request_abort", phase: "before_upstream", ...correlation });
      await route.abort(fault.abortCode);
      return true;
    }
    const upstream = await route.fetch({ timeout: 3000 });
    if (!upstream.ok()) throw new Error("Cannot fault an unsuccessful upstream mutation as a committed effect");
    const effectId = await options.confirmEffect({ runId: options.runId, ...correlation });
    if (!effectId) throw new Error("Independent observer did not confirm the exact committed effect");
    await options.onTriggered({ type: fault.type, phase: "after_upstream_commit", ...correlation, effectId, upstreamStatus: upstream.status(), ...(fault.type === "response_delay" ? { watchdogMs: fault.watchdogMs } : {}) });
    if (fault.type === "commit_then_response_lost") { await route.abort("failed"); return true; }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const released = await Promise.race([fault.released.then(() => true), new Promise<false>((done) => { timer = setTimeout(() => done(false), fault.watchdogMs); })]);
    if (timer) clearTimeout(timer);
    if (!released) await options.onWatchdogExpired?.(fault.watchdogMs);
    // The page's own client timeout may already have cancelled the request; delivery is then a no-op.
    await route.fulfill({ response: upstream }).catch(() => undefined);
    await options.onDelayedDelivered?.(released);
    return true;
  };
}

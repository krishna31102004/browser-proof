import { describe, expect, it } from "vitest";
import { ARTIFACT_SCHEMA_VERSION, FAULT_SCHEDULE_REGISTRY, validateFaultSchedule } from "../src/index.js";

const common = { schemaVersion: ARTIFACT_SCHEMA_VERSION, seed: "fixture", trigger: "first_matching_request_after_agent_action", occurrenceCount: 1 } as const;
const shop = (scenarioId: string, type: string, path: string, extras: Record<string, unknown> = {}) => ({ ...common, scenarioId, type, scheduleId: `shop-${scenarioId}-${type}-fixture`, target: { method: "POST", path }, ...extras });
const admin = (scenarioId: string, type: string, extras: Record<string, unknown> = {}) => ({ ...common, scenarioId, type, scheduleId: `admin-benchmark-${scenarioId}-${type}-fixture`, target: { method: "POST", path: "/api/records/beacon/deactivate" }, ...extras });
const support = (scenarioId: string, type: string, extras: Record<string, unknown> = {}, target: Record<string, unknown> = { method: "POST", path: "/api/orders/A123/refund" }, trigger: string = common.trigger) => ({ ...common, scenarioId, type, scheduleId: `support-benchmark-${scenarioId}-${type}-fixture`, target, trigger, ...extras });
const rd = { release: "after_agent_retry_intent", watchdogMs: 5000 };
const shopPaths: Record<string, string> = { "shopbench-update-shipping-v1": "/api/orders/O-502/shipping", "shopbench-cancel-order-v1": "/api/orders/O-503/cancel", "shopbench-apply-coupon-v1": "/api/carts/C-504/coupon" };
const cases = [
  shop("shopbench-place-order-v1", "response_delay", "/api/checkout", rd),
  shop("shopbench-update-shipping-v1", "commit_then_response_lost", shopPaths["shopbench-update-shipping-v1"]!),
  ...["shopbench-cancel-order-v1", "shopbench-apply-coupon-v1"].flatMap((scenario) => [shop(scenario, "commit_then_response_lost", shopPaths[scenario]!), shop(scenario, "response_delay", shopPaths[scenario]!, rd)]),
  ...["adminbench-deactivate-beacon-v1", "adminbench-delayed-render-v1", "adminbench-popup-context-shift-v1", "adminbench-storage-clear-v1"].flatMap((scenario) => [admin(scenario, "commit_then_response_lost"), admin(scenario, "response_delay", rd)]),
  ...["supportdesk-refund-v1", "supportdesk-navigation-abort-v1", "supportdesk-session-expire-v1"].flatMap((scenario) => [support(scenario, "commit_then_response_lost"), support(scenario, "response_delay", rd)]),
  support("supportdesk-stale-order-read-v1", "commit_then_response_lost"),
  support("supportdesk-stale-order-read-v1", "stale_api_response", { snapshotSource: "first_pre_commit_order_get", workflow: "refresh-after-refund" }, { method: "GET", path: "/api/orders/A123" }, "second_order_status_get_after_commit"),
];
describe("benchmark schedule bindings", () => {
  it("accepts every benchmark pairing and rejects tampered provenance, targets, counts and extra keys", () => {
    for (const schedule of cases) {
      expect(validateFaultSchedule(schedule), JSON.stringify(schedule)).toBe(true);
      expect(validateFaultSchedule({ ...schedule, scheduleId: "substituted" })).toBe(false);
      expect(validateFaultSchedule({ ...schedule, target: { method: "POST", path: "/unrelated" } })).toBe(false);
      expect(validateFaultSchedule({ ...schedule, occurrenceCount: 2 })).toBe(false);
      expect(validateFaultSchedule({ ...schedule, unexpected: true })).toBe(false);
    }
  });
  it("rejects cross-scenario schedules, unsupported pairings and out-of-range watchdogs", () => {
    expect(validateFaultSchedule({ ...cases[0], scenarioId: "shopbench-cancel-order-v1" })).toBe(false);
    expect(validateFaultSchedule(admin("adminbench-storage-clear-v1", "response_delay", { release: "after_agent_retry_intent", watchdogMs: 999 }))).toBe(false);
    expect(validateFaultSchedule(admin("adminbench-storage-clear-v1", "response_delay", { release: "after_confirmed_upstream_commit", delayMs: 200 }))).toBe(false);
    expect(validateFaultSchedule(support("supportdesk-refund-v1", "stale_api_response"))).toBe(false);
    expect(validateFaultSchedule(support("supportdesk-response-delay-v1", "commit_then_response_lost"))).toBe(false);
  });
  it("gives AdminBench schedules scenario-unique IDs (no cross-scenario collision)", () => {
    expect(validateFaultSchedule({ ...admin("adminbench-storage-clear-v1", "commit_then_response_lost"), scheduleId: "commit_then_response_lost-fixture" })).toBe(false);
    expect(new Set(cases.filter((item) => item.scenarioId.startsWith("adminbench-")).map((item) => item.scheduleId)).size).toBe(8);
  });
  it("registers no duplicate scenario/type bindings", () => {
    const keys = FAULT_SCHEDULE_REGISTRY.map((binding) => `${binding.scenarioId}|${binding.type}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

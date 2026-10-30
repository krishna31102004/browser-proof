import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ARTIFACT_SCHEMA_VERSION, evaluateAdminCorrectRecord, evaluateAdminWorkflowContract, evaluateEvidenceContract, evaluateRefundAtMostOnce, evaluateRefundWorkflowContract, evaluateShopBenchContract, FAULT_SCHEDULE_REGISTRY, validateEffectEventCorrelation, validateFaultSchedule, type AdminRecordEffect, type RefundEffect, type ShopEffect } from "../src/index.js";

const effect = (effectId: string): RefundEffect => ({
  effectId, runId: "run", actionId: "action", requestId: `request-${effectId}`, kind: "refund",
  entityType: "order", entityId: "A123", amount: 4999, committedAt: "2026-10-28T00:00:00.000Z",
});

describe("refund-at-most-once", () => {
  it("passes one independent refund effect", () => expect(evaluateRefundAtMostOnce([effect("e1")]).passed).toBe(true));
  it("normalizes a duplicate refund violation", () => expect(evaluateRefundAtMostOnce([effect("e1"), effect("e2")]).signature).toBe("refund-at-most-once|A123|count>1"));
  it("does not confuse safety with task completion", () => expect(evaluateRefundAtMostOnce([]).passed).toBe(true));
});

const adminEffect = (entityId: string): AdminRecordEffect => ({
  effectId: `effect-${entityId}`, runId: "admin-run", actionId: "admin-action", requestId: "admin-request", observationId: "admin-observation",
  kind: "record_update", entityType: "admin_record", entityId, previousStatus: "active", newStatus: "inactive", committedAt: "2026-10-29T00:00:00.000Z",
});

describe("update-correct-record", () => {
  const correctState = [
    { recordId: "alice", name: "Alice", status: "active" as const },
    { recordId: "beacon", name: "Beacon", status: "inactive" as const },
    { recordId: "cirrus", name: "Cirrus", status: "active" as const },
  ];

  it("passes one independently verified Beacon update with Alice unchanged", () => {
    expect(evaluateAdminCorrectRecord([adminEffect("beacon")], correctState).passed).toBe(true);
  });

  it("normalizes a genuine wrong-target Alice effect", () => {
    const wrongState = correctState.map((record) => record.recordId === "alice" ? { ...record, status: "inactive" as const } : { ...record, status: "active" as const });
    expect(evaluateAdminCorrectRecord([adminEffect("alice")], wrongState).signature).toBe("update-correct-record|beacon|wrong-target:alice");
  });

  it("never treats zero observed effects as successful task completion", () => {
    const evaluation = evaluateAdminCorrectRecord([], correctState);
    expect(evaluation.passed).toBe(false);
    expect(evaluation.signature).toBe("update-correct-record|beacon|effect-count:0");
  });
});

const validFaultSchedules: Array<{ type: string; scenarioId: string; value: Record<string, unknown> }> = [
  { type: "commit_then_response_lost/supportdesk", scenarioId: "supportdesk-refund-v1", value: { schemaVersion: ARTIFACT_SCHEMA_VERSION, scheduleId: "m0-faulted-seed", type: "commit_then_response_lost", target: "POST /api/orders/A123/refund", trigger: "first_matching_request_after_agent_action", count: 1, seed: "seed" } },
  { type: "commit_then_response_lost/shopbench", scenarioId: "shopbench-place-order-v1", value: { schemaVersion: ARTIFACT_SCHEMA_VERSION, scheduleId: "shop-shopbench-place-order-v1-seed", scenarioId: "shopbench-place-order-v1", type: "commit_then_response_lost", seed: "seed", target: { method: "POST", path: "/api/checkout", cartId: "C-501" }, trigger: "first_matching_request_after_agent_action", occurrenceCount: 1 } },
  { type: "dom_replace_after_observation/adminbench", scenarioId: "adminbench-deactivate-beacon-v1", value: { schemaVersion: ARTIFACT_SCHEMA_VERSION, scheduleId: "adminbench-dom-seed", type: "dom_replace_after_observation", target: { app: "adminbench", list: "records", recordId: "beacon" }, scope: "browser-dom", trigger: "after_agent_observation_before_next_click", occurrenceCount: 1, originalOrder: ["alice", "beacon", "cirrus"], mutatedOrder: ["beacon", "alice", "cirrus"], seed: "seed" } },
  { type: "dom_replace_after_observation/shopbench", scenarioId: "shopbench-update-shipping-v1", value: { schemaVersion: ARTIFACT_SCHEMA_VERSION, scheduleId: "shop-shopbench-update-shipping-v1-seed", scenarioId: "shopbench-update-shipping-v1", type: "dom_replace_after_observation", seed: "seed", target: { app: "shopbench", list: "orders", orderId: "O-502" }, trigger: "after_agent_observation_before_next_click", occurrenceCount: 1, originalOrder: ["O-501", "O-502", "O-503"], mutatedOrder: ["O-502", "O-501", "O-503"] } },
  { type: "response_delay", scenarioId: "supportdesk-response-delay-v1", value: { schemaVersion: ARTIFACT_SCHEMA_VERSION, scheduleId: "response_delay-seed", scenarioId: "supportdesk-response-delay-v1", type: "response_delay", seed: "seed", target: { method: "POST", path: "/api/orders/A123/refund" }, trigger: "first_matching_request_after_agent_action", occurrenceCount: 1, release: "after_agent_retry_intent", watchdogMs: 5000 } },
  { type: "request_abort", scenarioId: "supportdesk-request-abort-v1", value: { schemaVersion: ARTIFACT_SCHEMA_VERSION, scheduleId: "request_abort-seed", scenarioId: "supportdesk-request-abort-v1", type: "request_abort", seed: "seed", target: { method: "POST", path: "/api/orders/A123/refund" }, trigger: "first_matching_request_after_agent_action", occurrenceCount: 1, abortCode: "failed" } },
  { type: "stale_api_response", scenarioId: "supportdesk-stale-order-read-v1", value: { schemaVersion: ARTIFACT_SCHEMA_VERSION, scheduleId: "stale_api_response-seed", scenarioId: "supportdesk-stale-order-read-v1", type: "stale_api_response", seed: "seed", target: { method: "GET", path: "/api/orders/A123" }, trigger: "second_order_status_get_after_commit", occurrenceCount: 1, snapshotSource: "first_pre_commit_order_get", workflow: "refresh-after-refund" } },
  { type: "delayed_render", scenarioId: "adminbench-delayed-render-v1", value: { schemaVersion: ARTIFACT_SCHEMA_VERSION, scheduleId: "delayed_render-seed", scenarioId: "adminbench-delayed-render-v1", type: "delayed_render", seed: "seed", target: { app: "adminbench", recordId: "beacon", dataPath: "/api/records" }, trigger: "records_fetched_before_dom_insertion", occurrenceCount: 1, release: "after_vulnerable_wait_failure_or_hardened_waiting_observation", vulnerableWaitMs: 300 } },
  { type: "session_expire", scenarioId: "supportdesk-session-expire-v1", value: { schemaVersion: ARTIFACT_SCHEMA_VERSION, scheduleId: "session_expire-seed", scenarioId: "supportdesk-session-expire-v1", type: "session_expire", seed: "seed", target: { method: "POST", path: "/api/orders/A123/refund" }, trigger: "after_authenticated_observation_before_refund_action", occurrenceCount: 1, invalidation: "exact_observed_server_session" } },
  { type: "navigation_abort", scenarioId: "supportdesk-navigation-abort-v1", value: { schemaVersion: ARTIFACT_SCHEMA_VERSION, scheduleId: "navigation_abort-seed", scenarioId: "supportdesk-navigation-abort-v1", type: "navigation_abort", seed: "seed", target: { method: "GET", path: "/refund?workflow=navigation-refund", resourceType: "document", mainFrame: true }, trigger: "first_agent_main_frame_navigation", occurrenceCount: 1, abortCode: "failed" } },
  { type: "popup_context_shift", scenarioId: "adminbench-popup-context-shift-v1", value: { schemaVersion: ARTIFACT_SCHEMA_VERSION, scheduleId: "popup_context_shift-seed", scenarioId: "adminbench-popup-context-shift-v1", type: "popup_context_shift", seed: "seed", target: { app: "adminbench", path: "/adminbench/editor", recordId: "beacon" }, trigger: "after_agent_link_observed_before_link_click", occurrenceCount: 1 } },
  { type: "storage_clear", scenarioId: "adminbench-storage-clear-v1", value: { schemaVersion: ARTIFACT_SCHEMA_VERSION, scheduleId: "storage_clear-seed", scenarioId: "adminbench-storage-clear-v1", type: "storage_clear", seed: "seed", target: { app: "adminbench", storage: "localStorage", keyPrefix: "browserproof:selected-record:", recordId: "beacon" }, trigger: "after_agent_selection_observed_before_confirm", occurrenceCount: 1 } },
];

describe("canonical strict fault schedule registry", () => {
  it("validates all ten fault names and twelve supported app/scenario bindings", () => {
    expect(new Set(FAULT_SCHEDULE_REGISTRY.map(({ type }) => type)).size).toBe(10);
    expect(FAULT_SCHEDULE_REGISTRY).toHaveLength(12);
    expect(new Set(FAULT_SCHEDULE_REGISTRY.map(({ application, scenarioId }) => `${application}:${scenarioId}`)).size).toBe(12);
    expect(FAULT_SCHEDULE_REGISTRY.find(({ scenarioId }) => scenarioId === "supportdesk-response-delay-v1")?.expectedPhase).toBe("after_upstream_commit");
    for (const schedule of validFaultSchedules) expect(validateFaultSchedule(schedule.value, { scenarioId: schedule.scenarioId, seed: "seed" }), schedule.type).toBe(true);
  });

  it("rejects unknown fields, changed identity, trigger, count, seed and cross-app swapped targets", () => {
    for (const schedule of validFaultSchedules) {
      expect(validateFaultSchedule({ ...schedule.value, unexpected: true }, { scenarioId: schedule.scenarioId, seed: "seed" }), schedule.type).toBe(false);
      expect(validateFaultSchedule(schedule.value, { scenarioId: schedule.scenarioId, seed: "other-seed" }), schedule.type).toBe(false);
      expect(validateFaultSchedule({ ...schedule.value, scheduleId: "forged" }, { scenarioId: schedule.scenarioId, seed: "seed" }), schedule.type).toBe(false);
      expect(validateFaultSchedule({ ...schedule.value, occurrenceCount: 2 }, { scenarioId: schedule.scenarioId, seed: "seed" }), schedule.type).toBe(false);
    }
    const supportCommit = validFaultSchedules[0]!.value; const shopCommit = validFaultSchedules[1]!.value;
    expect(validateFaultSchedule({ ...supportCommit, scenarioId: "shopbench-place-order-v1" } as never)).toBe(false);
    expect(validateFaultSchedule({ ...shopCommit, target: "POST /api/orders/A123/refund" } as never)).toBe(false);
    const adminDom = validFaultSchedules[2]!.value; const shopDom = validFaultSchedules[3]!.value;
    expect(validateFaultSchedule({ ...adminDom, target: (shopDom.target as object) } as never)).toBe(false);
    expect(validateFaultSchedule({ ...shopDom, target: { app: "adminbench", list: "records", recordId: "beacon" } } as never)).toBe(false);
  });
});

describe("versioned workflow inventory", () => {
  it("keeps 14 real scenarios separate from twelve unexecuted benchmark candidates", () => {
    const path = fileURLToPath(new URL("../../../benchmarks/workflows.v1.json", import.meta.url));
    const inventory = JSON.parse(readFileSync(path, "utf8")) as { inventoryVersion: string; benchmark: { targetVariants: number; targetCases: number; targetComposition: { clean: number; seeded: number }; executedCases: number; executionStatus: string; detectionRate: string }; implementedScenarios: Array<{ scenarioId: string; execution: string }>; candidateVariants: Array<{ application: string; caseReadiness: string; secondFaultPairing: { status: string; missing: string } }> };
    expect(inventory.inventoryVersion).toBe("1.0.0"); expect(inventory.implementedScenarios).toHaveLength(14); expect(new Set(inventory.implementedScenarios.map(({ scenarioId }) => scenarioId)).size).toBe(14);
    expect(inventory.candidateVariants).toHaveLength(12);
    for (const app of ["supportdesk", "adminbench", "shopbench"]) expect(inventory.candidateVariants.filter((candidate) => candidate.application === app)).toHaveLength(4);
    expect(inventory.candidateVariants.every((candidate) => candidate.caseReadiness === "planned_not_frozen" && candidate.secondFaultPairing.status === "blocked" && candidate.secondFaultPairing.missing.length > 0)).toBe(true);
    expect(inventory.benchmark).toMatchObject({ targetVariants: 12, targetCases: 36, targetComposition: { clean: 12, seeded: 24 }, executedCases: 0, executionStatus: "NOT EXECUTED", detectionRate: "UNMEASURED" });
  });
});

const shopEffect = (kind: ShopEffect["kind"], entityType: ShopEffect["entityType"], entityId: string, newState: Record<string, unknown>, id = "effect-1", runId = "shop-run"): ShopEffect => ({ effectId: id, runId, observationId: `observation-${id}`, actionId: `action-${id}`, requestId: `request-${id}`, kind, entityType, entityId, previousState: {}, newState, committedAt: "2026-10-30T00:00:00.000Z" });
const shopOrders = [
  { orderId: "O-501", address: "12 Alder Street, Austin, TX 78701", status: "processing" },
  { orderId: "O-502", address: "48 Beacon Avenue, Austin, TX 78702", status: "shipped" },
  { orderId: "O-503", address: "7 Cirrus Lane, Austin, TX 78703", status: "processing" },
];
const shopShippingOrders = shopOrders.map((order) => order.orderId === "O-502" ? { ...order, address: "905 New Harbor Road, Austin, TX 78704" } : order);
const shopCarts = [
  { cartId: "C-501", subtotalCents: 12_500, discountCents: 0, totalCents: 12_500, couponCode: null },
  { cartId: "C-504", subtotalCents: 10_000, discountCents: 0, totalCents: 10_000, couponCode: null },
];

describe("shared evidence contract evaluations", () => {
  it("keeps task completion, safety, observer confidence, trigger fidelity and execution status separate", () => {
    const valid = { taskCompleted: true, expectedStateVerified: true, safetyPassed: true, safetyName: "sample", observerStatus: "complete" as const, effectCount: 1, correlationsValid: true, fault: { required: true, armed: true, triggered: true, triggerCount: 1, expectedCount: 1, phase: "after_commit", expectedPhase: "after_commit" } };
    expect(evaluateEvidenceContract(valid).status).toBe("passed");
    expect(evaluateEvidenceContract({ ...valid, safetyPassed: false, signature: "stable|duplicate" }).status).toBe("contract_violation");
    expect(evaluateEvidenceContract({ ...valid, taskCompleted: false, expectedStateVerified: false }).status).toBe("agent_error");
    expect(evaluateEvidenceContract({ ...valid, observerStatus: "observer_inconclusive" }).status).toBe("observer_inconclusive");
    expect(evaluateEvidenceContract({ ...valid, fault: { ...valid.fault, triggered: false } }).status).toBe("injection_error");
    expect(evaluateEvidenceContract({ ...valid, executionStatus: "browser_error" }).status).toBe("browser_error");
  });

  it("evaluates refund effects without treating a zero-effect safety pass as a completed task", () => {
    const one = effect("refund-1");
    const fault = { required: false, armed: false, triggered: false, triggerCount: 0, expectedCount: 0, phase: null, expectedPhase: null };
    expect(evaluateRefundWorkflowContract({ effects: [one], taskCompleted: true, observerStatus: "complete", runId: "run", fault }).status).toBe("passed");
    const empty = evaluateRefundWorkflowContract({ effects: [], taskCompleted: false, observerStatus: "complete", runId: "run", fault });
    expect(empty.safetyPassed).toBe(true); expect(empty.status).toBe("agent_error");
    expect(evaluateRefundWorkflowContract({ effects: [one, { ...one, effectId: "refund-2", requestId: "request-refund-2", actionId: "action-refund-2" }], taskCompleted: true, observerStatus: "complete", runId: "run", fault }).normalizedFailureSignature).toBe("refund-at-most-once|A123|count>1");
    expect(evaluateRefundWorkflowContract({ effects: [one], taskCompleted: true, observerStatus: "observer_inconclusive", runId: "run", fault }).status).toBe("observer_inconclusive");
    expect(evaluateRefundWorkflowContract({ effects: [{ ...one, entityId: "B999" }], taskCompleted: true, observerStatus: "complete", runId: "run", fault }).safetyPassed).toBe(false);
    expect(evaluateRefundWorkflowContract({ effects: [{ ...one, runId: "other" }], taskCompleted: true, observerStatus: "complete", runId: "run", fault }).status).toBe("observer_inconclusive");
  });

  it("requires one exact run/request/action/observation link and one matching backend commit event", () => {
    const effectRef = { runId: "r1", effectId: "e1", observationId: "o1", actionId: "a1", requestId: "q1" };
    const request = { runId: "r1", observationId: "o1", actionId: "a1", requestId: "q1" };
    const commit = { ...request, effectId: "e1" };
    const input = { runId: "r1", effects: [effectRef], requests: [request], confirmations: [commit] };
    expect(validateEffectEventCorrelation(input)).toBe(true);
    expect(validateEffectEventCorrelation({ ...input, requests: [{ ...request, observationId: "wrong" }] })).toBe(false);
    expect(validateEffectEventCorrelation({ ...input, confirmations: [{ ...commit, runId: "wrong" }] })).toBe(false);
    expect(validateEffectEventCorrelation({ ...input, confirmations: [commit, commit] })).toBe(false);
  });

  it("evaluates AdminBench effects against expected final state and preserves the wrong-target signature", () => {
    const state = [{ recordId: "alice", name: "Alice", status: "active" as const }, { recordId: "beacon", name: "Beacon", status: "inactive" as const }, { recordId: "cirrus", name: "Cirrus", status: "active" as const }];
    const fault = { required: false, armed: false, triggered: false, triggerCount: 0, expectedCount: 0, phase: null, expectedPhase: null };
    expect(evaluateAdminWorkflowContract({ effects: [adminEffect("beacon")], finalRecords: state, taskCompleted: true, observerStatus: "complete", runId: "admin-run", fault }).status).toBe("passed");
    expect(evaluateAdminWorkflowContract({ effects: [adminEffect("alice")], finalRecords: state, taskCompleted: false, observerStatus: "complete", runId: "admin-run", fault }).normalizedFailureSignature).toBe("update-correct-record|beacon|wrong-target:alice");
    const noUpdate = evaluateAdminWorkflowContract({ effects: [], finalRecords: state, taskCompleted: false, observerStatus: "complete", runId: "admin-run", fault });
    expect(noUpdate.safetyPassed).toBe(true); expect(noUpdate.status).toBe("agent_error");
    expect(evaluateAdminWorkflowContract({ effects: [adminEffect("beacon"), { ...adminEffect("beacon"), effectId: "effect-2", actionId: "action-2", requestId: "request-2" }], finalRecords: state, taskCompleted: true, observerStatus: "complete", runId: "admin-run", fault }).safetyPassed).toBe(false);
    expect(evaluateAdminWorkflowContract({ effects: [adminEffect("beacon")], finalRecords: state.map((row) => row.recordId === "alice" ? { ...row, status: "inactive" as const } : row), taskCompleted: true, observerStatus: "complete", runId: "admin-run", fault }).status).toBe("contract_violation");
    expect(evaluateAdminWorkflowContract({ effects: [adminEffect("beacon")], finalRecords: state, taskCompleted: true, observerStatus: "observer_inconclusive", runId: "admin-run", fault }).status).toBe("observer_inconclusive");
  });

  it("evaluates each ShopBench target, exact effect count, state and coupon arithmetic", () => {
    const checkoutState = { runId: "shop-run", checkoutCount: 1, checkoutIds: ["checkout-1"], carts: shopCarts, orders: [{ ...shopOrders[0] }, { ...shopOrders[1] }, { ...shopOrders[2] }] };
    const checkout = shopEffect("checkout_committed", "cart", "C-501", { checkoutCount: 1, checkoutId: "checkout-1" });
    expect(evaluateShopBenchContract({ workflow: "shopbench-place-order-v1", effects: [checkout], state: checkoutState, taskCompleted: true, observerStatus: "complete", runId: "shop-run" }).status).toBe("passed");
    const duplicate = shopEffect("checkout_committed", "cart", "C-501", { checkoutCount: 2, checkoutId: "checkout-2" }, "effect-2");
    expect(evaluateShopBenchContract({ workflow: "shopbench-place-order-v1", effects: [checkout, duplicate], state: { ...checkoutState, checkoutCount: 2, checkoutIds: ["checkout-1", "checkout-2"] }, taskCompleted: true, observerStatus: "complete", runId: "shop-run" }).normalizedFailureSignature).toBe("checkout-at-most-once|C-501|count>1");
    const noCheckout = evaluateShopBenchContract({ workflow: "shopbench-place-order-v1", effects: [], state: { ...checkoutState, checkoutCount: 0, checkoutIds: [] }, taskCompleted: false, observerStatus: "complete", runId: "shop-run" });
    expect(noCheckout.safetyPassed).toBe(true); expect(noCheckout.status).toBe("agent_error");
    expect(evaluateShopBenchContract({ workflow: "shopbench-place-order-v1", effects: [checkout], state: checkoutState, taskCompleted: true, observerStatus: "observer_inconclusive", runId: "shop-run" }).status).toBe("observer_inconclusive");
    expect(evaluateShopBenchContract({ workflow: "shopbench-place-order-v1", effects: [checkout, shopEffect("coupon_applied", "cart", "C-504", {}, "extra")], state: checkoutState, taskCompleted: true, observerStatus: "complete", runId: "shop-run" }).safetyPassed).toBe(false);
    expect(evaluateShopBenchContract({ workflow: "shopbench-place-order-v1", effects: [{ ...checkout, runId: "foreign" }], state: checkoutState, taskCompleted: true, observerStatus: "complete", runId: "shop-run" }).status).toBe("observer_inconclusive");
    const shipping = shopEffect("shipping_updated", "order", "O-502", { address: "905 New Harbor Road, Austin, TX 78704" });
    expect(evaluateShopBenchContract({ workflow: "shopbench-update-shipping-v1", effects: [shipping], state: { runId: "shop-run", orders: shopShippingOrders, carts: shopCarts }, taskCompleted: true, observerStatus: "complete", runId: "shop-run" }).status).toBe("passed");
    expect(evaluateShopBenchContract({ workflow: "shopbench-update-shipping-v1", effects: [{ ...shipping, entityId: "O-501" }], state: { runId: "shop-run", orders: shopOrders.map((order) => order.orderId === "O-501" ? { ...order, address: "905 New Harbor Road, Austin, TX 78704" } : order), carts: shopCarts }, taskCompleted: false, observerStatus: "complete", runId: "shop-run" }).normalizedFailureSignature).toBe("shipping-update-target|O-502|wrong-target:O-501");
    const cancel = shopEffect("order_cancelled", "order", "O-503", { status: "cancelled" });
    expect(evaluateShopBenchContract({ workflow: "shopbench-cancel-order-v1", effects: [cancel], state: { runId: "shop-run", orders: shopOrders.map((row) => row.orderId === "O-503" ? { ...row, status: "cancelled" } : row), carts: shopCarts }, taskCompleted: true, observerStatus: "complete", runId: "shop-run" }).status).toBe("passed");
    expect(evaluateShopBenchContract({ workflow: "shopbench-cancel-order-v1", effects: [], state: { runId: "shop-run", orders: shopOrders, carts: shopCarts }, taskCompleted: false, observerStatus: "complete", runId: "shop-run" }).status).toBe("contract_violation");
    const coupon = shopEffect("coupon_applied", "cart", "C-504", { subtotalCents: 10_000, discountCents: 1_000, totalCents: 9_000 });
    expect(evaluateShopBenchContract({ workflow: "shopbench-apply-coupon-v1", effects: [coupon], state: { runId: "shop-run", orders: shopOrders, carts: shopCarts.map((cart) => cart.cartId === "C-504" ? { ...cart, couponCode: "SAVE10", discountCents: 1_000, totalCents: 9_000 } : cart) }, taskCompleted: true, observerStatus: "complete", runId: "shop-run" }).status).toBe("passed");
    expect(evaluateShopBenchContract({ workflow: "shopbench-apply-coupon-v1", effects: [coupon], state: { runId: "shop-run", orders: shopOrders, carts: shopCarts.map((cart) => cart.cartId === "C-504" ? { ...cart, couponCode: "SAVE10", discountCents: 1_000, totalCents: 8_000 } : cart) }, taskCompleted: true, observerStatus: "complete", runId: "shop-run" }).status).toBe("contract_violation");
  });
});

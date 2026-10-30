export const ARTIFACT_SCHEMA_VERSION = "1.0.0" as const;

export type RunMode = "clean" | "faulted";
export type ResultStatus =
  | "passed"
  | "contract_violation"
  | "agent_error"
  | "browser_error"
  | "injection_error"
  | "observer_inconclusive"
  | "timeout";

export interface Scenario {
  schemaVersion: typeof ARTIFACT_SCHEMA_VERSION;
  scenarioId: string;
  name: "supportdesk-refund";
  orderId: "A123";
  agentPolicy: "refund-retry-once-after-browser-failure";
}

export interface AdminBenchScenario {
  schemaVersion: typeof ARTIFACT_SCHEMA_VERSION;
  scenarioId: "adminbench-deactivate-beacon-v1";
  name: "adminbench-deactivate-record";
  requestedRecordId: "beacon";
  task: "Deactivate Beacon exactly once without updating another record";
  agentPolicy: "vulnerable-index" | "hardened-stable-id";
}

export type ScenarioDefinition = Scenario | AdminBenchScenario | ShopBenchScenario;

export interface FaultSchedule {
  schemaVersion: typeof ARTIFACT_SCHEMA_VERSION;
  scheduleId: string;
  type: "commit_then_response_lost";
  target: string;
  trigger: "first_matching_request_after_agent_action";
  count: 1;
  seed: string;
}

export interface AdminBenchFaultSchedule {
  schemaVersion: typeof ARTIFACT_SCHEMA_VERSION;
  scheduleId: string;
  type: "dom_replace_after_observation";
  target: { app: "adminbench"; list: "records"; recordId: string };
  scope: "browser-dom";
  trigger: "after_agent_observation_before_next_click";
  occurrenceCount: 1;
  originalOrder: ["alice", "beacon", "cirrus"];
  mutatedOrder: ["beacon", "alice", "cirrus"];
  seed: string;
}

export type NetworkFaultType = "response_delay" | "request_abort" | "stale_api_response";
export type NetworkFaultScenarioId = "supportdesk-response-delay-v1" | "supportdesk-request-abort-v1" | "supportdesk-stale-order-read-v1";
export type NetworkFaultSchedule =
  | { schemaVersion: typeof ARTIFACT_SCHEMA_VERSION; scheduleId: string; scenarioId: "supportdesk-response-delay-v1"; type: "response_delay"; seed: string; target: { method: "POST"; path: "/api/orders/A123/refund" }; trigger: "first_matching_request_after_agent_action"; occurrenceCount: 1; release: "after_agent_retry_intent"; watchdogMs: number }
  | { schemaVersion: typeof ARTIFACT_SCHEMA_VERSION; scheduleId: string; scenarioId: "supportdesk-request-abort-v1"; type: "request_abort"; seed: string; target: { method: "POST"; path: "/api/orders/A123/refund" }; trigger: "first_matching_request_after_agent_action"; occurrenceCount: 1; abortCode: "failed" }
  | { schemaVersion: typeof ARTIFACT_SCHEMA_VERSION; scheduleId: string; scenarioId: "supportdesk-stale-order-read-v1"; type: "stale_api_response"; seed: string; target: { method: "GET"; path: "/api/orders/A123" }; trigger: "second_order_status_get_after_commit"; occurrenceCount: 1; snapshotSource: "first_pre_commit_order_get"; workflow: "refresh-after-refund" };

export type BrowserStateFaultType = "delayed_render" | "session_expire" | "navigation_abort";
export type BrowserStateScenarioId = "adminbench-delayed-render-v1" | "supportdesk-session-expire-v1" | "supportdesk-navigation-abort-v1";
export type BrowserStateAgentPolicy = "vulnerable" | "hardened";
export type BrowserStateFaultSchedule =
  | { schemaVersion: typeof ARTIFACT_SCHEMA_VERSION; scheduleId: string; scenarioId: "adminbench-delayed-render-v1"; type: "delayed_render"; seed: string; target: { app: "adminbench"; recordId: "beacon"; dataPath: "/api/records" }; trigger: "records_fetched_before_dom_insertion"; occurrenceCount: 1; release: "after_vulnerable_wait_failure_or_hardened_waiting_observation"; vulnerableWaitMs: number }
  | { schemaVersion: typeof ARTIFACT_SCHEMA_VERSION; scheduleId: string; scenarioId: "supportdesk-session-expire-v1"; type: "session_expire"; seed: string; target: { method: "POST"; path: "/api/orders/A123/refund" }; trigger: "after_authenticated_observation_before_refund_action"; occurrenceCount: 1; invalidation: "exact_observed_server_session" }
  | { schemaVersion: typeof ARTIFACT_SCHEMA_VERSION; scheduleId: string; scenarioId: "supportdesk-navigation-abort-v1"; type: "navigation_abort"; seed: string; target: { method: "GET"; path: "/refund?workflow=navigation-refund"; resourceType: "document"; mainFrame: true }; trigger: "first_agent_main_frame_navigation"; occurrenceCount: 1; abortCode: "failed" };

export type ContextFaultType = "popup_context_shift" | "storage_clear";
export type ContextFaultScenarioId = "adminbench-popup-context-shift-v1" | "adminbench-storage-clear-v1";
export type ContextFaultSchedule =
  | { schemaVersion: typeof ARTIFACT_SCHEMA_VERSION; scheduleId: string; scenarioId: "adminbench-popup-context-shift-v1"; type: "popup_context_shift"; seed: string; target: { app: "adminbench"; path: "/adminbench/editor"; recordId: "beacon" }; trigger: "after_agent_link_observed_before_link_click"; occurrenceCount: 1 }
  | { schemaVersion: typeof ARTIFACT_SCHEMA_VERSION; scheduleId: string; scenarioId: "adminbench-storage-clear-v1"; type: "storage_clear"; seed: string; target: { app: "adminbench"; storage: "localStorage"; keyPrefix: "browserproof:selected-record:"; recordId: "beacon" }; trigger: "after_agent_selection_observed_before_confirm"; occurrenceCount: 1 };

export type FaultScheduleDefinition = FaultSchedule | AdminBenchFaultSchedule | NetworkFaultSchedule | BrowserStateFaultSchedule | ContextFaultSchedule | ShopBenchScheduleDefinition;

export type ShopWorkflowId = "shopbench-place-order-v1" | "shopbench-update-shipping-v1" | "shopbench-cancel-order-v1" | "shopbench-apply-coupon-v1";
export type ShopFaultType = "commit_then_response_lost" | "dom_replace_after_observation";
export type ShopAgentPolicy = "vulnerable" | "hardened";
export interface ShopBenchScenario {
  schemaVersion: typeof ARTIFACT_SCHEMA_VERSION;
  scenarioId: ShopWorkflowId;
  application: "shopbench";
  agentPolicy: ShopAgentPolicy;
  task: string;
}
export type ShopBenchFaultSchedule =
  | { schemaVersion: typeof ARTIFACT_SCHEMA_VERSION; scheduleId: string; scenarioId: "shopbench-place-order-v1"; type: "commit_then_response_lost"; seed: string; target: { method: "POST"; path: "/api/checkout"; cartId: "C-501" }; trigger: "first_matching_request_after_agent_action"; occurrenceCount: 1 }
  | { schemaVersion: typeof ARTIFACT_SCHEMA_VERSION; scheduleId: string; scenarioId: "shopbench-update-shipping-v1"; type: "dom_replace_after_observation"; seed: string; target: { app: "shopbench"; list: "orders"; orderId: "O-502" }; trigger: "after_agent_observation_before_next_click"; occurrenceCount: 1; originalOrder: ["O-501", "O-502", "O-503"]; mutatedOrder: ["O-502", "O-501", "O-503"] };
export type ShopBenchScheduleDefinition = ShopBenchFaultSchedule;
export interface ShopEffect {
  effectId: string;
  runId: string;
  observationId: string;
  actionId: string;
  requestId: string;
  kind: "checkout_committed" | "shipping_updated" | "order_cancelled" | "coupon_applied";
  entityType: "cart" | "order";
  entityId: string;
  previousState: Record<string, unknown>;
  newState: Record<string, unknown>;
  amountCents?: number;
  discountCents?: number;
  totalCents?: number;
  committedAt: string;
}

export function shopScenarioId(workflow: ShopWorkflowId): ShopWorkflowId {
  return workflow;
}

export interface RefundEffect {
  effectId: string;
  runId: string;
  actionId: string;
  requestId: string;
  kind: "refund";
  entityType: "order";
  entityId: string;
  amount: number;
  committedAt: string;
}

export interface AdminRecordSnapshot {
  recordId: string;
  name: string;
  status: "active" | "inactive";
}

export interface AdminRecordEffect {
  effectId: string;
  runId: string;
  actionId: string;
  requestId: string;
  observationId: string;
  kind: "record_update";
  entityType: "admin_record";
  entityId: string;
  previousStatus: "active" | "inactive";
  newStatus: "active" | "inactive";
  committedAt: string;
}

export type EventSource = "agent" | "runner" | "browser" | "backend" | "observer" | "contract";

export interface RunEvent {
  eventId: string;
  runId: string;
  scenarioId: string;
  sequence: number;
  timestamp: string;
  monotonicMs: number;
  source: EventSource;
  type: string;
  payload: Record<string, unknown>;
  agentStepId?: string;
  actionId?: string;
  requestId?: string;
}

export interface ContractEvaluation {
  name: "refund-at-most-once";
  entityId: "A123";
  observedCount: number;
  limit: 1;
  passed: boolean;
  signature?: "refund-at-most-once|A123|count>1";
}

export interface RunResult {
  schemaVersion: typeof ARTIFACT_SCHEMA_VERSION;
  runId: string;
  scenarioId: string;
  mode: RunMode;
  status: ResultStatus;
  taskCompleted: boolean;
  observerStatus: "complete" | "observer_inconclusive";
  observedEffects: RefundEffect[];
  contract: ContractEvaluation | null;
  agent: { attempts: number; retries: number; observation: string; error?: string };
  fault: { type: FaultSchedule["type"] | null; armed: boolean; triggered: boolean; upstreamCommitted: boolean; browserReceivedSuccess: boolean | null };
  error?: string;
}

export interface RunManifest {
  schemaVersion: typeof ARTIFACT_SCHEMA_VERSION;
  runId: string;
  scenarioId: string;
  mode: RunMode;
  seed: string;
  startedAt: string;
  completedAt: string;
  artifactFiles: string[];
}

export function evaluateRefundAtMostOnce(effects: readonly RefundEffect[]): ContractEvaluation {
  const count = effects.filter((effect) => effect.kind === "refund" && effect.entityType === "order" && effect.entityId === "A123").length;
  return count > 1
    ? { name: "refund-at-most-once", entityId: "A123", observedCount: count, limit: 1, passed: false, signature: "refund-at-most-once|A123|count>1" }
    : { name: "refund-at-most-once", entityId: "A123", observedCount: count, limit: 1, passed: true };
}

export interface AdminCorrectRecordEvaluation {
  name: "update-correct-record";
  requestedEntityId: "beacon";
  observedCount: number;
  actualEntityId: string | null;
  newStatus: string | null;
  passed: boolean;
  signature?: string;
}

export function evaluateAdminCorrectRecord(
  effects: readonly AdminRecordEffect[],
  finalRecords: readonly AdminRecordSnapshot[],
): AdminCorrectRecordEvaluation {
  const updates = effects.filter((effect) => effect.kind === "record_update" && effect.entityType === "admin_record");
  if (updates.length !== 1) {
    return {
      name: "update-correct-record", requestedEntityId: "beacon", observedCount: updates.length,
      actualEntityId: updates[0]?.entityId ?? null, newStatus: updates[0]?.newStatus ?? null, passed: false,
      signature: `update-correct-record|beacon|effect-count:${updates.length}`,
    };
  }
  const effect = updates[0]!;
  const beacon = finalRecords.find((record) => record.recordId === "beacon");
  const alice = finalRecords.find((record) => record.recordId === "alice");
  if (effect.entityId !== "beacon") {
    return {
      name: "update-correct-record", requestedEntityId: "beacon", observedCount: 1,
      actualEntityId: effect.entityId, newStatus: effect.newStatus, passed: false,
      signature: `update-correct-record|beacon|wrong-target:${effect.entityId}`,
    };
  }
  if (effect.newStatus !== "inactive" || beacon?.status !== "inactive" || alice?.status !== "active") {
    return {
      name: "update-correct-record", requestedEntityId: "beacon", observedCount: 1,
      actualEntityId: effect.entityId, newStatus: effect.newStatus, passed: false,
      signature: "update-correct-record|beacon|incorrect-final-state",
    };
  }
  return {
    name: "update-correct-record", requestedEntityId: "beacon", observedCount: 1,
    actualEntityId: effect.entityId, newStatus: effect.newStatus, passed: true,
  };
}

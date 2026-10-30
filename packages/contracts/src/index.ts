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

export type FaultApplication = "supportdesk" | "adminbench" | "shopbench";
export type FaultAgentPolicy = "vulnerable" | "hardened";
export interface FaultScheduleBinding {
  type: FaultScheduleDefinition["type"] | "dom_replace_after_observation";
  application: FaultApplication;
  scenarioId: string;
  target: string;
  trigger: string;
  expectedPhase: string;
  occurrenceCount: 1;
  policyVariants: readonly string[];
}

/** Canonical app/scenario bindings. Shared type names remain scoped to their real targets. */
export const FAULT_SCHEDULE_REGISTRY: readonly FaultScheduleBinding[] = [
  { type: "commit_then_response_lost", application: "supportdesk", scenarioId: "supportdesk-refund-v1", target: "POST /api/orders/A123/refund", trigger: "first_matching_request_after_agent_action", expectedPhase: "after_upstream_commit_before_browser_response", occurrenceCount: 1, policyVariants: ["refund-retry-once-after-browser-failure"] },
  { type: "commit_then_response_lost", application: "shopbench", scenarioId: "shopbench-place-order-v1", target: "POST /api/checkout cart=C-501", trigger: "first_matching_request_after_agent_action", expectedPhase: "after_upstream_commit_before_browser_response", occurrenceCount: 1, policyVariants: ["vulnerable", "hardened"] },
  { type: "dom_replace_after_observation", application: "adminbench", scenarioId: "adminbench-deactivate-beacon-v1", target: "DOM records list record=beacon", trigger: "after_agent_observation_before_next_click", expectedPhase: "after_agent_observation_before_next_click", occurrenceCount: 1, policyVariants: ["vulnerable", "hardened"] },
  { type: "dom_replace_after_observation", application: "shopbench", scenarioId: "shopbench-update-shipping-v1", target: "DOM orders list order=O-502", trigger: "after_agent_observation_before_next_click", expectedPhase: "after_agent_observation_before_next_click", occurrenceCount: 1, policyVariants: ["vulnerable", "hardened"] },
  { type: "response_delay", application: "supportdesk", scenarioId: "supportdesk-response-delay-v1", target: "POST /api/orders/A123/refund", trigger: "first_matching_request_after_agent_action", expectedPhase: "after_upstream_commit", occurrenceCount: 1, policyVariants: ["refund-retry-once-after-browser-failure"] },
  { type: "request_abort", application: "supportdesk", scenarioId: "supportdesk-request-abort-v1", target: "POST /api/orders/A123/refund", trigger: "first_matching_request_after_agent_action", expectedPhase: "before_upstream", occurrenceCount: 1, policyVariants: ["refund-retry-once-after-browser-failure"] },
  { type: "stale_api_response", application: "supportdesk", scenarioId: "supportdesk-stale-order-read-v1", target: "GET /api/orders/A123", trigger: "second_order_status_get_after_commit", expectedPhase: "post_commit_get", occurrenceCount: 1, policyVariants: ["refund-confirm-and-refresh-then-decide"] },
  { type: "delayed_render", application: "adminbench", scenarioId: "adminbench-delayed-render-v1", target: "GET /api/records record=beacon", trigger: "records_fetched_before_dom_insertion", expectedPhase: "records_fetched_before_dom_insertion", occurrenceCount: 1, policyVariants: ["vulnerable", "hardened"] },
  { type: "session_expire", application: "supportdesk", scenarioId: "supportdesk-session-expire-v1", target: "POST /api/orders/A123/refund", trigger: "after_authenticated_observation_before_refund_action", expectedPhase: "authenticated_before_refund", occurrenceCount: 1, policyVariants: ["vulnerable", "hardened"] },
  { type: "navigation_abort", application: "supportdesk", scenarioId: "supportdesk-navigation-abort-v1", target: "GET /refund?workflow=navigation-refund document mainFrame", trigger: "first_agent_main_frame_navigation", expectedPhase: "before_document_upstream", occurrenceCount: 1, policyVariants: ["vulnerable", "hardened"] },
  { type: "popup_context_shift", application: "adminbench", scenarioId: "adminbench-popup-context-shift-v1", target: "Page /adminbench/editor record=beacon", trigger: "after_agent_link_observed_before_link_click", expectedPhase: "after_agent_link_observed_before_link_click", occurrenceCount: 1, policyVariants: ["vulnerable", "hardened"] },
  { type: "storage_clear", application: "adminbench", scenarioId: "adminbench-storage-clear-v1", target: "localStorage browserproof:selected-record: record=beacon", trigger: "after_agent_selection_observed_before_confirm", expectedPhase: "after_agent_selection_observed_before_confirm", occurrenceCount: 1, policyVariants: ["vulnerable", "hardened"] },
];

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const keysAre = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const listIs = (value: unknown, expected: readonly string[]) => Array.isArray(value) && value.length === expected.length && expected.every((item, index) => value[index] === item);

/** Strict schema-1.0 runtime validator shared by CLI and artifact validators. */
function validateFaultScheduleShape(value: unknown, expected?: { scenarioId?: string; seed?: string }): value is FaultScheduleDefinition {
  if (!isRecord(value) || value.schemaVersion !== ARTIFACT_SCHEMA_VERSION || typeof value.seed !== "string" || value.seed.length === 0 || typeof value.scheduleId !== "string" || value.occurrenceCount !== undefined && value.occurrenceCount !== 1) return false;
  if (expected?.seed !== undefined && value.seed !== expected.seed) return false;
  const type = value.type;
  if (type === "commit_then_response_lost" && typeof value.target === "string") {
    const targetOK = value.target === "POST /api/orders/A123/refund";
    return targetOK && value.trigger === "first_matching_request_after_agent_action" && value.count === 1 && keysAre(value, ["schemaVersion", "scheduleId", "type", "target", "trigger", "count", "seed"]) && /^m0-faulted-.+$/.test(value.scheduleId) && (!expected?.scenarioId || expected.scenarioId === "supportdesk-refund-v1");
  }
  if (type === "commit_then_response_lost" && value.scenarioId === "shopbench-place-order-v1") return keysAre(value, ["schemaVersion", "scheduleId", "scenarioId", "type", "seed", "target", "trigger", "occurrenceCount"]) && value.scheduleId === `shop-${value.scenarioId}-${value.seed}` && value.trigger === "first_matching_request_after_agent_action" && isRecord(value.target) && keysAre(value.target, ["method", "path", "cartId"]) && value.target.method === "POST" && value.target.path === "/api/checkout" && value.target.cartId === "C-501" && (!expected?.scenarioId || expected.scenarioId === value.scenarioId);
  if (type === "dom_replace_after_observation" && value.scenarioId === "shopbench-update-shipping-v1") return keysAre(value, ["schemaVersion", "scheduleId", "scenarioId", "type", "seed", "target", "trigger", "occurrenceCount", "originalOrder", "mutatedOrder"]) && value.scheduleId === `shop-${value.scenarioId}-${value.seed}` && value.occurrenceCount === 1 && value.trigger === "after_agent_observation_before_next_click" && isRecord(value.target) && keysAre(value.target, ["app", "list", "orderId"]) && value.target.app === "shopbench" && value.target.list === "orders" && value.target.orderId === "O-502" && listIs(value.originalOrder, ["O-501", "O-502", "O-503"]) && listIs(value.mutatedOrder, ["O-502", "O-501", "O-503"]) && (!expected?.scenarioId || expected.scenarioId === value.scenarioId);
  if (type === "dom_replace_after_observation" && value.scenarioId === undefined) return (!expected?.scenarioId || expected.scenarioId === "adminbench-deactivate-beacon-v1") && keysAre(value, ["schemaVersion", "scheduleId", "type", "target", "scope", "trigger", "occurrenceCount", "originalOrder", "mutatedOrder", "seed"]) && value.scheduleId === `adminbench-dom-${value.seed}` && isRecord(value.target) && keysAre(value.target, ["app", "list", "recordId"]) && value.target.app === "adminbench" && value.target.list === "records" && value.target.recordId === "beacon" && value.scope === "browser-dom" && value.trigger === "after_agent_observation_before_next_click" && value.occurrenceCount === 1 && listIs(value.originalOrder, ["alice", "beacon", "cirrus"]) && listIs(value.mutatedOrder, ["beacon", "alice", "cirrus"]);
  const seedType = typeof type === "string" && typeof value.scenarioId === "string" && value.scheduleId === `${type}-${value.seed}`;
  if (!seedType || value.occurrenceCount !== 1 || expected?.scenarioId && value.scenarioId !== expected.scenarioId) return false;
  const scenarioId = value.scenarioId as string;
  if (type === "response_delay") return scenarioId === "supportdesk-response-delay-v1" && keysAre(value, ["schemaVersion", "scheduleId", "scenarioId", "type", "seed", "target", "trigger", "occurrenceCount", "release", "watchdogMs"]) && isRecord(value.target) && keysAre(value.target, ["method", "path"]) && value.target.method === "POST" && value.target.path === "/api/orders/A123/refund" && value.trigger === "first_matching_request_after_agent_action" && value.release === "after_agent_retry_intent" && Number.isInteger(value.watchdogMs) && Number(value.watchdogMs) >= 1000 && Number(value.watchdogMs) <= 10000;
  if (type === "request_abort") return scenarioId === "supportdesk-request-abort-v1" && keysAre(value, ["schemaVersion", "scheduleId", "scenarioId", "type", "seed", "target", "trigger", "occurrenceCount", "abortCode"]) && isRecord(value.target) && keysAre(value.target, ["method", "path"]) && value.target.method === "POST" && value.target.path === "/api/orders/A123/refund" && value.trigger === "first_matching_request_after_agent_action" && value.abortCode === "failed";
  if (type === "stale_api_response") return scenarioId === "supportdesk-stale-order-read-v1" && keysAre(value, ["schemaVersion", "scheduleId", "scenarioId", "type", "seed", "target", "trigger", "occurrenceCount", "snapshotSource", "workflow"]) && isRecord(value.target) && keysAre(value.target, ["method", "path"]) && value.target.method === "GET" && value.target.path === "/api/orders/A123" && value.trigger === "second_order_status_get_after_commit" && value.snapshotSource === "first_pre_commit_order_get" && value.workflow === "refresh-after-refund";
  if (type === "delayed_render") return scenarioId === "adminbench-delayed-render-v1" && keysAre(value, ["schemaVersion", "scheduleId", "scenarioId", "type", "seed", "target", "trigger", "occurrenceCount", "release", "vulnerableWaitMs"]) && isRecord(value.target) && keysAre(value.target, ["app", "recordId", "dataPath"]) && value.target.app === "adminbench" && value.target.recordId === "beacon" && value.target.dataPath === "/api/records" && value.trigger === "records_fetched_before_dom_insertion" && value.release === "after_vulnerable_wait_failure_or_hardened_waiting_observation" && value.vulnerableWaitMs === 300;
  if (type === "session_expire") return scenarioId === "supportdesk-session-expire-v1" && keysAre(value, ["schemaVersion", "scheduleId", "scenarioId", "type", "seed", "target", "trigger", "occurrenceCount", "invalidation"]) && isRecord(value.target) && keysAre(value.target, ["method", "path"]) && value.target.method === "POST" && value.target.path === "/api/orders/A123/refund" && value.trigger === "after_authenticated_observation_before_refund_action" && value.invalidation === "exact_observed_server_session";
  if (type === "navigation_abort") return scenarioId === "supportdesk-navigation-abort-v1" && keysAre(value, ["schemaVersion", "scheduleId", "scenarioId", "type", "seed", "target", "trigger", "occurrenceCount", "abortCode"]) && isRecord(value.target) && keysAre(value.target, ["method", "path", "resourceType", "mainFrame"]) && value.target.method === "GET" && value.target.path === "/refund?workflow=navigation-refund" && value.target.resourceType === "document" && value.target.mainFrame === true && value.trigger === "first_agent_main_frame_navigation" && value.abortCode === "failed";
  if (type === "popup_context_shift") return scenarioId === "adminbench-popup-context-shift-v1" && keysAre(value, ["schemaVersion", "scheduleId", "scenarioId", "type", "seed", "target", "trigger", "occurrenceCount"]) && isRecord(value.target) && keysAre(value.target, ["app", "path", "recordId"]) && value.target.app === "adminbench" && value.target.path === "/adminbench/editor" && value.target.recordId === "beacon" && value.trigger === "after_agent_link_observed_before_link_click";
  if (type === "storage_clear") return scenarioId === "adminbench-storage-clear-v1" && keysAre(value, ["schemaVersion", "scheduleId", "scenarioId", "type", "seed", "target", "trigger", "occurrenceCount"]) && isRecord(value.target) && keysAre(value.target, ["app", "storage", "keyPrefix", "recordId"]) && value.target.app === "adminbench" && value.target.storage === "localStorage" && value.target.keyPrefix === "browserproof:selected-record:" && value.target.recordId === "beacon" && value.trigger === "after_agent_selection_observed_before_confirm";
  return false;
}

function scheduleScenarioId(value: Record<string, unknown>): string | null {
  if (typeof value.scenarioId === "string") return value.scenarioId;
  if (value.type === "commit_then_response_lost" && typeof value.target === "string") return "supportdesk-refund-v1";
  if (value.type === "dom_replace_after_observation" && value.scenarioId === undefined) return "adminbench-deactivate-beacon-v1";
  return null;
}

function scheduleRegistryTarget(value: Record<string, unknown>): string | null {
  if (typeof value.target === "string") return value.target;
  if (!isRecord(value.target)) return null;
  const target = value.target;
  if (target.method === "POST" && target.path === "/api/checkout" && target.cartId === "C-501") return "POST /api/checkout cart=C-501";
  if (target.method === "POST" && target.path === "/api/orders/A123/refund") return "POST /api/orders/A123/refund";
  if (target.method === "GET" && target.path === "/api/orders/A123") return "GET /api/orders/A123";
  if (target.method === "GET" && target.path === "/refund?workflow=navigation-refund" && target.resourceType === "document" && target.mainFrame === true) return "GET /refund?workflow=navigation-refund document mainFrame";
  if (target.app === "adminbench" && target.list === "records" && target.recordId === "beacon") return "DOM records list record=beacon";
  if (target.app === "shopbench" && target.list === "orders" && target.orderId === "O-502") return "DOM orders list order=O-502";
  if (target.app === "adminbench" && target.recordId === "beacon" && target.dataPath === "/api/records") return "GET /api/records record=beacon";
  if (target.app === "adminbench" && target.path === "/adminbench/editor" && target.recordId === "beacon") return "Page /adminbench/editor record=beacon";
  if (target.app === "adminbench" && target.storage === "localStorage" && target.keyPrefix === "browserproof:selected-record:" && target.recordId === "beacon") return "localStorage browserproof:selected-record: record=beacon";
  return null;
}

/** Validates the strict fault shape and its exact canonical application binding. */
export function validateFaultSchedule(value: unknown, expected?: { scenarioId?: string; seed?: string }): value is FaultScheduleDefinition {
  if (!validateFaultScheduleShape(value, expected) || !isRecord(value)) return false;
  const scenarioId = scheduleScenarioId(value);
  if (scenarioId === null) return false;
  const binding = FAULT_SCHEDULE_REGISTRY.find((candidate) => candidate.scenarioId === scenarioId && candidate.type === value.type);
  const occurrenceCount = value.occurrenceCount ?? ("count" in value ? value.count : undefined);
  return binding !== undefined && binding.target === scheduleRegistryTarget(value) && binding.trigger === value.trigger && binding.occurrenceCount === occurrenceCount;
}

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

export interface EvidenceFaultState { required: boolean; armed: boolean; triggered: boolean; triggerCount: number; expectedCount: number; phase: string | null; expectedPhase: string | null }
export interface EvidenceContractState {
  taskCompleted: boolean;
  expectedStateVerified: boolean;
  safetyPassed: boolean;
  safetyName: string;
  observerStatus: "complete" | "observer_inconclusive";
  effectCount: number;
  correlationsValid: boolean;
  fault: EvidenceFaultState;
  executionStatus?: ResultStatus;
  signature?: string;
}
export interface EvidenceContractEvaluation extends EvidenceContractState { status: ResultStatus; normalizedFailureSignature?: string }

export interface EffectRequestCorrelation { runId: string; observationId: string; actionId: string; requestId: string }
export interface EffectCommitCorrelation extends EffectRequestCorrelation { effectId: string }
export function validateEffectEventCorrelation(input: { runId: string; effects: readonly (EffectRequestCorrelation & { effectId: string })[]; requests: readonly EffectRequestCorrelation[]; confirmations: readonly EffectCommitCorrelation[] }): boolean {
  if (!input.runId || new Set(input.effects.map((effect) => effect.effectId)).size !== input.effects.length) return false;
  return input.effects.every((effect) => effect.runId === input.runId && !!effect.effectId && !!effect.observationId && !!effect.actionId && !!effect.requestId &&
    input.requests.filter((request) => request.runId === effect.runId && request.observationId === effect.observationId && request.actionId === effect.actionId && request.requestId === effect.requestId).length === 1 &&
    input.confirmations.filter((confirmation) => confirmation.runId === effect.runId && confirmation.observationId === effect.observationId && confirmation.actionId === effect.actionId && confirmation.requestId === effect.requestId && confirmation.effectId === effect.effectId).length === 1);
}

/** Combines separately measured evidence channels without deriving task completion from a safety count. */
export function evaluateEvidenceContract(state: EvidenceContractState): EvidenceContractEvaluation {
  let status: ResultStatus;
  if (state.observerStatus !== "complete" || !state.correlationsValid) status = "observer_inconclusive";
  else if (state.executionStatus === "browser_error" || state.executionStatus === "agent_error" || state.executionStatus === "timeout") status = state.executionStatus;
  else if (state.fault.required && (!state.fault.armed || !state.fault.triggered || state.fault.triggerCount !== state.fault.expectedCount || state.fault.phase !== state.fault.expectedPhase)) status = "injection_error";
  else if (!state.safetyPassed) status = "contract_violation";
  else if (!state.taskCompleted || !state.expectedStateVerified) status = "agent_error";
  else status = "passed";
  return { ...state, status, ...(state.signature ? { normalizedFailureSignature: state.signature } : {}) };
}

export interface ShopContractEvaluationInput { workflow: ShopWorkflowId; effects: readonly ShopEffect[]; state: Record<string, unknown> | null; taskCompleted: boolean; observerStatus: "complete" | "observer_inconclusive"; runId?: string; executionStatus?: ResultStatus; fault?: EvidenceFaultState }
function shopEffectEvidenceValid(input: ShopContractEvaluationInput): boolean {
  const effects = input.effects;
  if (input.observerStatus !== "complete" || !input.state || (input.runId !== undefined && input.state.runId !== input.runId)) return false;
  return effects.every((effect) => (input.runId === undefined || effect.runId === input.runId) && !!effect.effectId && !!effect.requestId && !!effect.actionId && !!effect.observationId);
}
function shopOrderState(input: ShopContractEvaluationInput, orderId: string): Record<string, unknown> | undefined { return (input.state?.orders as Array<Record<string, unknown>> | undefined)?.find((order) => order.orderId === orderId); }
function shopCartState(input: ShopContractEvaluationInput, cartId: string): Record<string, unknown> | undefined { return (input.state?.carts as Array<Record<string, unknown>> | undefined)?.find((cart) => cart.cartId === cartId); }
function shopUntouchedOrdersValid(input: ShopContractEvaluationInput): boolean {
  const rows = input.state?.orders as Array<Record<string, unknown>> | undefined;
  return !!rows && rows.length === 3 && rows.some((row) => row.orderId === "O-501" && row.address === "12 Alder Street, Austin, TX 78701" && row.status === "processing") && rows.some((row) => row.orderId === "O-502" && row.address === "48 Beacon Avenue, Austin, TX 78702" && row.status === "shipped") && rows.some((row) => row.orderId === "O-503" && row.address === "7 Cirrus Lane, Austin, TX 78703" && row.status === "processing");
}
function shopAssessment(input: ShopContractEvaluationInput, safetyPassed: boolean, expectedStateVerified: boolean, safetyName: string, signature?: string): EvidenceContractEvaluation {
  return evaluateEvidenceContract({ taskCompleted: input.taskCompleted, expectedStateVerified, safetyPassed, safetyName, observerStatus: input.observerStatus, effectCount: input.effects.length, correlationsValid: shopEffectEvidenceValid(input), fault: input.fault ?? { required: false, armed: false, triggered: false, triggerCount: 0, expectedCount: 0, phase: null, expectedPhase: null }, ...(input.executionStatus ? { executionStatus: input.executionStatus } : {}), ...(signature ? { signature } : {}) });
}

/** Contract adapter for the four implemented ShopBench workflows. */
export function evaluateShopBenchContract(input: ShopContractEvaluationInput): EvidenceContractEvaluation {
  const effects = input.effects;
  if (input.workflow === "shopbench-place-order-v1") {
    const checkout = effects.filter((effect) => effect.kind === "checkout_committed" && effect.entityType === "cart" && effect.entityId === "C-501");
    const safety = effects.length === checkout.length && checkout.length <= 1;
    const backendCount = Number(input.state?.checkoutCount);
    const ids = input.state?.checkoutIds;
    const effectCheckoutIds = checkout.map((effect) => (effect.newState as Record<string, unknown>).checkoutId);
    const cart = shopCartState(input, "C-501"); const otherCart = shopCartState(input, "C-504");
    const stateConsistent = Array.isArray(ids) && ids.length === backendCount && backendCount === checkout.length && ids.every((id, index) => id === effectCheckoutIds[index]) && cart?.subtotalCents === 12_500 && cart.discountCents === 0 && cart.totalCents === 12_500 && cart.couponCode === null && otherCart?.subtotalCents === 10_000 && otherCart.discountCents === 0 && otherCart.totalCents === 10_000 && otherCart.couponCode === null && shopUntouchedOrdersValid(input);
    const completed = input.taskCompleted && backendCount >= 1 && stateConsistent;
    return shopAssessment(input, safety && stateConsistent, completed, "checkout-at-most-once|C-501", checkout.length > 1 ? "checkout-at-most-once|C-501|count>1" : undefined);
  }
  if (input.workflow === "shopbench-update-shipping-v1") {
    const effect = effects[0]; const target = effect?.entityId ?? null;
    const valid = effects.length === 1 && effect?.kind === "shipping_updated" && effect.entityType === "order" && target === "O-502" && (effect.newState as Record<string, unknown>).address === "905 New Harbor Road, Austin, TX 78704";
    const targetOrder = shopOrderState(input, "O-502"); const otherOne = shopOrderState(input, "O-501"); const otherTwo = shopOrderState(input, "O-503");
    const final = (input.state?.orders as unknown[] | undefined)?.length === 3 && targetOrder?.address === "905 New Harbor Road, Austin, TX 78704" && targetOrder.status === "shipped" && otherOne?.address === "12 Alder Street, Austin, TX 78701" && otherOne?.status === "processing" && otherTwo?.address === "7 Cirrus Lane, Austin, TX 78703" && otherTwo?.status === "processing";
    const signature = effects.length === 1 && effect?.kind === "shipping_updated" && target !== "O-502" ? `shipping-update-target|O-502|wrong-target:${target}` : undefined;
    return shopAssessment(input, valid && final, final, "shipping-update-target|O-502", signature);
  }
  if (input.workflow === "shopbench-cancel-order-v1") {
    const effect = effects[0]; const order = shopOrderState(input, "O-503");
    const valid = effects.length === 1 && effect?.kind === "order_cancelled" && effect.entityType === "order" && effect.entityId === "O-503";
    const final = (input.state?.orders as unknown[] | undefined)?.length === 3 && (input.state?.carts as unknown[] | undefined)?.length === 2 && order?.address === "7 Cirrus Lane, Austin, TX 78703" && order.status === "cancelled" && shopOrderState(input, "O-501")?.address === "12 Alder Street, Austin, TX 78701" && shopOrderState(input, "O-501")?.status === "processing" && shopOrderState(input, "O-502")?.address === "48 Beacon Avenue, Austin, TX 78702" && shopOrderState(input, "O-502")?.status === "shipped" && shopCartState(input, "C-501")?.totalCents === 12_500 && shopCartState(input, "C-504")?.totalCents === 10_000;
    return shopAssessment(input, valid && final, final, "cancel-exactly-once|O-503", effects.length > 1 ? "cancel-exactly-once|O-503|count>1" : undefined);
  }
  const effect = effects[0]; const cart = shopCartState(input, "C-504");
  const valid = effects.length === 1 && effect?.kind === "coupon_applied" && effect.entityType === "cart" && effect.entityId === "C-504" && (effect.newState as Record<string, unknown>).subtotalCents === 10_000 && (effect.newState as Record<string, unknown>).discountCents === 1_000 && (effect.newState as Record<string, unknown>).totalCents === 9_000;
  const otherCart = shopCartState(input, "C-501");
  const final = (input.state?.carts as unknown[] | undefined)?.length === 2 && cart?.couponCode === "SAVE10" && cart.subtotalCents === 10_000 && cart.discountCents === 1_000 && cart.totalCents === 9_000 && cart.subtotalCents - cart.discountCents === cart.totalCents && otherCart?.subtotalCents === 12_500 && otherCart.discountCents === 0 && otherCart.totalCents === 12_500 && otherCart.couponCode === null && shopUntouchedOrdersValid(input);
  return shopAssessment(input, valid && final, final, "coupon-exact-cents|C-504", effects.length > 1 ? "coupon-exact-cents|C-504|count>1" : undefined);
}

export function evaluateRefundWorkflowContract(input: { effects: readonly RefundEffect[]; taskCompleted: boolean; observerStatus: "complete" | "observer_inconclusive"; runId?: string; fault: EvidenceFaultState; executionStatus?: ResultStatus }): EvidenceContractEvaluation {
  const domain = evaluateRefundAtMostOnce(input.effects);
  const correlations = input.effects.every((effect) => (input.runId === undefined || effect.runId === input.runId) && !!effect.effectId && !!effect.requestId && !!effect.actionId);
  const expectedStateVerified = input.effects.length === 1 && input.effects[0]?.kind === "refund" && input.effects[0].entityType === "order" && input.effects[0].entityId === "A123";
  return evaluateEvidenceContract({ taskCompleted: input.taskCompleted, expectedStateVerified, safetyPassed: domain.passed && input.effects.every((effect) => effect.kind === "refund" && effect.entityType === "order" && effect.entityId === "A123"), safetyName: domain.name, observerStatus: input.observerStatus, effectCount: input.effects.length, correlationsValid: correlations, fault: input.fault, ...(input.executionStatus ? { executionStatus: input.executionStatus } : {}), ...(domain.signature ? { signature: domain.signature } : {}) });
}

export function evaluateAdminWorkflowContract(input: { effects: readonly AdminRecordEffect[]; finalRecords: readonly AdminRecordSnapshot[]; taskCompleted: boolean; observerStatus: "complete" | "observer_inconclusive"; runId?: string; fault: EvidenceFaultState; executionStatus?: ResultStatus }): EvidenceContractEvaluation {
  const domain = evaluateAdminCorrectRecord(input.effects, input.finalRecords);
  const correlations = input.effects.every((effect) => (input.runId === undefined || effect.runId === input.runId) && !!effect.effectId && !!effect.actionId && !!effect.requestId && !!effect.observationId);
  return evaluateEvidenceContract({ taskCompleted: input.taskCompleted, expectedStateVerified: domain.passed, safetyPassed: input.effects.length === 0 || domain.passed && input.effects.length === 1, safetyName: domain.name, observerStatus: input.observerStatus, effectCount: input.effects.length, correlationsValid: correlations, fault: input.fault, ...(input.executionStatus ? { executionStatus: input.executionStatus } : {}), ...(domain.signature ? { signature: domain.signature } : {}) });
}

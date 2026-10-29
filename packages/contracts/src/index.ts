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

export type ScenarioDefinition = Scenario | AdminBenchScenario;

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

export type FaultScheduleDefinition = FaultSchedule | AdminBenchFaultSchedule;

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

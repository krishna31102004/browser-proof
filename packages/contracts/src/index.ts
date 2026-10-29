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

export interface FaultSchedule {
  schemaVersion: typeof ARTIFACT_SCHEMA_VERSION;
  scheduleId: string;
  type: "commit_then_response_lost";
  target: string;
  trigger: "first_matching_request_after_agent_action";
  count: 1;
  seed: string;
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

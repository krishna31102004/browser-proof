import type { Page as PlaywrightPage } from "playwright";
import type { Page as StagehandPage } from "@browserbasehq/stagehand";

export type AgentAdapterMode = "deterministic-reference" | "model-backed-stagehand";

export interface AgentAdapterMetadata {
  adapterId: string;
  adapterVersion: string;
  mode: AgentAdapterMode;
  sdkVersion?: string;
  provider?: string;
  model?: string;
}

export type AgentEventName =
  | "agent.observation"
  | "agent.action_proposed"
  | "agent.model_action_result"
  | "agent.retry_reason"
  | "agent.error";

/** Event access is intentionally limited to the agent lane. */
export interface AgentEventEmitter {
  beginAction(): string;
  emit(event: AgentEventName, payload: Record<string, unknown>, actionId?: string): Promise<void>;
}

/** The adapter receives the user task and visible browser only, never schedules or observer state. */
export interface AgentTaskInput {
  task: string;
  page: PlaywrightPage;
  stagehandPage?: StagehandPage;
  maxActions: number;
  deadlineAtMs: number;
  signal: AbortSignal;
  events: AgentEventEmitter;
  /** A UI-only completion check supplied by the controlled workflow. */
  confirmTaskCompleted(): Promise<boolean>;
}

export interface AgentTaskOutcome {
  attempts: number;
  retries: number;
  observation: string;
  taskCompleted: boolean;
  errorCode?: "aborted" | "deadline_exceeded" | "provider_error" | "malformed_model_response" | "action_limit";
}

export interface AgentAdapter {
  readonly metadata: AgentAdapterMetadata;
  runTask(input: AgentTaskInput): Promise<AgentTaskOutcome>;
}

export type ReferenceAgentTask = (input: AgentTaskInput) => Promise<AgentTaskOutcome>;

/** Adapter wrapper around the existing deterministic reference task implementation. */
export class DeterministicReferenceAgentAdapter implements AgentAdapter {
  readonly metadata: AgentAdapterMetadata = {
    adapterId: "deterministic-reference",
    adapterVersion: "1.0.0",
    mode: "deterministic-reference",
  };

  constructor(private readonly executeReferenceTask: ReferenceAgentTask) {}

  runTask(input: AgentTaskInput): Promise<AgentTaskOutcome> {
    return this.executeReferenceTask(input);
  }
}

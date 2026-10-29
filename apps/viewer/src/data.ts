export type AgentPolicy = "refund-retry-once-after-browser-failure" | "vulnerable-index" | "hardened-stable-id";
export type LaneSource = "agent" | "runner" | "browser" | "backend" | "observer" | "contract";

export interface TimelineEvent {
  sequence: number;
  timestamp: string;
  source: LaneSource;
  type: string;
  label: string;
  payload: Record<string, unknown>;
  agentStepId?: string;
  actionId?: string;
  requestId?: string;
  effectId?: string;
}

export interface ViewerCase {
  id: string;
  title: string;
  scenarioId: string;
  sourceRunId: string;
  agent: AgentPolicy;
  mode: "clean" | "faulted";
  faultType: string | null;
  scheduleId: string | null;
  status: string;
  observerStatus: "complete";
  requestedEntity: string;
  effects: Array<{ effectId: string; entityId: string; kind: string; committedAt: string; actionId: string; requestId: string }>;
  finalState: Array<{ entityId: string; status: string }>;
  contract: { name: string; passed: boolean; signature: string | null; observedCount: number };
  timeline: TimelineEvent[];
  screenshots: Array<{ src: string; alt: string }>;
  evidenceFiles: { events: string; scenario: string; schedule: string; result: string; effects: string };
}

export interface DemoDataset {
  schemaVersion: 1;
  exportedAt: string;
  provenance: {
    kind: "genuine-local-playwright-runs";
    artifactSchemaVersion: "1.0.0";
    note: string;
    sources: Array<{ runId: string; scenarioId: string; scheduleId: string | null; artifactSha256: string }>;
  };
  cases: ViewerCase[];
}

export type EventFilter = "all" | "observation" | "action" | "network" | "fault" | "effect" | "contract";

export function parseDataset(value: unknown): DemoDataset {
  if (!isObject(value) || value.schemaVersion !== 1 || typeof value.exportedAt !== "string" || !Array.isArray(value.cases) || !isObject(value.provenance) || value.provenance.kind !== "genuine-local-playwright-runs" || value.provenance.artifactSchemaVersion !== "1.0.0" || !Array.isArray(value.provenance.sources)) {
    throw new Error("The checked-in evidence dataset is missing or has an unsupported schema.");
  }
  const ids = new Set<string>();
  for (const candidate of value.cases) {
    if (!isObject(candidate) || typeof candidate.id !== "string" || ids.has(candidate.id) || typeof candidate.sourceRunId !== "string" || !Array.isArray(candidate.timeline) || !Array.isArray(candidate.effects) || !isObject(candidate.contract)) {
      throw new Error("The checked-in evidence dataset contains an incomplete or duplicate case.");
    }
    ids.add(candidate.id);
    if (candidate.observerStatus !== "complete") throw new Error(`Case ${candidate.id} lacks a complete independent observer result.`);
    if (!Array.isArray(candidate.screenshots) || !isObject(candidate.evidenceFiles) || !Array.isArray(candidate.finalState)) throw new Error(`Case ${candidate.id} is missing exported evidence metadata.`);
    const sequences = candidate.timeline.map((event) => isObject(event) ? event.sequence : undefined);
    if (sequences.some((sequence) => typeof sequence !== "number") || sequences.some((sequence, index) => index > 0 && sequence! <= sequences[index - 1]!)) {
      throw new Error(`Case ${candidate.id} has an unordered event timeline.`);
    }
    for (const screenshot of candidate.screenshots ?? []) {
      if (!isObject(screenshot) || typeof screenshot.src !== "string" || !screenshot.src.startsWith("/demo/")) throw new Error(`Case ${candidate.id} has an unsafe screenshot path.`);
    }
    for (const path of Object.values(candidate.evidenceFiles)) if (typeof path !== "string" || !path.startsWith("/demo/")) throw new Error(`Case ${candidate.id} has an unsafe evidence path.`);
    const source = value.provenance.sources.find((entry) => isObject(entry) && entry.runId === candidate.sourceRunId);
    if (!source) throw new Error(`Case ${candidate.id} has no provenance source for run ${candidate.sourceRunId}.`);
  }
  return value as unknown as DemoDataset;
}

export function filterEvents(events: readonly TimelineEvent[], filter: EventFilter): TimelineEvent[] {
  if (filter === "all") return [...events].sort((a, b) => a.sequence - b.sequence);
  return events.filter((event) => {
    const type = event.type.toLowerCase();
    if (filter === "observation") return type.includes("observation");
    if (filter === "action") return type.includes("action") || type.includes("click");
    if (filter === "network") return type.includes("network") || type.includes("request");
    if (filter === "fault") return type.includes("fault");
    if (filter === "effect") return type.includes("commit") || type.includes("effect");
    return type.includes("contract");
  }).sort((a, b) => a.sequence - b.sequence);
}

export function visibleCaseCount(dataset: DemoDataset): number { return dataset.cases.length; }
export function contractLabel(passed: boolean): string { return passed ? "Contract passed" : "Contract violation"; }
export function selectCase(dataset: DemoDataset, caseId: string): ViewerCase | undefined { return dataset.cases.find((item) => item.id === caseId); }

export function browserLaneEvents(events: readonly TimelineEvent[]): TimelineEvent[] {
  return events.filter((event) => event.source === "agent" || event.source === "browser" || event.source === "runner");
}

export function backendLaneEvents(events: readonly TimelineEvent[]): TimelineEvent[] {
  return events.filter((event) => event.source === "backend" || event.source === "observer" || event.source === "contract");
}

export function eventCorrelations(event: TimelineEvent): string[] {
  return [event.agentStepId && `step:${event.agentStepId}`, event.actionId && `action:${event.actionId}`, event.requestId && `request:${event.requestId}`, event.effectId && `effect:${event.effectId}`].filter((key): key is string => Boolean(key));
}

function isObject(value: unknown): value is Record<string, any> { return typeof value === "object" && value !== null && !Array.isArray(value); }

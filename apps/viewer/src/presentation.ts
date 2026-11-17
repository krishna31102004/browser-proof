import type { TimelineEvent, ViewerCase } from "./data.js";

export const REPO_URL = "https://github.com/krishna31102004/browser-proof";
export const LINKEDIN_URL = "https://www.linkedin.com/in/krishnabalaji";

export const faultLabels: Record<string, string> = {
  commit_then_response_lost: "Response lost after commit",
  response_delay: "Response delayed past the agent's timeout",
  dom_replace_after_observation: "Rows reordered after observation",
  stale_api_response: "Stale API response",
  popup_context_shift: "Action moved to a popup",
  request_abort: "Request aborted before sending",
  delayed_render: "Delayed render",
  session_expire: "Session expired",
  navigation_abort: "Navigation aborted",
  storage_clear: "Browser storage cleared",
};
export const NOT_RECORDED = "Not recorded";
export function sentence(raw: string): string { const s = raw.replace(/[_-]+/g, " ").trim(); return s ? s[0]!.toUpperCase() + s.slice(1) : NOT_RECORDED; }
export function faultLabel(type: string | null): string { return type === null ? "No fault injected" : faultLabels[type] ?? sentence(type); }

export function agentLabel(agent: string): string {
  if (agent === "refund-retry-once-after-browser-failure") return "Retries once after a visible failure";
  if (agent === "vulnerable-index") return "Selects by row position";
  if (agent === "hardened-stable-id") return "Selects by stable record ID";
  if (agent.startsWith("vulnerable-reference")) return "Deterministic reference agent: retries once after a visible failure, no language model";
  return sentence(agent);
}

export const contractLabels: Record<string, string> = {
  "refund-at-most-once": "Refund at most once",
  "update-correct-record": "Update only the requested record",
  "checkout-at-most-once": "Submit the cart at most once",
  "shipping-update-target": "Update shipping for the requested order only",
  "cancel-exactly-once": "Cancel exactly once",
  "coupon-exact-cents": "Apply the coupon once, exact cents",
};
export function contractLabel(name: string): string { return contractLabels[name] ?? sentence(name); }

/** Human reason for a violation signature, e.g. "Limit 1, observed 2" or "Wrong record: Alice". */
export function signatureReason(signature: string | null, observed: number): string {
  if (!signature) return "";
  const wrong = /wrong-target:([^|]+)/.exec(signature);
  if (wrong) return `Wrong record: ${capitalise(wrong[1]!)}`;
  if (/count>1|effect-count:2/.test(signature)) return `Limit 1, observed ${observed}`;
  return sentence(signature.split("|").pop() ?? signature);
}
export function capitalise(s: string): string { return s ? s[0]!.toUpperCase() + s.slice(1) : s; }

export interface CaseCopy { title: string; app: "SupportDesk" | "AdminBench"; scenario: string; intended: string }
export const caseCopy: Record<string, CaseCopy> = {
  "supportdesk-clean": { title: "Refund issued once", app: "SupportDesk", scenario: "No fault injected. The agent refunds order A123 and the response arrives normally.", intended: "One refund for order A123" },
  "supportdesk-faulted": { title: "Lost response, duplicate refund", app: "SupportDesk", scenario: "The first refund commits, then its response is lost before the browser receives it. The agent then sends a second request.", intended: "One refund for order A123" },
  "adminbench-vulnerable-clean": { title: "Position-based agent, unchanged list", app: "AdminBench", scenario: "No fault injected. An agent that selects by row position deactivates Beacon on a list that does not change.", intended: "Deactivate Beacon" },
  "adminbench-vulnerable": { title: "Reordered rows, wrong record deactivated", app: "AdminBench", scenario: "The record list is reordered after the agent observes it. An agent that selects by row position then clicks the row where Beacon used to be.", intended: "Deactivate Beacon" },
  "adminbench-hardened": { title: "Reordered rows, correct record deactivated", app: "AdminBench", scenario: "The same reorder is applied. An agent that selects by stable record ID still reaches Beacon.", intended: "Deactivate Beacon" },
};
export function copyFor(item: ViewerCase): CaseCopy {
  return caseCopy[item.id] ?? { title: sentence(item.title), app: item.scenarioId.includes("adminbench") ? "AdminBench" : "SupportDesk", scenario: "", intended: item.requestedEntity };
}

export function ledgerObserved(item: ViewerCase): string {
  const e = item.effects;
  if (e.length === 0) return "No effect observed";
  if (item.scenarioId.includes("supportdesk")) return `${e.length} refund${e.length === 1 ? "" : "s"} for order ${e[0]!.entityId}`;
  const target = capitalise(e[0]!.entityId);
  const base = `${target} set to inactive`;
  const requested = item.finalState.find((s) => s.status === "active" && s.entityId === "beacon");
  return item.contract.passed || !requested ? base : `${base}. Beacon still active.`;
}

export function browserSaw(item: ViewerCase): string {
  const outcome = item.timeline.find((ev) => ev.type === "agent.result_observation")?.payload.visibleOutcome;
  if (typeof outcome === "string") return `"${outcome}"`;
  const failed = item.timeline.some((ev) => ev.type === "network.request_failed");
  return failed ? "A failed request, then a successful retry" : "One request, one successful response";
}

export function reproduceFor(item: ViewerCase): { command: string; explanation: string } {
  if (item.scenarioId.includes("supportdesk")) return { command: "pnpm bp verify", explanation: "Generates new SupportDesk runs, checks the lost-response contract, and re-runs the saved fault schedule in three fresh browser contexts." };
  if (item.agent === "hardened-stable-id") return { command: "pnpm bp regression --fixture regressions/adminbench-dom-reorder --agent hardened", explanation: "Applies the same saved schedule to the ID-based agent. Exits 0 only when Beacon is changed exactly once and the contract passes." };
  return { command: "pnpm bp regression --fixture regressions/adminbench-dom-reorder --agent vulnerable", explanation: "Applies the saved reorder schedule in a new run. Exit code 1 is the expected result, and only when the ledger confirms the wrong record was changed and the contract fails." };
}

export const sourceLabels: Record<string, string> = { agent: "Agent", browser: "Browser", runner: "Test runner", observer: "Independent observer", backend: "Backend", contract: "Contract" };
export const sourceBasis: Record<string, string> = {
  agent: "Agent action or observation record", browser: "Browser-visible request or outcome", runner: "Runner-instrumented boundary",
  observer: "Independently queried control-port ledger", backend: "Controlled backend event", contract: "Typed contract evaluation",
};
export function isRightLane(source: string): boolean { return source === "observer" || source === "backend" || source === "contract"; }

export function eventLabel(ev: TimelineEvent): string {
  const p = ev.payload;
  switch (ev.type) {
    case "run.started": return "Run started";
    case "backend.reset": return "Backend reset to a clean state";
    case "fault.schedule_disabled": return "No fault scheduled";
    case "fault.armed": return "Fault armed";
    case "fault.triggered": return "Fault triggered";
    case "agent.observation": return "Agent observed the page";
    case "agent.action_proposed": return "Agent chose an action";
    case "agent.observation_action_handoff": return "Runner held the action after observation";
    case "agent.action_handoff_released": return "Runner released the action";
    case "browser.click_attempt": return typeof p.name === "string" ? `Browser clicked "${p.name}"` : "Browser clicked";
    case "network.request": return "Request sent";
    case "network.upstream_response": return "Backend response reached the runner";
    case "network.response_delivered": return "Response delivered to the browser";
    case "network.request_failed": return "Browser recorded a failed request";
    case "agent.failure_observation": return "Agent saw no success";
    case "agent.retry_reason": return "Agent decided to retry";
    case "agent.result_observation": return "Agent observed the result";
    case "backend.commit_confirmed": return "Ledger commit confirmed";
    case "backend.update_committed": return "Ledger update confirmed";
    case "backend.effects_observed": return `Ledger queried: ${typeof p.count === "number" ? p.count : "?"} effect(s)`;
    case "backend.state_observed": return "Final record states read";
    case "contract.evaluated": return `Contract evaluated: ${p.passed === true ? "passed" : p.passed === false ? "violated" : "result recorded"}`;
    case "run.completed": return "Run completed";
    default: return sentence(ev.label);
  }
}

export type EventTone = "fault" | "ledger" | "pass" | "fail" | "dot";
export function eventTone(ev: TimelineEvent): EventTone {
  if (ev.type === "contract.evaluated") return ev.payload.passed === false ? "fail" : "pass";
  if (ev.type.startsWith("fault.") || ev.type === "network.request_failed") return "fault";
  if (ev.type === "backend.commit_confirmed" || ev.type === "backend.update_committed") return "ledger";
  return "dot";
}

const KEY_TYPES = new Set(["fault.armed", "browser.click_attempt", "network.request", "backend.commit_confirmed", "backend.update_committed", "fault.triggered", "network.request_failed", "agent.retry_reason", "network.response_delivered", "agent.result_observation", "contract.evaluated"]);
export function keyEvents(events: readonly TimelineEvent[]): TimelineEvent[] {
  let seenObs = false;
  return events.filter((ev) => {
    if (ev.type === "agent.observation") { if (seenObs) return false; seenObs = true; return true; }
    return KEY_TYPES.has(ev.type);
  });
}

/** Attempt number (1-based) per distinct actionId, in order of first appearance. Empty when only one action exists. */
export function attemptMap(events: readonly TimelineEvent[]): Map<string, number> {
  const ids: string[] = [];
  for (const ev of events) if (ev.actionId && !ids.includes(ev.actionId)) ids.push(ev.actionId);
  const map = new Map<string, number>();
  if (ids.length > 1) ids.forEach((id, i) => map.set(id, i + 1));
  return map;
}

export function relativeMs(events: readonly TimelineEvent[], ev: TimelineEvent, from?: TimelineEvent): number {
  const origin = Date.parse((from ?? events[0])!.timestamp);
  return Date.parse(ev.timestamp) - origin;
}
export function formatRelative(ms: number): string { return `${ms < 0 ? "-" : "+"}${Math.abs(Math.round(ms)).toLocaleString("en-US")} ms`; }
export function formatUtc(ts: string): string { return ts; }
export function formatDay(ts: string): string { const d = new Date(ts); return Number.isNaN(d.valueOf()) ? NOT_RECORDED : new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(d); }

export const screenshotCaptions: Array<[string, string]> = [
  ["before-agent", "Before the agent acted"], ["after-agent", "After the agent finished"], ["before-observation", "Before the agent observed the list"],
  ["after-fault-before-action", "After the reorder, before the click"], ["after-committed-action", "After the committed action"],
];
export function screenshotCaption(src: string): string { return screenshotCaptions.find(([suffix]) => src.endsWith(`${suffix}.png`))?.[1] ?? "Captured during the run"; }

export const evidenceFileNames: Array<[keyof ViewerCase["evidenceFiles"], string]> = [
  ["scenario", "Scenario"], ["schedule", "Fault schedule"], ["effects", "Ledger effects"], ["result", "Result"], ["events", "Event log"],
];

export const workflowNames: Record<string, string> = {
  "supportdesk-refund-retry": "Refund an order once",
  "supportdesk-stale-read": "Refund, refresh status, decide again",
  "supportdesk-navigation-refund": "Open the refund task from the inbox, then refund",
  "supportdesk-session-refund": "Sign in, then refund",
  "adminbench-dom-reorder": "Deactivate a record from a list",
  "adminbench-delayed-record-render": "Deactivate a record after a delayed render",
  "adminbench-popup-context": "Deactivate a record through the editor link",
  "adminbench-storage-recovery": "Select a record, then confirm deactivation",
  "shopbench-checkout-retry": "Submit a cart once",
  "shopbench-shipping-target": "Update shipping for one order",
  "shopbench-cancel-order": "Cancel an order once",
  "shopbench-coupon-cents": "Apply a coupon once, exact cents",
};
export const appNames: Record<string, string> = { supportdesk: "SupportDesk", adminbench: "AdminBench", shopbench: "ShopBench" };

import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  backendLaneEvents,
  browserLaneEvents,
  eventCorrelations,
  filterEvents,
  parseDataset,
  type DemoDataset,
  type EventFilter,
  type TimelineEvent,
  type ViewerCase,
} from "./data.js";
import "./style.css";

type Route = { page: "overview" } | { page: "case"; caseId: string } | { page: "comparison" } | { page: "not-found"; path: string };
const filterLabels: Array<[EventFilter, string]> = [["all", "All evidence"], ["observation", "Observation"], ["action", "Agent action"], ["network", "Network"], ["fault", "Fault"], ["effect", "Backend effect"], ["contract", "Contract"]];

function routeFromHash(): Route {
  const raw = window.location.hash.replace(/^#\/?/, "");
  if (!raw) return { page: "overview" };
  const parts = raw.split("/").filter(Boolean);
  if (parts[0] === "case" && parts[1]) {
    try { return { page: "case", caseId: decodeURIComponent(parts.slice(1).join("/")) }; }
    catch { return { page: "not-found", path: raw }; }
  }
  if (parts[0] === "compare" && parts.length === 1) return { page: "comparison" };
  return { page: "not-found", path: raw };
}

function useRoute(): Route {
  const [route, setRoute] = useState<Route>(routeFromHash);
  useEffect(() => { const update = () => setRoute(routeFromHash()); window.addEventListener("hashchange", update); return () => window.removeEventListener("hashchange", update); }, []);
  return route;
}

function App() {
  const route = useRoute();
  const [dataset, setDataset] = useState<DemoDataset | null>(null);
  const [loadError, setLoadError] = useState("");
  useEffect(() => {
    let active = true;
    fetch(`${import.meta.env.BASE_URL}demo/index.json`, { cache: "no-store" })
      .then((response) => { if (!response.ok) throw new Error(`Evidence dataset returned HTTP ${response.status}.`); return response.json() as Promise<unknown>; })
      .then((value) => { if (active) setDataset(parseDataset(value)); })
      .catch((error: unknown) => { if (active) setLoadError(error instanceof Error ? error.message : "Evidence could not be read."); });
    return () => { active = false; };
  }, []);

  const supportActive = route.page === "case" && route.caseId.includes("supportdesk");
  const adminActive = route.page === "case" && route.caseId.includes("adminbench");
  return <div className="app-shell">
    <a className="skip-link" href="#main-content">Skip to evidence</a>
    <header className="topbar">
      <a className="brand" href="#/" aria-label="BrowserProof overview">
        <svg className="brand-mark" viewBox="0 0 38 38" aria-hidden="true"><rect x="1" y="1" width="36" height="36" rx="9" /><path d="M8 13h8m-8 12h8m6-12h8m-8 12h8" /><circle cx="19" cy="13" r="2.2" /><circle cx="19" cy="25" r="2.2" /><path d="M19 15.5v7" /></svg>
        <span>BrowserProof</span>
      </a>
      <nav className="primary-nav" aria-label="Evidence views">
        <a href="#/" aria-current={route.page === "overview" ? "page" : undefined}>Overview</a>
        <a href="#/case/supportdesk-faulted" aria-current={supportActive ? "page" : undefined}>SupportDesk</a>
        <a href="#/case/adminbench-vulnerable" aria-current={adminActive ? "page" : undefined}>AdminBench</a>
        <a href="#/compare" aria-current={route.page === "comparison" ? "page" : undefined}>Compare agents</a>
      </nav>
      <span className="recorded-badge"><i aria-hidden="true" />Static recorded evidence</span>
    </header>
    <main id="main-content" tabIndex={-1}>
      {!dataset && !loadError && <div className="page-state" role="status">Loading checked-in evidence…</div>}
      {loadError && <section className="page-state error-state" role="alert"><h1>Evidence could not be loaded</h1><p>{loadError}</p><p>The viewer requires a valid, checked-in dataset at <code>/demo/index.json</code>. No placeholder runs are shown.</p><a className="text-link" href="https://github.com/krishna31102004/browser-proof" target="_blank" rel="noreferrer">Review the source repository</a></section>}
      {dataset && route.page === "overview" && <Overview dataset={dataset} />}
      {dataset && route.page === "case" && <CasePage dataset={dataset} caseId={route.caseId} />}
      {dataset && route.page === "comparison" && <ComparisonPage dataset={dataset} />}
      {dataset && route.page === "not-found" && <UnknownPage path={route.path} />}
    </main>
    <footer className="footer"><span>BrowserProof · read-only evidence viewer</span><span>Recorded browser and backend observations · no hosted agent execution</span><a href="https://github.com/krishna31102004/browser-proof" target="_blank" rel="noreferrer">Source repository</a></footer>
  </div>;
}

function Overview({ dataset }: { dataset: DemoDataset }) {
  const refund = pickRefundCase(dataset.cases);
  const admin = pickAdminCase(dataset.cases, "vulnerable");
  const types = [...new Set(dataset.cases.map((item) => item.faultType).filter((item): item is string => Boolean(item)))];
  return <div className="page overview-page">
    <section className="hero-layout" aria-labelledby="home-title">
      <div className="hero-copy">
        <h1 id="home-title">One failure.<br /><em>Two refunds committed.</em></h1>
        <p className="hero-lede">BrowserProof shows what a browser agent saw beside what an independent backend ledger confirmed—then checks the outcome against its contract.</p>
        <div className="hero-actions"><a className="primary-action" href={refund ? `#/case/${encodeURIComponent(refund.id)}` : "#cases"}>Explore the recorded incident <span aria-hidden="true">→</span></a><a className="secondary-action" href="#/compare">Compare agent strategies</a></div>
        <p className="hero-scope">Static evidence from genuine local Playwright runs. The public site does not execute agents.</p>
      </div>
      {refund ? <IncidentStory item={refund} /> : <EmptyEvidence text="No faulted SupportDesk execution is available in this evidence set." />}
    </section>

    <section className="proof-strip" aria-label="What the evidence contains">
      <div className="proof-strip-intro"><span className="proof-mark" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M4 7h6m4 0h6M4 17h6m4 0h6M10 7l4 10" /></svg></span><p>Independent proof, in context</p></div>
      <div className="proof-stat"><strong>{dataset.cases.length}</strong><span>source-backed cases</span></div>
      <div className="proof-stat"><strong>{types.length}</strong><span>verified fault types</span></div>
      <div className="proof-provenance"><span className="ledger-key" aria-hidden="true" />Every committed effect comes from the controlled backend observer.</div>
      <time dateTime={dataset.exportedAt}>Evidence exported {formatDate(dataset.exportedAt)}</time>
    </section>

    <section className="method-strip" aria-label="How BrowserProof establishes an outcome">
      <div><span>Observe</span><p>Record the browser and agent’s actions.</p></div>
      <div><span>Verify</span><p>Query the controlled backend independently.</p></div>
      <div><span>Evaluate</span><p>Check committed effects against the contract.</p></div>
    </section>

    <section className="case-shelf" id="cases" aria-labelledby="case-index-title">
      <div className="section-heading"><div><h2 id="case-index-title">Follow the evidence</h2><p>Each view opens the recorded run, its real events, and its independently verified outcome.</p></div><span className="index-count">{dataset.cases.length} records</span></div>
      <div className="case-list">{dataset.cases.map((item, index) => <CaseRow key={item.id} item={item} index={index} />)}</div>
    </section>

    <section className="comparison-invitation" aria-labelledby="comparison-invitation-title">
      <div><h2 id="comparison-invitation-title">A stale index updates Alice.<br />A stable ID reaches Beacon.</h2><p>The AdminBench pair holds the same saved DOM reorder constant and changes the selection strategy. Both committed targets are verified from their own ledgers.</p></div>
      <div className="invitation-outcomes" aria-label="Observed AdminBench outcomes"><div><span>Vulnerable effect</span><strong className="target-wrong">{admin?.effects[0]?.entityId ?? "No confirmed target"}</strong><small>{admin?.contract.signature ?? "No contract signature"}</small></div><a className="primary-action" href="#/compare">Open the comparison <span aria-hidden="true">→</span></a></div>
    </section>
    <ReproduceSection item={refund} />
  </div>;
}

function IncidentStory({ item }: { item: ViewerCase }) {
  const milestones = refundMilestones(item);
  const [selected, setSelected] = useState<TimelineEvent | null>(null);
  return <section className="incident-story" aria-label="Featured SupportDesk response-loss incident">
    <div className="story-topline"><div><span className="section-kicker">SUPPORTDESK · RECORDED RUN</span><strong>{item.sourceRunId}</strong></div><StatusPill passed={item.contract.passed} status={item.status} /></div>
    <div className="story-outcome"><div><span>Independent backend ledger</span><strong>{item.effects.length} refunds committed</strong></div><div><span>At-most-once contract</span><strong>{item.contract.passed ? "Passed" : "Violation recorded"}</strong></div></div>
    <RefundStory item={item} milestones={milestones} selectedSequence={selected?.sequence ?? null} onSelect={setSelected} />
    {selected && <div className="story-inspector" aria-live="polite"><EventInspector event={selected} onClose={() => setSelected(null)} /></div>}
    <a className="story-full-link" href={`#/case/${encodeURIComponent(item.id)}`}>Open the full forensic record <span aria-hidden="true">↗</span></a>
  </section>;
}

type RefundMilestone = { event: TimelineEvent; annotation: string; sourceGroup: "Browser / agent" | "Independent ledger" | "Contract" };
function refundMilestones(item: ViewerCase): RefundMilestone[] {
  const commits = item.timeline.filter((event) => event.type === "backend.commit_confirmed");
  const failure = item.timeline.find((event) => event.type === "network.request_failed");
  const retry = item.timeline.find((event) => event.type === "agent.retry_reason");
  const contract = item.timeline.find((event) => event.type === "contract.evaluated");
  if (commits.length < 2 || !failure || !retry || !contract) return [];
  return [
    { event: commits[0]!, annotation: "First refund committed", sourceGroup: "Independent ledger" },
    { event: failure, annotation: "Browser received a failed response", sourceGroup: "Browser / agent" },
    { event: retry, annotation: "Agent chose to retry", sourceGroup: "Browser / agent" },
    { event: commits[1]!, annotation: "Second refund committed", sourceGroup: "Independent ledger" },
    { event: contract, annotation: item.contract.passed ? "Contract passed" : "At-most-once contract breached", sourceGroup: "Contract" },
  ];
}

function RefundStory({ item, milestones, selectedSequence, onSelect }: { item: ViewerCase; milestones: RefundMilestone[]; selectedSequence: number | null; onSelect: (event: TimelineEvent) => void }) {
  if (milestones.length !== 5) return <p className="story-unavailable" role="status">This evidence set does not contain the complete five-event response-loss sequence. Open the case to inspect the events that were recorded.</p>;
  return <div className="refund-story" role="region" aria-label="Refund response-loss story">
    <div className="story-lane-key"><span><i className="browser-key" />Browser / agent</span><span><i className="ledger-key" />Independent ledger</span></div>
    <ol className="story-steps">{milestones.map(({ event, annotation, sourceGroup }, index) => <li key={`${event.sequence}-${event.type}`}>
      <span className={`story-connector ${index === 0 ? "is-start" : ""}`} aria-hidden="true" />
      <button className={`story-step ${selectedSequence === event.sequence ? "is-selected" : ""} source-${event.source}`} type="button" aria-pressed={selectedSequence === event.sequence} aria-label={`Sequence ${event.sequence}: ${event.label}. ${annotation}. Show recorded event details.`} onClick={() => onSelect(event)}>
        <span className="step-meta"><span className="step-sequence">{String(event.sequence).padStart(2, "0")}</span><span>{sourceGroup}</span></span>
        <strong>{annotation}</strong>
        <small>{event.label}</small>
      </button>
    </li>)}</ol>
    <p className="story-help">Select a step to inspect its recorded timestamp and correlation IDs.</p>
    <span className="story-run-context">Run {item.sourceRunId}</span>
  </div>;
}

function CasePage({ dataset, caseId }: { dataset: DemoDataset; caseId: string }) {
  const item = dataset.cases.find((candidate) => candidate.id === caseId);
  if (!item) return <section className="page-state"><h1>That evidence record could not be found.</h1><p>The identifier is not present in the checked-in evidence bundle.</p><a className="primary-action" href="#/">Return to the evidence index</a></section>;
  const isAdmin = item.scenarioId.includes("adminbench");
  return <div className="page case-page">
    <div className="breadcrumb"><a href="#/">Evidence index</a><span aria-hidden="true">/</span><span>{isAdmin ? "AdminBench" : "SupportDesk"}</span></div>
    <section className="case-heading"><div><h1>{item.title}</h1><p className="lede"><span>{isAdmin ? "AdminBench" : "SupportDesk"} · {item.mode === "faulted" ? formatFaultType(item.faultType) : "clean execution"}</span><span className="policy-separator">·</span> Run <code>{item.sourceRunId}</code><span className="policy-separator">·</span> Agent policy <code>{item.agent}</code></p></div><StatusPill passed={item.contract.passed} status={item.status} /></section>
    <CaseOutcome item={item} />
    {isAdmin && <RecordOrder item={item} />}
    <section className="evidence-panel" aria-labelledby="timeline-title"><div className="section-heading evidence-heading"><div><h2 id="timeline-title">What the browser saw / what the backend confirmed</h2><p>Recorded source events remain in sequence. Select any event for its timestamp, payload, and linked IDs.</p></div><span className="observer-state"><i aria-hidden="true" />Observer: {item.observerStatus}</span></div><DualLaneTimeline item={item} /></section>
    <EvidenceExplorer item={item} />
    {item.screenshots.length > 0 ? <ScreenshotGallery screenshots={item.screenshots} /> : <section className="screenshot-section empty-screenshots"><h2>Captured browser view</h2><p>No screenshots were captured for this run. The recorded events and ledger result remain available above.</p></section>}
    <section className="case-summary-grid" aria-label="Case evidence summary"><div className="summary-box"><span className="section-kicker">REQUESTED</span><strong>{item.requestedEntity}</strong><span>{item.contract.name}</span></div><div className="summary-box"><span className="section-kicker">BACKEND COMMITTED</span>{item.effects.map((effect) => <strong key={effect.effectId}>{effect.entityId} <small>{effect.kind}</small></strong>)}<span>{item.effects.length} independently observed effect{item.effects.length === 1 ? "" : "s"}</span></div><div className="summary-box"><span className="section-kicker">CONTRACT VERDICT</span><strong>{item.contract.passed ? "Passed" : "Violation"}</strong><span>{item.contract.signature ?? `${item.contract.observedCount} observed effect(s)`}</span></div></section>
    <EvidenceFiles item={item} />
    <ReproduceSection item={item} />
  </div>;
}

function CaseOutcome({ item }: { item: ViewerCase }) {
  const isRefund = item.scenarioId.includes("supportdesk");
  return <section className={`case-outcome ${item.contract.passed ? "is-passing" : "is-violation"}`} aria-label="Recorded case outcome">
    <div><span>Browser / agent outcome</span><strong>{isRefund && item.mode === "faulted" ? "The refund response failed" : item.mode === "clean" ? "The request completed" : "The agent completed the action"}</strong></div>
    <span className="outcome-divider" aria-hidden="true">/</span>
    <div><span>Independent backend effect{item.effects.length === 1 ? "" : "s"}</span><strong>{item.effects.length ? item.effects.map((effect) => `${effect.entityId} · ${effect.kind}`).join("; ") : "No effect observed"}</strong></div>
    <div className="outcome-contract"><span>Contract</span><StatusPill passed={item.contract.passed} status={item.status} /></div>
  </section>;
}

function ComparisonPage({ dataset }: { dataset: DemoDataset }) {
  const vulnerable = pickAdminCase(dataset.cases, "vulnerable");
  const hardened = pickAdminCase(dataset.cases, "hardened");
  if (!vulnerable || !hardened) return <div className="page"><EmptyEvidence text="The checked-in dataset does not contain both sides of a verified AdminBench comparison." /></div>;
  const sameSchedule = Boolean(vulnerable.scheduleId && vulnerable.scheduleId === hardened.scheduleId);
  return <div className="page comparison-page"><div className="breadcrumb"><a href="#/">Evidence index</a><span aria-hidden="true">/</span><span>Compare agents</span></div>
    <section className="case-heading comparison-heading"><div><h1>Same reorder.<br /><em>Different record updated.</em></h1><p className="lede">AdminBench holds the same saved DOM change across both runs. The vulnerable policy trusted a stale position; the hardened policy resolved Beacon by stable ID.</p></div><span className={sameSchedule ? "schedule-match" : "schedule-mismatch"} role="status"><i aria-hidden="true" />{sameSchedule ? "Same saved schedule" : "Schedule mismatch"}</span></section>
    <div className="schedule-band"><span>Shared schedule</span><code>{vulnerable.scheduleId ?? "Missing schedule ID"}</code><span className="schedule-match"><i aria-hidden="true" />{sameSchedule ? "Matched in both runs" : "Does not match"}</span></div>
    <div className="comparison-grid"><AgentComparison item={vulnerable} label="Vulnerable · stale index" explanation="After the rows move, the previous position points to Alice." /><AgentComparison item={hardened} label="Hardened · stable ID" explanation="After the same reorder, the policy resolves Beacon by record ID." /></div>
    <section className="comparison-conclusion"><span className="conclusion-symbol" aria-hidden="true"><svg viewBox="0 0 32 32"><path d="M5 8h8m6 0h8M5 24h8m6 0h8M12 8l8 16" /></svg></span><div><h2>Same browser fault. Different committed target.</h2><p>The target is read from each independent effect ledger. The contract evaluates the requested record and final backend state.</p></div></section>
    <ReproduceSection item={hardened} />
  </div>;
}

function AgentComparison({ item, label, explanation }: { item: ViewerCase; label: string; explanation: string }) {
  return <article className={`agent-comparison ${item.agent === "vulnerable-index" ? "is-vulnerable" : "is-hardened"}`}><div className="comparison-title"><div><h2>{label}</h2><p>{explanation}</p></div><StatusPill passed={item.contract.passed} status={item.status} /></div><RecordOrder item={item} compact /><dl className="comparison-facts"><div><dt>Ledger target</dt><dd>{item.effects.map((effect) => effect.entityId).join(", ") || "No observed effect"}</dd></div><div><dt>Contract</dt><dd>{item.contract.passed ? "Passed" : item.contract.signature ?? "Violation"}</dd></div><div><dt>Final backend state</dt><dd>{item.finalState.map((record) => `${record.entityId} ${record.status}`).join(" · ")}</dd></div><div><dt>Fault injected</dt><dd>{item.faultType ?? "No fault"}</dd></div><div><dt>Source run</dt><dd><code>{item.sourceRunId}</code></dd></div></dl><a className="text-link" href={`#/case/${encodeURIComponent(item.id)}`}>Inspect this run <span aria-hidden="true">→</span></a></article>;
}

function RecordOrder({ item, compact = false }: { item: ViewerCase; compact?: boolean }) {
  const observation = item.timeline.find((event) => event.type.includes("observation"));
  const fault = item.timeline.find((event) => event.type.includes("fault") && event.type.includes("trigger"));
  const beforeRaw = observation?.payload.observedRowOrder ?? observation?.payload.originalOrder;
  const afterRaw = fault?.payload.mutatedOrder ?? fault?.payload.actualOrder;
  const before = Array.isArray(beforeRaw) ? beforeRaw.map(String) : [];
  const after = Array.isArray(afterRaw) ? afterRaw.map(String) : [];
  const target = item.effects[0]?.entityId;
  if (!before.length && !after.length) return <div className={`record-order ${compact ? "compact" : ""}`}><span className="source-note">No recorded row-order snapshot in this case.</span></div>;
  return <div className={`record-order ${compact ? "compact" : ""}`} aria-label="Recorded record order before and after the DOM change"><div className="order-state"><span className="order-label">Agent observed</span><ol>{before.map((id) => <li key={id} className={id === "beacon" ? "requested-row" : ""}><span>{recordName(id)}</span>{id === "beacon" && <small>requested</small>}</li>)}</ol></div><div className="order-transition"><span aria-hidden="true">↓</span>{fault ? "DOM reordered before action" : "No reorder recorded"}</div><div className="order-state"><span className="order-label">At action time · ledger target highlighted</span><ol>{(after.length ? after : before).map((id) => <li key={id} className={id === target ? "committed-row" : id === "beacon" ? "requested-row" : ""}><span>{recordName(id)}</span>{id === target ? <small>ledger target</small> : id === "beacon" ? <small>requested</small> : null}</li>)}</ol></div></div>;
}

function DualLaneTimeline({ item, compact = false }: { item: ViewerCase; compact?: boolean }) {
  const [filter, setFilter] = useState<EventFilter>("all");
  const [selected, setSelected] = useState<TimelineEvent | null>(null);
  const events = useMemo(() => filterEvents(compact ? keyEvidenceEvents(item.timeline) : item.timeline, filter), [item.timeline, filter, compact]);
  const browserEvents = browserLaneEvents(events);
  const backendEvents = backendLaneEvents(events);
  const browserKeys = new Set(browserEvents.flatMap(eventCorrelations));
  const backendKeys = new Set(backendEvents.flatMap(eventCorrelations));
  const linkedKeys = new Set([...browserKeys].filter((key) => backendKeys.has(key)));
  const rows = events.map((event) => ({ event, lane: browserEvents.includes(event) ? "browser" : "backend" as const }));

  return <div className={`timeline-wrap ${compact ? "timeline-compact" : ""}`}>
    {!compact && <div className="filter-bar" role="group" aria-label="Filter timeline events">{filterLabels.map(([value, label]) => <button key={value} type="button" className={filter === value ? "filter-chip selected" : "filter-chip"} aria-pressed={filter === value} onClick={() => { setFilter(value); setSelected(null); }}>{label}</button>)}</div>}
    {compact && <p className="key-event-note">Key events shown: {events.length} of {item.timeline.length} recorded events. Open the case for the full sequence.</p>}
    <div className="lane-headings"><span>Sequence</span><span><i className="lane-dot browser-dot" />Browser / agent</span><span><i className="lane-dot backend-dot" />Independent ledger / contract</span></div>
    <div className="timeline-rows" role="list" aria-label="Recorded execution timeline">
      {rows.map(({ event, lane }) => {
        const keys = eventCorrelations(event).filter((key) => linkedKeys.has(key));
        return <div className={`timeline-row ${selected?.sequence === event.sequence ? "active" : ""}`} role="listitem" key={`${event.sequence}-${event.type}`} data-event-sequence={event.sequence}>
          <div className="sequence-cell"><span>{String(event.sequence).padStart(2, "0")}</span><time dateTime={event.timestamp} title={event.timestamp} aria-label={`Recorded at ${formatDateTime(event.timestamp)}; exact timestamp ${event.timestamp}`}><span className="time-desktop" aria-hidden="true">{compact ? formatCompactTime(event.timestamp) : formatTime(event.timestamp)}</span><span className="time-mobile" aria-hidden="true">{formatMobileTime(event.timestamp)}</span></time></div>
          <div className={`lane-cell browser-cell ${lane === "browser" ? "has-event" : ""}`}>{lane === "browser" && <EventNode event={event} lane="browser" selected={selected?.sequence === event.sequence} onSelect={() => setSelected(event)} correlationKeys={keys} />}</div>
          <div className={`lane-cell backend-cell ${lane === "backend" ? "has-event" : ""}`}>{lane === "backend" && <EventNode event={event} lane="backend" selected={selected?.sequence === event.sequence} onSelect={() => setSelected(event)} correlationKeys={keys} />}</div>
        </div>;
      })}
      {events.length === 0 && <p className="empty-filter">No recorded events match this filter.</p>}
    </div>
    {linkedKeys.size > 0 && <p className="correlation-note"><span className="correlation-mark" />Matching chips carry real IDs recorded across sources. {linkedKeys.size} ID relationship{linkedKeys.size === 1 ? "" : "s"} shown.</p>}
    {selected && <EventInspector event={selected} onClose={() => setSelected(null)} />}
  </div>;
}

function EventNode({ event, lane, selected, onSelect, correlationKeys }: { event: TimelineEvent; lane: "browser" | "backend"; selected: boolean; onSelect: () => void; correlationKeys: string[] }) {
  return <button type="button" className={`event-node ${lane}-event ${eventTone(event.type)} ${selected ? "selected" : ""}`} onClick={onSelect} aria-pressed={selected} aria-label={`Sequence ${event.sequence}, ${event.source}: ${event.label}`} data-testid="timeline-event">
    <span className="event-heading"><span className="event-source">{sourceLabel(event.source)}</span><span className="event-sequence">#{event.sequence}</span></span><strong>{event.label}</strong>
    {correlationKeys.length > 0 && <span className="event-correlations">{correlationKeys.slice(0, 2).map((key) => <code key={key}>{key}</code>)}</span>}
  </button>;
}

function EventInspector({ event, onClose }: { event: TimelineEvent; onClose: () => void }) {
  return <aside className="event-inspector" aria-label="Selected event details"><div className="inspector-head"><div><h3>{event.label}</h3><p className="event-context">Sequence {event.sequence} · {sourceLabel(event.source)}</p><p className="evidence-basis">Evidence basis: {sourceBasis(event.source)}</p></div><button type="button" className="icon-button" onClick={onClose} aria-label="Close event details"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg></button></div><dl className="event-meta"><div><dt>Recorded time</dt><dd><time dateTime={event.timestamp} title={event.timestamp} aria-label={`Recorded at ${formatDateTime(event.timestamp)}; exact timestamp ${event.timestamp}`}>{formatDateTime(event.timestamp)}</time></dd></div><div><dt>Event type</dt><dd><code>{event.type}</code></dd></div>{event.agentStepId && <div><dt>Agent step</dt><dd><code>{event.agentStepId}</code></dd></div>}{event.actionId && <div><dt>Action ID</dt><dd><code>{event.actionId}</code></dd></div>}{event.requestId && <div><dt>Request ID</dt><dd><code>{event.requestId}</code></dd></div>}{event.effectId && <div><dt>Effect ID</dt><dd><code>{event.effectId}</code></dd></div>}</dl><details><summary>Allowlisted event payload</summary><pre>{JSON.stringify(event.payload, null, 2)}</pre></details></aside>;
}

function EvidenceExplorer({ item }: { item: ViewerCase }) {
  return <section className="evidence-explorer"><div className="section-heading"><div><h2>Open the recorded source files</h2><p>Sanitized evidence is published with this run. Paths and source IDs come from the checked-in record.</p></div><span className="source-note">Source run <code>{item.sourceRunId}</code></span></div><div className="evidence-links">{Object.entries(item.evidenceFiles).map(([name, path]) => <a key={name} href={path} target="_blank" rel="noreferrer"><span>{name}</span><strong>Open JSON <span aria-hidden="true">↗</span></strong></a>)}</div><p className="provenance-note">The timeline replays recorded events. Fresh-schedule reproduction applies the saved schedule again in a new browser context; it is a separate local CLI operation.</p></section>;
}

function ScreenshotGallery({ screenshots }: { screenshots: ViewerCase["screenshots"] }) {
  const [active, setActive] = useState<ViewerCase["screenshots"][number] | null>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!active) { trigger.current?.focus(); return; }
    closeButton.current?.focus();
    const containTabFocus = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const root = dialog.current;
      if (!root) return;
      const focusable = [...root.querySelectorAll<HTMLElement>("a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])")]
        .filter((element) => element.getAttribute("aria-hidden") !== "true" && element.getClientRects().length > 0);
      const first = focusable[0]; const last = focusable[focusable.length - 1];
      if (!first || !last) { event.preventDefault(); root.focus(); return; }
      const current = document.activeElement;
      if (!root.contains(current)) { event.preventDefault(); first.focus(); }
      else if (event.shiftKey && (current === first || current === root)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (current === last || current === root)) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", containTabFocus, true);
    return () => document.removeEventListener("keydown", containTabFocus, true);
  }, [active]);
  return <section className="screenshot-section"><div className="section-heading"><div><h2>Screenshots from this run</h2><p>Open a captured browser view to inspect the recorded page state.</p></div></div><div className="screenshot-grid">{screenshots.map((shot) => <button className="screenshot-thumb" type="button" key={shot.src} onClick={(event) => { trigger.current = event.currentTarget; setActive(shot); }} aria-label={`Open screenshot: ${shot.alt}`}><img src={shot.src} alt={shot.alt} loading="lazy" /><span>{shot.alt}</span></button>)}</div>{active && <div ref={dialog} className="lightbox" role="dialog" aria-modal="true" aria-label="Screenshot detail" tabIndex={-1} onKeyDown={(event) => { if (event.key === "Escape") setActive(null); }} onClick={(event) => { if (event.target === event.currentTarget) setActive(null); }}><button ref={closeButton} type="button" className="lightbox-close" onClick={() => setActive(null)} aria-label="Close screenshot"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg></button><figure><img src={active.src} alt={active.alt} /><figcaption>{active.alt}</figcaption></figure></div>}</section>;
}

function EvidenceFiles({ item }: { item: ViewerCase }) {
  const files = Object.entries(item.evidenceFiles);
  return <details className="file-details"><summary>Evidence file paths and provenance</summary><dl>{files.map(([name, path]) => <div key={name}><dt>{name}</dt><dd><a href={path} target="_blank" rel="noreferrer"><code>{path}</code></a></dd></div>)}</dl><p>Export provenance: genuine local Playwright execution. Run IDs and effect IDs link to the recorded artifact source.</p></details>;
}

function ReproduceSection({ item }: { item: ViewerCase | null }) {
  const [copied, setCopied] = useState(false);
  const isAdmin = Boolean(item?.scenarioId.includes("adminbench"));
  const policy = item?.agent === "vulnerable-index" ? "vulnerable" : "hardened";
  const command = isAdmin ? `pnpm bp regression --fixture regressions/adminbench-dom-reorder --agent ${policy}` : "pnpm bp verify";
  async function copy() { try { await navigator.clipboard.writeText(command); setCopied(true); window.setTimeout(() => setCopied(false), 1800); } catch { setCopied(false); } }
  const explanation = isAdmin
    ? policy === "vulnerable" ? "This fresh run applies the versioned DOM schedule. Exit 1 is expected only when the independent ledger confirms the wrong target and the safety contract fails." : "This fresh run applies the versioned DOM schedule to the hardened policy and requires a Beacon commit with a passing contract."
    : "This command generates new SupportDesk runs, checks the post-commit response-loss contract, and reproduces the saved fault schedule in three fresh browser contexts.";
  return <section className="reproduce-panel"><div><h2>Take the evidence further</h2><p>{explanation} This viewer remains static and read-only.</p></div><div className="command-box"><code>{command}</code><button type="button" onClick={copy} aria-live="polite">{copied ? "Copied to clipboard" : "Copy command"}</button></div><a href="https://github.com/krishna31102004/browser-proof" target="_blank" rel="noreferrer">Setup and prerequisites <span aria-hidden="true">↗</span></a></section>;
}

function CaseRow({ item, index }: { item: ViewerCase; index: number }) {
  return <a className="case-row" href={`#/case/${encodeURIComponent(item.id)}`}><span className="case-row-number">{String(index + 1).padStart(2, "0")}</span><span className={`case-icon ${item.contract.passed ? "pass" : "fail"}`} aria-label={item.contract.passed ? "Contract passed" : "Contract violation"}><svg viewBox="0 0 24 24" aria-hidden="true">{item.contract.passed ? <path d="m5 12 4 4L19 6" /> : <><circle cx="12" cy="12" r="8" /><path d="M12 8v5m0 3h.01" /></>}</svg></span><span className="case-row-main"><strong>{item.title}</strong><span>{item.scenarioId} · {agentLabel(item.agent)} · <code>{item.sourceRunId}</code></span></span><span className="case-row-result"><strong>{item.effects.length} effect{item.effects.length === 1 ? "" : "s"}</strong><small>{item.contract.passed ? "Contract passed" : "Contract violation"}</small></span><span className="row-arrow" aria-hidden="true">↗</span></a>;
}

function StatusPill({ passed, status }: { passed: boolean; status: string }) { return <span className={`status-pill ${passed ? "status-pass" : "status-fail"}`}><i aria-hidden="true" />{passed ? "Contract passed" : status === "contract_violation" ? "Contract violation" : status}</span>; }
function EmptyEvidence({ text }: { text: string }) { return <section className="page-state"><h1>Evidence set is incomplete</h1><p>{text}</p><a href="#/">Return to overview</a></section>; }
function UnknownPage({ path }: { path: string }) { return <section className="page-state"><h1>This evidence view does not exist.</h1><p><code>/{path}</code> is not an available route. The evidence set has not been changed.</p><a className="primary-action" href="#/">Return to the evidence index</a></section>; }
function formatDate(value: string): string { const date = new Date(value); return Number.isNaN(date.valueOf()) ? "date unavailable" : new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date); }
function formatDateTime(value: string): string { const date = new Date(value); return Number.isNaN(date.valueOf()) ? value : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" }).format(date); }
function formatTime(value: string): string { const date = new Date(value); return Number.isNaN(date.valueOf()) ? "—" : new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", fractionalSecondDigits: 3 }).format(date); }
function formatCompactTime(value: string): string { const date = new Date(value); return Number.isNaN(date.valueOf()) ? "—" : new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(date); }
function formatMobileTime(value: string): string { const date = new Date(value); return Number.isNaN(date.valueOf()) ? "—" : new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date); }
function sourceLabel(source: string): string { return source === "observer" ? "Observer" : source === "contract" ? "Contract" : source === "backend" ? "Backend" : source === "runner" ? "Runner" : source === "browser" ? "Browser" : "Agent"; }
function sourceBasis(source: string): string { return source === "observer" ? "independently queried control-plane ledger" : source === "contract" ? "typed contract evaluation" : source === "backend" ? "controlled backend event" : source === "runner" ? "runner-instrumented boundary" : source === "browser" ? "browser-visible request or outcome" : "agent action or observation record"; }
function eventTone(type: string): string { const normalized = type.toLowerCase(); if (normalized.includes("contract")) return normalized.includes("violation") ? "tone-breach" : "tone-contract"; if (normalized.includes("fault") || normalized.includes("failed")) return "tone-fault"; if (normalized.includes("commit") || normalized.includes("effect")) return "tone-effect"; if (normalized.includes("request") || normalized.includes("network")) return "tone-network"; return "tone-observation"; }
function keyEvidenceEvents(events: readonly TimelineEvent[]): TimelineEvent[] {
  const types = new Set(["agent.observation", "browser.click_attempt", "backend.commit_confirmed", "fault.triggered", "network.request_failed", "agent.retry_reason", "contract.evaluated"]);
  const seen = new Set<string>();
  return events.filter((event) => { if (!types.has(event.type)) return false; if (event.type === "agent.observation" && seen.has(event.type)) return false; seen.add(event.type); return true; });
}
function recordName(id: string): string { return id === "beacon" ? "Beacon" : id === "alice" ? "Alice" : id === "cirrus" ? "Cirrus" : id; }
function formatFaultType(type: string | null): string { return type === "commit_then_response_lost" ? "commit then response lost" : type === "dom_replace_after_observation" ? "DOM reorder after observation" : type ?? "unknown fault"; }
function agentLabel(agent: ViewerCase["agent"]): string { return agent === "vulnerable-index" ? "vulnerable index" : agent === "hardened-stable-id" ? "stable record ID" : "retry after browser failure"; }
function pickRefundCase(cases: ViewerCase[]): ViewerCase | null { return cases.find((item) => item.scenarioId.includes("supportdesk") && item.mode === "faulted") ?? null; }
function pickAdminCase(cases: ViewerCase[], agent: "vulnerable" | "hardened"): ViewerCase | null { return cases.find((item) => item.scenarioId.includes("adminbench") && item.mode === "faulted" && (agent === "vulnerable" ? item.agent === "vulnerable-index" : item.agent === "hardened-stable-id")) ?? null; }

createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);

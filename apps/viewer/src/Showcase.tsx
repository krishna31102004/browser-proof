import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TimelineEvent, ViewerCase } from "./data.js";
import { Icon } from "./icons.js";
import { Inspector } from "./Inspector.js";
import { formatDay, formatRelative } from "./presentation.js";
import { usePrefersReducedMotion } from "./router.js";
import { ProvenanceChip, StatusPill } from "./ui.js";

const STEP_AT = [0, 600, 1600, 2800, 4200, 5200, 6400];
const DONE_GAP = 1600; // 8,000 ms total
type Status = "idle" | "playing" | "paused" | "done";

interface Beat { n: number; lane: "browser" | "ledger"; title: string; text: string; event: TimelineEvent; related: TimelineEvent[] }

export function buildBeats(item: ViewerCase): Beat[] | null {
  const t = item.timeline;
  const requests = t.filter((e) => e.type === "network.request");
  const commits = t.filter((e) => e.type === "backend.commit_confirmed");
  const failed = t.find((e) => e.type === "network.request_failed");
  const contract = t.find((e) => e.type === "contract.evaluated");
  if (requests.length < 2 || commits.length < 2 || !failed || !contract) return null;
  const [r1, r2] = requests as [TimelineEvent, TimelineEvent];
  const [c1, c2] = commits as [TimelineEvent, TimelineEvent];
  const between = (types: string[], lo: number, hi: number) => t.filter((e) => types.includes(e.type) && e.sequence > lo && e.sequence < hi);
  return [
    { n: 1, lane: "browser", title: "Refund requested", text: "The agent clicks Refund. The browser sends the request.", event: r1, related: t.filter((e) => ["agent.action_proposed", "browser.click_attempt"].includes(e.type) && e.sequence < r1.sequence) },
    { n: 2, lane: "ledger", title: "First refund committed", text: "The observer finds refund 1 in the ledger.", event: c1, related: [] },
    { n: 3, lane: "browser", title: "Response lost", text: "The injected fault drops the reply. The browser records a failed request.", event: failed, related: t.filter((e) => e.type === "fault.triggered") },
    { n: 4, lane: "browser", title: "Second request sent", text: "The agent then retries. The browser sends another refund request.", event: r2, related: between(["agent.failure_observation", "agent.retry_reason", "browser.click_attempt"], failed.sequence, r2.sequence) },
    { n: 5, lane: "ledger", title: "Second refund committed", text: "The observer finds refund 2 for the same order.", event: c2, related: t.filter((e) => e.type === "network.response_delivered") },
    { n: 6, lane: "ledger", title: "Contract evaluated", text: "", event: contract, related: t.filter((e) => e.type === "backend.effects_observed") },
  ];
}

const browserReadout = (s: number) => s === 0 ? "Nothing yet" : s <= 2 ? "1 request in flight" : s <= 4 ? "1 failed request" : "1 failed request, then 1 success";
const tally = (s: number) => (s <= 1 ? 0 : s <= 4 ? 1 : 2);

export function Showcase({ item, sectionRef }: { item: ViewerCase; sectionRef?: (el: HTMLElement | null) => void }) {
  const beats = useMemo(() => buildBeats(item), [item]);
  const reduced = usePrefersReducedMotion();
  const [step, setStep] = useState(6);
  const [status, setStatus] = useState<Status>("idle");
  const [selected, setSelected] = useState<number | null>(null);
  const [announce, setAnnounce] = useState("");
  const timers = useRef<number[]>([]);
  const stage = useRef<HTMLDivElement>(null);
  const started = useRef(false);
  const statusRef = useRef<Status>("idle");
  statusRef.current = status;

  const clear = useCallback(() => { timers.current.forEach((id) => window.clearTimeout(id)); timers.current = []; }, []);
  useEffect(() => clear, [clear]);

  const schedule = useCallback((from: number) => {
    clear();
    const next = from + 1;
    for (let s = next; s <= 6; s += 1) timers.current.push(window.setTimeout(() => setStep(s), 600 + STEP_AT[s]! - STEP_AT[next]!));
    timers.current.push(window.setTimeout(() => { setStatus("done"); setAnnounce("Replay finished. 2 refunds committed. Contract violated."); }, 600 + STEP_AT[6]! - STEP_AT[next]! + DONE_GAP));
  }, [clear]);

  const play = useCallback(() => { if (reduced) return; started.current = true; setStep(0); setStatus("playing"); schedule(0); }, [reduced, schedule]);
  const pause = useCallback(() => { clear(); setStatus("paused"); }, [clear]);
  const resume = useCallback(() => { setStatus("playing"); schedule(step); }, [schedule, step]);
  const finish = useCallback(() => { clear(); setStep(6); setStatus("done"); }, [clear]);

  // Start once when 30% of the stage is visible; settle silently if it leaves the viewport mid-replay.
  useEffect(() => {
    const el = stage.current;
    if (!el || reduced || !beats || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.intersectionRatio >= 0.3 && !started.current && statusRef.current === "idle" && !document.hidden) play();
        else if (entry.intersectionRatio < 0.05 && statusRef.current === "playing") finish();
      }
    }, { threshold: [0, 0.05, 0.3] });
    io.observe(el);
    return () => io.disconnect();
  }, [reduced, beats, play, finish]);
  useEffect(() => {
    const onReplay = () => { if (!reduced) play(); };
    window.addEventListener("bp-replay", onReplay);
    return () => window.removeEventListener("bp-replay", onReplay);
  }, [reduced, play]);
  useEffect(() => {
    const onVis = () => { if (document.hidden && statusRef.current === "playing") pause(); };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [pause]);

  if (!beats) return <section className="container showcase-missing" ref={sectionRef}><p>This evidence set does not contain the complete response-loss sequence. <a href={`#/case/${encodeURIComponent(item.id)}`}>Open the case</a> to inspect the events that were recorded.</p></section>;

  const origin = beats[0]!.event;
  const rel = (e: TimelineEvent) => formatRelative(Date.parse(e.timestamp) - Date.parse(origin.timestamp));
  const seq = (e: TimelineEvent) => String(e.sequence).padStart(2, "0");
  const order = item.effects[0]?.entityId ?? "";
  const observed = item.contract.observedCount;
  const stepping = reduced;
  const live = status === "playing" || status === "paused" || (stepping && step < 6);
  const stateOf = (n: number): "pending" | "active" | "done" => (!live ? "done" : n > step ? "pending" : n === step && !stepping ? "active" : "done");
  const gapSeconds = (Date.parse(item.timeline.find((e) => e.sequence === beats[2]!.event.sequence + 1)?.timestamp ?? beats[3]!.event.timestamp) - Date.parse(beats[2]!.event.timestamp)) / 1000;
  const selectedBeat = selected !== null ? beats.find((b) => b.n === selected) ?? null : null;

  const onSelect = (n: number) => {
    if (selected === n) { setSelected(null); return; }
    if (status === "playing") { clear(); setStatus("paused"); setStep(n); }
    setSelected(n);
  };
  const stepTo = (s: number) => { setStep(s); setAnnounce(s === 0 ? "Step 0 of 6: before the request" : `Step ${s} of 6: ${beats[s - 1]!.title}`); };
  const onBeatKey = (event: React.KeyboardEvent) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    const all = [...(stage.current?.querySelectorAll<HTMLButtonElement>("button.beat, button.contract-bar") ?? [])];
    const i = all.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    all[(i + (event.key === "ArrowRight" ? 1 : -1) + all.length) % all.length]?.focus();
    event.preventDefault();
  };
  const toggleLabel = status === "playing" ? "Pause" : status === "paused" ? "Play" : "Play";
  const onToggle = () => { if (status === "playing") pause(); else if (status === "paused") resume(); else play(); };

  const beatBtn = (b: Beat) => {
    const s = stateOf(b.n);
    return <button type="button" key={b.n} className={`beat beat-${b.lane} beat-${b.n} is-${s}${selected === b.n ? " is-selected" : ""}${b.n === 3 ? " beat-fault" : ""}`} aria-pressed={selected === b.n}
      aria-label={`Step ${b.n} of 6, ${b.lane === "browser" ? "browser and agent" : "independent ledger"}: ${b.title}. Recorded sequence ${b.event.sequence}. Show event details.`} onClick={() => onSelect(b.n)}>
      <span className="beat-meta"><i className="beat-marker" aria-hidden="true" /><span className="mono">{seq(b.event)}</span><span className="mono muted">{rel(b.event)}</span>
        {(b.n === 2 || b.n === 5) && <span className="beat-m-icon" aria-hidden="true"><Icon name="arrow-down-right" /></span>}{b.n === 3 && <span className="beat-m-icon warn" aria-hidden="true"><Icon name="x-circle" /></span>}</span>
      <span className="beat-title">{b.title}</span><span className="beat-text">{b.text}</span>
    </button>;
  };
  const contractState = step >= 6 || !live ? (item.contract.passed ? "pass" : "fail") : "pending";
  const contractBeat = beats[5]!;

  return <div className="showcase panel" ref={(el) => sectionRef?.(el)}>
    <div className="showcase-head">
      <div className="showcase-outline">
        <ProvenanceChip>Recorded run · {formatDay(origin.timestamp)} UTC · replay, not live</ProvenanceChip>
        <p className="outcome-line"><span className="muted">Recorded outcome:</span> {item.effects.length} refunds committed. <span className="fail-text"><Icon name="x-circle" />Contract violated.</span></p>
      </div>
      <div className="showcase-controls">
        <div className="progress" aria-hidden="true">{[1, 2, 3, 4, 5, 6].map((n) => <i key={n} className={n < step ? "on" : n === step ? (live ? "cur" : "on") : ""} />)}</div>
        {stepping ? <>
          <button type="button" className="btn btn-secondary" disabled={step <= 0} onClick={() => stepTo(Math.max(0, step - 1))}><Icon name="chevron-left" />Previous step</button>
          <button type="button" className="btn btn-secondary" disabled={step >= 6} onClick={() => stepTo(Math.min(6, step + 1))}>Next step<Icon name="chevron-right" /></button>
          <span className="step-status">Step {step} of 6</span>
          {step < 6 && <button type="button" className="text-btn" onClick={() => stepTo(6)}>Show final state</button>}
        </> : <>
          <button type="button" className="btn btn-secondary" onClick={onToggle}><Icon name={status === "playing" ? "pause" : "play"} />{toggleLabel}</button>
          <button type="button" className="btn btn-secondary" onClick={play}><Icon name="rotate-ccw" />Replay</button>
        </>}
      </div>
    </div>

    <div className="stage" ref={stage} role="group" aria-label="Replay of a recorded refund incident" data-step={step} data-status={status} data-live={live ? "1" : "0"} onKeyDown={onBeatKey}>
      <div className="readout readout-browser"><p className="label">Browser saw</p>{[0, 1, 3, 5].map((s) => <p key={s} className={`readout-val${browserReadout(step) === browserReadout(s) ? " on" : ""}`} aria-hidden={browserReadout(step) !== browserReadout(s) || undefined}>{browserReadout(s)}</p>)}</div>
      <div className="readout readout-ledger"><p className="label accent-label">Ledger holds</p><p className="tally" aria-label={`${tally(step)} refunds`}>{[0, 1, 2].map((v) => <span key={v} className={tally(step) === v ? "on" : ""} aria-hidden={tally(step) !== v || undefined}>{v}</span>)}</p><p className="muted-sm">refund{tally(step) === 1 ? "" : "s"}{order ? ` for order ${order}` : ""}</p></div>
      <div className="legend" aria-hidden="true"><span><i className="beat-marker ring" />Browser and agent</span><span><i className="beat-marker solid" />Independent ledger</span></div>
      <div className="band band-browser" aria-hidden="true" /><div className="band band-ledger" aria-hidden="true" />
      <div className="lane-label lane-label-browser"><p className="label">Browser and agent</p><p className="caption">What the page and the agent observed</p></div>
      <div className="lane-label lane-label-ledger"><p className="label accent-label">Independent ledger</p><p className="caption">Queried by a separate observer</p></div>
      {beatBtn(beats[0]!)}{beatBtn(beats[1]!)}{beatBtn(beats[2]!)}
      <div className={`ledger-note${step >= 3 || !live ? " on" : ""}`}>Ledger unchanged: {tally(3)} refund</div>
      <div className={`gap-marker${step >= 3 || !live ? " on" : ""}`} aria-hidden="true"><span><b className="mono">{gapSeconds.toFixed(1)} s</b><em>later</em></span></div>
      {beatBtn(beats[3]!)}{beatBtn(beats[4]!)}
      <i className={`conn conn-a${step >= 1 || !live ? " on" : ""}`} aria-hidden="true" /><i className={`conn conn-b${step >= 3 || !live ? " on" : ""}`} aria-hidden="true"><Icon name="x-circle" /></i><i className={`conn conn-c${step >= 4 || !live ? " on" : ""}`} aria-hidden="true" />
      <button type="button" className={`contract-bar is-${contractState}${selected === 6 ? " is-selected" : ""}`} aria-pressed={selected === 6} aria-label={`Step 6 of 6, contract: Refund at most once. Recorded sequence ${contractBeat.event.sequence}. Show event details.`} onClick={() => onSelect(6)}>
        <span className="cb-main"><span className="label">Contract</span><strong>Refund at most once</strong></span>
        <span className="cb-detail">{contractState === "pending" ? "Limit 1. Not yet evaluated." : <>Limit 1. <span className="strong">Observed {observed}.</span></>}</span>
        <span className="cb-end"><StatusPill state={contractState} /><span className="mono muted">{seq(contractBeat.event)} · {rel(contractBeat.event)}</span></span>
      </button>
    </div>

    <p className="footnote">Events are shown in recorded order. The record shows the retry came after the lost response. It does not establish why the agent retried.</p>
    <span className="sr-only" role="status">{announce}</span>
    <div className="showcase-inspector">{selectedBeat ? <Inspector item={item} event={selectedBeat.event} related={selectedBeat.related} origin={origin} onClose={() => setSelected(null)} caseLink={`#/case/${encodeURIComponent(item.id)}?event=${selectedBeat.event.sequence}`} /> : <p className="muted">Select a step to see its recorded event.</p>}</div>
  </div>;
}

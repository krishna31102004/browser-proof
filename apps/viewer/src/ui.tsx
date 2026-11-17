import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "./icons.js";
import { LINKEDIN_URL, REPO_URL } from "./presentation.js";
import { routeKey, type Route } from "./router.js";

export function Mark({ size = 24, muted = false }: { size?: number; muted?: boolean }) {
  return <svg className={`mark${muted ? " mark-muted" : ""}`} viewBox="0 0 24 24" width={size} height={size} fill="none" aria-hidden="true" focusable="false">
    <path d="M8 19H6a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    <circle cx="7" cy="7" r="1.25" fill="currentColor" />
    <rect className="mark-ledger" x="10" y="10" width="12" height="12" rx="3" />
    <path className="mark-check" d="M13.25 16.25l2 2 3.75-4.25" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>;
}

export function SiteHeader({ route }: { route: Route }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const key = routeKey(route);
  useEffect(() => { setOpen(false); }, [key]);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { setOpen(false); button.current?.focus(); } };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);
  const links = <>
    <a href="#/evidence" aria-current={route.page === "evidence" || route.page === "case" ? "page" : undefined}>Evidence</a>
    <a href="#/compare" aria-current={route.page === "compare" ? "page" : undefined}>Compare</a>
    <a href="#/benchmark" aria-current={route.page === "benchmark" ? "page" : undefined}>Benchmark</a>
    <span className="nav-divider" aria-hidden="true" />
    <a className="nav-github" href={REPO_URL} target="_blank" rel="noreferrer" aria-label="BrowserProof on GitHub (opens in a new tab)"><Icon name="github" />GitHub</a>
  </>;
  return <header className="site-header">
    <div className="container header-row">
      <a className="brand" href="#/" aria-label="BrowserProof home"><Mark /><span>BrowserProof</span></a>
      <nav className="primary-nav" aria-label="Primary">{links}</nav>
      <button ref={button} type="button" className="icon-button menu-button" aria-expanded={open} aria-controls="site-menu" aria-label="Menu" onClick={() => setOpen((v) => !v)}><Icon name={open ? "x" : "menu"} size={20} /></button>
    </div>
    {open && <nav id="site-menu" className="mobile-menu" aria-label="Primary">{links}</nav>}
  </header>;
}

export function SiteFooter() {
  return <footer className="site-footer">
    <div className="container">
      <div className="footer-row">
        <a className="brand brand-small" href="#/" aria-label="BrowserProof home"><Mark size={20} /><span>BrowserProof</span></a>
        <nav className="footer-links" aria-label="Footer">
          <a href="#/evidence">Evidence</a><a href="#/compare">Compare</a><a href="#/benchmark">Benchmark</a>
          <a href={REPO_URL} target="_blank" rel="noreferrer" aria-label="GitHub (opens in a new tab)">GitHub</a>
          <a href={LINKEDIN_URL} target="_blank" rel="noreferrer" aria-label="LinkedIn (opens in a new tab)">LinkedIn</a>
        </nav>
      </div>
      <div className="footer-notes"><span>Built by Krishna Balaji. © 2026.</span><span>Static recorded evidence. Nothing on this site executes an agent.</span></div>
    </div>
  </footer>;
}

export function StatusPill({ state }: { state: "pass" | "fail" | "pending" }) {
  const label = state === "pass" ? "Contract passed" : state === "fail" ? "Contract violated" : "Pending";
  return <span className={`pill pill-${state}`}>{state !== "pending" && <Icon name={state === "pass" ? "check" : "x-circle"} />}{label}</span>;
}

export function Button({ href, children, variant = "primary", large = false, external = false, icon }: { href: string; children: ReactNode; variant?: "primary" | "secondary"; large?: boolean; external?: boolean; icon?: "arrow-right" | "arrow-up-right" | "github" }) {
  return <a className={`btn btn-${variant}${large ? " btn-lg" : ""}`} href={href} {...(external ? { target: "_blank", rel: "noreferrer" } : {})}>{children}{icon && <Icon name={icon} />}</a>;
}

export function Disclosure({ summary, children, className = "" }: { summary: string; children: ReactNode; className?: string }) {
  return <details className={`disclosure ${className}`}><summary><Icon name="chevron-right" />{summary}</summary><div className="disclosure-body">{children}</div></details>;
}

export function useCopy(): { copied: string | null; copy: (text: string, key?: string) => void; failed: boolean } {
  const [copied, setCopied] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const copy = (text: string, key = text) => {
    navigator.clipboard.writeText(text).then(() => { setFailed(false); setCopied(key); }, () => { setFailed(true); setCopied(key); });
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(null), 1800);
  };
  return { copied, copy, failed };
}

export function CommandBlock({ commands, label }: { commands: string[]; label?: string }) {
  const { copied, copy, failed } = useCopy();
  return <div className="command-block" role="group" aria-label={label ?? "Command"}>
    {commands.map((cmd) => <div className="command-row" key={cmd}>
      <pre className="command-code" tabIndex={0} aria-label={`Command: ${cmd}`}><span className="prompt" aria-hidden="true">$ </span><code>{cmd}</code></pre>
      <button type="button" className="btn btn-secondary btn-sm" onClick={() => copy(cmd)}>{copied === cmd ? (failed ? "Press Ctrl+C to copy" : <><Icon name="check" />Copied</>) : <><Icon name="copy" />Copy command</>}</button>
    </div>)}
    <span className="sr-only" role="status">{copied && !failed ? "Command copied" : ""}</span>
  </div>;
}

export function IdChip({ value, label }: { value: string; label?: string }) {
  const { copied, copy } = useCopy();
  return <button type="button" className="id-chip" title={value} aria-label={`Copy ${label ?? "identifier"} ${value}`} onClick={() => copy(value)}>{copied ? "Copied" : value.slice(0, 8)}</button>;
}

export function Breadcrumb({ items }: { items: Array<{ label: string; href?: string }> }) {
  return <nav className="breadcrumb" aria-label="Breadcrumb"><ol>{items.map((item, i) => <li key={item.label}>{item.href ? <a href={item.href}>{item.label}</a> : <span aria-current="page">{item.label}</span>}{i < items.length - 1 && <span className="crumb-sep" aria-hidden="true">/</span>}</li>)}</ol></nav>;
}

export function PageState({ title, children, role }: { title: string; children: ReactNode; role?: "status" | "alert" }) {
  return <section className="container page-state" role={role}><h1>{title}</h1>{children}</section>;
}

export function ProvenanceChip({ children }: { children: ReactNode }) { return <span className="prov-chip"><i aria-hidden="true" />{children}</span>; }
export function SectionHead({ label, title, intro, id }: { label?: string; title: string; intro?: ReactNode; id?: string }) {
  return <div className="section-head">{label && <p className="section-label">{label}</p>}<h2 id={id}>{title}</h2>{intro && <p className="lede-sm">{intro}</p>}</div>;
}

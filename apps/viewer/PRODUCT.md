# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

The primary users of the public evidence site are technical recruiters, software engineering hiring managers, and engineers reviewing a portfolio project, particularly at AFROTECH 2026. Automation engineers also use the viewer to investigate recorded runs and source evidence.

A recruiter should understand BrowserProof's purpose and the core failure within 10–15 seconds without a live explanation. Engineers should be able to continue from the overview into the complete forensic record.

## Product Purpose

BrowserProof tests browser agents against controlled browser and network faults, then compares what the browser and agent observed with committed effects independently queried from a controlled backend ledger. Success means a visitor can understand the failure and inspect the evidence that supports the conclusion.

## Positioning

The viewer's defining mechanism is its synchronized browser/agent and independently observed backend lanes, tied together by real event sequence numbers and correlation IDs, then evaluated against explicit contracts. Browser clicks, response status, screenshots, and agent claims do not establish committed effects.

## Operating Context

Visitors arrive anonymously at a public, static portfolio site. They may have no prior context, a phone at a conference, or more time to inspect the source-backed examples on desktop. The UI is recorded evidence playback; reproducing a saved schedule is a separate local CLI operation.

## Capabilities and Constraints

- The viewer is a read-only Vite/React/TypeScript static app that loads a checked-in, provenance-validated dataset.
- It presents five curated synthetic-data runs: two SupportDesk refunds cases and three AdminBench cases, including a vulnerable/hardened comparison under one saved DOM-reorder schedule.
- The two verified fault types are `commit_then_response_lost` and `dom_replace_after_observation`. The broader ten-fault plan and 36-case campaign are targets, not completed claims.
- The public deployment contains static evidence only. It has no hosted agent, runner, backend, payment endpoint, authentication, or live execution.
- All current cases, event sequences, source IDs, action/request/effect correlations, schedules, contracts, independently observed effects, source screenshots, and evidence downloads must remain true and available.
- No additional fault type, benchmark, backend, database, hosted runner, or unrelated roadmap feature belongs in this UI task.

## Brand Commitments

Use the name BrowserProof and precise, plain language. The presentation should feel like a premium software-engineering portfolio project, not generic SaaS marketing. Claims must be bounded by the checked-in evidence.

## Evidence on Hand

The current checked-in bundle at `public/demo/` contains five source-backed cases and provenance fingerprints. The README describes the local runner, independent ledger, contracts, and static evidence viewer. The public URL is `https://browserproof.vercel.app`.

## Product Principles

- Show the observed browser event and backend effect as distinct sources of truth.
- Lead with the concrete failure and its consequence, then let visitors inspect deeper evidence progressively.
- Preserve recorded values and sequence relationships exactly.
- Make public claims no broader than the evidence that can be opened and checked.
- Support keyboard use, clear responsive reading, and a useful path from a brief overview to technical detail.

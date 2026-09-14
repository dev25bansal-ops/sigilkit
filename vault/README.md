# `vault/` — deliberate keep, with a boundary (TD-8)

This directory holds 21 private research notes (competitive landscape, funding/bounty
strategy, risk plans, audit raw findings, build plans). They are **committed on purpose**,
not by accident:

1. The whitepaper's correction trail **links into them** — `docs/WHITEPAPER-v2.1.md`
   points at `vault/Whitepaper Corrections.md` as its evidence trail, and the README
   points at `vault/Risk & De-risk Plan.md`. Removing the directory would break
   published links.
2. They are the project's memory of *why* decisions were made (e.g. why E15 sliding-window
   damping was deliberately not built, why the audit route is Cantina/Sherlock).

**Boundary (the TD-8 decision):** research notes stay, but they are explicitly marked
non-normative. `docs/STATUS.md` records that the catalog + code win over vault notes
whenever anything disagrees. Nothing in this directory is a promise, a roadmap, or a
disclosure — it is working research, with dates in filenames where the date matters
(`Audit Raw Findings 2026-08-24.md`, `Comprehensive Analysis 2026-08-24.md`).

Before public launch, re-run this decision: if any single note is too sensitive to
publish (funding terms, named individuals), move that note — not the directory — to a
private repo and leave a tombstone link here.

# SigilKit — status source of truth (TD-4)

`docs/Issues-Catalog-2026-09-12.md` (42 items, 2026-09-12) is the **current and only
active planning document**. Everything else is historical context:

| Document | Status | Relationship to the active catalog |
|---|---|---|
| `docs/Issues-Catalog-2026-09-12.md` | **ACTIVE** — all 42 items addressed in code on 2026-09-12 | Source of truth. Supersedes the 09-11 catalog and audits the E1–E20 wave (19/20 built; E15 intentionally not built). |
| `docs/Issues-Catalog-2026-09-11.md` | SUPERSEDED — 23/24 closed 2026-09-11 | Historical. Its open item (A1: public repo + first CI run) is still open and is tracked here, not there. |
| `docs/Enhancements-2026-09-12.md` | SUPERSEDED — 19/20 implemented 2026-09-12 | Historical. E15 (sliding-window damping) was deliberately not built; see the catalog's INV-1 notes. |
| `docs/WHITEPAPER-v2.1.md` | CURRENT technical whitepaper (Sept 2026) | Product claims. Counts verified by `npm run check:docs`; audit-status warning is authoritative (SEC-1). |
| `vault/` (21 notes) | CONTEXT — private research, kept deliberately (TD-8) | Background for the whitepaper corrections trail. Not normative; when in doubt, the catalog + code win. |
| `CHANGELOG.md` | CURRENT release log | Normative per-release record. `[Unreleased]` §2026-09-12 lists what each catalog item changed. |
| `docs/CI-WAIVERS.md` | CURRENT waiver register (TD-6) | Every `continue-on-error` waiver with dated removal criteria. |

**Rule:** if two documents disagree, the catalog wins for *what was decided*, the code
wins for *what is true*, and this file wins for *which document to read*. Update this
file — not the superseded docs — when status changes.

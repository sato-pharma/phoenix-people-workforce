---
paths:
  - "src/lib/report-it/**"
  - "src/components/report-it/**"
  - "app/**/{report-it,pharmacovigilance}/**"
  - "tests/*report-it*"
---

# Module memory — Report It (pharmacovigilance — patient data)

**Scope:** Adverse-event reports (patient data, not HR), the pharmacovigilance desk and its export.

This file is loaded because this session opened a file of this module (or the module-memory hook matched the work to it). **It binds exactly like AGENTS.md.** First the module's rules, then every memory note filed under it: each note line is the cue, and the whole note is `.claude/cloud-context/memory-mirror/<name>.md` (identical to the laptop memory folder). **Before acting on a line that bears on your change, open its note.**

**Keeping it current:** a rule or fact you learn while working in this module goes into **Rules** below, in the same PR as the work. If a rule changed, EDIT its line — never add a second line that contradicts it. The notes block is generated (`node scripts/module-memory/build.mjs`); a new note reaches it through the fold, which runs three times a day — 09:00, 15:00 and 21:00 Cairo (docs/module-memory.md).

🔴 **A RULE BULLET OVER 1,200 BYTES MUST NAME ITS `docs/` ACCOUNT, or the required `validate` job goes RED** — `tests/agents-long-hooks-cite-docs.test.ts` measures every line starting `- ` inside the Rules block below, and this module file can sit far under its size cap while one bullet is over this limit. **Relocate FIRST, trim second:** write the evidence into a `docs/` file, then cut the bullet to the cue plus that pointer. Trimming first destroys the account while reading as a tidy-up. 🔴 **AND CITING docs/ IS NOT ENOUGH — the same test caps HOW MANY bullets may be over 1,200 at a tenth of all of them, which has about ONE bullet of slack**, so a long bullet reddens `validate` with its pointer in place (2026-10-04: 26 of 263 against a limit of 26.3). The fix is to shorten YOUR OWN long bullet, never to delete anyone's rule.

🔴 **PUT THE OPERATIVE CLAIM IN THE BULLET'S FIRST `**bold**` SPAN.** A session that never opens this file sees only that one span: `ruleHeadlines()` in `.claude/hooks/module-memory-injector.mjs` takes the FIRST `**…**` match per bullet (`/\*\*(.+?)\*\*/`) and nothing else, so a boundary, an exception or a date written in a later bold clause of the same bullet does not travel. A first span that states an absolute the rest of the bullet then qualifies is the worst case — it is read as the whole rule. 🔴 **Those spans are also the only thing that grows the pointer, which `tests/module-memory.test.ts` caps at 4,000 bytes (hard cliff 4,500) — a module that passes it is SPLIT, never trimmed** (`phoenix-crm` → `phoenix-crm-approvals`, 2026-10-03).

<!-- module-memory:rules:begin — hand-written; add this module's rules here -->
## Rules

- 🔴 **Every read of a report leaves a `report_it_audit_logs` row, or it is refused** (owner brief, 2026-11-13, REC-051) — `logReportRead` runs inside `getReport` and `listReports` and throws `Unavailable:` (503) when the insert fails. Never make it best-effort; a zero-row list writes nothing on purpose. Pinned by `tests/report-it-read-log.test.ts`.
- 🔴 **The read-all list is changed only through `phx_report_it_set_dashboard_access`** — the grant and its audit row are one transaction, service_role only. Managed by `report_it:export` holders (Super Admin, CEO, Finance Manager — owner, 2026-11-13) from the panel on `/admin/report-it`; only a current employee can be added. Never write `report_it_dashboard_access` directly.
- 🔴 **The owner of every new report is whoever holds `report_it_dashboard_access` — the QPPV today** (owner, 2026-11-13, REC-033). `readReportItOwners` (`src/lib/report-it/notify.ts`) reads the table at each notice; never hard-code a person, an HR id or an address. A `report_it:export` role reads every report but is NOT an owner and is not told. She follows open reports on her Report It desk (`ReportItDueDesk`, oldest due first) — never the Needs-you board. Pinned by `tests/report-it-lifecycle.test.ts`.
- 🔴 **The new-report notice carries NO patient data — reference, Cairo time and the desk link only** (owner, 2026-11-13). No patient name or initials, reaction, medicine, seriousness, outcome or submitter, in the email (durable outbox, one per report per owner) or the in-app notice; both run in `afterResponse`, and a failure is logged, never thrown to the submitter. `buildNewReportEmail` takes only those three facts.
- **A report is received → under assessment → closed, one step forward, no reopen** (owner, 2026-11-13). `report_it_reports_status_check` allows only those three; the old `submitted` became `received`. Due: 15 calendar days if serious, 90 otherwise (`REPORT_IT_DUE_DAYS`, nothing in the repo stated a rule). Only a read-all viewer moves a report, through `phx_report_it_set_status`, which writes the `status_changed` audit row in the same transaction.
- **A report is shape-checked before it is stored** (`reportPayloadRefusal`, 200 KB cap, 413 at the route) and a list read is capped at 100 rows (`boundedReportPage`). Every Report It route answers errors through `src/lib/report-it/http.ts`.
<!-- module-memory:rules:end -->

<!-- module-memory:notes:begin — generated by scripts/module-memory/build.mjs; do not edit -->
## Memory notes (2)

- `report-it-module-build` — Report It pharmacovigilance ADR reporting module — current build state, files, and pending steps
- `report-it-sounds-like-hr-and-is-patient-data` — "Report It" is the pharmacovigilance ADR register, not a staff grievance channel — and report_it:export is the read-EVERY-patient-report gate, held by three roles only
<!-- module-memory:notes:end -->

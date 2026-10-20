---
paths:
  - "src/lib/crm/kpis*"
  - "src/components/crm/kpis*"
  - "app/**/kpis/**"
  - "tests/*kpi*"
---

# Module memory — KPIs — the board, its three reports and the manager rows

**Scope:** The KPIs board: the Summary and the Frequency, Coverage and Call Rate reports, their filters and links, and the manager rows built by averaging the rows beneath each manager.

This file is loaded because this session opened a file of this module (or the module-memory hook matched the work to it). **It binds exactly like AGENTS.md.** First the module's rules, then every memory note filed under it: each note line is the cue, and the whole note is `.claude/cloud-context/memory-mirror/<name>.md` (identical to the laptop memory folder). **Before acting on a line that bears on your change, open its note.**

**Keeping it current:** a rule or fact you learn while working in this module goes into **Rules** below, in the same PR as the work. If a rule changed, EDIT its line — never add a second line that contradicts it. The notes block is generated (`node scripts/module-memory/build.mjs`); a new note reaches it through the fold, which runs three times a day — 09:00, 15:00 and 21:00 Cairo (docs/module-memory.md).

🔴 **A RULE BULLET OVER 1,200 BYTES MUST NAME ITS `docs/` ACCOUNT, or the required `validate` job goes RED** — `tests/agents-long-hooks-cite-docs.test.ts` measures every line starting `- ` inside the Rules block below, and this module file can sit far under its size cap while one bullet is over this limit. **Relocate FIRST, trim second:** write the evidence into a `docs/` file, then cut the bullet to the cue plus that pointer. Trimming first destroys the account while reading as a tidy-up. 🔴 **AND CITING docs/ IS NOT ENOUGH — the same test caps HOW MANY bullets may be over 1,200 at a tenth of all of them, which has about ONE bullet of slack**, so a long bullet reddens `validate` with its pointer in place (2026-10-04: 26 of 263 against a limit of 26.3). The fix is to shorten YOUR OWN long bullet, never to delete anyone's rule.

🔴 **PUT THE OPERATIVE CLAIM IN THE BULLET'S FIRST `**bold**` SPAN.** A session that never opens this file sees only that one span: `ruleHeadlines()` in `.claude/hooks/module-memory-injector.mjs` takes the FIRST `**…**` match per bullet (`/\*\*(.+?)\*\*/`) and nothing else, so a boundary, an exception or a date written in a later bold clause of the same bullet does not travel. A first span that states an absolute the rest of the bullet then qualifies is the worst case — it is read as the whole rule. 🔴 **Those spans are also the only thing that grows the pointer, which `tests/module-memory.test.ts` caps at 4,000 bytes (hard cliff 4,500) — a module that passes it is SPLIT, never trimmed** (`phoenix-crm` → `phoenix-crm-approvals`, 2026-10-03).

<!-- module-memory:rules:begin — hand-written; add this module's rules here -->
## Rules

Moved out of `crm` on 2026-10-20 so its injected pointer stays under the 4,000-byte margin `tests/module-memory.test.ts` enforces. **`crm` keeps every glob it had**, so a session working on these files loads both modules and nothing that used to arrive stops arriving.

- 🔒 **IN THE EMPLOYEE PORTAL, KPIs IS A SIDEBAR HEADING WITH A SUMMARY AND THREE REPORTS — Frequency, Coverage, Call Rate each have a page of their own** (owner, 2026-10-14). `/employee-portals/kpis` keeps only the consolidated tabs (`PORTAL_KPI_SUMMARY_TABS`) and FORWARDS a retired `?tab=` to its report; the admin shell is unchanged and still carries all seven tabs. The Call Rate report's Total view lays AM and PM side by side beside a count of calls — **never one blended rate**. Pinned by `runKpisReportsSplitTests`.
- 🔒 **THE KPI REPORTS FILTER BY ANY COLUMN AND BY ANY DOCTOR ON THE OPEN REP'S LIST** (owner, 2026-10-14: "filter by anything in any of the KPI reports"). Two levels, one URL builder: rep RANGES (`KpiFilterState.ranges`, `r_<column>=min..max`) and doctor filters (`KpiFilterState.doctor`, the `d…` params in `kpis-doctor-filters.ts`). 🔴 **A rep with nothing to measure on a column NEVER matches a bound on it** (no plan is not 0%), bounds read the figure as printed (one decimal), and the doctor filters narrow the PRINTED rows only — the tiles and breakdowns stay on the rep's whole list and add up to his row. The doctor params ride only on Coverage and Frequency, and opening a different rep starts his list unfiltered. Both filter modules import nothing server-side (client bar). Pinned by `runKpiRangeFilterTests`, `runKpiReportFilterUrlTests`, `runKpiDoctorFilterTests`, `runKpiReportFilterWiringTests`.
- 🔒 **IN THE PORTAL, EACH SUMMARY ROW LINKS INTO THAT REP'S REPORTS** (owner, 2026-10-14: polish the KPIs Summary page). `summaryReportLinks` puts Coverage, Frequency and Open visits under the rep's name (desktop `RepCell` action and the phone card); portal root only, doctor filters reset, Coverage/Frequency only for a rep with a measurable plan. Pinned by `runKpisReportsSplitTests` block 7.
- 🔒 **THE KPIs BOARD CARRIES A MANAGER ROW FOR EVERY MANAGER, BUILT BY AVERAGES** (owner, 2026-10-20: "every dm kpis is calculated based on his reps average and nsm based on dsms av and so on"). `buildKpiManagerRows` (`src/lib/crm/kpis-manager-rows.ts`) fills `board.managers`, never the rep table: a District Manager's row is the plain average of his own reps' printed rows; every manager above averages only the rows DIRECTLY beneath him (his managers plus any rep reporting to him straight), never all the reps at the bottom. Each of the twelve measures is averaged on its own — AM and PM are never blended — and a row printing "No plan", "No calls" or "No GPS feed" is left out of that measure, never counted as zero. Built from the scoped reps BEFORE any filter; rep rows, team totals and the podium are untouched. "Reports to" matches the whole chain (`managersAbove`). Pinned by `tests/kpis-filters.test.ts` (`runKpiManagerRowChecks`) and `tests/manager-filter.test.ts`.
<!-- module-memory:rules:end -->

<!-- module-memory:notes:begin — generated by scripts/module-memory/build.mjs; do not edit -->
## Memory notes (0)

_No notes filed under this module yet._
<!-- module-memory:notes:end -->

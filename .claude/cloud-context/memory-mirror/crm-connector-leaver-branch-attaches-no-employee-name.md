---
name: crm-connector-leaver-branch-attaches-no-employee-name
description: "Deduction candidates created for a LEAVER carry employee_name = NULL and render as the literal text \"Name unavailable\" — the CRM connector's employee lookups never select full_name"
metadata: 
  node_type: memory
  type: project
  originSessionId: de3d5355-ce2f-47ce-91e5-037397fd3f85
  modified: 2026-10-01T00:00:00.000Z
---

Every deduction candidate produced through the **leaver** path lands with `employee_name = NULL`,
and `src/components/admin/deductions-workspace.tsx` renders that as the literal string
**"Name unavailable"** — so the Pending screen shows an amount against a blank. That breaks the
owner's standing rule that human-readable names, never codes, appear in UI and chat.

**It is not the settlement code.** `src/lib/deductions/connectors/crm.ts` looks employees up three
times and every one selects `hr_id, crm_id, job_title, hire_date` — **never `full_name`**. The
active-rep path gets its name from the CRM visits mirror; the leaver branch has no equivalent, so
`recommendation.employeeName` is null and `service.ts:201` (`employee_name: draft.employeeName ?? null`)
faithfully writes the null. `insertCandidateDrafts` and `reconcileCandidateDrafts` share that mapping,
so switching paths does not help.

Proved on 2026-08-23 running the final-settlement scan for August's 12 eligible leavers: of 107
August candidates, `name_null` was **exactly 7** — the 7 the run created. The pre-existing 100 (the
neutralised 03 Aug accident) all had names because those people were active at the time. The
settlement path of [[one-part-employees-have-no-part-2-for-deductions-to-land-in]] is simply the
first thing that exercises the leaver branch in volume.

Backfilled those 7 in production with an `UPDATE … FROM employees` guarded on
`employee_name is null` (fill only, never overwrite) — `name_null` 7 → 0, `aug_total` unchanged at
107. **The code is still unfixed:** the next settlement run will reproduce it.

**July 2026 had 6 more, found 2026-08-23 and backfilled the same way** (`B-138`, `B-147`, `B-169`,
`B-171`, `B-176`, `B-178` — all leavers, all `created_by = 'B-10'`). Every one had an identical name
in **both** `employees.full_name` and `employee_resignations.employee_name`, so there was no
ambiguity to resolve. After: July 107 live rows / 104,461.56 EGP **unchanged**, `name_null` 6 → 0,
and **zero live candidates without a name in the whole table, any month**. Superseded rows were left
alone deliberately — they are dated records and they never render.

The guard trigger `deductions_candidates_guard_locked` is **BEFORE UPDATE only** and fires solely
when `old.locked_at is not null` AND a *value* column changes; `employee_name` is not in its list,
so a name backfill is permitted even on a published row, and an INSERT is unimpeded entirely.

**CORRECTION 2026-08-23 — this never reached the screen, and the earlier note above overstated it.**
`listCandidatesForMonth` merges an employees directory over every row before any consumer sees it
(`service.ts:927-933`), and that directory has **no status filter**, so leavers resolve fine. All
seven callers go through it — table, export, publish, automated-payroll, reconciliation. The
component's own comment says so: *"The name is resolved server-side … so this only guards the case
where the person genuinely has no name anywhere."* **"Name unavailable" was never rendered for any of
the 13.** The real damage was to the STORED record: `service.ts:931` treats the stored name as the
collection-time snapshot, and the leaver path never captured one — so a direct SQL read shows a bare
code, the snapshot is lost on a later rename, and every settlement run needs a hand backfill.

**FIXED AND LIVE IN PRODUCTION 2026-08-23** — PR #2343, squash-merged as `fe9308c5`, confirmed
serving by `/api/healthz` (`revision: fe9308c5…`), Railway deploy `SUCCESS`, production service
source branch verified still `main`. Adds `full_name` to the leaver employee select and threads it
through, trimming to null — a whitespace name is TRUTHY and would beat the directory fallback and
render blank, so `""`/`"   "` must collapse. Both new assertions were proved to fire by reverting
the fix, per the regression-test rule. **Future settlement runs store the name; the two hand
backfills should not be needed again.**

**Why:** the lesson that generalises is not "the UI broke" — it is that a NULL in a column with a
display-time fallback is invisible from the screen and only shows up in SQL. Check the stored value,
not the rendering.

**How to apply:** after any leaver-path deduction run, check
`select count(*) filter (where employee_name is null) from deductions_candidates where month = … and year = …`
before handing the month over for review. The real fix is to add `full_name` to the employee selects
in `crm.ts` and thread it into the leaver recommendation. Related:
[[how-to-attribute-a-production-write]], [[crm-door-resigned-exclusion-costs-a-contact-read-1100-doctors]].

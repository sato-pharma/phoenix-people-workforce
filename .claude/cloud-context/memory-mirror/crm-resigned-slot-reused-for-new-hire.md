---
name: crm-resigned-slot-reused-for-new-hire
description: "SETTLED - NOT A FINDING, do not re-raise (owner, 2026-09-21: 'this is correct'). The CRM admin DELIBERATELY reuses a resigned rep's CRM account/slot for the replacement hired into the SAME area+line, so a resolved agent_hr_id pointing at a resigned employee may belong to someone else BY DESIGN. Verify only the HANDOVER by hiring dates - no working visit may cross the leaver's last working date - then report the reuse as normal, never a defect. Two live traps: the hard-floor CRM_RESIGNED_AGENT_CRM_IDS list OUTRANKS employment_status and can hide an ACTIVE rep from the no-activity deduction detector (audit it whenever a rep looks idle; removing an id needs the owner); and writing employees.crm_id does NOT stamp existing rows - a later deep sync does. The visit_type -5 / contact_crm_id 0 row is a COMPANY-WIDE public-holiday stamp, not a handover artefact."
metadata:
  node_type: memory
  type: feedback
  originSessionId: acf84ee7-aa00-4fe6-a7e9-f2d84d29236f
  modified: 2026-09-25T22:55:45.845Z
---

**Reusing a resigned rep's CRM account for the replacement is CRM administration working as intended
— not a defect (owner, 2026-09-21: *"this is correct … check hiring dates"*, and again 2026-07-22).**
When an employee resigns and a replacement is hired into the same territory and line, the iReports360
admin manually overrides the resigned account onto the new hire — same `crm_id`, same data. So a
resolved `agent_hr_id` that points at a *resigned* employee **may belong to someone else entirely, by
design.** Do not re-open this as a finding; a deep audit "discovered" it on 2026-09-21 and the owner
closed it, asking why settled rules are re-litigated from scratch.

**The only thing to verify is the HANDOVER, by hiring dates:** no *working* visit may fall after the
leaver's `last_working_date`. A boundary-crossing row that is `visit_type -5`/`-6` is a holiday/leave
marker, not a visit (working days — see [[crm-visit-type-maps-there-are-three-not-two]]), so it does
not count as a crossing.

**Why the identity goes wrong:** `ireports360_visits.agent_hr_id`/`double_hr_id` are resolved at sync
time from `agent_crm_id`/`double_crm_id` against `employees.crm_id`. A stale resolution attributes a
NEW hire's genuine visit to the OLD resigned employee — the visit row is real, only the identity is
wrong. Cross-check the raw **`agent_name`** column (the CRM's own live display string, format
`"First.Last ( Area / Line )"`) against the resolved employee: a mismatch means the slot was
reassigned and the resolution is stale.

## Two live traps

- 🔴 **The hard-floor `CRM_RESIGNED_AGENT_CRM_IDS` list (`src/lib/crm/reads.ts`) OUTRANKS
  `employment_status`.** A reused slot left on it hides an **active** rep from Double Visit Analytics
  AND the Field Workforce Compliance matrix that feeds automated payroll's **no-activity deduction
  detector** — i.e. an invisible active rep is a candidate for a wrongful deduction against real
  salary. This list has been wrong the same way 8+ times (1477, 1102, 1395, 1521, 1247, 1523, 1166 …).
  **Audit the whole list against live employment whenever a rep looks impossibly idle, and removing an
  id needs the owner's confirmation — never edit it unilaterally:**
  ```sql
  select hr_id, full_name, employment_status, crm_id from employees
  where crm_id ~ '^[0-9]+$' and crm_id::int in (<the array>) and employment_status = 'active';
  ```
- 🔴 **Writing `employees.crm_id` does NOT attribute a single existing row.** Reads filter on the
  sync-stamped `agent_hr_id`; only rows a later sync re-reads get stamped (light poll = yesterday..
  today; the deep rolling run every 3h from 06:00 Cairo = today-10..today; older rows need the wide
  reconcile slice or the re-stamp routine in `sync.ts`). **Never tell the owner "visible now, no sync
  needed" after a mapping** — check `sync_runs` for a deep run started after the mapping's
  `employees.updated_at`.

## Fixing a reused slot, and the pre-hire artefact

- **If the slot is NOT on the hard-floor list, a two-row `employees.crm_id` write is enough** — no
  code change. `resolveLiveDepartedExclusion` self-heals (an active holder of the `crm_id` drops it
  from the departed scan), and tier-2 attribution is employment-gated (`isAttributableOn` blocks
  `visitDay < hireDate` **strictly**, so the hire date itself is attributable). **Order: release the
  leaver's `crm_id` FIRST** (`employees_crm_id_unique_idx` is unique-where-not-null across ALL
  statuses), then claim it. **Do NOT clear `crm_username` on the leaver** — clearing it once stranded
  587 visits. The `sync.ts` guard (~line 677) refuses to write a NULL over a good `agent_hr_id`, so
  the leaver's own history survives the release.
- **The cheapest reused-slot detector needs no name compare — a visit dated before its agent's hire
  date.** Nothing in the app runs it; re-run rather than re-derive:
  ```sql
  select count(distinct e.hr_id) people, count(*) visits,
         count(*) filter (where v.visit_type = -8) campaign
  from employees e join ireports360_visits v on upper(v.agent_hr_id)=upper(e.hr_id)
  where e.hire_date is not null and v.visit_date < e.hire_date;
  ```
- 🔴 **Never use CRM activity to date anyone's employment — the arrow only points the other way.**
  Visits reaching back before a rep's hire date are the *slot's* history, not evidence they worked
  unpaid. See [[reps-who-never-appear-in-any-salary-record]].

## The `-5` / `contact_crm_id 0` row is a COMPANY-WIDE public-holiday stamp

Not a handover signature, not an account-creation artefact (both earlier readings were wrong). The
CRM stamps one `visit_type -5` (Public Holiday) row against **every** account on the roster — working
and departed alike — on a holiday date. **Recognise it by the DATE, never the slot:** a date whose
row count collapses to roughly the agent count while `distinct_agents` jumps to the whole roster, with
`-5`/`contact_crm_id 0` on nearly every row. Such a row **stays unmapped** when it predates its
holder's hire date; `findPreHireMappingConflict` then refuses the admin mapping flow and offers two
wrong answers (map to the prior holder, or "correct" the hire date) — **neither**; leave it unmapped
(owner rule: *trust the hire date* — [[coaching-dates-legitimately-predate-the-hire-date]]).

## 🔴 One unresolved money fact — Omar Tamer's unpaid month (do not lose this)

Omar Tamer worked the **Tanta / Anti-Infective seat (slot 1399), 25 May – 24 June 2026, and was NEVER
PAID** — owner-confirmed 2026-08-23 (*"omar tamer worked that month"*). Verified four ways: no
`salary_records` row in any 2026 month, not in `automated_payroll_non_employees`, no `ats_offers` row
(his agreed pay is nowhere in the system), and zero `expense_claims` (202 field visits' transport/fuel
also unreimbursed). The seat's salary those months went to **Nada Elsharkawy `B-97`** (16,373 EGP each,
LWD 2026-06-28). His `AI-0010` record (hired 2026-09-01) is a re-hire that does not cover the stint.
**Do NOT infer the amount owed from the seat rate.** May/June batches are `locked` — settling this is
the owner's call and subject to [[never-fix-a-published-and-announced-month]].

## The meta-lesson this cost

**A settled rule's `description` must OPEN with the VERDICT** ("settled, not a finding"), or recall
surfaces it as a hazard and the next session runs an investigation instead of a recognition — which is
exactly what happened here on 2026-09-21. Same defect and same fix as
[[acting-dm-authority-is-app-role-not-job-title]]. Related:
[[campaign-visits-make-a-working-rep-look-like-a-zero]] ·
[[crm-boards-key-the-same-rep-two-different-ways]].

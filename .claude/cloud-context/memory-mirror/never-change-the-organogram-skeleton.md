---
name: never-change-the-organogram-skeleton
description: "OWNER RULE: never alter the organogram skeleton — seats, reporting lines, manager pointers — and never even propose it. Only the Super Admin initiates a structure change, by his own intent, never from an agent's suggestion."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 76790e1c-f7b7-4d3e-a6a2-edce4aff525f
  modified: 2026-08-22T13:54:28.833Z
---

**Owner's words, 2026-08-22: "Never change in the skeleton of organogram. Unless the super admin
did this by intent — not by suggestion from yours."**

The **skeleton** is the org structure itself:

- `au.seats` — seats, tiers, `parent_seat_id`, activation
- `au.occupancy_history` — who occupies which seat, and when
- `employees.manager_hr_id` — reporting lines
- anything that moves a person from one manager, seat, district, or region to another

**Do not change it. Do not propose changing it.** The prohibition covers the suggestion, not just
the act — an agent's recommendation is exactly what he ruled out. A structure change begins with the
Super Admin's own intent, expressed unprompted.

**Why:** he is **hiring into the vacant seats**. A vacancy is a role being filled, not a gap to be
patched by shuffling people underneath it. Reassigning reps to "cover" a vacancy silently rewrites
the org chart that the business, targets, and approvals all read from — and then the new hire
arrives to a structure nobody agreed to. The AU seat model is the source of truth for org structure
and vacancy data (AGENTS.md §4); rearranging it to make a report look tidier corrupts the very thing
the hire is measured against.

**What triggered the rule:** the Anti-Infective Upper Egypt 2 DM seat (`SEAT-AIF-DM-UE-2`) went
vacant when Ahmed Nashaat Ali Ahmed resigned 2026-08-03, and its four reps reassigned up to the NSM
Magdy El Senosey — **which is the designed behaviour**, see [[acting-dm-authority-is-app-role-not-job-title]].
I twice proposed re-homing those four (first by promoting Nosiba Salah Hussenin Moussa to full DM,
then by pointing their `manager_hr_id` at her). Both were rejected — the second in these terms. The
correct answer was **leave it alone; a hire is in progress.**

**How to apply:**
- A vacant seat is **not** a problem to solve. Report it, name who is covering in the interim, stop.
- Never end a reply by recommending a reassignment, a promotion, a seat move, or a manager-pointer
  change. Report the facts and let him decide.
- **HR-record fields are NOT the skeleton** and remain fair game with approval: `job_title`,
  `area_name`, contact details. Correcting Nosiba's `job_title` on 2026-08-22 was explicitly approved
  and changed no structure — the organogram renders its labels from **seat tier** via `TITLE_BY_TIER`
  (`src/lib/reports/organogram-au-source.ts:41`), never from `job_title`, so the chart was
  byte-identical before and after. Prove that distinction before touching anything adjacent.
- If a structure change is genuinely required by a task he asked for, **stop and say so** rather
  than making it.

Related: [[acting-dm-authority-is-app-role-not-job-title]] ·
[[organogram-chart-source-is-au-seat-model-not-directory]] ·
[[au-seat-drift-view-is-the-org-truth-check]] ·
[[a-third-of-target-carrying-territories-have-no-rep]] ·
[[organogram-has-two-data-paths-suppress-only-hits-vacancies]]

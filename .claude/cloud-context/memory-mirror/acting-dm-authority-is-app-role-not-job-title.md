---
name: acting-dm-authority-is-app-role-not-job-title
description: "SETTLED — NOT A FINDING, do not re-raise. A rep acting as District Manager is SUPPOSED to keep job_title 'Medical Representative' and take her authority from app_auth_users.role. An audit that surfaces this has found the design working, not a defect: report nothing, and never promote her title to fix visibility"
metadata: 
  node_type: memory
  type: project
  originSessionId: 76790e1c-f7b7-4d3e-a6a2-edce4aff525f
  modified: 2026-09-21T00:06:44.617Z
---

**A person's TITLE comes from THREE places. Fixing `job_title` alone changes almost nothing —
that mistake was made here on 2026-08-22 and reported as done before the other two were checked.**

| Shown where | Source | Skeleton? |
| --- | --- | --- |
| Organogram **chart** | `au.seats.seat_tier` → `TITLE_BY_TIER` (`organogram-au-source.ts:41`) | **YES — off limits** |
| Organogram **directory path**, people cards | `positions.title` via `employees.position_id`, **preferred over `job_title`** (`organogram-view-model.ts:492`, `positionTitle ?? jobTitle`) | no — HR field |
| HR record, payroll, exports | `employees.job_title` | no — HR field |

`ACTING_DM` and `DM` **both** map to "District Sales Manager" on the chart, so an acting DM reads as
a district manager there **no matter what her HR fields say** — and that is correct and must stay.
Changing it would mean changing her seat tier, which is the skeleton.

**Phoenix separates what someone IS from what they MAY DO, and only the second grants access.**

| | Column | Governs |
| --- | --- | --- |
| what she **is** | `employees.job_title` | HR data, payroll, headcount, how she appears |
| what she **may do** | `app_auth_users.role` | **every** `assertPermission(ctx, resource, action)` |

Nothing server-side reads `job_title` for access. `District Manager` is what grants
`team: ["read","export"]` — the authority to see a team — plus `leave: approve`,
`weekly_plans: approve`, `early_birds: approve`, `attendance` (full), `payroll: read`,
`direct_orders: approve` and ~18 more (`src/lib/auth/permissions.ts:758`).

**OWNER RULE (stated 2026-08-22, emphatically): a medical rep acting as a district manager stays a
medical rep.** She takes the *authorities* of a DM but "appear on system medical rep and everything
for him medical rep". **Do NOT promote her `job_title` to fix a visibility problem — the title was
never what was broken.** Do not propose promoting her to a real DM either; that was proposed and
rejected in those words.

**The live case — Nosiba Salah Hussenin Moussa (`B-1`), Anti-Infective Upper Egypt 1.** She holds
**two seats at once**, the only occupant who does: `SEAT-AIF-ADM-UE-1` (tier `ACTING_DM`, labelled
in the seat model itself "rep acting as DM") and `SEAT-AIF-REP-UE1` (tier `REP`, Minia 1) — she
still works her own territory. Her app role has been `District Manager` all along, so she could
always see her team. **Production had drifted her `job_title` to "District Sales Manager";
corrected to "Medical Representative" 2026-08-22 16:5x Cairo**, one row, guarded
`where hr_id='B-1' and job_title='District Sales Manager' and employment_status='active'`.
Verified after: app role still `District Manager`, both seats intact, both reports intact
(Aisha Ehab Mamdouh Hussein · Hanan Safwat), zero drift in `au_v_employee_seat_drift`.
**Her `position_id` was still `1` = "District Sales Manager" and OVERRODE the corrected job title on
the directory path — set to `2` = "Medical Representative" the same day** (position counts moved
DSM 18→17, MedRep 73→74). `positions` carries a nominal `line_id`/`area_id` that is **not** applied
to the employee — 73 reps shared position 2 across many areas — and holds no salary or grade column,
so the move had no payroll or territory effect; her `area_id` stayed `1123` (Minia 1).

**Safe to change a title this way.** Only one trigger fires on `employees.job_title`
(`phx_employee_terminal_vacancy_guard`) and it no-ops unless `employment_status` is
resigned/terminated/inactive. Field-force auto-provisioning is **app-level on the hire path**, not a
DB trigger — a direct title update does not fire it.

**The code already encodes all of this — read it before "fixing" anything:**
- `tests/portal-nav-acting-dm-uses-app-role.test.ts` names B-1 and asserts the sidebar follows the
  access role; `resolvePortalRole` tries the access role first, falls back to the title.
- `tests/early-birds-scope.test.ts:86` — "the acting DM reporting to him IS one of his districts,
  **even though she is titled a rep**".
- `src/lib/reports/organogram-au-source.ts:46` maps `ACTING_DM: "District Sales Manager"`, so the
  org chart still draws her on a district lane regardless of her title.
- `ACTING_DM` is a **first-class DM tier** for sales scope and attribution, not a gap:
  `seat-area-scope.ts:111`, `manager-attribution.ts:150`, `closing-publish-recipients.ts:36`.

**If the Super Admin ever asks to give an acting DM more reps, it is the REPS that move, not her** —
their `manager_hr_id` points at her, and her `District Manager` app role already covers whoever
reports to her. **Never initiate or suggest that** — moving a reporting line is the organogram
skeleton, which is off limits: [[never-change-the-organogram-skeleton]].

**Reassignment up to the NSM on a DSM resignation is DESIGNED, not a defect** — `team-calendar.ts:153`:
"when a DSM resigns, their reports get reassigned UP to the NSM until a replacement is hired". Do
not report that as a broken approval chain; it routes fine.

Related: [[changing-a-user-role-needs-four-writes]] · [[account-creation-defaults-role-to-employee]] ·
[[organogram-chart-source-is-au-seat-model-not-directory]] · [[au-seat-drift-view-is-the-org-truth-check]] ·
[[field-force-provisioning-live-and-guard-relaxed-2026-08-14]] ·
[[guard-every-prod-write-when-another-session-shares-the-queue]]

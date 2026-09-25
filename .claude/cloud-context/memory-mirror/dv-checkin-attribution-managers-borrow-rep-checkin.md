---
name: dv-checkin-attribution-managers-borrow-rep-checkin
description: "Managers (DM/TM/NSM) log no CRM visits or GPS check-ins of their own; the rep submits and tags them, so a manager's route/check-in = the REP's check-in. Apply system-wide."
metadata: 
  node_type: memory
  type: reference
  originSessionId: c95b0eb4-5da2-4ad7-8fff-cca41372c27a
  modified: 2026-08-01T20:19:37.055Z
---

**Owner-stated business rule — apply SYSTEM-WIDE (2026-08-01).** District Managers, Training
Managers — any manager — have **no contact list** and do **not** hand-enter their own CRM visit
records. On a **double visit** the **rep** enters his own CRM record and tags the manager as the
double-visitor, so the visit shows up in the manager's (`double_crm_id`) records **but the manager
never submitted it**. The ONE exception: a **triple visit**, where the DM hand-submits a record
tagging HIS manager (the National Sales Manager).

**Consequence for GPS check-ins / routes:** a manager logs **no check-ins of his own**. The GPS
check-in always belongs to the **rep** (the visit's `agent_crm_id` / submitter). To show a
manager's route or check-in time you must **map the rep's check-in onto the double-visitor and the
triple-visitor**.

**Where this bites:** any code that fetches a person's check-ins by *their own* `agent_crm_id`
shows managers with an EMPTY route/no check-ins (wrong — was the "why is the map empty for A-7"
symptom). Correct approach: for a person, the check-in owners each day = the `agent_crm_id`s of the
visits where that person is the `double_crm_id` (plus their own, for the triple-visit case) — query
THOSE reps' check-ins and attribute them to the manager, ideally labelled "via <rep>".

Verified 2026-08-01: A-7 (crm 1234, a manager) had **0** own check-ins on Jun 14; the rep he
double-visited (crm **1483**) had **4** mappable check-ins.

Applied first in `src/lib/crm/visit-workload.ts` (Expense Approvals workload evidence, PR #1598).
**STILL TODO:** `src/lib/crm/rep-day.ts` (FWC visits page `/admin/field-workforce-compliance/visits/[hrId]/[date]`). Its *visit* query is already correct (`.or(agent_crm_id.eq.X,double_crm_id.eq.X)`, line 288) but it then filters check-ins with `checkin.agentID === agentId` (line 235) → the manager gets visits but an EMPTY route. **CORRECTION (re-verified 2026-08-01):** `double-visit-analytics/service.ts` does NOT have this bug — case-insensitive grep for `checkin` returns 0 matches there. Its separate real defect is the *visit source*: `getDoubleVisitExpenseWorkloadEvidence` reads the double-visit mirror, so a rep's SOLO field days go missing. Don't conflate the two. Related: [[cairo-timezone-audit-round2-2026-08-01]] (CRM timestamps are already Cairo — don't shift check-in/save times).

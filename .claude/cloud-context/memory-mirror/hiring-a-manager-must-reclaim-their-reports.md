---
name: hiring-a-manager-must-reclaim-their-reports
description: "Resignation pushed reports UP and nothing ever brought them back — a newly-hired NSM had 0 direct reports. Fixed + drift detector, 2026-08-05"
metadata: 
  node_type: memory
  type: project
  originSessionId: 10e06afa-c79f-4b2e-a156-1458a3d6b0b7
  modified: 2026-08-05T06:40:49.327Z
---

**Resignation was a ONE-WAY move.** `phx_release_terminal_manager_ownership` reassigns a departing
manager's reports UP to the next manager and stamps `pending_manager_replacement_for_hr_id` so a
replacement can re-inherit them. **Nothing ever performed that re-inheritance.** Refilling the seat
left every report stranded at the higher manager, permanently.

Found live 2026-08-05:
- **AI-0008 (Magdy El Senosey) was hired into `SEAT-AIF-NSM` and had ZERO direct reports** while
  running the entire Anti Infective line.
- All 5 AIF DMs + the acting DM still reported to the CEO (**AA**), whose direct-report count was
  inflated to **21**.
- 12 active employees carried markers naming **B-157** and **B-175**, both long resigned.

This is not cosmetic: `employees.manager_hr_id` drives **approval routing**, team visibility and
hierarchy scoping — a stranded report sends its approvals to the wrong person.

**Fixed in PR #1747 (merged `3bfbb81c`), migration `20260805030000`, applied to BOTH DBs:**
- `trg_au_reclaim_reports_on_manager_hire` on `au.occupancy_history` — hiring into a seat reassigns
  the occupants of every CHILD seat to the new manager and clears their marker. Never fails the
  hire (exception-swallowed); never makes an acting DM their own manager.
- `public.au_v_employee_seat_drift` — the detector. Flags area id/name, region code, manager, and
  stale markers per seated active employee. **Reported 0 drift across all 103 after the fix.**
- One-off correction of the 11 stranded rows applied by hand under owner approval, each audited as
  `employee_manager_reassignment` with before/after. Result: Magdy 0→**11**, CEO 21→**10**.

**The nuance that matters — don't "simplify" it away:** the marker is cleared ONLY when the
employee's own manager seat is occupied. The 5 Upper Egypt 2 reps KEEP their `B-175` marker
because `SEAT-AIF-DM-UE-2` is genuinely vacant; that marker is what makes reporting views group
them under the vacant DM seat instead of rendering them as direct NSM reports.

**Acting-DM self-parent trap:** an ACTING_DM occupies both the manager seat and their own rep seat
beneath it, so that rep seat's "manager" resolves to themselves (B-1 / Nosiba). Both the trigger
and the detector explicitly exclude self-management. The detector's first version flagged her as
drift — a false positive, correctly fixed in the rule rather than in the data.

**Still open (owner's call, both deliberately untouched):**
1. `VAC-PEDIA-CAIRO-DOWNTOWN-SHOUBRA-MR` — an open vacancy for a Pedia rep in Down town, an area
   Pedia has no seat for. Create the seat or cancel the vacancy. **Owner DEFERRED this 2026-08-05
   ("skip downtown now") — do NOT re-raise it as urgent; it blocks only that one hire.**
2. 7 AIF Upper Egypt reps carry region_name "Upper Egypt" while their seats say "Upper Egypt 1/2".
   Narrowing the label to match the seat is *more* correct, BUT sales fact rows still carry the
   coarse **UE**, and the Phase A bridge expands UE downward, not upward — so narrowing could
   create a new blind spot. Needs the sales-side vocabulary settled first.

Closes the series with [[seat-is-now-a-foreign-key-of-the-hiring-ledger]] and
[[org-visibility-and-seat-vanish-diagnosis-2026-08-04]].

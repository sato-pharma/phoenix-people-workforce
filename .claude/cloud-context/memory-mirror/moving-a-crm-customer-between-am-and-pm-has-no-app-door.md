---
name: moving-a-crm-customer-between-am-and-pm-has-no-app-door
description: "A Phoenix CRM customer's AM/PM list type can only be changed by SQL — nothing in the app edits it — and the value is COPIED onto the plan item and the visit at capture, so a move is four tables plus a `list_type_changed` audit event."
metadata:
  node_type: memory
  type: project
  originSessionId: ee35f02f-28ec-4203-94bc-19b0b160975c
  modified: 2026-10-03T17:55:31.781Z
---

**There is no screen, route or RPC that changes `phoenix_crm_customers.list_type`.** It is written
once, at creation — `server/list.ts` (add a customer / validate outside) and `server/list-template.ts`
(the SFE's sheet upload) — and never again. `phoenix_crm_rename_customer` edits the name and the
phone only. So a mis-filed AM/PM comes to a session as a direct production write (§8 pre-authorizes
it; announce and show the pre-image).

**The value is COPIED, not joined, so one UPDATE is not enough.** `list_type` lives in four places,
and different screens read different ones — `day-detail.ts` and `team-calendar.ts` read the VISIT's
copy, `monthly-plans.ts` and plan-vs-actual read the PLAN ITEM's, the list board reads the
CUSTOMER's:

| Table | What it is |
| --- | --- |
| `phoenix_crm_customers` | the list entry |
| `phoenix_crm_plan_items` | copied at save — `check (list_type in ('AM','PM'))`, no `Pharmacy` |
| `phoenix_crm_visits` | copied at capture |
| `phoenix_crm_list_requests` | copied on an add/drop/grade request |

`phoenix_crm_countable_visits` is a VIEW over `phoenix_crm_visits` and follows by itself. Leave one
copy behind and the halves disagree silently — the AM · PM · Pharmacies golden rule counts them
apart, so the wrong half is a wrong figure on two boards with nothing red anywhere.

**Check the caps before moving a plan item** (`phoenix_crm_settings`: `pm_daily_cap` 15,
`am_daily_cap` 5) — `resolvePlanItems` only tests the days a save touched, so a direct write bypasses
every check. And **check the monthly frequency target changes**: `grade_targets` is AM A=1 / PM
A=3 B=2 C=1, so an A moving AM→PM triples his required visits for the month.

**`phoenix_crm_list_events` has no `event_type` CHECK constraint**, and manual fixes have their own
types there by precedent (`visit_locations_restamped`, and the function-written `customer_renamed` /
`grade_changed`). Nothing in `src/` reads the table, so a new type breaks no screen — file the move
as `list_type_changed` with `from`/`to`, the reason, and the row ids touched.

**Done once: مستشفي المهدي** (Private Hospital, grade A, `SEAT-PED-REP-D11`, pedia, B-100 Mohamed
Ahmed Mohamed Hassan Salem) moved AM→PM on 2026-10-03 at the owner's instruction — customer + 1 plan
item (Sat 3 Oct, approved week) + 1 visit. The tell was the place's own hours: 16:00 on Wed and Sat,
and its only visit logged at 17:42 Cairo. A sweep of all 18 active AM customers with captured places
found no other one whose hours start after 12:30, so this was the only mis-filing.

Related: [[a-pharmacy-check-in-counts-as-the-pharmacy-visit]].

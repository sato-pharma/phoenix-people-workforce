# The Regional Sales Manager's team reports

Owner, 2026-11-08. Dr. Hany Saad, the Regional Sales Manager (Pedia, Alex-BHR · Delta (1) · Delta (2)), sent eight
needs about his team: the district managers under him and the reps under them. The owner's instruction: build every
partial one "exactly as he wants, exactly 100%", in the Regional Sales Manager account only, with one shortcut per
report on his overview landing page, in words Phoenix already uses.

## Who opens them

`readsRegionalTeamReports` (`src/lib/phoenix-crm/server/access.ts`) is true only for a viewer holding a manager seat
of tier `RSM`. Every new page and the Weekly Sheet export check it on the server before any read: any other seat,
the CEO's login included, is sent back to the portal home, and the export answers 403. The loaders ask it again. His reach is `regionalTeamRepSeats`: the REP seats in his `scopeTerritories`.

## The eight needs and where each lives

| # | His need | Page | Code |
| --- | --- | --- | --- |
| 1 | The reps' plans | Reps List → Reps weekly plans | already built |
| 2 | Yesterday's and today's visits, with the times entered | Visits — Yesterday and Today (`/employee-portals/team-visits`) | `server/team-visits.ts` |
| 3 | Plan coverage | KPIs → Coverage | already built |
| 4 | Last month's coverage, who was not covered, visit frequency | KPIs → Coverage and Frequency, previous month | already built |
| 5 | The district managers' plans: is anyone else with the rep that day | District Managers' Plans (`/employee-portals/district-manager-plans`) | `server/manager-plan-bookings.ts` |
| 6 | When planning with a district manager, whom that manager goes with and visits | Plan your week in Phoenix CRM: his own board (`/employee-portals/field-crm?tab=plan`) | `buildBoard` in `server/manager-plans.ts` |
| 7 | A weekly sheet: 50 PM and 10 AM a week, 3 doctors of each speciality in every account | Weekly Sheet (`/employee-portals/weekly-sheet`) + Excel | `src/lib/crm/weekly-sheet.ts` |
| 8 | The ROI of the requests in his region | ROI Tracking | `resolveRegionRouteScope` in `roi-report-scope.ts` |

The landing tiles are `src/lib/employee-portal/regional-team-reports.ts`, drawn by `RmCommandCenter` under
"My Team's Reports".

Every shortcut on his landing to "his plans" opens his Phoenix CRM board (`RSM_PLAN_BOARD_HREF`), the older
Dashboards row's "Region Plans" included. `/employee-portals/plans` is the old form's read-only history.

## Visits — Yesterday and Today

- Every rep under his district managers, grouped by district manager.
- AM · PM · Pharmacies are counted APART, through validated customers only. Pharmacies are distinct names per day,
  the team calendar's rule. A visit to an unvalidated customer is "waiting" and counts in no figure.
- Each visit shows its Saved-at time: `captured_at`, Cairo, 12-hour. A visit copied from the old CRM recorded no
  time and says so.
- "Today" is the visit day (`viewer.visitDay`, which runs to 02:00 Cairo); yesterday is the day before it.
- A district manager's own visits sit in the district manager's row and count in no rep's figure.
- **No location column is selected.** The far-visit and place-vs-actual evidence is not the Regional Sales
  Manager's (`readsPlaceVsActual`).

## Chain visits on the plans

Same rep, same day, two of the rep's managers is a **chain visit, shown neutrally** (the owner's planning-calendar
rule of 2026-10-24, applied word for word). It is information only: it never blocks a save and never colours a
half-day as a problem. The words are `chainVisitLine`: "Chain visit — <name> (<title>) is also with <rep> this day".

- Read from every planner kind's SENT `with_rep` halves (`isManagerPlanSent`). A draft is nobody's booking.
- The old weekly plan form is not read: its last plan was written on 24 October 2026.
- Shown on District Managers' Plans, beside each rep in his own board's picker (`ManagerBoardDay.repNotes`, loaded
  only when `writer.kind === "rsm"`; a failed read is logged and the lines are left out), and under each half of a
  district manager's week in the approvals view (`halfNotes`, for a Regional Sales Manager viewer only).
- On District Managers' Plans a week the district manager has not sent reads "Not sent yet"; the draft is not shown.

## The district manager's own day on his board

When he picks a district manager for a day, his board shows that district manager's own plan for the day. It is the
panel #155 built for the "With a district manager" half (`districtManagerDays`, `server/manager-dm-day.ts`), drawn
under the day's district manager picker too, and not twice when the half is "With a district manager". That panel
shows the week as it stands, a draft included, with its status said (the owner's rule for #155).

## The Weekly Sheet

- The field week, Saturday to Wednesday (`isCallRateWorkingDay`; Thursday and Friday are not working days).
- Targets are per WORKING day: 10 PM and 2 AM, so a full week is exactly 50 and 10. Approved leave and national
  holidays come out of the target, as on Call Rate. If the holiday calendar or leave cannot be read, the page says
  a target may be a day too high.
- It opens on the last finished Saturday-to-Wednesday week; Next week moves on.
- A seat nobody sits on has no target and no working days, and reads "No target · seat is vacant", never "Below"
  (`weeklySheetResult`, shared by the screen and the Excel).
- Account depth is **read from the AM visit comments** (`comment` + `detail_comment`, the week combined), because a
  visit to an account records the account, not the doctors met. The owner's answer when asked: "check from their
  comments if you find good, if not pull the data you can". On 8 November 2026, 1,288 of 2,362 AM visits in 28 days
  named a doctor or a speciality.
- The parser is `src/lib/crm/account-doctor-notes.ts`, pure. Columns: Pediatrics, Internal Medicine / GP (GP and
  ممارس join Internal Medicine, as Dr. Hany wrote), ENT. Other specialities are read and kept out. An account is
  "Met" at 3 or more in each column.
- A comment naming no doctor reads "No doctors written in the comment", never 0.
- It says "doctor" on purpose. Phoenix CRM screens say "customer", but these are Dr. Hany's own words, and the owner
  asked for them exactly.
- The Excel export (`weekly-sheet-workbook.ts`, `/api/crm/weekly-sheet/export`) wears the house identity and
  re-derives nothing.
- A Thursday notice was planned and **dropped**: Dr. Hany never asked for one, and it would have needed a new
  scheduled job in about six registries.

## ROI of the requests in his region

The Medical Rep's territory route, widened to his whole team. Only the login role "Regional Manager" runs it (on
8 November 2026, one login: Dr. Hany). `resolveRegionRouteScope` takes:

- the `area_id` of every ACTIVE employee his chain reaches (never his own seat, never a leaver's old patch), and
- his own seat line.

It feeds the same `visibleAreaIds` + `visibleAreaLineNames` pair that `territoryRouteAdmitsRequest` reads, so the
report, View Sales, the export and the filter options all agree. **Both halves or nothing**: an area is shared by
every line (`public.areas.line_id` is NULL), so the line half is what keeps another line's spend out.

On 8 November 2026 every Pedia request on his 16 areas was already raised by his own team, so the route added no
row that day. It matters the day someone outside his chain, a product manager for example, spends on Pedia in his
areas. The same scope also feeds the Manager Scorecard, the ROI Business Report and the live tracker, which only
regroup rows ROI Tracking already admits; the Case File keeps its stricter `canSeeMarketingRequest` check.

Pinned by `tests/regional-team-reports.test.ts`.

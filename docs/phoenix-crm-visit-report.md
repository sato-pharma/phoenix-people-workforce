# Phoenix CRM — the Visit report generator

Account behind the one-line cue in `.claude/rules/phoenix-crm-boards.md` (owner, 2026-10-15).

## Who reads it

- **Super Admin and SFE Manager** across the company, at `/admin/phoenix-crm/visit-report`.
- **A district manager (or acting district manager) across his own team**, at
  `/employee-portals/visit-report`, in the portal shell — his navigation mode is `employee-portal`, so an
  admin-shell address would bounce him. His sidebar row rides the Place checks flag (the same two seat
  tiers).
- `canReadVisitReport` (Super Admin, SFE Manager, or `readsTeamVisitReport`) gates both pages, both routes
  and the loader — a redirect on a page, a 404 elsewhere.
- **A page of its own, never a tab of `PhoenixCrmApp`.** The tabs are the component tree the rep's app
  renders; the report shows where named people's phones were, so one wrong role check inside that tree
  would show a rep that anything was measured (Golden Rule #1).
- A district manager's reach is `readableSeats`: his scope, less an acting district manager's own rep
  seat. A rep or district outside it answers with the same 404 sentence as one that does not exist.

## Three sights in `visit-report-fields.ts`

`manager` (the default), `sfe`, `superAdmin`.

- The district manager is offered **95 of the 113 fields**. He never gets the 17 `sfe`-sight ones — the
  measurement behind a distance (accuracy, phone clock, a place's accuracy, where its point came from), per
  "District Managers see the distance only" (2 Oct 2026), plus the integrity cases, the device telemetry and
  the speed that come from silent tables — nor `mockDevice`.
- A field added without a sight is a district manager's, so give it one when it is not. The test pins the
  exact hidden list.
- The owner first answered "hide nothing the SFE Manager can see" and, shown the conflict with the two
  rulings (the 2 Oct distance-only ruling and the integrity board being Super Admin and SFE only), chose
  **keep the two rulings** on 2026-10-15. Never widen the 17 without his word naming them.
- `mockDevice` is the one `superAdmin`-sight field. `resolveVisitReportSelection` drops it, and
  `loadVisitReportEvidence` never queries a position case or selects `device_mocked` for the SFE Manager, so
  it is ABSENT from his answer, not blank.

## One loader, one truth

Only the CHOSEN categories' side tables are read. The screen, the dashboard and the one-tab workbook all
come from the same loader, so the file cannot hold a field or a visit the screen would refuse.

The order, gap and speed fields come from save times: they carry their reading note, are never flagged, and
the speed uses only the phone's own reading times (owner, 2 Oct 2026).

Pinned by `tests/phoenix-crm-visit-report.test.ts`.

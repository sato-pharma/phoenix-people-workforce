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

- The district manager is offered **97 of the 115 fields**. He never gets the 17 `sfe`-sight ones — the
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

## The 16 Oct 2026 audit fixes

The owner asked for a deep audit of the report on 16 Oct 2026 and then for five of its findings to be fixed.

- **Whose visit it is.** A visit with no rep on it is a manager's own single visit, and it is the
  manager's. The loader asks `personOnTheVisit` (rep first, then manager), the integrity board's own rule.
  It never falls back to the seat's occupant. That fallback printed 13 of the 25 such visits on production
  under the name of the rep whose territory they were on, and the other 12 as "Unknown rep" on vacant
  seats. It also put them into that rep's day order, gaps, route line and "Visits per rep" panel. The field
  is now labelled **Who visited**, the table column **Who**, and the tile and panel say *person*. The
  `· N reps` count still counts reps only. The day sequence is keyed on the person, never the seat.
- **The on-screen read is rate limited and audited.** The access registry declared the POST audited, but
  nothing wrote a row: there were 0 rows against 6 for the workbook. The route now runs
  `assertApiRateLimit` first (20 a minute; the workbook allows 10). After the read it writes a
  `phoenix_crm_visit_report_view` audit row past the response, so a logging failure never refuses a reader.
- **The map is built once.** A pin click or a day change redraws the markers on the existing map. Before,
  every one built a new map, which reloaded the tiles and lost the reader's pan and zoom. The view is
  fitted again only when the day or the shown visits change. Markers are numbered, and routes drawn, per
  person per day.
- **Two wording errors.** The page headings count the fields the viewer is actually offered
  (`visitReportFieldsFor(scope.sight).length`) instead of a hard-coded 113. The real totals are 115 in all
  and 97 for a district manager. A visit the Super Admin entered later for a rep (`isEnteredForRep`, 18 on
  production) reads *No location: entered later by the Super Admin*, the wording every other screen uses,
  instead of "No validated place".

Pinned by `tests/phoenix-crm-visit-report.test.ts`.

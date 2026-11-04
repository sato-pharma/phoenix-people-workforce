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

- The district manager is offered **97 of the 116 fields**. He never gets the 18 `sfe`-sight ones — the
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
- **A district manager keeps "Validation decided by" and "Validation note or refusal reason"** (owner, 2026-11-01).
  Asked directly after Place checks stopped sending a manager the decider's name, he answered "Keep it" for the name
  and, for the note, that the rep's manager can see the decider's comment. This is the one place a manager can read
  who decided. Do not take it for a leak and remove it without his word.

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
  (`visitReportFieldsFor(scope.sight).length`) instead of a hard-coded 113. The real totals were 115 in all (116 since Sent late (min) joined on 3 Nov 2026)
  and 97 for a district manager. A visit the Super Admin entered later for a rep (`isEnteredForRep`, 18 on
  production) reads *No location: entered later by the Super Admin*, the wording every other screen uses,
  instead of "No validated place".
- **A district manager never reads "Weak signal".** Under the 2 Oct 2026 distance-only ruling, anyone below
  the Super Admin and the SFE Manager reads a weak reading as *At the place*, as on the approval cards and
  the place report (`readsLocationDetail`). The report had printed "Weak signal" to district managers on 7
  visits, in the table, the location field and the dashboard. The owner added this fix to the same PR the
  same night.

## The 16 Oct 2026 additions

After the audit the owner asked for the three improvements it recommended, plus saved views ("make a save
view for someone to save his fav choices"). Asked in chat, he answered four questions, each with the
recommended option except the third.

- **The Excel file always starts with Visit date · Who visited · Customer name** ("Always lead with
  them"). This reverses the 15 Oct "only the chosen and filtered data" ruling for these three columns
  alone: a file of distances or approval notes with no date and no name on each line cannot be read on
  its own. A ticked lead field moves to the front and is never printed twice; an unticked one takes the
  row's own head (`row.visitDate`, `row.repName`, `row.customerName`), which every row carries for every
  reader. The three sit under one band, "The visit". The screen's table already led with them.
  `VISIT_REPORT_LEAD_KEYS`, `visitReportWorkbookColumns`.
- **Three ready-made sets** — Daily activity, Location, Off-plan approvals (`VISIT_REPORT_STARTER_SETS`).
  Each is cut to the reader's sight by `visitReportStarterFields`, so a district manager's Location set
  holds the distance and the far / at-the-place wording and none of the 17 `sfe`-sight fields. A set
  only ticks boxes; Apply still runs the report.
- **The last choice is remembered in the browser.** With no link to reopen and no fields in the address,
  the last applied choice is ticked on arrival. It lives in `localStorage` under
  `phoenix-crm:visit-report:last-fields`, every read and write is inside a `try`, and the page works the
  same without it. It is a convenience only; saved views are the durable store.
- **Result filters** — who visited, one day, planned or unplanned, and the position against the place
  (far first, a visit with no position as a choice of its own). One pure matcher,
  `src/lib/phoenix-crm/visit-report-filters.ts`, narrows the table, the map and the dashboard
  (`narrowVisitReportView` works the count, the days, the "recorded on X of Y" counts and every panel out
  again from what is left). The download link carries the same four filters, and the workbook route
  narrows through the same function before it builds the file, so what is on screen is still what is in
  the file. The subtitle and the export's audit row say what it was narrowed to. Filters only remove
  visits from an answer the loader already shaped, so they cannot widen what a reader sees. A new Apply
  starts unnarrowed.
- **Saved views are their owner's only, and hold fields only** ("Only its owner", "Fields only").
  Table `phoenix_crm_visit_report_views` (migration `20261017001000`), keyed on the viewer's canonical
  HR id AND `is_test` — a test login carries the HR id of the real person it mirrors, so without the
  flag the two would share one list. `src/lib/phoenix-crm/server/visit-report-views.ts` takes no owner
  argument anywhere, so nobody, the Super Admin included, lists or deletes another person's views. The
  same name saved again replaces that view; at most 20 per person; a name is at most 60 characters. The
  field keys are cleaned against the reader's sight on save AND on read. The route
  (`/api/phoenix-crm/visit-report/views`, GET · POST · DELETE) is gated by `canReadVisitReport` with the
  report's own 404, and a save or a delete writes a `phoenix_crm_visit_report_saved_view` audit row past
  the response.

## One doctor or account (4 Nov 2026)

A team asked whether the system can follow the visits to one doctor over a period, so that the rep, or whoever takes
the territory after a rep leaves, can see where things stand with that doctor. The owner asked for it on the Visit
report: "filter by rep or area then filter by dr or polyclinic and get the mentioned report".

- **The picker.** Once a rep or a district is chosen, a **Customer** list appears under it (the CRM says AM and PM, never doctor or account, on its screens)
  (`loadVisitReportCustomers`, GET `/api/phoenix-crm/visit-report/customers`). It lists that territory's customers
  that are on the list, waiting for validation or met outside it. Campaign-visit holders and dropped customers are
  left out, but a link that names a dropped customer still opens. Across a district each name also says whose
  territory it is on. It sits behind the report's own door and gives the same 404s.
- **The read.** With a customer chosen, the visits are read by `customer_id` on the seat, not by the person. Every
  rep who held the territory is in the history, which is the point: the next rep reads the last one's products,
  objections, next steps and comments. `resolveReportCustomer` gives a 404 for a customer who is not on the chosen
  seats, in the same words as for one that does not exist. A manager's report refuses a customer.
- **A year.** One customer gets a few visits a month, so the period may run up to 365 days
  (`VISIT_REPORT_MAX_DAYS_CUSTOMER`), and **Last 3 months** and **Last 12 months** buttons appear. Without a
  customer, the 92-day and 31-day limits stay as they were.
- **The day order stays true.** Visit number in the day, the gap and the distance from the previous visit still
  describe the whole day. The other visits of each day the customer was seen are read for the sequence alone and
  never become rows. Their phone-clock times are read by visit id, never a whole year of the seat's.
- **Customer history** is the fourth ready-made set. It holds the date, who visited, the manager and product manager
  on the visit, the customer, list, speciality, grade and place, the products detailed, samples, the objection and
  its note, the next step and its date, the comment, the detailed comment, and the days since the last visit. A
  district manager gets the whole set.
- The title, the Excel file's name and the audit rows read "customer · rep or district". The link and the download
  carry the same `customer`, so the screen and the file still match.

Pinned by `tests/phoenix-crm-visit-report.test.ts`.

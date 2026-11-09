# Visits — Yesterday and Today — premium pass, 9 November 2026

Visits — Yesterday and Today is the Regional Sales Manager's page at `/employee-portals/team-visits`, the second of
the reports under My Team's Reports. Dr. Hany Saad asked for it on 8 Nov 2026: yesterday's visits and today's, and the
times they were entered. On 9 Nov 2026 the owner asked for a premium pass on every one of those reports: "eyeball
every report in My Team's Reports, premium polish big work, every single component", then "group reps by district
manager". This file covers what the page shows after that pass and where each figure comes from. Who may open it and
the counting rules it shares with the other team reports are in `docs/regional-team-reports.md`.

## What a Regional Sales Manager sees, top to bottom

1. **The toolbar.** It shows the two dates, a line saying that today is still running, and **Download Excel**.
   - **Judge by** (Yesterday / Today so far) picks the day the two narrowing filters read.
   - **Show** (Every rep / Saved visits / No visits saved) narrows the reps listed. Each choice prints the number of
     reps it would list.
   - **Order** (Territory / Most doctor visits / Earliest first visit) sorts the reps inside each team, on the
     "Judge by" day. Ties fall back to territory then name. In "Earliest first visit" a rep with no timed visit comes
     last, never first.
   - The filter lives in the address (`?show=none&day=today&sort=first`) and is read strictly. Anything else means
     every rep, judged by yesterday, in territory order.
   - **A notice when a day on the screen is not a field working day.** The field week is Saturday to Wednesday, the
     call rate's own weekday rule (`isCallRateWorkingDay`). On a Saturday morning "yesterday" is a Friday, and the
     line says so, so a team of zeros does not read as a team that did nothing. National holidays are not read here.
2. **Four tiles.**
   - Yesterday's doctor visits.
   - Today's doctor visits so far.
   - Reps who saved a visit yesterday ("x of y").
   - Visits waiting for validation, both days.

   The tiles always count the whole team, whatever the filter.
3. **Today so far against yesterday at this time.** Today's saved visits, set against what yesterday had saved by the
   same minute of its own visit day, and the difference as a count. It is printed only while today's visit day is
   running. With two teams or more, a second table under it gives the same comparison team by team. The rows add up
   to the figures above. A team whose seats are all vacant says "Every seat is vacant" instead of printing zeros.
4. **The teams side by side.** One line per region and district manager, for both days:
   - doctor visits;
   - AM · PM · Pharmacies;
   - how many reps saved a visit;
   - doctor visits per rep who saved one;
   - the first and last saved time.

   A team's name jumps to its section. The panel shows only when there are two teams or more.
5. **When the visits were saved.** Two-hour blocks, both days. The blocks add up to the visits that carry a time. A
   visit copied from the old CRM has no time and is counted on its own line.
6. **The district managers' own visits.** What each district manager saved in person. These visits are counted in no
   rep's figure and in none of the tiles. A team with nobody in the district manager's seat says so.
7. **Reps to look at.** For the "Judge by" day, three lists:
   - reps in a seat who saved nothing (a day on approved leave or recorded admin work is accounted for, never here);
   - reps whose every visit is still waiting for validation;
   - every rep with a visit waiting, and how many.

   These are facts, with no rank and no verdict. A vacant seat never appears here. A name jumps to that rep's own row
   (on a phone, to the rep's card), but only when the row is on the page under the current filter.
8. **The jump list.** One link per team.
9. **One section per region and district manager**, as before (`groupByRegionAndManager`). The changes in this pass:
   - Vacant seats keep their rows in a light colour of their own (owner, 9 Nov 2026), after the reps. Each says
     "Seat is vacant · nobody to count on either day" instead of rows of zeros. A filter lists reps only, so it
     leaves them out.
   - When the district manager saved no visits, their own row prints one quiet line, "Visits made alone · none saved".
     Before, it printed "0 AM · 0 PM · 0 Pharmacies" over "No visits saved".
   - Each rep's square adds the first and last saved time and the span between them.
   - Today's square adds what that rep had saved yesterday by this time.
   - A **day strip** runs from 7 AM to midnight, with one mark per saved visit. AM is deep blue, PM mid blue, a
     pharmacy slate, and a visit waiting for validation amber.
   - Each visit still waiting for validation carries the tag "Waiting for validation", so the "waiting" figure
     points at real rows.
   - On a phone, a day with more than four visits folds its list behind "Show the N visits" (a native `<details>`,
     no script), so a long day does not bury the next rep. The figures, the timeline and the strip stay open.

## The rules every figure follows

- **AM · PM · Pharmacies stay three figures.** "Doctor visits" means AM + PM, validated, and nothing else.
  Pharmacies are distinct pharmacies in a day, which is the team calendar's rule. A visit to a customer not yet
  validated is counted only as waiting. Its time is still listed and tagged.
- **The visit day runs from 02:00 to 02:00 Cairo** (`VISIT_DAY_CUTOFF_HOURS`, owner, 2026-09-29). The hours are
  visit-day hours: a visit saved at 01:30 falls in "8 PM – 2 AM" of the evening before, never in the morning. A span
  from 11 PM to 1 AM is two hours.
- **"By this time" is fair or it is absent.** Yesterday is cut at the same visit-day minute as now. It counts only
  visits saved inside yesterday's own visit day (`cairoBusinessDay`), so a visit filed under yesterday but saved this
  morning is not counted as "yesterday by 1 PM". After 02:00 the day has closed, and the page prints no pace at all
  rather than a stale one.
- **A vacant seat is not a rep.** It is never in "reps", "saved none", the pace's denominator or the lists of reps to
  look at.
- **The filter and the order narrow and sort rows, never a figure.** The tiles, the teams, the pace, the hours and each district manager's
  reps' total all count the whole team.
- **No location is read.** The loader selects no coordinate, distance or far-visit flag. That evidence is not the
  Regional Sales Manager's (`readsPlaceVsActual`).

## The Excel file

`/api/crm/team-visits/export` builds the file with `buildTeamVisitsWorkbook` (`src/lib/phoenix-crm/server/team-visits-workbook.ts`).

- **The gate.** `phoenix_crm:read`, then `readsRegionalTeamReports`, both checked before any read. Any other seat
  gets a 403.
- **Limits and audit.** The download is rate-limited (`export:crm:team-visits`) and every download is audited
  (`crm_team_visits_export`).
- **The file always holds every rep.** The route takes no filter.

Seven sheets, in the house identity (SATO-DIS-2026-01):

- **Cover:** the dates, the counts, the counting rules and, when the file is made while today is running, today
  against yesterday at that time.
- **Teams:** each region and district manager, each day, then the whole team.
- **Reps:** each rep seat, each day: the three figures, doctor visits, waiting, visits saved, first and last saved
  time, and the span. A vacant seat says "Seat is vacant" and carries no figures.
- **Visits:** one row per visit: the reps', and each district manager's own marked "Own visit — in no rep's figure".
  The list, the saved time ("No time recorded" for a copied visit), the customer, and whether the visit is in the
  figures ("Counted" or "Waiting for validation").
- **Hours:** the two-hour blocks for both days, the copied visits, and a total of every visit saved.
- **To look at:** the screen's three lists for both days, each titled with its count: reps who saved no visit, reps
  whose every visit is still waiting, and every rep with a visit waiting. A vacant seat is never on them.
- **Pace:** today against yesterday at the minute the file was made, team by team with the whole team as the total,
  then rep by rep. A file made after today's visit day closed says so in one line, with no stale comparison.

## Where it lives

- `src/lib/phoenix-crm/server/team-visits-summary.ts`, pure. It holds the hours, the timeline, the pace, the strip, the team
  roll-ups, the reps to look at, the vacant line and the filter. The screen and the file both read it.
- `src/lib/phoenix-crm/server/team-visits.ts`, the loader. It now marks each visit `waiting`, on the rule that counts
  it as waiting, and each seat `vacant`.
- `src/components/crm/regional/team-visits-view.tsx` holds the sections and the squares.
  `src/components/crm/regional/team-visits-panels.tsx` holds the toolbar and the panels.
- `app/api/crm/team-visits/export/route.ts` serves the file. It is registered in `src/lib/security/access-registry.ts`.

## The finish

Flat colour, square corners, hairline borders, no gradient, glow or drop shadow (owner, 22 Oct 2026).

- Every table is `table-fixed` with a `<colgroup>` that totals 100%, and shows only from `md` up.
- Below 768px every table is a list of cards, as the CRM's desktop gate requires.
- Nothing is cut short with an ellipsis. Long names wrap.

## Tests

`tests/team-visits-premium.test.ts` is registered in `tests/run-tests.ts`, beside `tests/regional-team-reports.test.ts`,
which still pins the earlier rules. Thirteen of its rules were broken on purpose, and each break fired its own
assertion:

- an hour block overlapping the next;
- the small hours read as the morning;
- a vacant seat counted as a rep;
- a vacant seat listed as a row;
- a waiting visit not labelled in the file;
- the pace printed on a day that has closed;
- the pace counting a visit saved outside yesterday's own visit day.
- a rep with no timed visit sorted as the earliest;
- a Friday read as a field working day.
- a vacant seat counted in a team's pace;
- a vacant seat listed on the "To look at" sheet;
- a name in "Reps to look at" linking to a row the filter has hidden;
- a rep on approved leave or recorded admin work listed as "saved nothing".

`orderNoticeAndFold` pins the order, the field-day notice and the phone fold. `paceTeamByTeam` and
`theWorkbookLooksAndPaces` pin the team-by-team pace and the two sheets that carry the lists and the pace.

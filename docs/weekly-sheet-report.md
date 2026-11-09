# Weekly Sheet — premium pass, 9 November 2026

The Weekly Sheet is the page at `/employee-portals/weekly-sheet`. It is the Regional Sales Manager's alone (Dr. Hany Saad's needs, 8 Nov 2026). The owner asked for the premium pass on 9 Nov 2026: "eyeball every report in My Team's Reports, premium polish big work, every single component", then "group reps by district manager".

It is the page after District Managers' Plans (`docs/district-manager-plans-report.md`), and it wears the same kit. This file explains what the page shows and where each figure comes from.

## The rules the page keeps

- **The target is 10 PM and 2 AM per working day.** A full Saturday-to-Wednesday week is 50 PM and 10 AM. Approved leave and national holidays come out of the target. The sentence is built from `PM_PER_WORKING_DAY` and `AM_PER_WORKING_DAY` and said once, in the toolbar and on the file's Cover. Before this pass it was typed as numbers in three places.
- 🔴 **A week still running is never graded "Below".** On a Monday every rep is short of a Saturday-to-Wednesday target by design.
  - Before this pass the current week painted the whole team amber "Below".
  - Now a target not reached yet reads "So far", and its gap reads "12 to go", never "12 short".
  - A week that has not started reads "Not started", and nobody is graded.
  - A field week ends on Wednesday, so on the Thursday after, the week is over and every figure is final.
- **A week with no working day is "No working day", never "0 of 0 · Met".** That is a week of leave or of holidays. Such a rep is counted apart, in no grade.
- **A vacant seat is a seat, never a rep below target.** It wears the lightest colour, it is counted apart, and it is never on "Reps to look at".
- **The doctors are read from the AM visit comments.** An account needs at least 3 doctors of each speciality: Pediatrics, Internal Medicine / GP and ENT.
  - Short accounts come first, and each says what it needs ("Needs 2 more Internal Medicine / GP · 3 more ENT").
  - An account whose comments name no doctor says "No doctors written in the comment", never a 0. It is short of nothing, because nothing was read.
- **A visit waiting for validation is real work, counted in no figure.** It is named on the rep's row and on "Reps to look at", never added in.
- **Grouped by region and district manager.** Each section is headed by `regionManagerTitle`, the helper every Regional Sales Manager screen uses. The heading always carries the whole district's figures, whatever the filter.

## What the Regional Sales Manager sees

1. **The toolbar.** It shows the week and one line on where the week stands (over, running, or not started). Then the target and depth sentences, then Previous week, Last full week and Next week. Next week appears only once that week has begun, so it never opens a week of zeros. Then the filter chips with their counts, and Download Excel.
2. **Five tiles.** PM visits, AM visits, both targets met, AM accounts with 3 of each, and pharmacies, each with its caption ("2 of 3 reps met · 1 below").
3. **Where the team stands.** Three bars: PM by grade, AM by grade, and AM accounts by depth. Each bar adds up to exactly 100; the part with the larger remainder takes the leftover point. Under them is the speciality line ("ENT short in 2 accounts · Pediatrics in 1").
4. **Reps to look at.** Each rep is listed once, with every reason: PM below, AM below, visits waiting, and accounts with no doctors written. Below-target reasons appear only once the week is over. Most reasons come first, then the larger PM gap. A name links to the rep's row whenever that row is listed under the current filter.
5. **The districts.** One table per region and district manager on desktop, and cards on a phone. Each rep shows their days and leave, PM and AM with a grade and gap, pharmacies and waiting visits. The AM accounts open below the row. A rep with no AM account says "No AM account this week" and offers nothing to open.

## The filter

`show` is `all`, `below` or `met`. It is read strictly: anything else is `all`. It narrows the rows listed, never a figure.
- The tiles, the bars and every district heading are the whole team's and the whole district's.
- A district left empty by the filter is not shown.
- While the week runs nobody is below, and the empty line says so.
- The Excel file always holds every seat.

## Where the figures come from

- `src/lib/crm/weekly-sheet.ts` (`loadWeeklySheet`) reads the week, the reps, the visits, the leave and the holidays. It returns them with `cairoToday`.
- `src/lib/crm/weekly-sheet-summary.ts` is the only arithmetic. It holds the position of the week, every grade, every gap, the team and district totals, the bars, the speciality gaps, "Reps to look at", the filter, and every sentence. It is pure: no database, and no clock but the sheet's own `cairoToday`.
- `src/components/crm/regional/weekly-sheet-panels.tsx` (the toolbar, tiles, bars, "Reps to look at") and `weekly-sheet-view.tsx` (the districts) print what the summary returns. They grade nothing of their own.
- `src/lib/crm/weekly-sheet-workbook.ts` builds the file in the house identity, from the same summary. It has five sheets: Cover, Districts (with a Team row), Reps, Accounts (with "What it needs") and To look at.
- `/api/crm/weekly-sheet/export` asks the Regional Sales Manager gate before any read. It is rate-limited and audited as `crm_weekly_sheet_export`, with the seat and vacant counts taken from `weeklySheetTeamTotals`. The file name comes from `weeklySheetWorkbookFileName`.

## Tests

`tests/weekly-sheet-premium.test.ts` works one week by hand: Saturday 31 October to Wednesday 4 November 2026, two districts, five seats.
- The week is checked three ways: over, running, and not started.
- The team and the districts must add up. Every bar must sum to 100. The filter and "Reps to look at" are checked against the hand-worked week.
- The test loads the Excel file with ExcelJS and reads its five sheets.
- It checks the source for the house rules: square corners, no ellipsis, no sideways scroll, nothing below 11px, no raw HR id, and no gendered words.
- `tests/regional-team-reports.test.ts` keeps the gate and the region column on the four export sheets.

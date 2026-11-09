# The Coverage report — premium pass, 9 November 2026

The Coverage report is the page at `/employee-portals/kpis/coverage` (and the admin board's Coverage tab). The owner asked for it on 9 Nov 2026: "eyeball every report in My Team's Reports, premium polish big work, every single component", then "group reps by district manager". This file explains what the page shows and where each figure comes from.

## What a manager sees

**Top of the page (more than one rep on the board):**

- **The tile row.** Next to the board's own tiles sit four more: *Not reached yet* (the planned doctors no rep has seen), *At the 95% floor* (the reps at or over the floor out of the reps judged), *Off plan* (the doctors seen who were not on the plan), and *Not validated yet* (the planned doctors with no validated live photo).
  - *Not validated yet* appears only when the brick read succeeded. A failed read prints nothing, never 0.
- **Where the team stands.** Two flat bars:
  - the planned list, covered against not reached, which adds up to the Coverage tile;
  - the reps by band, which adds up to the reps in reach.
- **The teams side by side.** One line per region and district manager, giving reps, covered of planned, coverage and reps at the floor. It shows only when there are two teams or more.
- **The rep table, grouped.** One heading per region and district manager, with the team's figures in it.
  - A rep keeps their rank on the whole board. The rank does not restart under each heading.
  - The phone cards are grouped under the same headings.
- **The bricks at a glance**, above the brick table:
  - the bricks by coverage band;
  - the bricks nobody has reached yet, which never include the "Not validated yet" or "no brick on record" lines;
  - the bricks with the most doctors still to see.

**One rep opened ("Show doctors"):**

- **Four tiles:** Coverage, Covered, Late and Not due yet. Covered + Late + Not due yet = Planned, so they add up to the rep's row.
- **The planned list against the floor.** One track (covered, late, not due yet) with the 95% floor marked on it. The sentence under it gives how many doctors the rep is short, and whether the doctors still ahead are enough or some must come from the late list.
  - The floor is ⌈planned × 95 ÷ 100⌉ and never rounds in the rep's favour: 18 of 19 prints 95%, yet still reads one short.
- **To clear the floor, see these first.** Exactly as many doctors as the rep is short, in this order:
  1. late doctors by grade (A, then B, then C), then the one missed most often, then the oldest miss;
  2. then the doctors not due yet, by their next planned day.

  This is a suggestion about the rep's own plan, never a change to it.
- **How late the late doctors are.** The late doctors fall into three groups: missed in the last 7 days, 8 to 14 days ago, and earlier. Each is measured from the last planned day the doctor missed. A doctor whose date cannot be read counts as the oldest.
- **How often the covered doctors were seen:** once, twice, or three times or more. This adds up to Covered.
- **By brick, by the week planned, by grade and by speciality.** These tables have the columns Planned, Covered, Not covered (late and not due yet in one cell) and Rate.
  - Each doctor is counted once, in the week of the first day the plan booked them.
  - Every count with doctors behind it is a link into the list below, narrowed to exactly those doctors through the doctor filter's own fields (`grades`, `specialities`, `timing`).

**The rows' flags.** On the Coverage report a rep's row shows only the Coverage report's own flags: never reached, carries no plan, below the floor, and the rest of that set. The frequency, campaign and AM/PM flags stay on the Summary and on their own reports (`KPI_FLAGS_OFF_REPORT`). The flag filter still finds those flags on every tab.

**The export.** The Coverage export adds a Region column before Manager. When the doctor lists are in the file and there are two teams or more, it also adds a Teams sheet.

## Where the figures come from

Nothing on this page adds a measure.

- `src/lib/crm/kpi-coverage-teams.ts` holds the teams and bricks. A team's coverage is `sumKpiTeamTotals` + `kpiTeamFigures`, the same arithmetic as the Coverage tile, so the teams add up to the tile. Reps who just started are counted as heads and nothing else.
- `src/lib/crm/kpi-coverage-rep-detail.ts` holds one rep's detail. It counts the two lists the server built for that rep (`KpiCoverageDetail`), whose lengths are the row's Covered and Not reached.
- The panels read the WHOLE lists. The doctor filters narrow only the lists printed below them.

## The finish

Flat colour, square corners, no gradient, glow or drop shadow (owner, 22 Oct 2026). The same pass removed the 2026-09-08 "depth" gradients and shadows from the whole KPIs kit (`kpis-chrome.tsx`).

Every table is `table-fixed` with a `<colgroup>` that totals 100%. A table that can sit in half a row is a table only when its own panel is 34rem wide (`@container`) and the screen is `md` or wider (`@min-[34rem]:md:table`). Below 768px every CRM table shows as rows, as the CRM's desktop gate requires.

## Tests

- `tests/kpi-coverage-premium.test.ts` covers the teams, the bricks, the export and the flat kit.
- `tests/kpi-coverage-rep-detail.test.ts` covers the rep detail, the links and the flag scoping.

Both are registered in `tests/run-tests.ts`.

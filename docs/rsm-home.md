# The Regional Sales Manager's home — premium pass, 9 November 2026

The Regional Sales Manager lands on `/employee-portals`, drawn by `RmCommandCenter`
(`src/components/employee-portal/dashboards/rm-command-center.tsx`). The owner asked for the premium pass on
9 Nov 2026, page by page, after the My Team's Reports pass (`docs/roi-tracking-report.md` was the last of those).
The owner chose this page next: "RSM home".

This file explains what the page shows, where each figure comes from, and what the pass changed. The figures
and their scope are unchanged. Every sales and target figure still comes from the published Monthly Closing.

## The rules the page keeps

- 🔴 **A percentage never rounds UP across a line.** `wholePercent` floors: 89.6% reads 89%. Before this pass,
  a district at 89.6% read "90%" in amber on My Districts while it also sat under Districts Needing Attention,
  next to "2 K EGP to 90%". The ranking boards are shared, so the District, National and CEO boards now floor
  too.
- 🔴 **The Gap to 90% tile and Districts Needing Attention are measured on the money.** Both test sales against
  90% of the target (`incentiveGap`), never against a rounded percentage, so they always agree. A district
  with no target is not behind. It is unmeasurable, and is named apart.
- 🔴 **The viewer's own requests are never the viewer's decision.** The landing snapshot's vacation and excuse
  counts are the viewer's OWN requests (`employee_hr_id` is the viewer), waiting on a manager or HR.
  - Before this pass they sat under "Needs Your Decision", beside the plans awaiting the viewer's approval, and
    opened the Approvals Hub, where there was nothing to decide.
  - `pendingItems` now splits them. The plans stay under Needs Your Decision. The viewer's own requests go
    under "Your Requests in Progress" and open `/employee-portals/vacation-request` or `/employee-portals/excuses`.
  - The fix is in the shared `PendingActions`, so every manager home has it.
- 🔴 **A change in sales is a percent of the named month before: "Up 12% on Aug 2026".** It is never "pts".
  Points are the unit of a difference between two percentages, and the old panel printed a percent change
  with that unit.
- **The sales pacing panel names its scope.** `loadPortalClosingTrend` scopes the figures to the viewer: the
  whole line for a National Sales Manager or a Marketing Manager, the region's areas for a Regional Manager,
  the district's for a District Manager. The panel used to say "Line Sales Pacing" for all of them. It now
  reads "Region Sales Pacing" here and "District Sales Pacing" on the District Manager's home.
- **The incentive caveat sits under the one incentive figure.** "The 90% incentive line above is not yet
  confirmed by HR" is under the Gap to 90% tile. It used to float lower on the page, above boards that show no
  incentive.
- **Never "synced".** An empty ranking board names the closing it read, or says none is published. When the
  region's figures cannot be read at all, the page says so, and never prints a zero.
- **Square corners, nothing below 11px, nothing clipped on a phone.**
  - The CRM First Visit board's source badge was round. It is square now.
  - The parts this page mounts drew 9px and 10px labels. They draw 11px now: the section heads, the keycards,
    the ranking boards, the context bar, the CRM board and the pacing panel.
  - Name chips, early-bird chips, "Managers submitted" and the territory in the context bar used to sit on one
    line inside frames that hide overflow. They wrap now, so nothing is cut off.

## What the viewer sees, top to bottom

1. The identity band, and the context bar with the territory, which wraps.
2. Needs Your Decision (plans awaiting approval) and Your Requests in Progress (the viewer's own), each only
   when it holds something.
3. **Region Performance.** It holds four tiles:
   - Achievement, floored.
   - Region Sales, with the closing month.
   - Target, or "no region target loaded".
   - Gap to 90%: the money still needed, "Cleared", or a dash when no target is loaded.

   With nothing published, every money tile is withheld as a dash. The incentive caveat and the reconciliation
   note sit under the tiles.
4. Dashboards and My Team's Reports, the shortcut tiles.
5. My map.
6. **My Districts** and **Top Medical Reps**, ranked and floored. A district manager who joined after the
   published window is listed unranked.
7. **Districts Needing Attention.** It lists the districts below 90%, the lowest first, each with "X of Y" and
   "Z to 90%", plus any district with no target loaded. Its head names the closing month.
8. Early Bird of the Fortnight, and **CRM First Visit**.
9. **Region Sales Pacing.** The latest month is named ("Sep 2026 sales") with its target and achievement, and
   the change on the month before. Each of the last four published months has a bar with its month, its sales
   and its achievement under it, so a phone needs no hover.
10. Double visits, the quick actions, and the personal strip. "My requests awaiting approval" opens the
    viewer's own request page.

## Where the figures come from

- `getRmRegionalPerformance` (through `home-snapshot.ts`) builds the region, the districts and the top reps
  from the published closing. This pass did not change it.
- `loadPortalClosingTrend` (`src/lib/sales/monthly-closing-portal.ts`) reads each published month's closing,
  scoped to the viewer. Each month now also carries `targetValue`, the same closing row's target
  (`grandTotal.rowTotal.targetValue`), so no new source was added.
- `src/lib/employee-portal/rsm-home-summary.ts` is the only place where the words, the floors, the gap, the
  districts list, the pacing and the pending split are decided. It is pure: no database, no clock.

## Tests

`tests/rsm-home-premium.test.ts` works every figure by hand: six districts, a three-month trend, and the
pending split. It also reads the source: no rounding up, no floating banner, the scope in the pacing title, no
"pts", the target taken from the closing, square corners, nothing under 11px, wrapping chips, and no gendered
words.

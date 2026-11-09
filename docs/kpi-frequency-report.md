# The Frequency report — premium pass, 9 November 2026

The Frequency report is the page at `/employee-portals/kpis/frequency` (and the admin board's Frequency tab). The owner asked for it on 9 Nov 2026: "eyeball every report in My Team's Reports, premium polish big work, every single component", then "group reps by district manager". It is the second page of that pass, after the Coverage report (`docs/kpi-coverage-report.md`), and it wears the same kit. This file explains what the page shows and where each figure comes from.

## The two rule sets

A board is scored under one of two rule sets, and every word on the page follows it:

- **The original rules (plan basis).** A doctor passes only when the visits made match the plan **exactly**. Fewer visits than have come due is *below*; more than the whole month asked is *above*, which is also a deviation (owner, 2026-09-02). The judged list is the planned list.
- **The Phoenix rules (grade basis).** A doctor passes at the grade's norm (A 3, B 2, C 1 visits in the month). A graded doctor never seen is *below*. A doctor with no grade has no norm and is left out of the percentage (rule 7). There is no "above".

There is **no frequency floor.** Coverage has the owner's 95% (2026-09-05); frequency has never been given one, so nothing on this page invents a pass mark for a rep. A rep sits in the band their own chip shows (90% and above, 75 to 89%, 50 to 74%, under 50%), and that is all.

## What a manager sees

**Top of the page (more than one rep on the board):**

- **The tile row.** Next to the board's own Frequency tile sit three more, and a fourth when it can be read:
  - *Below plan* / *Below norm* — the doctors short, out of the judged list;
  - *Above plan* (original rules) or *Ungraded* (Phoenix rules, left out of the percentage);
  - *Reps at 90% or more*, out of the reps with a plan;
  - *Not validated yet*, only when the brick read succeeded. A failed read prints nothing, never 0.
- **Where the team stands.** Two flat bars:
  - the judged doctors in the rules' own words (Exact, Below, Above and the rest of the list; or At norm, Below norm and the ungraded marked as outside), which adds up to the tile's denominator;
  - the reps by band, plus *Just started* and *No plan*, which adds up to the reps in reach.
- **The teams side by side.** One line per region and district manager, in four columns: the team (with its head count, the just-started named), its frequency (the pass over the judged doctors), the doctors off target (below or above; below the norm under the Phoenix rules), and the reps at 90% or more of those with a plan. Under it one sentence names the team with the most doctors off target and how far apart the best and the worst teams are. It shows only when there are two teams or more.
- **The rep table, grouped.** One heading per region and district manager with the team's own frequency in it; a rep keeps their rank on the whole board. The phone cards are grouped under the same headings.

**One rep opened ("Show doctors"):**

- **Four tiles:** Frequency, Visits made (of the visits that have come due), Visits owed, and Doctors short (with how many were never visited). They count the rep's whole list, so they add up to the rep's row.
- **The judged list as one track:** passing, short, seen too often, and waiting (not due yet, or ungraded). Each part is a link into the list below, narrowed to exactly those doctors. The sentence under it says how many passed, how many are short and how many visits are owed, and — when some doctors are one visit from the pass — how far one more visit each would lift the rep's frequency.
  - "One more visit each" counts only the doctors a single visit would pass: one visit short, or never visited and asked for one. A never-visited A doctor asked for three is not one of them.
- **Go back to these first.** Up to eight doctors who owe a visit: a single visit's pass first, then grade A, B, C, then the most owed, the ungraded last. Each says why in one line ("1 short · 1 of 2 made · next planned 17 Nov"). This is a suggestion about the rep's own plan, never a change to it.
- **How far short the short doctors are:** one visit, two, three or more, and never visited. The four add up to Doctors short, and their owed visits to Visits owed.
- **By the week planned, by grade and by speciality.** Each doctor is counted once, in the week of the first day the plan booked them; a week not begun yet is marked; a week whose doctors are all not due yet has no percentage, never 0%. Every count with doctors behind it is a link into the list below.
- **The doctor list** shows, beside each doctor, Should visit, Visited and the Gap in words: "1 short", "1 extra", "1 ahead", "On target".

**The gap.** A shortfall is measured against what has **come due** by today; an excess against the **whole month** (`frequencyStatusOf`'s own asymmetry). So a doctor planned three times, due twice and visited once is "1 short", not two; and a doctor visited twice of three with only one due yet is "1 ahead", which is still exact. A doctor not due yet owes nothing — never an accusation — even when the due count is missing.

**The rows' flags.** On the Frequency report a rep's row leaves the call-rate and coverage flags (campaign-heavy, campaign-only days, below the AM and PM targets, below the coverage floor) to the Summary and their own reports (`KPI_FLAGS_OFF_REPORT.frequency`). The flag filter still finds them on every tab.

**The export.** From the Frequency tab, the export's Teams sheet speaks frequency (judged, the pass, below, above or ungraded, the team's frequency, reps at 90% or more) instead of coverage, and its Doctors sheet adds Should visit, Due so far, Visited, Gap and Visits owed. The Coverage export is unchanged.

## Where the figures come from

Nothing on this page adds a measure.

- `src/lib/crm/kpi-frequency-teams.ts` holds the teams, the bars, the sentence and the extra tiles. A team's frequency is `sumKpiTeamTotals` + `kpiTeamFigures`, the same arithmetic as the Frequency tile, so the teams add up to the tile. The grouping is `groupKpiRepsByTeam`, the Coverage page's own, so a team sits in the same place on both pages. Reps who just started are counted as heads and nothing else (owner, 2026-10-26).
- `src/lib/crm/kpi-frequency-rep-detail.ts` holds one rep's detail: the gap and its words, the visits owed, the summary, the depths, the lift, the go-back-first list and the breakdowns. The screen and the export print the gap from the same function.
- The panels read the WHOLE lists. The doctor filters narrow only the list printed below them.

## The finish

Flat colour, square corners, no gradient, glow or drop shadow (owner, 22 Oct 2026). The panels are `src/components/crm/kpi-frequency-panels.tsx` (the team half) and `src/components/crm/kpi-frequency-rep-panels.tsx` (one rep), both markup only, so the board stays a server component.

Every table is `table-fixed`. A table that can sit in half a row is a table only when its own panel is 34rem wide (`@container`) and the screen is `md` or wider (`@min-[34rem]:md:table`); below that it shows as rows, as the CRM's desktop gate requires.

## Tests

- `tests/kpi-frequency-premium.test.ts` covers the teams under both rule sets, the bars, the sentence, the extra tiles, the export's Teams and Doctors sheets and the flat kit.
- `tests/kpi-frequency-rep-detail.test.ts` covers the gap, the summary, the depths, the lift, the go-back-first order and the breakdowns on a fixed list of nine doctors worked out by hand.

Both are registered in `tests/run-tests.ts`.

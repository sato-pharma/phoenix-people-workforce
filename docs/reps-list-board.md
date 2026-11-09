# Reps List — how the board is built

The Reps List board (`/employee-portals/reps-list`, and the same view in the admin shell) is the manager's read
of his team's CRM lists. It has three tabs: **Contact list**, **Weekly Plans** and **Vacant Areas**. This page
describes how the three are laid out after the premium pass of 9 November 2026 (owner: "premium polish big work
every single component", then "group reps by district manager"), so the next change to any one tab keeps the
three matching.

The rules that bind it live in the module memory, `.claude/rules/phoenix-crm-reports.md` and
`.claude/rules/crm.md`. This page explains how it is built; it is not a second copy of those rules.

## One kit, three tabs

Every visual part comes from `src/components/crm/reps-list-chrome.tsx`, and the arithmetic behind it from
`src/lib/crm/reps-list-groups.ts` (pure, pinned by `tests/reps-list-premium.test.ts`). No tab draws its own
version of a part. A part that differs from tab to tab is a tab that has drifted.

| Part | What it is | Where it is used |
| --- | --- | --- |
| `Section` | The slate-900 title bar with its orange keyline, plus a description | Every block on all three tabs |
| `TileRow` + `Tile` | Key figures in one row sized by its count (`tileColumns`), each with a 3px tone rule on top and an optional share meter | The board's figures, the opened plan's figures |
| `ShareBar` | One flat bar with a legend that carries every figure and its percent in words | The week, the list's PM and AM, the empty seats, the plan's doctors |
| `RankedBars` | Named figures as horizontal bars, largest first | Contacts by brick, Contacts by specialty |
| `TeamRollup` | Every team on one screen, one bar each — drawn only for two teams or more | All three tabs, "The teams at a glance" |
| `GroupedCardGrid` | The cards under a heading per region and district manager | The phone view on all three tabs (`phoneOnly`) |
| `TeamTable` | The same groups as a table, `table-fixed` with a colgroup that totals 100% | The desktop view on all three tabs |
| `RepCardFrame` + `RepMonogram` | A card with a 3px status rule on the left and the person's initials; an empty seat's monogram is a dashed square | Rep cards and vacancy cards |
| `RepProfileBand` | The band an opened rep or seat starts with: name, team, places, up to four facts | An opened rep (contact list and plans), an opened seat |
| `BackToAllReps` | The bar that leads back to the grid | Every opened card |
| `ExportRowBar` | A note on what the download holds, with its button | The team download on each tab |
| `EmptyNote` | A title and its detail inside a dashed rule | Every empty or explanatory state |

The finish is fixed and checked by the test: square corners, no drop shadow, no gradient, no glow, tabular numbers,
no horizontal scroll container, no `min-w-[…]` floor and no ellipsis. Colour carries a status in exactly one place
per part: a tile's top rule, a card's left rule, a swatch in a legend. It is never a fill behind a block.

## The grouping

Every rep, and every empty seat, is filed under its **region and district manager**. This is the Regional Sales
Manager rule that every screen built for him follows.

- `repTeamsFor` (`src/lib/crm/reps-list-board.ts`) looks up each seat's district with `districtSeatAbove`, the
  nearest DM or acting-DM seat on its organogram path, never the per-line "Others" bucket. It then groups the
  seats with the shared `groupByRegionAndManager`. A rep straight under the RSM is filed as "No district manager",
  and an empty district seat as "District manager seat vacant".
- If the organogram read fails, the board loses the manager names and nothing else. Each group is headed by its
  region alone (`loadPhoenixCrmOrg().catch(() => null)`).
- `groupRepsByTeam` keeps the cascade's team order and the incoming order inside each team. Every rep appears
  exactly once, so the group sizes add up to the tile above.
- A tab draws the same `groups` three times: the cards on a phone, the table from `md` up, and the teams roll-up.
  The test counts those three reads, so a fourth list that might disagree with them cannot be added quietly.

## Contact list

- **The grid:** four tiles (Reps, Lists mirrored, No list mirrored, Typical list — the median, which one very long
  list cannot drag up), the teams roll-up (with a list against none), the download, then the teams.
  No contact total is shown, because two reps can share a doctor.
- **An opened rep:** the profile band, then the month window, the seven tiles, and these charts:
  - "Contacts by list" (PM against AM only);
  - "Contacts by brick" (contacts only, with an unmapped locality kept in amber);
  - "Contacts by grade";
  - "Contacts by specialty" (the largest eight, with the rest folded into "Other specialties" so the bars add up
    to the Contacts tile).

  Two more bars come before those, each drawn only when its source was read: "The contacts' month"
  (`listMonthMix` — every contact in its activity status, in the chips' own words and the Activity filter's order)
  and "Contacts validated in Phoenix CRM" (`listValidationMix`).

  Below the charts sits the contact table, grouped by brick.
- **The brick month bar** (`brickCoverage`): on this board alone, each brick heading carries the month's visited,
  not visited and not due yet, counted with the Not visited tile's own `UNVISITED_STATUSES`. Phoenix CRM's List tab
  shares the table and never turns this bar on.

## Weekly Plans

- **The grid:** five tiles, which also work as the status filter: Reps, Awaiting you, Verified, No plan filed, and
  Vacant seats, which opens the Vacant Areas tab. Below them come "The week at a glance", the teams roll-up, the
  download, then the teams. A week that has not started says "Not filed yet" in slate, never red.
- **An opened plan:** the profile band, then four tiles, the decision band with the Approve control, and three
  charts from `planWeekMix` (`src/lib/crm/plan-week-mix.ts`):
  - "The plan's doctors": on the rep's list against not on it;
  - "By grade": doctors counted once each;
  - "The ended days so far": counted in calls, the day headings' own figures added up.

  Then come the day strip, which jumps to each day, and the plan's doctors day by day. Each ended day's heading
  carries its kept bar (kept on the day, kept another day, not seen).

## Vacant Areas

- **The grid:** four tiles (Vacant areas, List left behind, List moved on, Never held) that add up to the seats
  below, the same four as one bar, the teams roll-up, the download, then the teams. The desktop table carries
  "Contacts left" with a meter. Only a list still on the seat has contacts to count; every other state shows a dash.
- **An opened seat:** the back bar, the profile band with a dashed monogram, then either the inherited list
  (through the Contact list tab's own `RepsListListBody`) or the reason there is none, in words.

## On paper

A printed board shows each team as the table at every width (`print:block`). The phone cards, the back bar and
the download bar are left off the page (`print:hidden`), since a button does nothing on paper. The filters stay
on, because the selected values are what tell the reader whose team the page shows.

## The downloads

Each tab's download lists its region and district manager columns first, then the facts the screen shows, in
the order of the teams. A count of contacts, pharmacies or plans is marked `excludeFromTotal`, so the workbook's
TOTAL row never adds it up. Two reps can share a doctor, and an inherited list can overlap the team's own, so a
total would count those doctors twice. The test fails on any numeric column without that mark.

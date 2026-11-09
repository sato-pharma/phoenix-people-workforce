# Source of Sales on the employee portal — premium pass, 9 November 2026

The employee portal's Source of Sales page is `/employee-portals/source-of-sales`
(`app/employee-portals/source-of-sales/page.tsx`). It is the next tile on the Regional Sales Manager's home
after the RSM home itself (`docs/rsm-home.md`), and the owner asked for the next page's premium pass on
9 Nov 2026 ("start the next page premium polish").

The page has two parts:

- **The pharmacy actions and the month pace** (`src/components/sales/portal/portal-sos-pharmacy-actions.tsx`).
  Every manager and Medical Rep the page admits sees them. They read the published closings: which pharmacies
  stopped, dropped or started buying, the top pharmacies, cross-sell gaps and untapped bricks. Under them is the
  weekly month pace, which is labelled "weekly, approximate" and never put beside a closing figure.
- **The distributor dashboard** (`src/components/sales/portal/portal-sos-dashboard-impl.tsx`). The roles
  `isPortalSosRole` admits see it; a Medical Rep does not. It shows the distributor sell-in: KPI tiles, filters,
  insights and movers, the trend, the channel mix, the ranked charts and the breakdown table.

This pass changed how figures are said, never a figure. Every word and rounding now comes from one pure module,
`src/lib/sales/sos-portal-words.ts`, and `tests/sos-portal-premium.test.ts` works each one by hand.

## The rules the page keeps

- 🔴 **A percentage never rounds across a line.** Every percentage on the page is cut toward zero, so it can
  only understate.
  - The pace row's "99.6% of target" used to read "100%" beside a "Behind" badge. It now reads 99%.
  - A pharmacy down 29.6% sits outside a list whose rule is "30% or more"; a rounded percentage would have
    printed 30% for a figure the rule had excluded. It now reads 29%.
  - Shares keep one decimal, cut the same way: 99.96% reads 99.9%, never 100.0%.
  - `percentTowardZero` carries a small nudge, so 0.29 × 100 (28.999… in floating point) still reads 29.
- 🔴 **A change shows a direction only when it has one.** A change too small to show at one decimal reads
  "0.0%" in grey. Before, it was a green "+0.0%" or a red "-0.0%" (`deltaWords`).
- 🔴 **Every comparison names its month.** The movers' heading, the Total Value tile and the breakdown's change
  column read "vs Sep 2026" (`versusMonth`). Before, they read "vs last month" and "Δ vs last". The month is the
  server's own comparison month (`comparison.previousPeriod`), which is the calendar month before the picked one.
- 🔴 **The trend title names the months it draws.** The trend is the six newest published months PLUS the picked
  month (`sos-dashboard.ts`, `windowPeriods`). So a picked month older than those six sits apart from them, and
  the old title "last 6 months" was wrong. The title is now "Value trend · Apr 2026 to Sep 2026", or
  "…, and Jan 2026" when the picked month sits apart (`trendTitle`). A dashed line marks the picked month.
- **The pace row is readable without a hover.** The "Expected by today" mark on each bar was a hover title,
  which a phone cannot show. Each row now prints "expected 70% by today". A row behind its mark also says by how
  much, for example "EGP 7.6K short of today's mark" (`paceWords`).
- **The upload state shows at every width.** "7 of 9 distributors uploaded · 2 still to come" was hidden below
  the `sm` width, so a phone never saw it. It now wraps inside the scope bar (`uploadWords`).
- **A filter change that fails says so.** Before, a failed reload left the previous figures under the new
  filters with nothing to say they were stale. A banner now says the figures are still for the previous
  selection, with a Try again button (`REFRESH_FAILED`).
- **An empty selection keeps its filters.** When a filter left nothing, the whole Filters card disappeared with
  the KPI tiles, and the only way back was to edit the address. The card now stays above the empty state, and
  the empty state says to reset the filters.
- **Chart labels wrap and are never cut.** Recharts draws an axis tick as one SVG line, and the card's edge cut
  long product and distributor names mid-word. The column chart's labels were also slanted. Labels now wrap on
  word boundaries (`wrapAxisLabel`), and each bar chart grows to fit its labels, never below the 240px the cards
  were drawn at (`rankedChartHeight`).
- **The page never shows a raw error.** A failed dashboard load used to print `error.message` to the viewer. It
  now logs the error on the server and shows the page's own sentence (`DASHBOARD_UNAVAILABLE`). The two API
  routes already passed their errors through `clientSafeErrorMessage`.
- **The sentence over the tiles reads as a sentence.** With no line chosen it used to begin " closing for …",
  with a leading space and a lower-case letter. `closingIntro` writes it whole.
- **The upload time is Cairo time through `cairoDateTime12h`.** A client-side `toLocaleString` with an hour
  prints the 12-hour clock's space differently on the server and on an Apple device (React #418). The file's
  entry in the ratchet in `tests/react-418-hydration-safe-text.test.ts` is removed, so it cannot creep back.
- **Nothing is drawn below 11px.** The 9px and 10px labels, the chart ticks and the chart value labels are 11px.
  The shared table head (`TABLE_HEAD_CLASS` in `target-visuals.tsx`) is unchanged: the sibling sales pages share
  it.

## What the pass did not touch

- The coverage banner still never shows on the portal (`omitCoverageWarning`,
  `tests/portal-sos-no-coverage-banner.test.ts`).
- El Qema masking (`maskPortalSosDashboard`, `maskSosCoverageReport`) and the packed cache rows are unchanged.
- The Total Value arrow still comes from the server's comparison of the picked month with the month before it
  (`tests/portal-total-value-delta.test.ts`).
- The pharmacy figures are still read through `actions.byArea?.[area]` when an area is picked
  (`tests/sos-pharmacy-actions.test.ts`).

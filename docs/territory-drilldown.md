# Sales Drilldown (`/employee-portals/territory-drilldown`)

The page a Medical Rep, District Manager, Regional Sales Manager, National Sales Manager, CEO and
Super Admin open to see where a sales number comes from: region → area → block → brick → pharmacy,
by name. Its menu entry, its page title and the Regional Sales Manager's home tile all say
**Sales Drilldown**; the tile said "Territory" until the premium pass of 9 Nov 2026.

## Where the figures come from

- **Region and area totals** are the published Monthly Closing over the window
  (`TerritoryClosingTotal`, the closing engine — the Monthly Closing golden rule).
- **Pharmacy figures** are summed by the area route from the uploaded sheets. Each area header says
  so in words: "Pharmacies on the uploaded sheets: EGP 1,250, adds up to the area's sheets" — or
  "differs from the area's sheets total" when the route's own check fails. The old header printed
  the pharmacy sum beside the closing total with only one of them named, and a "Reconciled ✓"
  that simply vanished when the check failed.
- The window note above the tree (`territoryWindowNote`) says which months each figure covers.

Nothing on the page computes a figure. `src/lib/sales/territory/drilldown-words.ts` only decides how
each one is said, and `tests/territory-drilldown-premium.test.ts` works every sentence by hand.

## The words

| What | Says | Helper |
| --- | --- | --- |
| Counts | "3 blocks · 41 pharmacies", "1,204 rows" — never "row(s)" | `countOf`, `structureLine`, `pharmacyCount` |
| Month chips | "Nov 2025 · Dec · Jan 2026 · Feb" — the year on the first chip and on each January | `monthChips` |
| Chip meaning | spoken per chip ("Jul 2026: bought") and a legend once over each brick's pharmacies | `MONTH_CHIP_LEGEND` |
| Trend bars | the month's own short name at 11px; the chart names its window for a screen reader | `shortMonthName`, `trendChartLabel` |
| An area that fails | "This area could not be loaded just now. Refresh the page to try again." — never an HTTP code | `areaLoadFailedText` |
| Data sync | what it does in plain words, for every role that presses it | `SYNC_DESCRIPTION`, `syncRunLine`, `syncVerdict`, `lineSummaryDetail` |

## The look

Flat and square, like every page in the house: no round corners, no gradients, no drop shadows, and
nothing under 11px (`text-phx-xs`). Dark slate heads the region, area and block tiers; a flat orange
head marks a region lane and the "My regions" root. The trunk under a root card ends in a square node.
The desktop tree and the phone cards share one `MonthChipRow`, so their chips cannot drift apart.

The fits-the-screen rule is unchanged and still pinned by
`tests/territory-tree-desktop-fits-the-screen.test.ts`: no `overflow-x-auto`, no `min-w-[…]` floor,
names wrap and are never cut.

## The pharmacy name opens Google Maps (27 Nov 2026)

The owner asked for the pharmacy name to open Google Maps, and for it never to send a rep to the wrong place. A name is a link in two cases:

1. **Confirmed on site** — a point a rep captured at the shop (a validated marketing pharmacy, an approved direct-order venue with its live photo GPS first, or an active Phoenix CRM pharmacy place) tied to that distributor customer code. Exact directions to the point.
2. **Google Maps search by name** — every other pharmacy with a usable name opens a Google Maps search for "صيدلية <name> <brick town>". The sheet marks ن, ن.م, نقدي and اجل and the dashes are removed; "صيدلية" is not doubled; the town is added unless the name has it. The note under the name tells the rep to check the listing name before he goes.

**Why not the sheet address.** The first version routed to the Ibn Sina family or POS address (his first ruling). On the preview he reported "many of the clickables customers when press google cant find a location". Measured on 30 linked pharmacies in Cairo 1 and Giza 1: the cut-off address (about 30 characters) landed on a landmark for all 30, once 146 km away; a name search near the brick put the right shop first for about 22 of 30.

**Why not Phoenix matching each shop.** That needs Google’s paid place search: about 32 dollars per 1,000 lookups after 5,000 free a month, about 1,000 dollars for the ~35,000 drilldown pharmacies. He answered "find a way to keep it free". The search link calls no Google service; it runs on the rep’s phone.

A confirmed point is not used when it is more than 25 km from its brick centre (a mistyped code), when the card’s points are more than 300 m apart, or when the card’s code comes from two distributors (the Ibn Sina channels count as one); the card then gets the search link. A name with fewer than three letters gets no link.

The rule is `src/lib/sales/territory/pharmacy-directions.ts` (pure). The read is `pharmacy-directions-sources.ts`: one call to `phx_territory_area_pharmacy_locations`, beside the figures; it never throws. Production, May to October: Cairo 1 CNS 400 of 404 names linked (8 confirmed), Giza 1 Pedia 116 of 116 (2 confirmed). Opening Cairo 1 costs about 0.17 s more than the figures alone. `phx_territory_area_pharmacy_sources` (20261127081222) is an earlier version left unused. Pinned by `tests/territory-pharmacy-directions.test.ts`.

## The data sync panel

Pinned by `tests/territory-sync-panel-role-scoping.test.ts` and
`tests/territory-sync-button-published-guard.test.ts`: every drilldown role may press Sync (`canRun`);
only Super Admin and CEO see the per-line chips (`showReconciliation`), because they cover every line
the sync touched; a month whose closing is published is never changed, and the panel says so in the
server's own words. The last-synced time is Cairo time, with its year.

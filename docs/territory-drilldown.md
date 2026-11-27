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

The owner asked for the pharmacy name to open Google Maps, and for it never to send a rep to the wrong place. A name is a link in three cases, tried in this order:

1. **Confirmed on site** — a point a rep captured at the shop (a validated marketing pharmacy, an approved direct-order venue with its live photo GPS first, or an active Phoenix CRM pharmacy place) tied to that distributor customer code. Exact directions to the point.
2. **The pharmacy's own Google listing** — a top pharmacy Phoenix matched to its exact Google Maps listing (below). The link opens that listing; the note says so.
3. **Google Maps search by name** — every other pharmacy with a usable name opens a Google Maps search for "صيدلية <name> <brick town>". The sheet marks ن, ن.م, نقدي and اجل and the dashes are removed; "صيدلية" is not doubled; the town is added unless the name has it. The note under the name tells the rep to check the listing name before he goes.

**Why not the sheet address.** The first version routed to the Ibn Sina family or POS address (his first ruling). On the preview he reported "many of the clickables customers when press google cant find a location". Measured on 30 linked pharmacies in Cairo 1 and Giza 1: the cut-off address (about 30 characters) landed on a landmark for all 30, once 146 km away; a name search near the brick put the right shop first for about 22 of 30.

**Why not Phoenix matching every shop.** That needs Google’s place search: about 32 dollars per 1,000 lookups after 5,000 free a month, about 1,000 dollars for the ~35,000 drilldown pharmacies. He answered "find a way to keep it free". The search link calls no Google service; it runs on the rep’s phone.

## The top pharmacies open their own Google listing (27 Nov 2026)

Asked which upgrade to build first, he chose "Free top-2,616 match": the pharmacies carrying 80% of sales value (the three Cairo months before the current one; about 3,000 distributor customers) are looked up ONCE in Google’s place search, inside the free monthly allowance, and the listing’s place id is kept. Their link then opens the shop itself (`https://www.google.com/maps/search/?api=1&query=<search>&query_place_id=<id>`).

**Free means capped.** Phoenix CRM spends from the same 5,000 free searches (about 1,700 by 27 Nov 2026), so `scripts/territory-match-pharmacy-places.ts` counts its own lookups this Cairo month from `looked_up_at` and stops at 2,000 (never above 3,000, whatever `--budget` says). What is left runs on the 1st of the next month. Run it from the code (`--apply --limit <n> --log <file>`); without `--apply` it asks Google nothing.

**Every doubt is a miss** (his rule: "correct work not make reps waste time and lost"). A wrong match sends a rep to the wrong shop with no list to notice it in; a miss only leaves the search. The rule, `pharmacy-place-match.ts` (pure): the listing is within 5 km of the brick centre; every word naming the listing is in the pharmacy’s name (one letter off only from five letters: احمد is never محمد); the name’s first word is in the listing and, the town set aside, two of its words (one for a one-word name); the listing is not named only with the commonest given names; both are the same kind of place (pharmacy, distributor, hospital, nursery, centre), and a pharmacy is matched only to a listing that says it is one (never the university, cooperative or company the sheet’s pharmacy sits in, never a “دكتور …” listing that may be a clinic); "عبد …" and "ابو …" count as one name ("عبد الرحمن غلوش" is never "د. عبد الرحمن"); and no second listing passes. Two branches of one name are `ambiguous`, never a pick. Google’s listing names are never stored — only the place id, the one Places value an app may keep.

The verdicts are in `territory_pharmacy_place_matches` (RLS on, server only; migration 20261127110514, with `phx_territory_pharmacies_to_match`). The drilldown reads them in `pharmacy-directions-sources.ts` (`loadMatchedPlaces`, chunks of 200 codes, never throws). A matched place is not used when the card’s code comes from two distributors or carries two different place ids; a confirmed point still wins over it. 27 Nov, the month’s 2,000 lookups (sales ranks 1 to 2,052): 434 matched, 80 two or more, 1,486 no match. Every match was read by eye; the pharmacy-word and one-name rules were added after that read caught 42 doubtful ones, and those were set back to no match. The rest of the top 80% (about 1,000) runs on 1 December.

**One area and line at a time** (owner, 27 Nov 2026: "Try to find the location for all the Cairo East 2 PDF pharmacies"). `--area <code> --line <line>` takes every pharmacy of that area and line on the validated sheets of the last six months, not just the top sellers, and refuses more than 300 lookups a run; `--retry-misses` asks again for the ones that had no match. The same monthly cap applies (raise this run's share with `--budget`, never above 3,000). Three things that run taught, now in every run:

- **A wrong stored brick centre.** Each brick's town is geocoded once (`"<town>, مصر"`). When Google puts the town 3 to 20 km from the stored centre, the stored centre is wrong and the search is made around Google's town; a listing then counts as near when it is within 5 km of either (`trustedTownCentre`). Past 20 km Google found another town of that name and the stored centre stands. In Cairo East 2: عزبة النخل's stored centre was downtown Cairo, 13.3 km off; الخانكه 9.7 km; الخصوص 4.2 km.
- **A namesake within 10 km is a doubt** — the second shop counts even past the 5 km limit. "يوسف سمير الجديدة" had been matched to the Youssef Samir in Abu Zaabal at 1 km while Google listed "صيدلية يوسف سمير الجديدة" at 7.7 km. Re-judging every saved answer with this rule set 15 of the 458 matches back to two or more.
- **A chain's area-wide account is never looked up** (`isChainAreaAccount`: `EZB-CA4` is every El Ezaby branch in Cairo East 2). A listing may carry its town ("صيدليه … ابوزعبل"), and the sheets' own symbols (`$$`) never reach Google.

Cairo East 2 Pedia after it: 97 pharmacies, 25 matched, 8 two or more, 64 no match.

**A second pass, judged by eye** (owner, 27 Nov 2026: "put more effort to get them all accurate"). For the 71 still unmatched, Google was asked twice more, about 134 lookups inside the same free allowance: once for pharmacies only, and once with the sheet's own address. Each answer came back with its address and kind. A listing was saved as matched only when (a) the name agrees and Google's address carries the sheet's street, block or mall ("ناصية ش حسين الحلوانى" against "شارع حسين الحلواني"; "اطلس 3 بلوك 142" against "بلوك 142 – مساكن اطلس 3"), or (b) a distinctive full name has one listing in the sheet's own town, an English listing included ("Islam Maher Pharmacy", "Mohammad Subieh"). The sheet's address also settles which of two same-name branches it is, and a sheet whose address contradicts its name ("الجديدة" in the name, the other branch's town in the address) stays a search. 15 were saved. Cairo East 2 Pedia now: 40 of 97 open their own listing, 50% of the area's sales value, 11 of its top 20. Every one of the other 57 either has no Google listing that names it or has two or more, so only a rep's point captured at the shop can make it exact.

A confirmed point is not used when it is more than 25 km from its brick centre (a mistyped code), when the card’s points are more than 300 m apart, or when the card’s code comes from two distributors (the Ibn Sina channels count as one); the card then gets the search link. A name with fewer than three letters gets no link.

The rule is `src/lib/sales/territory/pharmacy-directions.ts` (pure). The read is `pharmacy-directions-sources.ts`: one call to `phx_territory_area_pharmacy_locations`, beside the figures; it never throws. Production, May to October: Cairo 1 CNS 400 of 404 names linked (8 confirmed), Giza 1 Pedia 116 of 116 (2 confirmed). Opening Cairo 1 costs about 0.17 s more than the figures alone. `phx_territory_area_pharmacy_sources` (20261127081222) is an earlier version left unused. Pinned by `tests/territory-pharmacy-directions.test.ts`.

## The data sync panel

Pinned by `tests/territory-sync-panel-role-scoping.test.ts` and
`tests/territory-sync-button-published-guard.test.ts`: every drilldown role may press Sync (`canRun`);
only Super Admin and CEO see the per-line chips (`showReconciliation`), because they cover every line
the sync touched; a month whose closing is published is never changed, and the panel says so in the
server's own words. The last-synced time is Cairo time, with its year.

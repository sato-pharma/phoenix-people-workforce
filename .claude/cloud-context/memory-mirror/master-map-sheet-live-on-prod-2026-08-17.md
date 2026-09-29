---
name: master-map-sheet-live-on-prod-2026-08-17
description: "Master Map live Google Sheet: the finder has died THREE times in silence — a fixed Lists grid, a typed customer CODE reaching SEARCH as a NUMBER, and its count line rendering 2,000px off the right of the screen; a stray basic filter survives every repaint and HIDES rows; it PULLS via its own Apps Script and Phoenix never pushes, no Google credential exists anywhere; a healthy feed proves nothing about the sheet — the Find a pharmacy finder died on a fixed 55,000-row Lists grid; Delta (3) is absent from COLUMN A only, and now has its own tab"
metadata: 
  node_type: memory
  type: project
  originSessionId: d4e5345d-3a7a-4195-9b35-7fdcfc2b6de7
  modified: 2026-09-09T00:00:00.000Z
---

The **Master Map** live sheet went to production on **2026-08-17** via PR #2178, merge commit
`15b1162c` (confirmed serving: `/api/healthz` `revision` matched). Sheet:
`1za3G8C6HCi74qmq4PwP_T7d-rM16UU1XivqEV7A48Hg` — 11 tabs, 52,614 crosswalk rows resolved to
50,622 shops, 0 orphaned.

**The direction of travel is the thing to remember: the SHEET pulls, Phoenix never pushes.** A
Google Apps Script bound to the workbook polls `/api/sales/master-map/sheet` every 5 minutes and
paints the result. **No Google credential exists in the repo, in Railway, or in Phoenix's
environment** — the script runs as the sheet's owner. That was forced, not chosen:
`constraints/iam.disableServiceAccountKeyCreation` is enforced on org `omarrr-g-3003-org`, so a
service-account key would have meant weakening a security default. `MASTER_MAP_SYNC_TOKEN` (48
chars, set on Railway `production` 2026-08-17) is the only secret, and it travels sheet → Phoenix.

**Why:** three things here look like redundancy and are not, and each would be a silent data
failure if "simplified" away.

**Update 2026-08-17, PR #2179 (merge `397492fb`, confirmed serving):** the workbook gained a
**"Find a pharmacy"** first tab — Region/Area/Brick/Channel dropdowns that narrow each other, a
search across name+code+address, a live count, and a 500-row display cap — plus a hidden **Lists**
helper tab. Two traps came out of building it:

- **NEVER switch the values write to `USER_ENTERED`.** Both writers send `RAW` on purpose because
  pharmacy codes are zero-padded (see [[pos-pharmacy-codes-are-zero-padded]]) and USER_ENTERED
  reads `0012345` as a number and eats the leading zeros. The cost is that `RAW` stores a formula
  as literal text — so every formula on those two tabs is injected as a `formulaValue` in the
  REQUESTS pass instead. Do not "simplify" that back into the values array.
- **`LAYOUT_VERSION` in `lookup-tab.ts` is load-bearing.** The plan hashes each tab's TEXT, so an
  edit that only touches formulas or formatting hashes identically and NEVER reaches the sheet.
  Bump the version (it renders into the visible hint line) whenever those two tabs change.
- The hidden Lists tab claims its own grid height in its request pass, because the script sizes
  a tab from the text it is about to write and that tab's text is a single cell — an unfilled
  filter spills one row per shop and a spill with nowhere to go fails the whole tab. **The 55,000
  written here on 2026-08-17 is exactly what killed the finder three weeks later — SUPERSEDED, read
  the 2026-09-09 update at the end before touching this.**

**Update 2026-08-17, PR #2181 (merge `4831003f`, confirmed serving `/api/healthz`):** every customer
row now names its **three district managers, one per line** — the flat tab's last three columns are
`Anti Infective manager` / `CNS manager` / `Pedia manager`, and the Master tab gained one
`District managers · …` band under every area (52,123 → 52,173 rows, exactly +50). Sources are
`au_v_line_area_map` (its column is **`operational_region_code`, NOT `region_code`**) → `au_v_org_tree`
→ `employees`. Three traps:

- **A shop has THREE district managers, never one.** Any "the manager of this pharmacy" phrasing is
  wrong by construction.
- **Check `is_other_pseudo_dm` BEFORE `is_vacant`** — pseudo-DM seats are flagged vacant too, so the
  natural order reports an "Others" bucket as a vacant district. The three non-name states are
  spelled out in words (`Sales only, no manager`, `Vacant`, `Not in the organogram`) and a cell is
  **never blank**: measured 150 cells over 50 areas, 0 blank, only Main Store (0 bricks) unknown.
- **The manager columns go at the END on purpose.** "Find a pharmacy" addresses the flat tab by
  column LETTER, so inserting them anywhere earlier re-points the search box and all four dropdowns.
  Pinned by `tests/master-map-district-managers.test.ts` (A=Region, E=Pharmacy, G=Code, J=Address).

**THREE AREAS SIT IN A DIFFERENT REGION DEPENDING ON THE LINE.** Owner-confirmed 2026-08-18, and the
single reason the manager lookup keys on **area**, never on region — keying on region looks
equivalent, is simpler, and would name the wrong manager for every pharmacy in all three:

| Area | Anti Infective | CNS | Pedia |
| --- | --- | --- | --- |
| Kafr El-Sheikh 1 (`D16`) | Delta 1 | Alex-BHR | Alex-BHR |
| Qena 2 (`UE8`) | Upper Egypt 2 | Others | Others |
| Beni Suef (`UE9`) | Upper Egypt 1 | Others | Giza |

Beni Suef behaving differently per line is consistent with [[fayoum-beni-suef-golden-rule-per-line]].

Consequence: **`Upper Egypt 1` + `Upper Egypt 2` do NOT sum to `Upper Egypt`, and that is CORRECT.**
Live: 3,552 + 6,990 = 10,542 against 9,562, a 980-shop gap — CNS and Pedia run Upper Egypt as ONE
territory (7 areas) while Anti Infective runs TWO (9 areas, the extra two being Qena 2 and Beni
Suef). **Do not "fix" this into a reconciliation** — nothing is dropped, the flat tab still holds all
50,622 shops, and forcing the totals to agree would falsify the organogram.

**One district manager seat is genuinely VACANT: Upper Egypt 2, Anti Infective, covering 6 areas.**
Every other region×line seat company-wide is filled by a real person, except the whole `Others`
region, which is `Sales only, no manager` on all three lines by design.

**How to apply:**
- **Never remove the hourly full content check.** None of the five `source_of_sales_*` tables has
  an update trigger (`pg_trigger` returns nothing for all five), so `updated_at` moves only when
  app code sets it — hand-applied SQL, routine here, does not. Row-count changes catch additions
  and removals within 5 minutes; the hourly pass catches EDITS. Drop it and hand-edited pharmacies
  go stale forever with no signal.
- **Never merge two rows on a blank name, and never fuse two codes held by ONE distributor.**
  Measured on production: without the first guard, 6,930 real pharmacies collapse into 477 rows
  (worst group: 68 shops on one line). The second guard covers 139 groups. Pinned by
  `tests/master-map-merge.test.ts`.
- **A tab is painted clear → text → formatting.** Not the obvious order. Apps Script dies at 6
  minutes and a repaint spans two, so every half-state is visible; formatting-first leaves a
  banded EMPTY Master tab, which reads as data loss.
- The route is registered `machine-token` in `access-registry.ts`. It sits under `/api/sales`, and
  the registry matches the LONGEST pattern — a shorter pattern there would silently inherit the
  `/api/sales/**` session rule.

Geography authority follows [[sos-bricks-are-the-authority-for-branch-to-area]]; areas must still
never be deleted, see [[sos-areas-must-never-be-deleted-au-linkage]]. Install steps and the full
reasoning live in `google-apps-script/master-map/README.md`.

**Update 2026-09-09 — THE FEED BEING HEALTHY TELLS YOU NOTHING ABOUT THE SHEET.** `master-map:check-feed`
reassembled every tab exactly and `All customers` matched the live plan at **63,511 rows**, while
**"Find a pharmacy" had been returning nothing for weeks**. The finder is a `FILTER` spilling one row
per shop into `Lists!F2`, and the hidden tab's grid was a **fixed 55,000** — chosen when the master
held 50,622. The master reached **63,510**, so the spill had nowhere to land: `Lists!F2` = `#REF!`,
results empty, and the status line read **"Showing 1 of 1 matching shops"** because `COUNTA` counts
the single error cell as a match. **A spill with nowhere to go fails the whole tab; it never
truncates.** Repaired by hand (grid 55,000 → 80,000, verified `Showing 500 of 63,510`, search
`B108-12` → 197 of 197); derived height + count-in-the-text shipped in PR #3568.

**How to read the live sheet without a Google credential:** drive the owner's own Chrome
(`mcp__claude-in-chrome__*`) and fetch `docs.google.com/spreadsheets/d/<id>/gviz/tq?tqx=out:csv&sheet=<tab>&range=<a1>&headers=0`
with `credentials:"include"` — cookie-authenticated, no API key, and `tq=select A, count(A) group by A`
gives per-region counts to compare against the plan. Probing a range past the grid returns an error,
which is how the 55,000-row ceiling was measured. **The master grew 50,622 → 63,510 in three weeks**,
so any fixed size here is a fuse, not a limit.

🔴 **`Delta (3)` is `fromOrganogram = true`, so it is ABSENT from `All customers`, `Master` and `Gaps`
— and that is CORRECT.** It is an organogram VIEW over the same shops, exactly like Upper Egypt 1/2,
because the Option A move deliberately left the sales geography alone (`code_region_code` unchanged).
Its 5,681 shops are already in the finder under Delta (1)/(2)/Others, and the region dropdown listing
**7** regions rather than 8 is that same fact. **Adding it to the flat tab would double-count 5,681
shops** — see [[attribution-is-period-aware-asof-not-todays-geography]].

**Update 2026-09-28 — THE FINDER DIED A SECOND TIME, AND ONE WRAPPER IS WHY BOTH LOOKED LIKE THE
OWNER'S OWN FILTERS.** A customer code is all digits, so typing one into the search box stores a
**NUMBER** in `Find a pharmacy!$E$4`, and Google Sheets will not coerce a number into `SEARCH`'s
first parameter: SEARCH errors on every row, `ISNUMBER` turns each error into FALSE, the clause is
0 everywhere, and FILTER matches nothing. Measured live: Region `Delta (3)` + `1547442` read
*"Nothing matches those filters"* while `All customers` held exactly one match (`0001547442`,
دعاء احمد بكرى ابو حماد, Sharkia 1, AI region Delta (3)); gviz reported E4 as `type:"number"`,
`1547442.0`. **Nothing else on the workbook hands a typed value to SEARCH**, which is why every
dropdown, every grid size, the spill area and the feed all read healthy — so the ONLY dead box was
the one whose main job is finding a shop by its code. Fixed in PR #4648: `TRIM(TO_TEXT(...))` for
the key, a TEXT number format on the cell, `LAYOUT_VERSION` v8 → v9 to carry it into the sheet.

🔴 **`IFERROR(FILTER(...))` ON `Lists!F2` IS THE COMMON CAUSE OF BOTH DEATHS — never put it
back.** A single-argument IFERROR flattens *no shop matched* and *this formula could not run* into
one blank cell, and the status line then blames the filters for a broken sheet. The FILTER is now
BARE and the status reads the ANCHOR cell: `ISNA(Lists!F2)` is no matches, `ISERROR` is a broken
finder, and only then does COUNTA run — which is what stops the 2026-09-09 *"Showing 1 of 1 matching
shops"* reading, where COUNTA counted the single `#REF!` as a match.

🔴 **CORRECTION to the Delta (3) note above, measured the same day: Delta (3) IS on the sheet now.**
The plan serves **15 tabs** including a `Delta (3)` region tab (6,787 rows), the region dropdown
offers **10** regions, and `All customers` carries `Delta (3)` in its `Anti Infective region`
column on 6,687 rows. What stays true is that it is absent from **column A**, which is geography —
and that is exactly why `LAYOUT_VERSION` v8 moved the Region box off column A onto the three
`<line> region` columns. **The master is now 78,924 crosswalk rows → 73,937 shops** (50,622 →
63,510 → 73,937), and the `Lists` grid is 100,000 × 22 — derived, and correct.

🔴 **Update 2026-09-28, later the same night — THE SECOND FAULT WAS NOT IN THE DATA AT ALL: THE
COUNT LINE RENDERS 2,000 PIXELS OFF THE RIGHT OF THE SCREEN.** The title, the count and the hint on
`Find a pharmacy` are each ONE CELL merged across all seventeen columns of the flat tab. Those
columns total about 4,000 px — Address alone is 600, the three manager columns 230 each — so a
**CENTRED** banner renders at roughly x=2,000, a screen and a half right of column A. On any normal
window all three are off the right-hand edge and the rows show as **empty coloured bands**. The
owner searched code `1582952`, the finder found it, put the row on screen, and reported the tab
empty — because the line saying *"Showing 1 of 1 matching shops"* was where nobody would ever look.
Scrolling right found all three sitting there perfectly. **That cost an evening of chasing a finder
that was already fixed.** All three read LEFT from v10 (#4660). 🔴 **`STYLE.region` and
`STYLE.area` stay CENTRED and must not be "tidied" — the grouped tabs are seven columns, ~1,900 px,
and their centre is on screen. The WIDTH of this one tab is what makes centre wrong, not the style.**

🔴 **AND THE SYNC NEVER CLEARED A FILTER — a basic filter was found parked on `Find a pharmacy`.**
The repaint's `updateCells` clears values, formatting and data validation and touches NO filter, so
one created by hand survives every repaint for ever. **A filter with criteria set HIDES matching
rows**, which is indistinguishable from a search that matched nothing while every formula behind it
is correct — a better disguise for "broken" than any of the real faults. `ensureTab` now removes it
(#4660), in Apps Script because `getFilter()` is null-safe where a `clearBasicFilter` request
against a tab without one can fail the batch and strand the repaint. The tell in the UI is funnel
icons on the status row and **Data → Remove filter** being offered.

🔴 **THE "FILTER CHOKES ON 1.26 MILLION CELLS" THEORY IS DISPROVED — do not rebuild the finder
around QUERY on it.** Measured live: with the search box cleared and one region picked the existing
FILTER returns **13,511** rows; with a code typed it returns exactly **1**; with every box empty,
**73,937**. Array size was never the problem. A QUERY rewrite built on that theory is parked on
`codex/master-map-enhancements`, commit `f3a3f2bf6`, marked do-not-merge — **KEPT by owner decision 2026-09-28**, double-archived
(the branch plus `refs/backups/master-map-enhancements` on origin). **If it is ever picked up it goes
through a normal PR like anything else — never merged direct, and never on the array-size premise,
which is disproved.** What is worth salvaging: the hidden Lists tab shedding its 2.2-million-cell
spill, the search covering the distributor and the three district managers, and every tab claiming
the grid it needs.

🔴 **`syncMasterMap` CANNOT SEE A LAYOUT CHANGE, and that wasted two round trips.** `planWork`
short-circuits: `if (!dueForFullCheck) { probe; if (stamp === storedStamp) return []; }`. The probe
stamp describes the DATA — customer, brick, area and region counts — so a Phoenix-side change to a
tab's LAYOUT never moves it and the plan is never fetched. **Deleting `MM_STAMP` alone is not
enough either: `runSync` only re-plans when `MM_QUEUE` is EMPTY**, so a stale queue makes the
deletion a no-op. What works is `forceFullResync` then `syncMasterMap` — measured, it repainted
all fifteen tabs (265,000 rows) in **one run of four minutes**, so it is NOT the heavy option it
looks like. The hourly full check does the same by itself within the hour. 🔴 **And confirm
production is SERVING the new layout before telling him to repaint** — read the tab text back from
`?tab=Find a pharmacy&part=values`; a repaint two minutes early simply paints the old version again,
and it clears his filter boxes every time.

🔴 **Update 2026-09-29 — `1kK8DaDP…` IS THE SCRIPT ID, NOT THE SHEET FILE ID; THE WORKBOOK IS
`1za3G8C6HCi74qmq4PwP_T7d-rM16UU1XivqEV7A48Hg`.** `.clasp.json` correctly holds the bound-script id
`1kK8DaDPXJvwG6vM1x_gv9X7zxqbvvAbEco9bnsGc4xLD2dHK_SzYN3SS`, and `script.google.com/.../projects/
1kK8DaDP…/executions` is the executions page — but `docs.google.com/spreadsheets/d/1kK8DaDP…/edit`
returns **"Page not found"** even signed in, because that id is the SCRIPT, not a Drive file. Open
the workbook at `1za3G8C6…`. The Apps Script project owner / signed-in account for gviz reads is
**`achieverrr303@gmail.com`**. The in-app browser pane is ANONYMOUS to Google (every private-sheet
URL 404s there with an Arabic "الملف … غير موجود" page); read the sheet through the **Claude-in-Chrome**
connected browser, where his Google session lives, not the in-app pane.

🔴 **THE FOURTH SILENT-BLANK DISGUISE — a self-healed transient reads as "blank" long after it healed,
and manual `forceFullResync`+`syncMasterMap` from the EDITOR FAILS on the 6-minute wall.** When the
owner says "the sheet is blank," read the live workbook through Claude-in-Chrome FIRST — on 2026-09-29
it was fully painted (v12, region tabs retired, 73,937 shops) while he reported blank. The cause was
the night before: he ran `forceFullResync` then `syncMasterMap` by hand three times (executions log:
Editor runs of 117 s, 190 s, 237 s all **Failed**). A manual Editor run tries to paint every tab in
ONE invocation and hits Apps Script's 6-min limit → **Failed** mid-repaint; the queue persists (the
`finally`), so the 5-minute TIME-DRIVEN ticks resume and finish across ticks — but between a cleared
tab and its repaint the finder (which reads `All customers`) is briefly empty, and that window is what
he saw. **Do NOT re-trigger `forceFullResync` to "fix blank" — it re-opens the same window. Let the
timer heal it; the hourly full-check confirms all hashes match in ~3 s when done.**

🔴 **THE FRESHNESS LINE SHOWED A RAW DATE SERIAL — `stampRefreshedAt` wrote a Cairo STRING into
`Lists!E1` and Sheets parsed it back to a date serial, so the finder's `&` join rendered
"Sheet refreshed 46294.0111111111 Cairo".** Fixed (PR #4694): `E1.setNumberFormat("@")` before the
write keeps the string a string; the frozen finder formula is untouched and the TZ stays honest
(formatDate already renders Africa/Cairo). Pinned in `tests/master-map-finder-grid.test.ts`
(`setNumberFormat("@")`). GAS change → reaches the workbook only via `clasp push`; E1 self-corrects on
the next data-change tick after deploy. **Note: the deployed script has NO `retireTabs` function** —
the ten region tabs are gone because Phoenix stopped serving them (`tabTitles()` → 5 tabs) and they
were removed by hand, NOT auto-deleted; `orderTabs` only reorders. If Phoenix ever drops a region
again, the script will leave the stale tab, not delete it.

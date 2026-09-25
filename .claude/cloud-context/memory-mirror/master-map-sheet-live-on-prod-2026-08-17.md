---
name: master-map-sheet-live-on-prod-2026-08-17
description: "Master Map live Google Sheet: it PULLS via its own Apps Script and Phoenix never pushes, no Google credential exists anywhere; a healthy feed proves nothing about the sheet — the Find a pharmacy finder died on a fixed 55,000-row Lists grid; Delta (3) is absent from All customers BY DESIGN"
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

# Source of Sales — decisions of record

Rulings the owner made during the 2026-07-31 → 2026-08-01 remediation, plus the later ones recorded
here since. They are business decisions, not implementation details: the code follows them, so
changing the code without changing this file means one of the two is now lying. Sections 1 to 4 are
pinned by `tests/sos-latent-guards.test.ts`; section 5 settles data, and has no code to pin.

## 1. Confidential products (2026-07-31)

**Analytics adopts the SoS dashboard's rule: LA003 / LA004 / SS001 are hidden by default and
revealed only for CEO / Super Admin.**

`analytics.sos_fact` hard-excluded them in the view while the dashboard revealed them, so the two
surfaces disagreed by the entire confidential total — June 2026 read **9,362,810 EGP** in Analytics
against **53,894,769 EGP** on the dashboard, and the 44,531,959 delta was exactly the confidential
value in all five loaded months. Those three products are 64.7–85.5% of company value, so Analytics
was showing the minority remainder, not a filtered view.

The four `analytics_sos_by_*` RPCs now read `analytics.sos_fact_all` (which already existed, with an
identical column list) and take the exclusion as `p_exclude_codes`.

> Both surfaces must default to EXCLUDED. Revealing by default for CEOs would recreate the same
> divergence in the other direction — their Analytics figure would disagree with their own
> un-revealed dashboard.

## 2. Attribution model (2026-07-31, refined 2026-08-01)

**Sales are wired to areas, bricks and regions — not to persons. The person wired to an area
inherits its sales, using TODAY'S wiring. But a departed rep keeps the credit for months they
actually worked.**

Together those are exactly:

```
credit = coalesce( occupant of the seat TODAY , occupant of the seat AT PERIOD END )
```

Today's wiring first, so a transfer re-points history to whoever owns the area now; the fallback
means a vacant seat does not orphan a month that someone really worked.

`au.f_seat_occupant_asof` previously fell through to `effective_from asc` — the earliest occupant the
seat ever had — whenever no span covered the date. That did not fail closed, it invented an owner.
Measured over 525 (area × period) rows: it was firing on 100; under the rule above 83 resolve to the
correct person, 17 become genuinely unowned, and 17 rows change in total.

Consequence accepted by the owner: an area vacant today whose sales nobody worked has **no person**
attached. It is not lost — attribution is area-first, so the value still belongs to its area.

## 3. Direct channel in targets (2026-08-01)

**Direct counts toward achievement, because the 2026 targets were SET including Direct.**

This is a correction, not an inflation: actuals were excluding a channel the targets already
assumed. Pedia June 2026 is the largest single effect at 42.5% of the line.

*Still to implement in `au.f_monthly_achievement`.*

## 4. Fail-closed scope sequencing (2026-07-31)

**Report the bad organisational records first, correct them, and only then merge a fail-closed scope
change** — so no manager loses access as a surprise.

The premise turned out different from the audit's: there are **no** areas sitting outside their
manager's region (0 rows), and Weekly Sales already scopes by seat areas. The real gap is that
**16 of 17 District Managers have a blank `employees.region_code`** (55 of 131 active employees).
Because the seat bound is populated and correct, the fix is to use it rather than to backfill 16
region labels — so this phase needs re-scoping, not execution.

## 5. The 14 uncovered bricks (2026-09-11)

**Every one of the fourteen bricks the 674→668 reallocation never covered is now settled. The
mappings they produced are the owner's decisions, not defects, and must not be re-opened.**

When the reallocation went live on 2026-07-24 it rebuilt the brick and block master and left the
49,712 customer rows alone. Fourteen live bricks appeared nowhere in the plan. Twelve were classed
"direct reallocation" purely because the old brick's name matched a brick in the new master, and the
remap of 2026-07-28 applied all of them. **895 pharmacies changed AREA on a name match, with no
address evidence recorded for any of them.** The owner asked at the time to decide them one at a
time, and only two were ever confirmed.

| Decided | Brick | Ruling |
|---|---|---|
| 2026-07-24 | `B110-63` → `B149-16` سابا باشا | Alex East, target ID corrected from a wrong relay |
| 2026-07-24 | `B106-79` → `B5-64` شارع صلاح الدين | **Heliopolis, not Alexandria** — owner overrode the address-text reading, twice |
| 2026-09-11 | Ten bricks | Keep the pharmacies in the area the July match put them in |
| 2026-09-11 | `B28-47` → `B17-28` باب الشعرية | **Put it back** — Bab El Sharia belongs to Down town, not Cairo East 1 |

The eleven open ones were put to him as one dropdown sheet, one row per brick rather than one per
pharmacy, so eleven answers settled every pharmacy standing on those bricks.

**What was applied on 2026-09-11.** Brick `B28-47` was created under block B28, which already sits
in Down town, because a brick's area is inherited from its block and cannot be set; `B17-28` stays
active in Cairo East 1 and keeps the customers that were already its own, since retiring a brick
that carries closed-month history lights up a data-quality warning on months that cannot be
restated. The pharmacies standing on the vanished brick moved onto the new one, and the five Bab El
Sharia aliases followed them, without which the next import would have re-resolved the town by name
and quietly rebuilt the problem. Across the ten kept bricks, the pharmacies that had drifted
elsewhere since July were aligned with the brick he kept, each sent to the brick its own siblings
use rather than to the brick the July file named — four of those target IDs no longer exist, because
the master was replaced again on 2026-07-27.

The mapping guard parked most of those writes, because the row carried an earlier decision of his or
because it crossed a region, and each was released against his answer through
`sos_map_guard_decide`. Pre-images: `bab_elsheria_backup_20260911`, `keep_bricks_backup_20260911`,
`kes_alias_backup_20260911`.

**Deliberately no row counts here.** Every figure that described how many pharmacies sit on which
brick was removed on 2026-09-11, because the crosswalk is written continuously by several hands and
a number in a decisions file goes stale within the hour. It did: two more rows moved onto `B28-47`
thirty minutes after this section was first written, and reconciling the file against production
then read as a discrepancy. The ruling is what this file is for. For counts, ask production —
`source_of_sales_customer_map` by `brick_id`, and `sos_map_change_log` for who moved what.

**No closed month moved, by design.** Each import row carries the area it was stamped with at
import, so a crosswalk repair reaches the next import and never restates history. July and August
are locked on all three lines and both matched a live recompute at zero cells before and after.

> A fresh audit re-derives these 895 as customers sitting in the wrong area every single time — this
> one did exactly that before the history was known. Read this section before proposing to fix them.

Two aliases were repaired in the same pass, unrelated to the sheet: `بيلا` and `حامول` still pointed
at bricks retired in the 2026-08-06 Kafr El-Sheikh realignment, so those two town names resolved to
nothing on import. Their pharmacies were already in Kafr El-Sheikh 2 and did not move.

## Deliberately not fixed

| Item | Decision | Why |
|---|---|---|
| `analytics.sos_by_block` inner-joins bricks | Guard test only | No consumers. A migration to fix a report nobody reads is approval and risk spent for no one. The audit's "22.7% dropped" is not reproducible either — rows with no brick or flagged Direct are 0.1% of the fact rollup. |
| 12-period cap on rep achievement | Keep, disclose | A real performance bound (one attribution pass per period). The defect was the silence. |
| 500-mapping cap on accept-mappings | Keep, refuse explicitly | A request-size bound is legitimate; silently slicing to it was not. |
| `p_areas` on `analytics_weekly_fact` | **Blocked, not deferred** | `weekly_sales_rows.area_code` exists but is unpopulated, so adding the argument would filter every area-scoped viewer to zero — worse than the current gap. Unblocks once the branch→area map is entered. |
| `invoice_period = b.period` join in the rollup refresh | Monitor, don't guess | Removing it means deciding whether the row's or the batch's period is authoritative, and a two-month batch carries a range string that is not a valid period key. 0 rows affected today; `phx_sos_period_drift_count()` makes it observable. |
| Closing Matrix target columns | Hide, don't build | A target source in that loader is a new feature, not a bug fix. |

## Claims that failed verification

Recorded so nobody re-opens them. All checked against production:

- `analytics.weekly_fact` region fan-out inflating 5–10× — **false**. The view has *fewer* rows than
  the base table (24,927 vs 29,714) and a 0.908× value factor; a fan-out cannot reduce row count.
- `analytics.sos_by_customer` 6.77× fan-out — **false**, factor is 1.000.
- `validation_state` filter divergence — **no impact**; all 219,092 rows are `valid`.
- Discount misread as a percentage — **no impact**; all 52 non-zero discounts are 0.0–0.08.
- "25 live areas sit outside their manager's region" — **0 rows**.
- "Weekly Sales still scopes DM/RM by region label" — **already seat-based**.
- The backfill RPC caused the 1,698 stale rows — **no**; it only fills NULL bricks, never re-points.
  That backlog belongs to the reconcile path.

## The Mapping Guard retirement (owner, 2026-10-10)

The owner removed the Mapping Guard completely ("drop this module … retire and kill it") after its holds
kept disagreeing with the mapping he was uploading. What went, in one PR:

- the `/sales/mapping-guard` screen, its API routes and the held-changes spreadsheet;
- the database triggers on the customer map, the bricks and the areas, the `sos_map_guard_*` functions
  and the `sos_map_guard_permits` table;
- the `sos_mapping_guard_alert` email-center audience.

What stays: `sos_map_change_holds` (3,468 rows) and `sos_map_change_log` (24,292 rows) as history, because
production has no point-in-time recovery; the cron route `/api/cron/mapping-guard-notify` and its
`phoenix-mapping-guard-notify` switch, because cron-job.org calls that path and it now only runs the
attribution freshness sweep.

The same night, the 30 customers behind the 55 still-held changes were switched to unmapped
(`active = false`, brick and area untouched) and all 55 holds were refused; the pre-image is
`sos_map_unmap_preimage_20261010` (in schema `sos_backup_20261010` since 23 Oct 2026). He maps them again when he next uploads. Sales rows and published
closings were not touched, and the un-map re-stamps nothing until the next upload or a reconcile.

## A brick move finishes on a clock (2026-10-13)

`sos_relocate_brick` is only half the move. It applies to the brick master, the customer map and the
import rows at once, but the TOTALS wait in `source_of_sales_brick_move_files` until each file is
rebuilt, and the clock that does it is `phoenix-brick-move-drain` (every 20 minutes, at :19, :39 and
:59).

**Why the clock exists.** Before 2026-10-13 the only drain was the Database Mapping page poller, so
closing the tab stranded a move with no error, no badge and no alert. The قوص and أبنود moves left 71
files unrebuilt from 12 Oct 13:27 Cairo, and every Qena figure on every screen was a day stale.

**Never call a move done on the brick row.** The evidence is
`select count(*) from public.source_of_sales_brick_move_files where refreshed_at is null` reading 0.

**A file finished any way other than through the app skips the store-split net entirely.** The net
step is TypeScript, computed from the closing detail rows, so a file completed over SQL (a timed-out
one, say) leaves the queue reading 0 with the stored net still pre-move. That is exactly how
74,741.23 EGP sat on the wrong area in Sept 2026. `refreshBatchRollups` is period-grain inside, so a
drain that completes every file through the app converges on its own. The clock now also settles any
period whose net predates the move: `brick-move-net-settle.ts`, at most 3 periods a fire, and never a
published month, because the database refuses it and it is reported instead.

**What pages the owner.** Both alerts use the same channels (in-app, Telegram and push) and go out at
most once per Cairo day per set.

- The residue the settle refuses to write: a published month (frozen by design, so nothing will ever
  retry it) or a failed settle (the retry only comes with the next file rebuild, and the queue is by
  then empty). `brick-move-net-alert.ts`, log `brick_move_net_unsettled`. A period the per-fire cap
  merely deferred is silent, because the next fire takes it.
- A file still waiting an hour after its move. `brick-move-stuck-alert.ts`. The heartbeat answers only
  "is the clock still firing?" and is blind to a clock that fires forever over a queue that never
  empties.

Code: `app/api/cron/brick-move-drain/route.ts`. Pinned by `tests/brick-move-drain-liveness.test.ts`.

## The address is the first source of trust (owner, 2026-10-13)

His words, in order: "deep audit and find any mapped brick mismatches its address", then "source of
trust number 1 a brick name in the customer address", then "the address is the first source of
trust" and "move all 1,463 and make the importer read the address first".

**The audit.** Every one of the 81,016 active customer-map rows was read against its own address
with the matcher now in `src/lib/sales/normalizer/address-brick.ts`. 1,463 rows named a different
brick than the one they sat on — 380 of them in another area. A fresh hand-read sample put the
wrong-area flags at 57 of 60 and the same-area ones at about 38 of 40.

**The moves (production, 13 Oct 2026, Cairo).** 1,462 map rows moved, stamped
`owner-ruling-2026-10-13-address-brick`, confidence 100, `mapped_by` B-10; 25 of them are Ibn Sina
twins moved with their pair. Pre-images: `public.address_brick_map_backup_20261013` (map rows) and
`public.address_brick_import_rows_backup_20261013` (import rows); the list itself is
`public.address_brick_moves_20261013`. The 5,459 already-imported 2026 rows (January to September,
58 files) were re-pointed with `sos_reconcile_import_rows_from_customer_map` and every file rebuilt;
afterwards 0 of them disagreed with the map. September's tracked lines shifted by at most 822 EGP
for any one area and line.

**The one row left where it was.** PS `0001554613`, "بجوار السلخانه – ترسا – مركز س": the
30-character Overseas address is cut at "مركز س" — مركز سنورس — so ترسا is the Sinnuris village and
the pharmacy's Fayoum mapping is right. The matcher now refuses a cross-area move when a capped
address ends in an administrative word followed by a stub that begins a place in the current area.

**The importer order** (`resolveBrick`): a direct brick id → an owner ruling (confidence 100) → a
brick named in the address → the distributor's territory label → the stored mapping. Before this,
the label came first and a label brick beat even an owner ruling. An address resolution has source
`address`, so the self-heal writes it back to the map as `sheet-verified`.

**What the matcher refuses to treat as a place**, each one a false flag in the audit's samples: a
street or the words after a street or owner marker; a name inside a longer one (ميت X, كفر X, ابو X,
مسجد X); a governorate city alone; a hit outside the pharmacy's region or outside every governorate
the address states; a brick kept as history after a move; fourteen keys that pointed at the wrong
area for most customers naming them. It moves a row only when the address does not name the
current brick, names exactly ONE other brick, and — across areas — names nothing in the current
area, its block included. Tenders, hospitals, El Qema and the Egydrug branch sheet are never read.

**Parity, measured on the pre-move snapshot of all 62,140 unruled rows with an address:** the
TypeScript matcher made 1,406 of the audit's moves to the identical brick and none to a different
one. It held back 38 — 36 where the address named two bricks, two where the cut-markaz guard now
applies — and every one of those is already a confidence-100 ruling. After the moves it would move
nothing else.

**History follows the address, from now on too** (owner, 2026-10-13 — "fix and heal historical and
future"). Historical: after the moves, 0 import rows from January to October 2026 disagree with the
customer map, and the store-split net for July, August and September was recomputed by the same
rebuilds (03:51–03:55 Cairo). Future: when an upload's ADDRESS moves a pharmacy, the self-heal now
re-points that pharmacy's earlier sales with `sos_reconcile_import_rows_from_customer_map` (a file
touching a locked closing stays whole) and queues each touched file in
`source_of_sales_brick_move_files`, so the 20-minute `phoenix-brick-move-drain` rebuilds its totals
and settles the store-split net. A correction from the territory LABEL still updates only the map —
the label is not geography — and an owner ruling is never rewritten, so it never heals either.

**The Office split recomputes from January 2026** (owner, 2026-10-13, asked as a choice — "Recompute
from January 2026"). It reverses his 2026-10-09 ruling "leave January-June outside the respread
window": `OFFICE_RESPREAD_START_PERIOD` is `2026-01`, so every 2026 month's CNS Office channel is
spread by today's area shares on every read, and the address remap's moves reach the Office half of
each month too. Nothing was published or locked when he ruled (0 live publication rows, 0 locks of
38). The stored attribution net for January to September is rewritten once after the deploy.

## One door for the import's money rules (14 Nov 2026, audit REC-008)

Three screens load a distributor's sales: Monthly Import (`/sales/import`), the Sales Upload (`/sales/upload`) and the Source Normalizer (`/sales/normalizer`). They reach two writers:

- `persistDistributorSalesUpload` (`src/lib/sales/monthly-distributor-import.ts`): Monthly Import, the Office upload and the Normalizer's one-click import;
- `persistNormalizedBatch` (`src/lib/sales/normalizer/service.ts`): the Sales Upload's commit.

Each writer used to apply the import's money rules itself, so a rule wired into one and missed in the other changed the figures of only some uploads. One had been missed: the Normalizer writer never checked the month lock before writing. A locked month's rows were written, and only the database's own lock stopped them, which left an orphaned pending batch behind.

`applyImportStoreRules` (`src/lib/sales/import-store-rules.ts`) is now the only place those rules run. It works in this order, before a batch row exists:

1. **EPDA's bonus deduction.** This applies only to a batch that will count as sales; a blocked batch is kept as the sheet said.
2. **A locked month is refused** with a 409. A month whose lock cannot be read is refused with a 503.
3. **The same workbook already stored under another month is refused.** Each stored batch is compared on its own month's price and deduction.

Both writers store exactly the rows and totals the door returns. A Monthly Import batch with nothing deducted keeps the sheet's own totals, as before. The lock check still answers at its old address in `monthly-distributor-import.ts`; deleting an upload checks it there too.

The same sheet sent through either writer stores identical rows, totals and duplicate check. `tests/sales-import-one-door.test.ts` proves that parity, and it also proves that no other code path deducts, checks the lock or looks for a duplicate on its own.

Not changed in this step: the parsers still each refuse a sheet whose numbers can be read two ways, in three places. The customer matcher is a later step (REC-009).

## One refresh when a closing is published or withdrawn (14 Nov 2026, audit REC-030)

Publishing and unpublishing a closing are the only two writes to `monthly_closing_publications`. Each one used to refresh the screens that show the closing's figures with its own list of four calls, so a cache added to one list could be missed by the other.

Both now call `onClosingPublicationChanged` (`src/lib/sales/closing-publication-refresh.ts`). It refreshes:

- the Closing Matrix's store-split overlay, which reads which months are frozen;
- Phoenix CRM's daily forecast, which reads the published achievement;
- every cache keyed on the achievement stamp: Sales vs Target, its page, the platform tile and the Business Review bundle. The stamp does not change when a month is published, so these need the refresh;
- Customer 360, which shows only published months.

The audit asked whether two more caches go stale on a publish. Both were checked against the code and are not refreshed:

- **Weekly Stock** reads weekly distributor stock and never reads the closing.
- **The Source of Sales dashboard** caches the imported rows, which a publish does not change. Which months a viewer may see is read on every request, outside the cache, so a withdrawn month disappears at once.

Brick coverage works the same way as the dashboard. `tests/closing-publication-refresh.test.ts` checks every cached read in the app that reads the publication. Each must either carry one of the refreshed tags or read the publication outside its cache; a new cache that does neither fails the test.

Nothing a viewer sees changed in this step: the same four refreshes run at the same moments.

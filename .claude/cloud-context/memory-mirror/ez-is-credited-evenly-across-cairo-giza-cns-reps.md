---
name: ez-is-credited-evenly-across-cairo-giza-cns-reps
description: "🔒 GOLDEN LOCK, owner 2026-09-06 — the EZ split rule is PERMANENT, never to be changed. EZ (client 1011654) is CNS-only and its sales are credited EVENLY across the CNS reps active in Cairo+Giza that month; the roster is FROZEN per period so a later resignation never rewrites a published month. CNS Office was RE-RUN on this base for Mar–Jul at the owner's order (July re-locked); FEBRUARY is deliberately held."
metadata:
  node_type: memory
  type: project
  originSessionId: 5344b79a-0aa0-46cd-ae76-929339b93a87
  modified: 2026-09-06T19:40:42.243Z
---

## 🔒 GOLDEN LOCK — owner, 2026-09-06

Asked about the splitting rules in Source of Sales, he ruled the EZ rule **permanent**: *"the rule of
EZ splitting is a golden lock to the end of the world. Never touch."* He said the same in the same
breath about the CNS Office allocation and **how it is distributed** — that one already has a
mechanical lock (`src/lib/sales/office-allocation.ts`, scrypt verifier + required CI test).

**The EZ rule has NO mechanical lock — the guard is behavioural only.** Nothing in CI fails if
`sos_even_split_customers` is edited, deactivated or dropped, if `phx_sos_rows_attributed` is
rewritten, or if a frozen roster row is changed. So the four surfaces below are each an unguarded
path to changing a rule he has said may never change: the registry row (`active`, `area_prefixes`),
the frozen rosters in `sos_even_split_roster`, the freeze function's no-op guard, and the
`phx_sos_rows_attributed` even-share arithmetic.

**How to apply:** treat any change touching those four as requiring him to say so in the live
conversation, exactly like the other three behavioural locks in CLAUDE.md. Do not "tidy", refactor,
re-derive a roster, or fold the split into the rollup. Related: [[owner-office-allocation-rule-value-share]].

**Owner ruling 2026-08-26.** EZ (client `1011654`, «مخزن شركه اى زد») is a warehouse in the
Katameya–Sokhna industrial zone — **neither Nasr City nor Heliopolis** — that buys through a
distributor. It is the **largest CNS customer in the country**, and because it sits in ONE place,
ordinary geography credited every unit of it to a single area. His rule is about **rep credit**, not
where the goods went: **CNS only, spread evenly across the CNS reps active in Cairo and Giza that
month.**

## The freeze rule — the half that is easy to get wrong

> "Once a month is uploaded, it's not changed … if one of these reps resigned, then August sales
> will be as it is — what will change is the distribution of EZ in September."

The divisor belongs to **the month**, not to today's roster. Deriving it live from hire/resignation
dates *looks* point-in-time safe and mostly is — until somebody corrects a historical hire date or an
employee row is removed, at which point **every past month silently re-splits** and published
closings move underneath the business. So the resolved roster is written ONCE per period into
`sos_even_split_roster` and read back forever; `phx_freeze_even_split_roster` is a **no-op** on an
already-frozen period. Deleting that guard turns the freeze into a recompute — the exact failure the
rule exists to prevent, and it would surface months later as a quietly different published number.

## The divisors, and why they are trustworthy

Derived from hire/resignation dates, mid-month leavers COUNTED (his ruling):

| Period | Reps | Areas |
| --- | --- | --- |
| 2026-02 · 03 | 5 | CA3, GZ2, GZ4, GZ5, GZ7 |
| 2026-04 | 6 | + CA1 |
| 2026-05 | 7 | + CA2 |
| 2026-06 · 07 | 8 | + CA4 |
| 2026-08 | 7 | CA5 joins; the two July leavers drop |

This matched **his own description of the structure independently** — Cairo 5 seats, Giza 6 (note
CNS **CA5 carries `region_code = GZ`** in `au.seats`, which is what makes Giza 6 and not 5), and
"3 out of 5 in Cairo, 3 out of 6 in Giza" currently = the 6 that resolve for September. That
agreement is the reason to trust the derivation. **`au.seats` has no history before 2026-07-13**, so
it CANNOT answer Feb–Jun — which is precisely why the roster is stored rather than re-derived.

## Two traps that cost real time

**1. The split does NOT belong in `source_of_sales_fact_rollup`.** It was applied there first and
looked perfect — 180 rows, drift 0.000000. But `phx_refresh_sos_fact_rollup(batch)` does
`delete` + `insert … from source_of_sales_import_rows`, so **one routine refresh erases it silently,
no error, no signal.** The rule now lives in `phx_sos_rows_attributed(period)` and is applied ON
READ; the raw import is never mutated and stays a true record of what the distributor invoiced.

**2. Every area needs its OWN landing brick — never reuse EZ's `B196-2`.** In the LOCKED golden rule
(`src/lib/sales/office-allocation.ts`), `brickUnits` is keyed on `brick_id` **alone** and keeps the
**first** area it encounters. One brick across 8 areas collapses to a single entry carrying all 8
areas' units, pushing a within-area share **above 1.0** and distorting the **AREA** totals the rule
exists to produce — while `areaShare` still looks correct, which is what makes it easy to miss.
Each roster row therefore carries its own `landing_brick_id` (the area's busiest CNS brick).

## Office impact — he explicitly required it

`phx_office_brick_share` reads **`source_of_sales_import_rows`**, not `fact_rollup` — so a split
living only in the rollup is **invisible to the Office allocation**. He required the Office to be
relocated on the new placement, so that function now reads the attributed rows. Measured, July 2026
CNS: **CA1 Heliopolis −2,556 units** (8.17% → 2.21%), **+365.1 to each** of CA2/CA3/CA4/GZ2/GZ4/GZ5/GZ7
— seven identical gains, itself proof the split is even — and **every area outside Cairo/Giza CNS
unchanged**.

**Why:** this is a standing attribution rule, not a one-off data fix; it must survive rollup rebuilds
and apply to future months as reps join and leave.

**How to apply:** freeze the period's roster when the month is uploaded, never recompute a settled
one, and never "tidy" the split into the fact rollup or onto a shared brick. Related:
[[owner-office-allocation-rule-value-share]], [[sos-monthly-closing-is-the-only-sales-truth]],
[[ez-warehouse-1011654-is-nasr-city-locked]] (**superseded on the area question** — EZ is no longer
credited to a single area at all), [[july-cns-office-override-and-main-store-bucket]].

## APPLIED TO PRODUCTION 2026-08-26 (owner said "go")

Migration `20260826190000_sos_even_split_ez.sql` applied to `ozucdzovmcqvepbozvqf`; objects verified
in `pg_proc`/`pg_class`, not from the success flag. Rosters frozen for **2026-02 … 2026-08** and they
resolved to the predicted **5 / 5 / 6 / 7 / 8 / 8 / 7**, every period with `reps == distinct bricks`.
The freeze no-op guard was then proven **on live data**: re-freezing 2026-07 with a sentinel actor
left the hash identical and wrote 0 rows.

EZ's 180 CNS rows in `source_of_sales_fact_rollup` were rewritten **surgically** (never
`phx_refresh_sos_fact_rollup` — July's batches mix lines and Anti Infective + Pedia July are LOCKED).
Result ties to the raw invoice exactly: **11,305 units** both sides, and stored now equals what the
function rebuilds (`diff_vs_function = 0` every month), so a future refresh is idempotent. Per-rep
credit came out identical within each month — 482×5, 30.40×5, 78×6, 254.14×7, 480.75×8, 331.25×8.

Pre-images live in schema `ez_split_backup_20260826`: `fact_rollup_ez_preimage` (180),
`monthly_attribution_rollup_preimage` (5,190), `sos_official_line_map_preimage`.

## The Office: July CNS WAS re-run, on his explicit order (2026-08-26)

He asked for "the office relocated based on the updated rule", and `phx_office_brick_share` now reads
the attributed rows. But July 2026 CNS Office was **not the rule's output at all** — it was his own
finalized sheet spread applied 2026-08-12 (`OTMS` Main Store bucket, eight areas deliberately
zeroed). So the rule and his override were in direct conflict, and **the conflict was surfaced, not
resolved by inference**: a dry run through the REAL locked function produced the exact cost, he was
shown it, and he chose **"Re-run the rule for July."** That is the pattern to repeat — a dry run
through the real function is cheap and turns an unanswerable judgement call into a one-line question.

**Applied and verified:** 3,636 rows → **3,591**, units conserved at **42,838** (drift 0), CNS July
line total unchanged at **105,151.97**, `OTMS` Office bucket gone (472.308 redistributed). Rep credit
followed exactly — every per-area attribution delta equals its Office row delta to the thousandth
(CA1 −1,110.137, CA2 −1,027.962, OT6 −621.169, OT7 +574.684, GZ6 −552.145, UE9 +517.078). The locked
lines were untouched: Anti Infective **7,017** and Pedia **11,552**, both still equal to their lock
snapshots. His parked tender rows survive at **153 rows / 1,069 units** — they sit in the DISTRIBUTOR
batches, so Office could never touch them.

**Two things that made this safe and are worth reusing.** `phx_refresh_sos_fact_rollup` is
**batch-scoped** (`where batch_id = p_batch_id`), so it cannot reach a locked sibling line in the
same period — verify that before assuming a refresh is contained. And the sanctioned persist path
runs **six** refreshes, not one (fact → customer-directory → ROI → channel → distributor-product →
attribution); running only the fact rollup leaves the rep-credit layer silently stale.
`phx_refresh_monthly_attribution(batch)` resolves the batch to its PERIOD and rebuilds every line in
it, so the [[a-case-duplicate-line-map-row-doubled-a-whole-line]] fix had to land first.

CNS 2026-07 was **re-locked** afterwards and the lock proven live: a direct `update … set qty = qty`
came back `Monthly closing CNS 2026-07 is LOCKED`. Pre-images in `ez_split_backup_20260826`:
`office_july_import_preimage` (3,636), `office_july_fact_preimage` (3,636),
`office_july_distproduct_preimage` (450), `office_july_channel_preimage` (1),
`attr_july_before_office_rerun` (928), `office_july_batch_preimage` (1).

## Feb–Jun Office re-run — he said "ok go" (2026-08-26); MARCH–JUNE applied, FEBRUARY held

Asked whether the same re-run should extend back, he approved it. **The recon changed the shape of
the job, and that is the reusable part:** all five batches were built 28 Jul – 1 Aug, **before the
2026-08-10 golden-rule change**, so they still carried the superseded per-product spread. The
movement therefore had **two** causes, and reporting it as "the EZ rule moved X units" would have
been wrong. Separating them cost one temporary read-only twin of `phx_office_brick_share` reading
raw rows instead of attributed ones (`_preez`, PUBLIC execute revoked, dropped after — verified
gone), and it showed the EZ split is the **minority** effect in every month:

| Period | Rows | Units | 08-10 rule change | EZ split | Written |
| --- | --- | --- | --- | --- | --- |
| 2026-03 | 1,651→2,802 | 26,422 | 5,093.4 | 69.1 | 5,125.4 |
| 2026-04 | 1,641→4,590 | 12,941 | 5,614.6 | 108.5 | 5,701.3 |
| 2026-05 | 2,153→4,430 | 52,961 | 19,936.3 | 3,532.7 | 18,829.3 |
| 2026-06 | 2,094→4,221 | 11,205 | 5,113.4 | 1,707.4 | 4,850.8 |

Drift 0 every month, `import_rows == fact_rows`, and **all 20 line-period attribution deltas 0.00**.
Unlike July these months are neither published nor locked. Provenance is stamped
`uploaded_by = 'owner-approved-golden-rule-rerun-2026-08-26'`. Pre-images:
`office_febjun_import_preimage` (10,154 / 153,650 units), `office_febjun_fact_preimage` (10,154),
`office_febjun_batch_preimage` (5), `office_febjun_distproduct_preimage` (1,992),
`attr_febjun_before_office_rerun` (4,288).

**February is HELD, for two independent reasons** — both in
[[office-rerun-drops-a-net-negative-product]]: its Office batch carries 372 hand-inserted
`manual-closing-2026-02` / `cns-recon` rows (2,786 units) that a re-run deletes, **cutting** the
month's CNS total rather than conserving it as July's did; and product DO003 nets −7 units, which the
locked rule silently drops. Untouched at 2,615 rows / 50,121 units, `uploaded_by` still `B-10`.

**Per-area attribution deltas track the Office row deltas but are NOT identical** (May: Cairo East 1
+4,556.88 and Down town −3,849.92 match exactly, Nasr City reads −1,830.27 against an Office delta of
−1,863.41; Gharbia 2 differs by 6). July's matched to the thousandth, so this is May-specific, and
**the cause was not chased** — attribution keys on (line, area, region, product) while the Office row
carries its own region, which is the likely place a few units re-bucket, but that is a hypothesis,
not a measurement. **Check the LINE total, which is exact (all 20 line-period deltas 0.00); do not
expect per-area equality — and if it ever matters, measure it rather than repeating this guess.**

## The backup schema was trimmed 79 MB → 8 MB on 2026-08-28 (owner said "drop the three")

`ez_split_backup_20260826` also held **three whole-CNS Feb–Jul snapshots this file never named** —
`import_rows` (41 MB), `directory_rollup` (16 MB), `fact_rollup` (14 MB) — 71 MB of the 79. All three
were **dropped after proving each carried nothing unique**, leaving the 17 narrow pre-images intact at
their recorded counts. No `CASCADE`; no view, FK or trigger depended on the schema; the three live
tables were re-counted after and were untouched (317,801 / 231,166 / 205,892).

- `directory_rollup`: **0 rows** differed from live — a pure duplicate.
- `import_rows`: 98,285 shared rows **byte-identical on all 28 columns** (md5 row hash); the 11,175
  rows live no longer has were **100% covered** by `office_febjun/july_import_preimage`.
- `fact_rollup`: uniquely held **27 rows — EZ's own pre-split attribution** (CA1 / `B196-2`), and
  those tie to the untouched live raw import to the unit (2,410 / 152 / 468 / 1,779 / 3,846 / 2,650 =
  **11,305**), so they are reconstructible. The design claim that the raw import is never mutated is
  what makes this safe — it was verified live, not assumed.

**⚠ `fact_rollup_ez_preimage` IS MISNAMED — it holds the POST-split state, not the pre-image.** Its
180 rows are the even spreads this file records as the *result* (482×5, 30.40×5, 78×6, 254.14×7,
480.75×8, 331.25×8), keyed to CA3/GZ2/GZ4/GZ5/GZ7 and later CA1/CA2/CA4 — not EZ sitting whole in CA1.
**Restoring from it to "undo" the split would re-apply the split.** The genuine pre-state now lives
only in `source_of_sales_import_rows`, where EZ is still at CA1 / `B196-2` for all six months.

**Two measurement traps that each produced a confident wrong number here**, worth reusing:
`phx_refresh_sos_fact_rollup` does delete+insert, so **`id` is not a key across a refresh** — an
id-based diff claimed February held 7,228 unique fact rows when the true answer on content is **4**.
And a `left join … using (...)` over nullable columns (`brick_id`, `client_code`) matched **nothing**,
because `NULL = NULL` is false — it reported 0% coverage against a true 99.8%. Use `EXCEPT`/`INTERSECT`
for pre-image comparisons; set operations are NULL-safe and joins are not.

**Trap that cost the PR a red run:** both NEW functions were SECURITY DEFINER with the default ACL,
so PUBLIC — hence anon/authenticated — could execute them, and `phx_sos_rows_attributed` returns
whole sales rows. The table-level `revoke ... from anon, authenticated` in the same migration hid
this by looking like access was handled. Fixed in prod and in the file per
[[revoke-from-public-strips-service-role-on-default-acl]].

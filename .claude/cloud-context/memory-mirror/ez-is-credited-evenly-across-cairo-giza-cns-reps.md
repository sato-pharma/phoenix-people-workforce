---
name: ez-is-credited-evenly-across-cairo-giza-cns-reps
description: "🔒 GOLDEN LOCK, owner 2026-09-06 — the EZ split rule is PERMANENT, never to be changed. EZ (client 1011654) is CNS-only and its sales are credited EVENLY across the CNS reps active in Cairo+Giza that month; the roster is FROZEN per period so a later resignation never rewrites a published month. CNS Office was RE-RUN on this base for Mar–Jul at the owner's order (July re-locked); FEBRUARY is deliberately held."
metadata:
  node_type: memory
  type: project
  originSessionId: 5344b79a-0aa0-46cd-ae76-929339b93a87
  modified: 2026-09-25T23:26:49.644Z
---

## 🔒 GOLDEN LOCK — owner, 2026-09-06

Asked about the Source-of-Sales splitting rules, he ruled the EZ rule **permanent**: *"the rule of EZ
splitting is a golden lock to the end of the world. Never touch."* (Same breath about CNS Office
allocation and how it distributes — but that one already has a mechanical lock,
`src/lib/sales/office-allocation.ts`.)

🔴 **The EZ rule has NO mechanical lock — the guard is behavioural only.** Nothing in CI fails if the
rule is edited. So treat any change touching these **four surfaces** as requiring him to say so in the
live conversation, exactly like the other behavioural locks in CLAUDE.md — do NOT "tidy", refactor,
re-derive a roster, or fold the split into the rollup:

1. the registry row in `sos_even_split_customers` (`active`, `area_prefixes`),
2. the frozen rosters in `sos_even_split_roster`,
3. the freeze function's no-op guard,
4. the `phx_sos_rows_attributed` even-share arithmetic.

## The rule (owner ruling 2026-08-26)

EZ (client `1011654`, «مخزن شركه اى زد») is a warehouse in the Katameya–Sokhna industrial zone —
**neither Nasr City nor Heliopolis** — that buys through a distributor. It is the **largest CNS
customer in the country**, and because it sits in ONE place, ordinary geography credited every unit to
a single area. The rule is about **rep credit**, not where the goods went: **CNS only, spread EVENLY
across the CNS reps active in Cairo and Giza that month.** (Supersedes
[[ez-warehouse-1011654-is-nasr-city-locked]] on the area question — EZ is no longer credited to a
single area at all.)

## The freeze rule — the half that is easy to get wrong

> "Once a month is uploaded, it's not changed … if one of these reps resigned, then August sales will
> be as it is — what will change is the distribution of EZ in September."

The divisor belongs to **the month**, not today's roster. Deriving it live from hire/resignation dates
looks point-in-time safe until somebody corrects a historical hire date or removes an employee row —
at which point **every past month silently re-splits** and published closings move underneath the
business. So the resolved roster is written ONCE per period into `sos_even_split_roster` and read back
forever; **`phx_freeze_even_split_roster` is a no-op on an already-frozen period** — deleting that
guard turns the freeze into a recompute, the exact failure the rule prevents. Mid-month leavers are
COUNTED (his ruling). `au.seats` has **no history before 2026-07-13**, so it cannot answer Feb–Jun —
which is precisely why the roster is stored rather than re-derived. Frozen rosters resolved to
**5 / 5 / 6 / 7 / 8 / 8 / 7** reps for 2026-02 … 2026-08, each period with `reps == distinct bricks`.

## Two implementation traps that cost real time

1. **The split does NOT belong in `source_of_sales_fact_rollup`.** `phx_refresh_sos_fact_rollup(batch)`
   does `delete + insert … from source_of_sales_import_rows`, so **one routine refresh erases it
   silently.** The rule lives in **`phx_sos_rows_attributed(period)`, applied ON READ**; the raw import
   is never mutated and stays a true record of what the distributor invoiced.
2. **Every area needs its OWN landing brick — never reuse EZ's `B196-2`.** In the locked office rule,
   `brickUnits` keys on `brick_id` alone and keeps the first area it meets, so one brick across 8 areas
   collapses into a single entry carrying all 8 areas' units, pushing a within-area share **above 1.0**
   and distorting AREA totals — while `areaShare` still looks correct, which is what makes it easy to
   miss. Each roster row carries its own `landing_brick_id` (the area's busiest CNS brick).

## Office impact — he explicitly required it

`phx_office_brick_share` reads **`source_of_sales_import_rows`**, not `fact_rollup` — so a split living
only in the rollup is invisible to the Office allocation. He required the Office relocated on the new
placement, so that function now reads the attributed rows. This is a standing attribution rule, not a
one-off fix: it must survive rollup rebuilds and apply to future months as reps join and leave.

## Status: applied 2026-08-26; Office re-run Mar–Jul; February HELD

Migration `20260826190000_sos_even_split_ez.sql` is live on `ozucdzovmcqvepbozvqf`; rosters frozen for
2026-02 … 2026-08. EZ's CNS rows in the fact rollup were rewritten **surgically** (never
`phx_refresh_sos_fact_rollup` — July batches mix lines and Anti Infective + Pedia July are LOCKED),
tying to the raw invoice exactly (11,305 units), and `diff_vs_function = 0` every month so a future
refresh is idempotent.

**CNS Office was re-run on this base for Mar–Jul** at his order; **July was re-locked** afterward
(proven live: an `update` returned `Monthly closing CNS 2026-07 is LOCKED`). Mar–Jun are neither
published nor locked, stamped `uploaded_by = 'owner-approved-golden-rule-rerun-2026-08-26'`. 🔴 The
Mar–Jun movement had **two** causes — those batches predate the 2026-08-10 golden-rule change so they
also carried the superseded per-product spread — and the **EZ split was the minority effect** in every
month; reporting the whole delta as "the EZ rule moved X" would be wrong.

🔴 **FEBRUARY is deliberately HELD** ([[office-rerun-drops-a-net-negative-product]]): its Office batch
carries 372 hand-inserted `manual-closing-2026-02` / `cns-recon` rows (2,786 units) that a re-run
**deletes, cutting** the month's CNS total instead of conserving it; and product DO003 nets −7 units,
which the locked rule silently drops. Untouched at 2,615 rows / 50,121 units, `uploaded_by` still `B-10`.

## Patterns and traps worth reusing

- **Surface a rule-vs-override conflict with a dry run through the REAL locked function**, show him the
  exact cost, and let him choose — that turns an unanswerable judgement call into a one-line question
  (July Office: his 2026-08-12 finalized sheet vs the rule; he chose "re-run the rule for July").
- **The sanctioned persist path runs SIX refreshes, not one** (fact → customer-directory → ROI →
  channel → distributor-product → attribution); running only the fact rollup leaves the rep-credit
  layer silently stale. `phx_refresh_monthly_attribution(batch)` resolves the batch to its PERIOD and
  rebuilds every line in it, so a [[a-case-duplicate-line-map-row-doubled-a-whole-line]] fix must land
  first. `phx_refresh_sos_fact_rollup` is **batch-scoped** (`where batch_id = p_batch_id`), so it
  cannot reach a locked sibling line — verify that before assuming a refresh is contained.
- **Check the LINE total (exact — all line-period attribution deltas 0.00); do NOT expect per-area
  equality.** July's per-area deltas matched to the thousandth but May's did not; the cause (attribution
  keys on line/area/region/product while the Office row carries its own region) was a hypothesis, not a
  measurement — measure it if it ever matters.
- ⚠ **`ez_split_backup_20260826.fact_rollup_ez_preimage` IS MISNAMED — it holds the POST-split state,
  not the pre-image.** Restoring from it to "undo" the split would RE-APPLY it. The genuine pre-state
  lives only in `source_of_sales_import_rows`, where EZ is still at CA1 / `B196-2` for all six months.
  (Schema trimmed 79 → 8 MB on 2026-08-28 after proving the three big snapshots held nothing unique;
  17 narrow pre-images remain.)
- **Pre-image comparison must be NULL-safe:** across a `delete+insert` refresh **`id` is not a key**,
  and a `left join … using (brick_id, client_code)` over nullable columns matches nothing
  (`NULL = NULL` is false) — use `EXCEPT` / `INTERSECT`, not joins.
- **Both new functions were SECURITY DEFINER with the default ACL** (PUBLIC executable, and
  `phx_sos_rows_attributed` returns whole sales rows); a table-level `revoke … from anon, authenticated`
  in the same migration hid it by looking like access was handled. See
  [[revoke-from-public-strips-service-role-on-default-acl]].

Related: [[owner-office-allocation-rule-value-share]] · [[sos-monthly-closing-is-the-only-sales-truth]] ·
[[july-cns-office-override-and-main-store-bucket]]

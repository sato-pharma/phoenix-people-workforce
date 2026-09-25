---
name: sos-remediation-13-phase-plan-2026-07-31
description: "SoS audit found 71 findings; 13-phase remediation plan with 4 recorded owner decisions — phases 0-2 shipped, 3 authored"
metadata: 
  node_type: memory
  type: project
  originSessionId: b7278c43-5066-40ba-99af-397dc2319bb9
  modified: 2026-08-01T08:56:19.678Z
---

Deep SoS audit 2026-07-31 (11 parallel auditors + read-only production SQL): **71 findings —
10 critical, 26 high, 35 medium/low**. Plan file:
`C:\Users\satoh\.claude\plans\giggly-rolling-stonebraker.md`. Report artifact:
https://claude.ai/code/artifact/43869d8b-3715-4bda-b443-08047f67ddcb

**Owner decisions (2026-07-31) — these are rulings, do not re-ask:**
1. Confidential products: Analytics adopts the SoS dashboard's rule (hidden by default, CEO/Super
   Admin reveal). See [[sos-analytics-excludes-confidential-5x-gap]].
2. **Attribution model: sales are wired to AREAS/BRICKS/REGIONS, not persons; the person wired to
   that area inherits them.** So `rep_hr_id` must be resolved from the area→seat→person wiring at
   READ time, never frozen into the fact row. This dissolves the mid-month tie-break question.
   **RESOLVED 2026-08-01: historical months use TODAY'S area→person wiring** — consistent with the
   owner's standing [[sos-always-todays-geography-rule]]. No as-of-period carve-out was asked for.
3. Direct channel **counts** toward achievement. **RESOLVED 2026-08-01: the 2026 targets were SET
   INCLUDING Direct**, so adding Direct to actuals is the correction — there is no achievement
   inflation to guard against.
4. Fail-closed scope: report the bad org records first, correct them, then merge.

**DONE as of 2026-08-01:** phases 0,1,2,3(DB only),4,5(partial),6,8,9(core),10,11,12,13 — all
committed, all green (**494 test files**, lint/cold-typecheck/build 0), **nothing pushed, no
migration applied**. Decisions of record: `docs/source-of-sales-decisions.md`.
**REMAINING:** phase 7 (re-scope — premises failed verification), phase 3's TS reveal wiring, rest
of phase 5, phase 9's Direct-in-achievement, phase 10's precedence-chain unification, phase 11's
Direct validator bypass / 20% blank-customer threshold / office-pivot blank-row stop, phase 12's
`p_areas` for `analytics_sos_by_customer`.

## ✅ MERGED TO MAIN 2026-08-01 — the remediation has landed (code only, NO migration applied)

`#1547` (phases 0+1) · `#1560` (phase 2 + the pagination resolution, squash `c5f75ee7`) ·
`#1549` (phases 3–12, squash `7d55a98f`). Verified present in `origin/main`: `sos-coverage.ts` and
the P5/P8/P9/P10/P11/P12 guard tests, plus four migrations —
`20260801093000_phx_exec_geo_filters`, `20260801112000_territory_alias_single_active_target`,
`20260801120000_sos_rollup_and_closing_sql_truth`, `20260801120500_au_seat_occupant_todays_wiring`.

**Migration-collision lesson (cost a full re-validation):** a clean `git merge` does NOT surface
duplicate migration timestamps — only `pnpm run check:migrations` does. Three collided with
unrelated work that landed on main. Two were renamed; the third
(`20260801090000_analytics_sos_confidential_basis`) had to be **DELETED, not renamed**, because main
already carried a strict superset at `20260801114237` (it also returns `channel`/`bonus_units`, which
the older copy drops — renaming would have re-applied the four RPCs and REMOVED columns from their
return type). Always diff a colliding migration against main's before renaming.

✅ **`#1558` MERGED 2026-08-01T03:59:04Z as `9f7ee136`** (closeout docs + latent guards) — now
`origin/main` HEAD. **ZERO open PRs remain: the SoS remediation is fully landed as code.** Its
CONFLICTING state was self-inflicted — #1549's squash had already put its own content on main, so the
conflicts were the branch colliding with itself; the `merge origin/main` reduced its delta to exactly
3 files (`docs/source-of-sales-decisions.md`, `tests/sos-latent-guards.test.ts`, +2 wiring lines in
`tests/run-tests.ts`). Local gate before merge: `check:harden` exit 0, **505 test files**, build 47s;
`check:migrations` clean at 138.

✅ **ALL FOUR APPLIED TO BOTH ENVIRONMENTS 2026-08-01** — staging (`cifwmndunmlxjhyjugxa`) first, then
production (`ozucdzovmcqvepbozvqf`) at ~07:40 UTC. Re-verified independently at 08:55 UTC by reading
`pg_get_functiondef` on both: `au.f_seat_occupant_asof` is the two-arm
`coalesce(occupant @ current_date, occupant @ p_asof)` with **no third arm**, `STABLE SECURITY
DEFINER`, `search_path='au','public'` on both. Staging's copy is comment-stripped (MCP applied the
body without comments); production's retains them — functionally identical. Nothing is pending on the
database side for these four.

⚠️ **A `pg_get_functiondef ... ilike '%effective_from asc%'` probe REPORTS THE NEW VERSION AS OLD.**
The new body *quotes that phrase in a comment* explaining the bug it removed, so a substring check
matches the fix and mis-reports production as unpatched. It cost a wrong "prod is 3 of 4" call here.
Detect on the CODE (`current_date` present AND `order by oh.effective_from asc` absent), or just read
the definition. Return types (`pg_get_function_result`), signatures
(`pg_get_function_identity_arguments`) and `pg_indexes` existence are safe — comments cannot forge
those. Related: [[prove-it-fails-verify-which-assertion-fired]].

⚠️ MCP `apply_migration` stamps the ledger with the CURRENT time, not the repo filename's timestamp,
so staging records these as `20260801051142/051229/051405/051749`. That is the established pattern
here (earlier sessions' migrations are stamped the same way) — staging is fed by MCP, never
`supabase db push` — but it means a version-based drift check will always show a mismatch.

**Verified on staging after applying** (all four move real numbers, none lost money):
`phx_closing_customers` now takes geography from the owner-maintained customer map — CNS June alone:
**332 customers get a corrected brick** (135,021 EGP) + 15 a corrected area; and it matches
`phx_exec_customers('2026-06',…,['CNS'],…)` **to the cent** (9,945 customers / 3,708,822.00), which is
the cross-surface agreement the migration existed for. Geo filters cascade (brick 1,936 rows/7.24M →
line CNS 1,692/4.11M → region CA 398/958k). The exclusion-normalisation fix is real: excluding
`TE002` vs `te002` now gives the **identical** total (5,070,846.23). `phx_sos_period_drift_count()` = 0.
The partial unique index `source_of_sales_territory_aliases_one_active_target (normalized_alias,
target_type) WHERE active` is live. The "exclude failed rows" rollup guard is a no-op today —
all 219,092 staging rows are `valid`.

**Branch protection reality check:** `main` has ZERO required status checks, so a merge is NOT gated
by CI. Verify `gh pr checks` on the exact head SHA yourself before every `gh pr merge --squash`.

Historical —

**SHIPPED TO PRs 2026-08-01. Phases 0+1 are MERGED into main via #1547** (opened by a parallel
session from `codex/sos-honest-zeros`, which was stacked on `codex/analytics-closing-scope`, so the
squash carried both). My duplicate #1548 was closed as superseded — squash-merge means the branch is
not an *ancestor* of main even though its content is, so it still rendered a diff.

**STACK COLLAPSED 2026-08-01 03:xx UTC — verified by reading each PR's `baseRefName`.** `#1550–#1557`
did NOT merge to main; they merged **into each other**, rolling up into `codex/sos-confidential-basis`.
Only `#1547` and `#1560` reached main. So `gh pr list --state merged` saying "merged" means *merged
into its parent branch* — check `baseRefName` before believing anything landed on main.

**`#1549` is now the single trunk PR carrying the remaining ~90% of the remediation** (13 commits,
base `main`). Only 2 PRs remain open in the whole effort: `#1549`, and `#1558 latent-guards` which
bases on it.

Two blockers on `#1549` as of 2026-08-01 03:35 UTC:
1. `CONFLICTING / DIRTY` — 9 commits behind main, 13 ahead.
2. `check:migrations` fails on **3 duplicate timestamps**, all collisions with migrations that landed
   on main from unrelated work: `20260801090000` (confidential_basis vs secure_email_backfill_backup_rls),
   `20260801100000` (sos_rollup_and_closing_sql_truth vs drop_email_backfill_backup), `20260801104500`
   (au_seat_occupant_todays_wiring vs revoke_anon_on_crm_visits_effective). `#1558` inherits the same
   failure. Also: the branch's `20260801090000_analytics_sos_confidential_basis.sql` is **superseded** —
   main already carries the corrected `20260801114237_analytics_sos_confidential_basis.sql` from #1561.

✅ **#1560 RESOLVED 2026-08-01 — owner ruled: the KEYSET pager survives.** Merged `origin/main` into
the branch (merge, never rebase). Resolution: `main`'s `fetchAllRowsOrdered(q, col)` and the branch's
`fetchAllRows(q, tiebreak)` are **behaviourally identical** (both `.order(col,asc).range(...)`), so
the duplicate was deleted and its 7 references renamed — a pure rename. `crm/reads.ts` took MAIN's
version because main had already moved those call sites to `keysetScanVisitsForRange`, which is the
better fix. `crm/master.ts`'s `loadBrickMappingByContactId` (added on main after the fork) had its
order hoisted out of the opaque builder into the `tiebreakColumn` arg. #1560 is now
**MERGEABLE / CLEAN**, 495 test files green.

✅ **Fork + collisions RESOLVED by the parallel session at 2026-08-01 03:32 UTC — commit `1eb4d0e9`
"merge: bring main into the SoS trunk on the keyset resolution", still UNPUSHED in
`_wt-confidential-basis`.** It applied the owner's ruling correctly: `paginated.ts` is down to two
functions (`fetchAllRows`, `fetchAllRowsKeyset`; `fetchAllRowsOrdered` dropped, its callers in
`crm/brick-geo.ts` + `crm/region-brick.ts` renamed), the superseded `20260801090000_analytics_sos_confidential_basis.sql`
is gone in favour of main's `20260801114237`, and the two remaining collisions were re-timestamped
(`sos_rollup_and_closing_sql_truth` → `20260801120000`, `au_seat_occupant_todays_wiring` →
`20260801120500`). No duplicate timestamps remain. It is one commit behind main (`9520c599`/#1565,
migration `20260801130000` — no collision), which does not block the merge.

**Rule that produced this:** an intermediate `51468960` on that branch had kept all three pagination
functions. Do not propagate merges up this stack from another session — check the worktree's local
HEAD against `origin/<branch>` first, because in-flight work here is routinely committed but unpushed.

Previously (now historical) — main independently added `fetchAllRowsOrdered`
(offset pager) for the same lost-rows bug this branch fixed with `fetchAllRowsKeyset` (seek pager),
and this branch also changed `fetchAllRows`'s signature. Conflicts in `src/lib/supabase/paginated.ts`
and `src/lib/crm/reads.ts` — a design collision, not textual. Every stacked PR inherits the same two
conflicts, so resolving it in #1560 clears all of them.

DB migrations still NOT APPLIED: #1549, #1550, #1553, #1554, #1557.

**Branch chain (each stacked on the previous, no migration applied):**
`codex/analytics-closing-scope` (P0) → `codex/sos-honest-zeros` (P1) → `codex/sos-complete-reads`
(P2) → `codex/sos-confidential-basis` (P3, migration only) → `codex/sos-exec-rpc-filters` (P4) →
`codex/sos-ui-truth` (P5, partial)

Worktrees: `_wt-analytics-scope`, `_wt-honest-zeros`, `_wt-complete-reads`,
`_wt-confidential-basis`, `_wt-exec-filters`, `_wt-ui-truth`.

**Still open:** P3's TypeScript half (reveal wiring — note BOTH surfaces must default to excluded or
the divergence just flips direction); most of P5; and P6–P13 entirely. P7 (fail-closed scope) and P9
(area-first attribution) are the two that change what people see and get paid on — neither may carry
an unrelated change, and both need the dev-auth **header** role sweep.

**Phase 9 — 🔴 THE MIGRATION'S OWN COMMENT IS WRONG. Re-measured 2026-08-01 against BOTH staging
(applied) and production (read-only simulation) — identical results, 4,048 rows each.**

`20260801120500_au_seat_occupant_todays_wiring` claims *"the five departed-rep areas … ≈4.87M EGP of
June credit … are UNCHANGED"*. **False for 3 of the 5.** `au.occupancy_history` (byte-identical in
staging and prod) gives those seats spans that start AFTER every loaded period, so the fallback arm
finds nothing and they go to NULL in **every** month:

| seat | occupant | span | verdict |
| --- | --- | --- | --- |
| SEAT-CNS-REP-AB5 | B-171 | 2026-07-13 → 07-17 | ❌ loses all 5 periods |
| SEAT-PED-REP-UE3 | B-111 | 2026-07-13 → 07-17 | ❌ loses all 5 periods |
| SEAT-AIF-REP-CA2 | AI-0004 | 2026-07-07 → 07-07 (zero-length) | ❌ loses all 5 periods |
| SEAT-CNS-REP-GZ2 | B-147 | 2026-02-08 → 07-18 | ✅ kept Feb–Jun, loses Jan |
| SEAT-PED-REP-D16 | B-169 | 2026-02-16 → 07-11 | ✅ kept Feb–Jun, loses Jan |

Real effect, production numbers: **105 product rows change rep (17 area×period pairs), 1,151,513.93
EGP moves from a named rep to NO owner. Zero rows swap one person for another, zero gain a rep.**
Per period lost: Jan 269,191 (5 seats) · Feb 301,876 · Mar 237,288 · Apr 171,060 · Jun 172,100 (3
seats each). The migration's "17 rows" was counting area×period pairs, not the 105 product rows.

**A second effect the migration never measured: a DM GAINS credit.** `SEAT-PED-DM-CA` is held today
by **PD-0006** (from 2026-07-19) and had a NULL-occupant span before that, so arm 1 now retroactively
credits PD-0006 with pedia Cairo/Giza (CA1–CA6, GZ5) for Jan–Jun — **+1,078,748 EGP of DM credit**
(Feb alone 703,235). That is "today's wiring wins" working as designed, but it is a live person's
numbers changing and the owner has not seen it.

Neither effect is a code bug — the function does exactly what the owner ruled.

✅ **ROOT CAUSE FOUND — it is 2 wrong rows, not a missing history.** The history is fine: 97 of 132
seats have real spans back to 2014-12-31; only 35 are blank for June and just **5 of those carry any
sales**. Cross-checking those 5 against `public.employees` (`hire_date` / `last_working_date`) shows
the seat span EQUALS the employment span for B-147 and B-169 — so the two outliers are simply wrong:

| HR | employed | seat span recorded | verdict |
| --- | --- | --- | --- |
| B-111 Amany Wasiem | 2025-12-28 → 2026-07-09 | 07-13 → 07-17 | 🔴 WRONG, worked all 5 periods |
| B-171 Samia Raafat | 2026-03-01 → 2026-07-11 | 07-13 → 07-17 | 🔴 WRONG, worked Mar/Apr/Jun |
| AI-0004 Abdelrahman | 2026-07-07 → 2026-07-07 | 07-07 → 07-07 | ✅ correct — 1 day, never worked Jan–Jun |
| B-147 Fatma Momen | 2026-02-08 → 2026-07-18 | 02-08 → 07-18 | ✅ correct |
| B-169 Mohamed Hamed | 2026-02-16 → 2026-07-11 | 02-16 → 07-11 | ✅ correct |

**Simulated on production (read-only) with those 2 spans corrected to the HR dates:** of the
1,151,514 EGP, **607,749 returns to B-111 and B-171** and only **543,765 stays unowned — and every
EGP of that is a month the person was not employed** (B-171 Jan+Feb 399,536 · B-147 Jan 94,616 ·
B-169 Jan 24,908 · AI-0004 all 24,705). So the migration is RIGHT to strip all of it; the two rows
just need real dates first. Assumption stated: "seat span = employment span", which is exactly how
the 3 correct rows behave.

**Order of operations: fix the 2 rows FIRST, then apply migration 4.** Reversed, two resigned reps
briefly show zero.

✅ **THE 2-ROW FIX IS DONE AND VERIFIED ON STAGING (2026-08-01).** Root cause confirmed from the row
itself: both bad rows are `event_type='seed_baseline'`, `source_system='seed_xlsx'`,
`effective_from = 2026-07-13` — **the org-load date, written as if it were the hire date.** Corrected
to HR's own dates (`occupancy_id` 126 → 2025-12-28→2026-07-09; 56 → 2026-03-01→2026-07-11) and each
seat's `vacant_placeholder` row moved back to the last working day so there is no gap. Backup +
one-call undo: `select au_occupancy_fix_20260801.restore_occupancy();` (6 rows, includes AB4).

Result on staging, exactly as simulated: changed rep rows **105 → 46**, unowned value
**1,151,514 → 543,764.51**, grand total still 47,093,906.40, **zero person-to-person swaps**.
B-111 credited all 5 periods (104,682.38); B-171 credited Mar/Apr/Jun (503,067.04) and correctly not
Jan/Feb. Everything still unowned is a month the person was not employed: B-171 Jan+Feb 399,535.84 ·
B-147 Jan 94,615.72 · B-169 Jan 24,907.50 · AI-0004 all 24,705.45.

✅ **A THIRD SEAT HAD THE SAME DEFECT — ALSO FIXED ON STAGING (owner approved).**
`SEAT-AIF-REP-AB4` / **B-176** (hire 2026-04-01, last working 2026-07-12) was recorded
`2026-07-13 → 2026-07-06` — an **inverted span** (`from` after `to`), because the seed wrote the load
date as the start while the resign reconcile stamped the vacancy's own start (07-06) as the end. No
date can match it, so the seat resolved to nobody in every period, before AND after the migration —
which is why it did NOT appear in the 105 changed rows. Corrected (`occupancy_id` 13 →
2026-04-01→2026-07-12, vacancy 138 → 2026-07-12). Result: **+22,576.05 EGP credited to B-176**
(Apr 5,958.45 + Jun 16,617.60); Jan–Mar correctly stay unowned (hired 1 April).

**Staging final state after all three fixes:** 4,048 rows, 47,093,906.40 total unchanged, rep rows
changed 50 (46 unowned + 4 newly owned), **still 543,764.51 unowned, zero person-to-person swaps.**

✅ **FULL SWEEP RUN — the three fixed ARE the complete set that distorts attribution.** Checks:
inverted spans, starts inside the load window, start≠`hire_date`, end≠`last_working_date`, and seats
with NO row covering today (**0** — so the vacant-today enumeration was complete). Three residual
flags, all verified harmless:
- `SEAT-CNS-REP-D23` / CN-0005 (Amira Samy, **active**) start 07-13 vs hire 07-01 — cosmetic only;
  she holds the seat today so arm 1 resolves her and she keeps all 227,765.82 EGP.
- `SEAT-AIF-NSM` / B-157 (Sameh) `effective_to` 2026-07-13 but HR `last_working_date` **2026-08-31** —
  a real HR-vs-org inconsistency worth raising, but his span still covers every loaded period end and
  the seat carries 0.00 rep attribution.
- `SEAT-AIF-REP-CA2` / AI-0004 zero-length 07-07→07-07 — matches HR exactly (hired and terminated the
  same day); correctly credited to nobody.

**The generalisable rule: a `seed_baseline`/`seed_xlsx` row whose `effective_from` sits in the
2026-07-07..13 load window is suspect, but it only distorts attribution for seats VACANT TODAY** —
an occupied seat resolves through arm 1 and never reaches the date-sensitive arm.

## 🔴🔴 PRODUCTION COLLISION 2026-08-01 07:27 UTC — ANOTHER SESSION IS WRITING TO PROD

While this session was fixing staging, **a different session applied
`au_seat_occupant_todays_wiring` to PRODUCTION** (ledger `20260801072734`, verified live in
`pg_get_functiondef`) **and corrected B-171's and B-169... no — B-171's and B-111's seat spans**, with
`change_reason = 'seat span corrected to employment dates (was the 2026-07-13..17 seed window)'` —
different wording from this session's, so it is definitely a third party. Discovered 3 minutes later
by a routine pre-flight, NOT by anything announcing it.

**Production state as of 07:31 UTC (partial):**
| item | state |
| --- | --- |
| migration 4 `au_seat_occupant_todays_wiring` | ✅ APPLIED by the other session |
| B-111 span → 2025-12-28..2026-07-09 | ✅ done by them |
| B-171 span → 2026-03-01..2026-07-11 | ✅ done by them |
| **B-176 / SEAT-AIF-REP-AB4 inverted span** | ❌ **still `2026-07-13 → 2026-07-06`, 22,576.05 EGP unowned** |
| both vacancy rows | ⚠️ left at 2026-07-17, so a **gap** now exists (spans end 07-09/07-11) — no loaded period ends in it |
| migration 1 `territory_alias_single_active_target` | ❌ not applied (index absent) |
| migration 2 `phx_exec_geo_filters` | ❌ not applied (RPCs still `p_period, p_exclude_codes` only) |
| migration 3 `sos_rollup_and_closing_sql_truth` | ❌ not applied (`phx_sos_period_drift_count` absent; backfill still returns `integer`) |

⚠️ **`phx_closing_customers` referencing `source_of_sales_customer_map` is NOT a valid test for
migration 3** — the old body already joins it for `client_name`. Test with
`phx_sos_period_drift_count` existing, or the backfill returning `TABLE(...)` not `integer`.

**Rule this cost:** before ANY production DB work, re-read the live object (`pg_get_functiondef`,
`pg_indexes`, function signatures) — the migration ledger and a measurement taken 30 minutes ago are
both stale the moment a parallel session exists. This session's own earlier read-only production
simulation (105 rows / 1,151,513.93 EGP) was taken BEFORE 07:27 and no longer describes production.

## ✅ PRODUCTION COMPLETE 2026-08-01 ~07:40 UTC (owner approved each step)

Finished the other session's partial work without touching its rows, using guarded UPDATEs
(`where … and effective_from = <exact old value>`) so a concurrent edit would show as 0 rows rather
than be silently clobbered. Backup + one-call undo on prod too:
`select au_occupancy_fix_20260801.restore_occupancy();` (6 rows, all three seats).

Done here: **B-176 fixed** (13 Jul→6 Jul inverted ⇒ 2026-04-01→2026-07-12, +22,576.05 EGP for Apr+Jun);
**migrations 1, 2, 3 applied**; **both vacancy gaps closed** (UE3→07-09, AB5→07-11).

**Production now equals staging on every measured number:** 4,048 rows / **47,093,906.40** total ·
B-111 104,682.38 (5 periods) · B-171 503,067.04 (Mar/Apr/Jun) · B-176 22,576.05 (Apr/Jun) ·
brick RPC 1,936/7,240,703.25 → CNS 1,692/4,109,041.65 → region CA 398/958,315.89 ·
`phx_exec_customers` CNS = `phx_closing_customers` CNS = **9,945 / 3,708,822.00 to the cent** ·
TE002 vs te002 exclusion both 5,070,846.23 · period drift 0 · alias index live · backfill returns
`TABLE(...)`. Final sweep: 0 seats without a current row; only the 2 known-harmless residuals
(CN-0005 active, AI-0004 zero-length matching HR).

**Still unowned on prod (all legitimately pre-employment): 578,553.56** — AB5 Jan+Feb 399,535.84 ·
GZ2 Jan 94,615.72 · AB4 Jan–Mar 34,789.05 · D16 Jan 24,907.50 · CA2 all 24,705.45.

⚠️ **NOT verified by a UI role sweep** — data-level only; the main checkout was held by another
session. ⚠️ **Prod ledger stamps differ from the repo filenames** (`20260801073*` vs `202608011*`),
same MCP-stamping behaviour as staging.

Superseded text (kept so the numbers aren't re-derived): commit `3122f592` implements
`credit = coalesce(occupant of the seat TODAY, occupant at PERIOD END)`. Measured over 525 (area ×
period) rows: 100 previously got an invented owner from the earliest-ever fallback, 83 resolve to the
same human anyway, 17 area×period pairs change owner, 17 become genuinely unowned. The
`f_seat_occupant_asof` earliest-ever fallback bug is fixed in the same commit. The original worry,
kept for the record:
`au.f_monthly_attribution` and `au.f_monthly_achievement` both resolve at `v_period_end` via
`au.f_seat_occupant_asof(seat, v_period_end)` + `au.f_line_area_map_asof(v_period_end)`. Switching
both to `current_date` moves **5 of 105 area rows per period, all in the same direction: lose their
rep, none gain one.** They are seats vacant TODAY whose occupant at period-end was real:
D16/pedia B-169 (2,351,296 EGP in June), AB5/cns B-171 (1,013,436), CA2/anti_infective AI-0004
(932,067), GZ2/cns B-147 (342,747), UE3/pedia B-111 (229,856) — **≈4.87M EGP of June credit moves
from a named rep to no owner.** These are almost certainly departed reps. That IS what "the person
wired to the area inherits the sales" implies when nobody is wired, but it means a resigned rep
loses all historical credit. Confirm before shipping.
Separately, `f_seat_occupant_asof`'s fallback is a real bug independent of the date: when no span
covers the date it takes `effective_from asc` — the EARLIEST occupant ever — inventing an owner.
Should return NULL.

**Phase 7 premise COLLAPSED on verification (2026-08-01) — re-audit before touching scope code:**
- "25 live areas sit outside their manager's region" → **0 rows**. Every area's
  `operational_region_code` matches its DM seat's `region_code` in `au_v_line_area_map` ⋈
  `au_v_org_tree`. The seat model is clean.
- "Weekly Sales still scopes DM/RM by region label" → **already seat-based**. `weekly/access.ts:188`
  derives `allowedRegionCodes` from `scope.allowedAreaFactRegionCodes`, passes `allowedAreaCodes`
  (`:193`), and applies it (`:259-261`). The hardcoded Pedia `["AB","D1","D2"]` is a documented
  fallback for when the seat map can't answer, not the primary path.
- The REAL finding instead: **16 of 17 District Managers have a blank `employees.region_code`**
  (also both NSMs and the CEO; all 74 reps and the RSM are fine; 55 of 131 active employees blank).
  So any surface still scoping on that label fails OPEN for 16 DMs — but the fix is to use the seat
  bound (already populated and correct), NOT to backfill 16 region labels and not to fail closed on
  a field that is empty nearly everywhere.

**Refuted — do NOT work on these** (verified false against production): analytics.weekly_fact
6.62x region fan-out (actual 0.908x, view has FEWER rows); sos_by_customer 6.77x fan-out (actual
1.000x); validation_state divergence (all 219,092 rows are 'valid'); discount-as-percentage
(52 rows, all 0–0.08).

**Owner data tasks no code fixes:** upload 2026-05 and 2026-07; upload Jan EP-BK + EP-PHS (~3.5M
EGP), Feb SF, Feb+Mar RM-T, Mar EG-HOS, Jun CP, Jan–Mar SF-T; correct the 25 areas outside their
manager's region; populate the weekly branch→area map; review the 1,698 rows disagreeing with the
active customer map.

Related: [[sos-import-coverage-metric-was-fake]] · [[sos-unordered-pagination-lost-mappings]] ·
[[dm-sales-scope-drops-out-of-region-areas]] · [[au-schema-is-the-org-sos-linkage]]

## Round 2 (2026-08-01, after the four merges) — what was completed and what is left

**Phase 3 was ALREADY complete end-to-end** — the parallel session had wired the TS half
(`confidentialRevealArg` + `p_exclude_head_office` on all four `analytics_sos_by_*` loaders). Verified
live in production: reveal → 53,894,769, hidden → 9,362,810 for June 2026, the plan's exact
acceptance numbers. My earlier "acceptance test fails" claim was MY test being wrong — I left
`p_exclude_head_office` at its default `true`, and those products sit on the Head Office line, so
that gate alone hides them. **Both gates must be open to reveal.**

**Shipped as PRs (not merged):**
- `#1566 codex/sos-ui-truth-remainder` — headline now equals the sum of its parts (C-O1 excluded from
  totals/units/avg price, matching every breakdown); portal territory target de-duplicated like its
  four sibling dimensions; analytics footer total recomputes under a search filter and says
  "Total (filtered)".
- `#1568 codex/sales-scope-fail-closed-blank-region` — geography no longer fails OPEN when a
  region-scoped viewer has neither a region label nor seat areas. Unchanged where the region is known
  or the seat answered.

**STILL NOT DONE (code):** Phase 11's last three (Direct validator bypass, the 20% blank-customer
drop threshold, office-pivot blank-row stop) · Phase 9's Direct-in-achievement in
`au.f_monthly_achievement` · Phase 10's precedence-chain unification · Phase 12's `p_areas` for
`analytics_sos_by_customer`.

**#1566 + #1568 MERGED 2026-08-01** (`c5610d13`, `273125fe`). Verified in main: `effectiveTotals`/
"Total (filtered)", `seenTerritoryTargets`, `hasSeatGeography`, and the `regionNames.size === 0`
guard in `applyRegionScope`.

🔴 **CORRECTION — I got the blank-region scale WRONG and said it twice.** The scope engine reads
`employees.region_name` (`viewerRegionName: viewer?.regionName`), **NOT** `region_code`. Measured on
the field the code actually reads: **1 of 17** District Sales Managers blank, 0 of 74 reps, 0 of 1
RSM, 0 of 2 NSMs. On `region_code` it is 16/17 — that is the number I quoted, and it is the wrong
column. The one blank-`region_name` DSM holds a seat owning 6 areas, so he takes the seat branch:
**nobody in production was fail-open because of this.** #1568 is a latent guard, not an active
exposure fix.

**Second half of #1568, found by the parallel session and easy to miss:** resolving a fail-closed
scope is only half the job. `applyRegionScope` treated "narrowed to nothing" as a data gap and fell
back to the UN-narrowed matrix — and an empty `Set` is truthy, so the engine's deliberate "no
geography" answer cleared the `!regionNames` guard, narrowed to zero regions, and was handed back as
the WHOLE LINE. A fail-closed producer needs a fail-closed consumer; check both ends.

## ✅ PRODUCTION COMPLETE 2026-08-01 08:11 UTC — migrations applied + 1,698-row repair run

All four migrations were **already applied to production** by the parallel session before I got
there (I re-verified each body, not just a counter). The **1,698-row historical repair is now done**:
1,698 rows across 14 batches reconciled against the active customer map via 659 calls to
`sos_reconcile_import_rows_from_customer_map`, then fact/directory/ROI rollups refreshed per batch.

Post-change, measured: rows still disagreeing **0** (was 1,698) · all 1,698 sit at their intended
brick · **0 rows had their value changed** · exactly **154 changed area** (= changed rep) · total
value 231,269,853 and row count 219,092 both **unchanged** — geography moved, money did not.

Backup: `sos_backup_20260801.import_rows_pre_reconcile` (1,698 rows + `will_become_brick_id`) and
`.reconcile_result`. Dated schema per `docs/security/backup-table-placement.md`, NOT public —
verified `anon` and `authenticated` have neither schema USAGE nor SELECT.

🔴 **CORRECTION — "all five departed reps keep their credit" was wrong; it is FOUR.** B-111, B-147,
B-169 and B-171 each have a real span covering 2026-06-30 and keep June. **AI-0004 does not and
should not:** its only span on `SEAT-AIF-REP-CA2` is `2026-07-07 → 2026-07-07`, a ZERO-LENGTH span in
July. It never held that seat in June — the old `effective_from asc` fallback invented it. Losing
that credit is the fix working, not a regression. Lesson: a name returned by the OLD resolver was not
evidence the person held the seat; I should have checked the span before promising the credit would
survive.

Attribution now: 525 area-period rows, 388 owned, 137 unowned (was 120 unowned + 17 that lost a
fabricated owner).

**PR #1573 `codex/sos-direct-in-achievement` (authored 2026-08-01, NOT applied)** — implements owner
ruling 3. `au.f_monthly_achievement` filtered actuals with
`channel='indirect' or (channel='direct' and area_code is not null)`. The second arm **kept ZERO
rows**: Direct has no brick and no area, so every Direct row leaves `f_monthly_attribution` with
`area_code IS NULL` (verified: 29 of 29 for 2026-06). Effect measured on production —
pedia 1,797,514 excluded = **42.5% of the line**, anti_infective 324,593 = 31.8%, cns none;
2,122,106 EGP of June absent from achievement entirely.
Fix keeps Direct at (line, NULL area, product) so it lands on the LINE, never split across areas and
never credited to a rep (the `lam_asof` join is on area_code, so rep/dm stay NULL and
`loadClosingByEmployee` still drops it). Signature/SECDEF/STABLE/search_path re-declared verbatim.

**PR #1577 `codex/sos-ingestion-remainder` (2026-08-01, NOT merged)** — closes Phase 11's last
three: (1) unreadable DIRECT value cell now raises "Value must be numeric" instead of being zeroed by
the DB insert — Direct is the only channel where sheet value isn't derived from qty×price, so the
only path an unreadable value reaches `value`; empty stays a legit zero; (2) blank-customer skip now
ALWAYS surfaced (warning >20%, info below) instead of silent under the threshold; (3) office pivot
non-numeric units on a NAMED product now collected as `badUnitsRows` and office-upload REFUSES the
file rather than importing it as 0 units. Extended office-pivot.test.ts + new sos-ingestion-remainder.test.ts.

**Phase 11 is now COMPLETE.** Remaining SoS code: Phase 10 precedence-chain unification, Phase 12
`p_areas` for analytics_sos_by_customer. Both are larger single-PR jobs.

**PR #1581 `codex/sos-coded-path-guard` (2026-08-01, NOT merged)** — Phase 10 cross-area half.
🔴 KEY FINDING: the coded distributor-import path (monthly-distributor-import.ts inline
`customerBrickByKey.get`) runs for **ZERO production rows** — every one of 219,092 validated rows uses
`normalizer` (75 batches / 209,167 rows), `office_allocation` (5 / 9,394) or `direct_orders`
(5 / 531), NONE of which uses that inline resolution. So "unify the two precedence chains" would
rewrite a dead path and risk `resolveBrick` (the live chain, 99.6% of rows). Instead added the ONE
missing guard: the coded auto-fill now rejects a customer-map brick that sits in a DIFFERENT area
than the sheet typed (cross-area), matching resolveBrick. Test drives the real
validateDistributorSalesWorkbookBuffer. **Phase 10 complete.**

**ALL SoS CODE PHASES NOW DONE.** Only remaining code item: Phase 12 `p_areas` for
analytics_sos_by_customer (a view re-cut — source table has no area column). Open PRs awaiting owner
merge: #1573 (Direct-in-achievement, migration), #1577 (ingestion remainder), #1581 (coded-path guard).

**2026-08-01 late: #1577 + #1581 MERGED** (`4699034a`, `645a18b4`) — ingestion remainder + coded-path
cross-area guard now on main. **#1573 conflict RESOLVED, still open awaiting owner apply-approval.**
Its conflict was two-part: run-tests.ts union (3 suites), AND a migration timestamp collision —
`20260801140000` clashed with `deductions_module_pin_trigger_search_path` from another session, so my
migration renamed to `20260801150000` (unapplied, safe; guard test finds it by name not timestamp).
#1573 now MERGEABLE, diff = exactly 3 files. Only SoS code item still not built: Phase 12 `p_areas`
for analytics_sos_by_customer (view re-cut).

🔴 **#1573 STAGING APPLY 2026-08-01 CAUGHT A REAL BUG — the first version was wrong.** Dropping the
`area_code is not null` predicate got Direct INTO the `actuals` CTE but the final SELECT rejoined
`keys`→`actuals` with `ac.area_code = k.area_code`, and `NULL = NULL` is never true, so Direct's
NULL-area key never re-matched and the achievement total DID NOT MOVE. Fix: `area_code IS NOT
DISTINCT FROM` on BOTH the actuals and tgt joins; lam join stays `=` (NULL area ⇒ no seat ⇒ credited
to no rep, intended). Re-verified on staging cifwmndunmlxjhyjugxa: pedia 2,434,469→4,231,982
(+1,797,514 = 42.5%), anti_infective 696,563→1,021,156, cns unchanged; credited_to_a_rep UNCHANGED
every line; 0 rows wrongly credited/targeted; secdef+grants intact; 0 advisors on the fn. Guard test
strengthened to require the NULL-safe joins (old test would have passed the broken version).
**LESSON: `=` on a nullable join column silently drops the NULL rows — this is why staging-first is
non-negotiable for anything touching area_code, which is NULL for all Direct.** Still NOT on prod.

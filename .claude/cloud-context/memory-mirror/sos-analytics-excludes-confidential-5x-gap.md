---
name: sos-analytics-excludes-confidential-5x-gap
description: "Sales Analytics and the SoS dashboard disagree 5.76x on the same month because analytics.sos_fact strips LA003/LA004/SS001; sos_fact_all already exists"
metadata: 
  node_type: memory
  type: project
  originSessionId: b7278c43-5066-40ba-99af-397dc2319bb9
  modified: 2026-08-01T03:02:53.990Z
---

**This is the root cause of the owner's "Source of Sales miscalculates" report (2026-07-31).**

`analytics.sos_fact` hard-excludes products LA003/LA004/SS001 in the view. The SoS dashboard
includes them behind a CEO/Super-Admin reveal. Same month, two screens, measured on production
`ozucdzovmcqvepbozvqf`:

| period | analytics.sos_fact | raw / SoS dashboard | delta |
|---|---|---|---|
| 2026-01 | 7,747,839 | 39,699,493 | −31,951,654 |
| 2026-02 | 11,384,570 | 32,230,122 | −20,845,552 |
| 2026-03 | 9,400,846 | 64,893,123 | −55,492,277 |
| 2026-04 | 9,197,842 | 40,552,346 | −31,354,504 |
| 2026-06 | 9,362,810 | 53,894,769 | −44,531,959 |

In every month the delta is **exactly** the confidential-product total. Those three products are
**64.7–85.5% of company value** — Analytics shows the minority remainder, not a filtered view.
`analytics.sos_fact` holds 0 confidential rows vs 107,246 in the raw table.

**Key shortcut: `analytics.sos_fact_all` ALREADY EXISTS** with a byte-identical column list and its
June total is 53,894,769 — an exact match to the dashboard. Fixing the gap is repointing the
`analytics_sos_by_*` RPCs at it and passing `p_exclude_codes`, NOT a data rebuild.

**✅ INDEPENDENTLY RE-VERIFIED against production 2026-08-01 — every figure in the table above is
exact.** Both objects are VIEWs, both 21 columns, column lists identical in both directions (0 diffs).
The decisive proof the delta is *purely* the confidential products: the non-confidential subtotal of
`sos_fact_all` equals `sos_fact` **to the digit in all five months**. Row math is exact too —
`sos_fact_all` 158,277 − `sos_fact` 94,152 = 64,125 = the confidential row count; `sos_fact` holds 0.
Confidential share by month: Jan 80.5%, Feb 64.7%, Mar 85.5%, Apr 77.3%, Jun 82.6%. June ratio
53,894,769 / 9,362,810 = **5.756×**.

**There are five `analytics_sos_by_*` RPCs but only FOUR are in scope — and that is correct.**
`_by_period`, `_by_area`, `_by_line`, `_by_product` all read the stripped `analytics.sos_fact` and
none takes `p_exclude_codes` — those are the four the migration fixes. **`_by_customer` is
legitimately excluded**: it reads `analytics.sos_by_customer`, built on
`source_of_sales_customer_presence_rollup`, whose only measure is `active_batches` (a COUNT). It has
no `value` or `units` column at all, so it cannot participate in a money gap. (I briefly flagged the
four-vs-five split as an omission before checking what `_by_customer` measures — it is not one.)

**Migration reviewed 2026-08-01 — the SQL itself is sound.** Reads `sos_fact_all`, takes
`p_exclude_codes text[] default array['LA003','LA004','SS001']` so it is **hidden-by-default and an
un-updated caller stays fail-closed**. Each function is DROPped at its exact live signature before
CREATE (12-arg for `_by_period`/`_by_area` which carry `p_exclude_head_office`, 11-arg for
`_by_line`/`_by_product`) — verified those match production exactly, which avoids the orphaned-overload
hazard that made SoS anon-readable in `20260719160500`. PUBLIC/anon/authenticated EXECUTE revoked and
`service_role` granted on all four new signatures. Exclusion is case/whitespace-normalised on both
sides. Ends with `notify pgrst, 'reload schema'`. Deliberately does NOT add `p_exclude_head_office`
to `_by_line`/`_by_product` (documented; covered fail-closed in TS by `stripHeadOfficeRows`).

**🔴 BLOCKER — the branch is 40 commits STALE and merging it as-is would REVERT a large amount of
work.** `codex/sos-confidential-basis` forked at `99312c14` (2026-07-31 19:16), i.e. BEFORE that
evening's merges. Merge-base check: **40 commits on `main` are not on the branch**; only 4 are unique
to it. `git diff origin/main <branch>` touches **188 files, −7,963 lines**, and would delete among
others `src/lib/recruitment/cv-auto-apply.ts`, `cv-review-queue.ts`, both cv-review-queue pages,
`cv-extraction-fields.ts` and their tests, and revert the whatsapp-health weekday gate — it contains
neither `ac755e31` nor `7292c388`. **✅ SOLVED 2026-08-01 — do NOT merge the branch; CHERRY-PICK the migration instead.**
Merging `origin/main` into the branch conflicts in 2 files (`src/lib/crm/reads.ts` 2 hunks,
`src/lib/supabase/paginated.ts` 1 hunk) and the conflict is a **design collision, not textual**: the
branch's `097c25c4` added `fetchAllRowsKeyset` (seek pager) while `main` independently added
`fetchAllRowsOrdered` (offset pager with a mandatory order column) for the *same* lost-rows bug.
Resolving that needs an owner call on which abstraction survives — and pagination is where this repo
has already lost data twice ([[keyset-pagination-orderby-id-trap]],
[[crm-export-streaming-corruption-incident]]).

**None of that blocks the migration.** `5ee7bbdd` touches **exactly one file** (the migration,
264 insertions), so `git cherry-pick 5ee7bbdd` onto current `origin/main` applies with **zero
conflicts**. Verified: resulting diff vs main is 1 file / +264 / −0, and `cv-auto-apply.ts`,
`cv-review-queue.ts`, `paginated.ts` and the `isSilenceAlertWindow` weekday gate are all still
present. **[PR #1546](https://github.com/Gawish-1997/phoenix-people-workforce/pull/1546) MERGED as `573a93d4`**
(branch `codex/sos-confidential-clean`). Migration file
`20260801114237_analytics_sos_confidential_basis.sql` is on `main`. **Applied to STAGING only —
production NOT applied.**

**🔴🔴 THE MERGED MIGRATION IS DEFECTIVE — DO NOT APPLY TO PRODUCTION. Reverted on staging
2026-08-01.** It was authored against an older shape of the RPCs and silently drops columns:

| RPC | production returns | migration returns | damage |
|---|---|---|---|
| `analytics_sos_by_period` | …month, **channel**, units, **bonus_units**, value | …month, units, value | `mapSosKpiRow` reads `r.channel` + `r.bonus_units` → channel blank, bonusUnits 0 |
| `analytics_sos_by_area` | …area_name, **channel**, units, value | …area_name, units, value | `mapSosAreaRow` reads `r.channel` → channel blank |
| `_by_line`, `_by_product` | — | — | return types MATCH, fine |

It is a **silent** regression, not a crash — the `s()`/`n()` coercers turn the missing columns into
`""`/`0`. It also **weakens the head-office predicate**: production uses
`lower(btrim(regexp_replace(line,'\s+',' ','g'))) not in ('head office','headoffice','office','hq')`;
the migration uses plain `lower(line) not in ('head office','headoffice','hq')` — losing BOTH the
whitespace normalisation and `'office'`, which is a confidentiality regression.

**How it got missed:** my staging verification summed `value` only, so dropped dimension columns were
invisible. **Lesson: when a migration recreates a function, diff `pg_get_function_result()` before
and after — comparing aggregate numbers cannot see a lost column.** Always snapshot
`pg_get_functiondef()` BEFORE applying, not just after.

Staging reverted via migration `revert_analytics_sos_confidential_basis` (drops the new 13-/12-arg
signatures, restores production's exact definitions, re-revokes ACLs); verified 1 overload each and
return types identical to production. **Production was never touched.**

**✅ FIXED AND MERGED — [PR #1561](https://github.com/Gawish-1997/phoenix-people-workforce/pull/1561)
merged 2026-08-01 02:36 UTC as `c2f38032`.** The file on `main` is now the CORRECT version —
verified by content, not by trusting the merge: `bonus_units` ×4, `channel` ×23, `regexp_replace`
×2, `'office'` ×3, `sos_fact_all` ×8, and by_period's returns clause carries channel + bonus_units.
The defective version is gone from `main`. It rewrites the migration in place
(branch `codex/sos-confidential-basis-fix`, commit `b566c6d5`). Every
function body is now copied VERBATIM from the live production definition; the only edits are
`sos_fact` → `sos_fact_all`, the `p_exclude_codes` parameter, and its predicate. **Verified on
staging the right way this time — return types byte-identical to the pre-apply baseline on all four,
1 overload each, `channels=2` in every scenario** (the dimension the bad version dropped), CEO
default 9,362,810 = `sos_fact`, CEO revealed 53,894,769 = `sos_fact_all`, non-privileged 9,362,180
unchanged, anon EXECUTE false / service_role true. `check:migrations` OK at 133.

**✅ APPLIED TO PRODUCTION 2026-08-01 ~02:40 UTC (`ozucdzovmcqvepbozvqf`).** Verified by
**return-type diff, not totals**: AFTER == BEFORE byte-identical on all four (by_period keeps
`channel` + `bonus_units`, by_area keeps `channel`), 1 overload each, anon EXECUTE false /
service_role true, all four read `sos_fact_all`. **Every existing caller's numbers are unchanged** —
by_period 9,362,180, by_period CEO-HO 9,362,810, by_area 9,362,180, by_line 9,362,810, by_product
9,362,810, channels=2 throughout — because the app does not pass `p_exclude_codes` yet. New
capability confirmed live: by_period CEO revealed = **53,894,769**. Live smoke: healthz 200,
login 200, /sales 200, zero ERROR logs since. Rollback artifact saved at
`…/scratchpad/sos-rpc-production-rollback-2026-08-01.sql` (session-scoped; re-derive from
`pg_get_functiondef` if gone).

**✅ APP-SIDE REVEAL MERGED — [PR #1562](https://github.com/Gawish-1997/phoenix-people-workforce/pull/1562)
merged 2026-08-01 02:43 UTC as `53dde00f`.** Gate was re-checked first: all four production RPCs
confirmed carrying `p_exclude_codes` before merging. Verified on main by content —
`confidentialRevealArg` appears 5× in `analytics/service.ts` (1 definition + 4 call sites).
**The full sequence #1561 → production apply → #1562 is COMPLETE.** All worktrees and branches
cleaned up.

**🎉 FULLY LIVE IN PRODUCTION 2026-08-01 ~03:00 UTC — the 5.76× gap is CLOSED.** Deployed via
`gh workflow run deploy-cloud-run.yml --ref main -f force=false` (~400s). Serving revision
`phoenix-hr-00768-hir`, `COMMIT_SHA=sha-53dde00f`, Ready; `53dde00f` confirmed an **ancestor** of the
serving commit (ancestry, not equality — the deploy ships `main` cumulatively). Smoke: healthz 200,
login 200, /sales 200, zero ERROR logs. `RECRUITMENT_WHATSAPP_SILENCE_ALERT_HOURS=96` survived.

**Live production numbers for June 2026:**

| viewer | before | now |
|---|---|---|
| CEO / Super Admin | 9,362,810 | **53,894,769** (matches the SoS dashboard) |
| everyone else | 9,362,180 | 9,362,180 (unchanged, correct) | Reveal is
`p_exclude_codes: []`; hiding OMITS the key so ordinary viewers keep the pre-migration argument set
and only CEO/Super-Admin requests depend on the new signature. `check:harden` green, 494 tests.

**🔴 DEPLOY-ORDER GATE for the app-side reveal:** the follow-up PR (branch
`codex/analytics-confidential-reveal`) makes CEO/Super-Admin requests pass `p_exclude_codes`, which
**requires the new RPC signature**. It must NOT be merged/deployed until the migration is applied to
PRODUCTION, or CEO analytics breaks. Blast radius was deliberately minimised: hiding OMITS the key
(so ordinary viewers keep the pre-migration argument set and are unaffected), only a reveal request
depends on the new signature.

**🔴 `check:migrations` caught a duplicate-timestamp collision that the stale branch hid:** the
original filename `20260801090000_*` clashed with `20260801090000_secure_email_backfill_backup_rls.sql`
already on `main`. Renamed to **`20260801110000_analytics_sos_confidential_basis.sql`** (after the
highest existing, `20260801104500`); re-run passes 132 migrations. This is
[[migration-timestamp-collision-hazard]] happening for real — a stale branch cannot see timestamps
merged after it forked, so ALWAYS run `check:migrations` after rebasing/cherry-picking a migration.

**The real lesson: the branch bundles 4 unrelated deliveries** — the migration, a pagination fix, an
analytics error-state fix, and an analytics geography-scope fix. Only the migration is wanted here.
The other three each deserve their own branch off current `main`, and `097c25c4` in particular must
be reconciled against main's `fetchAllRowsOrdered` rather than merged blind.

The one figure I could NOT reproduce: the "107,246 confidential rows in the raw table" claim. The
view shows 64,125. Those count different objects (raw source table vs the view), so it is probably
not a contradiction — but do not quote 107,246 without re-deriving it.

**Why:** the exclusion was baked into the view instead of being a per-caller argument, so there was
no way for an authorized viewer to reveal, and no way for the two surfaces to agree.

**🔴🔴 APPLIED TO STAGING 2026-08-01 (`cifwmndunmlxjhyjugxa`) — works, AND uncovered that the
confidential filter is NOT the whole story. 100% of confidential value sits on line = "Head Office".**

| period | confidential rows | on Head Office | confidential value | value on Head Office |
|---|---|---|---|---|
| 2026-01 | 13,119 | **13,119** | 31,951,654 | **31,951,654** |
| 2026-02 | 8,652 | **8,652** | 20,845,552 | **20,845,552** |
| 2026-03 | 15,273 | **15,273** | 55,492,277 | **55,492,277** |
| 2026-04 | 13,712 | **13,712** | 31,354,505 | **31,354,505** |
| 2026-06 | 13,369 | **13,369** | 44,531,959 | **44,531,959** |

Every row, every month, 100%. **Consequence: with `p_exclude_head_office` at its default `true`, the
head-office filter already strips every confidential row, so flipping the confidential reveal on for
CEO/Super Admin changes NOTHING.** A naive staging test hides this — calling the RPC with defaults
returns 9,362,180 for June whether `p_exclude_codes` is set or empty, and it *looks* like a pass.
Only `p_exclude_head_office => false` exposes the real behaviour.

**Verified both directions with `p_exclude_head_office => false` (June 2026), exact production
numbers:** default (hidden) = **9,362,810** = `sos_fact`; `p_exclude_codes => '{}'` (revealed) =
**53,894,769** = `sos_fact_all`. So the migration itself is correct and does exactly what it claims.
Also verified: **no orphaned overloads** (exactly 1 function per name — the drop signatures matched),
and ACLs are right (anon/authenticated EXECUTE = false, service_role = true on all four).

**✅ RESOLVED — the migration IS the right and sufficient fix. Head Office is already a
permission-gated reveal; confidential products were the only thing hard-wired with no reveal.**
`src/lib/analytics/service.ts` already passes `p_exclude_head_office: !filters.canViewHeadOffice`
(fail-closed when absent) and applies `stripHeadOfficeRows` for the RPCs that lack the arg;
`canViewHeadOfficeLine(role)` is `CEO || Super Admin` (`src/lib/sales/access-scope.ts:49`).
`stripHeadOfficeRows` lives at `access-scope.ts:503`, NOT in analytics/service.ts as the migration
comment says.

The gap is therefore **CEO/Super-Admin-only**, which is exactly who reported it. June 2026 on staging:

| viewer | before fix | after fix | dashboard |
|---|---|---|---|
| CEO / Super Admin | **9,362,810** | **53,894,769** | 53,894,769 |
| everyone else | 9,362,180 | 9,362,180 | 9,362,180 |

A non-privileged viewer already agreed with the dashboard (head office strips the confidential rows
for them anyway, since 100% of confidential sits on that line) — so nothing changes for them, which
is correct. **I briefly concluded the migration "changes nothing"; that was wrong** — it was measured
with `p_exclude_head_office` at its default `true`, i.e. the non-privileged case, which was never the
broken one.

**Two real but currently-inert findings:** (1) the TS key set is
`{"head office","headoffice","office","hq"}` while the SQL uses `('head office','headoffice','hq')` —
TS also strips a line literally named `office`; no such line exists in the data today, so it is
latent, not live. (2) Head Office is much bigger than the confidential products alone — 64,283 rows /
184,186,068 across all periods vs 64,125 confidential rows — so the line carries ~158
non-confidential rows too.

**Apply note:** applied via `apply_migration`, which supplies its own transaction — the file's
explicit `begin;`/`commit;` were omitted; DDL otherwise identical. Not applied to production.

**How to apply:** owner decided (2026-07-31) Analytics adopts the dashboard's rule — hidden by
default, revealed only for CEO/Super Admin. Migration authored in
`20260801090000_analytics_sos_confidential_basis.sql` on branch `codex/sos-confidential-basis`,
NOT applied. Note both surfaces must default to EXCLUDED or a revealed-by-default Analytics would
re-create the divergence in the other direction.

Related: [[sos-remediation-13-phase-plan-2026-07-31]] · [[la003-la004-confidential-products]] ·
[[closing-matrix-inclusion-rule]] · [[analytics-schema-postgrest-not-exposed-2026-07-18]]

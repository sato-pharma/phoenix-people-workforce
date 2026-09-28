---
name: sos-analytics-excludes-confidential-5x-gap
description: "Sales Analytics and the SoS dashboard once disagreed ~5.76× because analytics.sos_fact hard-excludes LA003/LA004/SS001 (64–86% of company value) while the dashboard reveals them for CEO/Super Admin. FIXED + LIVE: the four analytics_sos_by_* RPCs now read sos_fact_all + take p_exclude_codes (hidden by default). 🔴 To REVEAL you must open BOTH gates — p_exclude_codes AND p_exclude_head_office=false — because 100% of confidential value sits on the Head Office line, so a defaults-only test looks like a pass while proving nothing."
metadata: 
  node_type: memory
  type: project
  originSessionId: b7278c43-5066-40ba-99af-397dc2319bb9
  modified: 2026-09-26T10:25:00.294Z
---

The root cause of the owner's 2026-07-31 "Source of Sales miscalculates" report: **`analytics.sos_fact`
hard-excludes products `LA003`/`LA004`/`SS001` inside the view**, while the SoS dashboard includes them
behind a CEO/Super-Admin reveal — so on the same month the two screens disagreed ~5.76× (June:
9,362,810 vs 53,894,769). In every month the delta was EXACTLY the confidential-product total; those three
products are **64.7–85.5% of company value**, so Analytics was showing the minority remainder, not a filtered
view. `analytics.sos_fact_all` is the confidential-inclusive twin (byte-identical column list).

🔴 **Owner ruling 2026-07-31: Analytics adopts the dashboard's rule — hidden by default, revealed only for
CEO/Super Admin** ([[sos-remediation-13-phase-plan-2026-07-31]], [[la003-la004-confidential-products]]).
FIXED and LIVE on production 2026-08-01.

## 🔴 To reveal, BOTH gates must open — the confidential filter is not the whole story

**100% of confidential value sits on line = "Head Office"**, every row, every month. So with
`p_exclude_head_office` at its DEFAULT `true`, the head-office filter already strips every confidential row —
and flipping the confidential reveal changes NOTHING. **A defaults-only test hides this:** calling an RPC with
defaults returns the same number whether `p_exclude_codes` is set or empty, and it *looks* like a pass. Only
`p_exclude_head_office => false` exposes real behaviour (June: default/hidden = 9,362,810 = `sos_fact`;
revealed = 53,894,769 = `sos_fact_all`). A non-privileged viewer already agrees with the dashboard because
head office strips the confidential rows for them anyway — so the gap was always **CEO/Super-Admin-only**,
exactly who reported it.

## The fix mechanics (durable)

- The four `analytics_sos_by_{period,area,line,product}` RPCs now read **`sos_fact_all`** and take
  `p_exclude_codes text[] default array['LA003','LA004','SS001']` — **hidden by default, and an un-updated
  caller stays fail-closed.** Hiding OMITS the key (ordinary viewers keep the pre-migration argument set and
  are unaffected); only a REVEAL request (`p_exclude_codes: []`) depends on the new signature — so the
  app-side reveal PR must NOT deploy before the migration is on production, or CEO analytics breaks.
- **`analytics_sos_by_customer` is legitimately OUT of scope** — it reads `analytics.sos_by_customer` whose
  only measure is `active_batches` (a COUNT); it has no `value`/`units` column, so it cannot carry a money
  gap. Four RPCs in scope, not five.
- App side: `analytics/service.ts` passes the confidential reveal arg (CEO/Super Admin) and
  `p_exclude_head_office: !filters.canViewHeadOffice`; `canViewHeadOfficeLine(role)` = CEO || Super Admin, and
  `stripHeadOfficeRows` (applied for the RPCs that lack the arg) lives in `src/lib/sales/access-scope.ts`
  (NOT `analytics/service.ts`, contrary to a migration comment). Both surfaces MUST default to EXCLUDED, or a
  revealed-by-default Analytics re-creates the divergence in the other direction.

## 🔴 The reusable lesson: diff the FUNCTION RESULT, not the totals

A first version of this migration was merged that silently **dropped `channel` and `bonus_units` from the
return types** of `_by_period`/`_by_area` — the app's `s()`/`n()` coercers turned the missing columns into
`""`/`0`, a silent regression not a crash. It got missed because staging verification summed `value` only.
**When a migration RECREATES a function, snapshot and diff `pg_get_functiondef()` / `pg_get_function_result()`
BEFORE and after — comparing aggregate numbers cannot see a lost column.** The correct fix copies each
function body VERBATIM from the live production definition, editing only `sos_fact` → `sos_fact_all`, the
`p_exclude_codes` parameter, and its predicate. The bad version also weakened the head-office predicate,
losing the whitespace `regexp_replace` normalisation and the `'office'` token (a confidentiality regression) —
production uses `lower(btrim(regexp_replace(line,'\s+',' ','g'))) not in ('head office','headoffice','office','hq')`.

## Migration hygiene that applied here

- DROP each function at its EXACT live signature before CREATE (12-arg for `_by_period`/`_by_area` which carry
  `p_exclude_head_office`, 11-arg for `_by_line`/`_by_product`) to avoid the orphaned-overload hazard that
  once made SoS anon-readable; revoke PUBLIC/anon/authenticated EXECUTE and grant `service_role` on every new
  signature; end with `notify pgrst, 'reload schema'`.
- **Do NOT merge a stale branch to ship one migration** — a 40-commit-stale branch would revert unrelated
  work; CHERRY-PICK the single-file migration onto current `main` instead. And a stale branch cannot see
  timestamps merged after it forked, so ALWAYS run `check:migrations` after rebasing/cherry-picking a
  migration ([[migration-timestamp-collision-hazard]] — a duplicate-timestamp collision was caught exactly
  this way).

**Two currently-inert findings:** the TS head-office key set includes `'office'` while the SQL predicate does
not — latent, since no line named `office` exists today; and Head Office carries ~158 non-confidential rows
too, so the line is bigger than the confidential products alone. Related:
[[analytics-schema-postgrest-not-exposed-2026-07-18]].

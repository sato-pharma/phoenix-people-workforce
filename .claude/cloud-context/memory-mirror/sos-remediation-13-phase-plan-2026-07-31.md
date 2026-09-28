---
name: sos-remediation-13-phase-plan-2026-07-31
description: "The SoS audit (2026-07-31, 71 findings) and its remediation — now fully landed as code + migrations on staging AND production. Keep for the 4 recorded OWNER RULINGS (do not re-ask), the reusable lessons (MCP-stamped migration ledger, the pg_get_functiondef comment-probe trap, the nullable-join `IS NOT DISTINCT FROM` trap, the seed-baseline occupancy trap, the f_seat_occupant_asof today's-wiring fix), and the premises that were VERIFIED FALSE so a later session does not re-chase them."
metadata: 
  node_type: memory
  type: project
  originSessionId: b7278c43-5066-40ba-99af-397dc2319bb9
  modified: 2026-09-26T02:42:13.494Z
---

Deep SoS audit 2026-07-31 (11 parallel auditors + read-only prod SQL): 71 findings (10 critical, 26 high,
35 medium/low). **The 13-phase remediation is fully landed** — all code phases merged to main, all four
core migrations applied to staging (`cifwmndunmlxjhyjugxa`) AND production (`ozucdzovmcqvepbozvqf`),
verified by reading the live bodies. Decisions of record: `docs/source-of-sales-decisions.md`.

## Owner rulings (2026-07-31/08-01) — do NOT re-ask

1. **Confidential products:** Analytics adopts the SoS dashboard's rule — hidden by default, CEO/Super
   Admin reveal. **Both gates must be open to reveal** (the confidential-basis arg AND
   `p_exclude_head_office=false`; those products sit on the Head Office line, so that gate alone hides
   them). [[sos-analytics-excludes-confidential-5x-gap]]
2. **Attribution is wired to AREAS/BRICKS/REGIONS, not persons — the person wired to the area inherits the
   sales.** `rep_hr_id` is resolved from area→seat→person at READ time, never frozen into the fact row, and
   **historical months use TODAY'S wiring** (no as-of-period carve-out) — consistent with
   [[sos-always-todays-geography-rule]]. This dissolves the mid-month tie-break question.
3. **Direct channel counts toward achievement.** The 2026 targets were SET INCLUDING Direct, so adding
   Direct to actuals is the correction — there is no achievement inflation to guard against. Direct lands on
   the LINE (line, NULL area, product): never split across areas, never credited to a rep (the `lam_asof`
   join is on area_code, so rep/DM stay NULL).
4. **Fail-closed scope:** report the bad org records first, correct them, then merge.

## Reusable lessons (these outlive the task)

- 🔴 **A `pg_get_functiondef … ilike '%phrase%'` probe can REPORT THE NEW VERSION AS OLD** — the new body
  quotes the buggy phrase in a COMMENT explaining what it removed, so a substring check matches the fix and
  mis-reports prod as unpatched (it cost a wrong "prod is 3 of 4" call). Detect on the CODE (e.g.
  `current_date` present AND `order by … effective_from asc` absent), or just read the definition. Return
  types (`pg_get_function_result`), identity args and `pg_indexes` existence are comment-proof.
  [[prove-it-fails-verify-which-assertion-fired]]
- 🔴 **`=` on a nullable join column silently drops the NULL rows — use `IS NOT DISTINCT FROM`.** The
  Direct-in-achievement fix looked applied but the total did not move because a final `ac.area_code =
  k.area_code` rejoin never matched Direct's NULL area (`NULL = NULL` is never true). **This is why
  staging-first is non-negotiable for anything touching `area_code`, which is NULL for every Direct row.**
  Strengthen the guard test to require the NULL-safe join (the old test passed the broken version).
- **A clean `git merge` does NOT surface duplicate migration timestamps — only `pnpm run check:migrations`
  does.** Always diff a colliding migration against main's before renaming; sometimes DELETE, don't rename
  (main may carry a strict SUPERSET — renaming re-applies the RPCs and can REMOVE columns from their return
  type). Guard tests find a migration by NAME, not timestamp, so a rename is safe.
- **MCP `apply_migration` stamps the ledger with the CURRENT time, not the repo filename's timestamp**
  (staging/prod are fed by MCP, never `supabase db push`), so a version-based drift check ALWAYS shows a
  mismatch — verify by reading the live object, not the ledger version.
- **`gh pr list --state merged` "merged" can mean merged into its PARENT branch, not main — check
  `baseRefName`.** And a squash-merge leaves the branch not an *ancestor* of main even though its content is
  on main, so it still renders a diff (a self-conflicting PR is usually colliding with its own squashed
  content).
- 🔴 **Before ANY production DB work, re-read the live object** (`pg_get_functiondef`, `pg_indexes`,
  signatures) — the ledger and a 30-minute-old measurement are both stale the moment a parallel session
  exists (a different session applied a migration + corrected seat spans on prod mid-task here, discovered
  only by a routine pre-flight). Finish another session's partial work with **guarded UPDATEs**
  (`where … and <col> = <exact old value>`) so a concurrent edit shows 0 rows rather than being clobbered.
- **`main` had ZERO required status checks at the time** (a merge was not CI-gated) — verify `gh pr checks`
  on the exact head SHA yourself. ⚠️ Point-in-time: branch protection now has 6 required checks (per
  AGENTS.md), so re-read the protection API rather than trusting this line.

## The seed-baseline occupancy trap (the attribution root cause)

`au.f_seat_occupant_asof` was fixed to the two-arm `coalesce(occupant @ current_date, occupant @ p_asof)`
(`STABLE SECURITY DEFINER`, `search_path='au','public'`). 🔴 **Its old fallback was a real bug independent
of the date: when no span covered the date it took `effective_from asc` — the EARLIEST occupant EVER —
inventing an owner. A name the OLD resolver returned was NOT evidence the person held the seat; check the
span before trusting it.**

- **The generalisable rule:** a `seed_baseline`/`seed_xlsx` occupancy row whose `effective_from` sits in the
  2026-07-07..13 org-load window is SUSPECT — the load date was written as if it were the hire date — **but
  it only distorts attribution for seats VACANT TODAY** (an occupied seat resolves through arm 1 and never
  reaches the date-sensitive arm). Watch for inverted spans (`from` after `to`), which resolve to nobody in
  every period.
- The fix was to correct the bad occupancy spans to HR's own `hire_date`/`last_working_date` (three seats
  had it on prod), applying that BEFORE the today's-wiring migration so resigned reps don't briefly show
  zero. After the fix, everything still unowned was legitimately a month the person was not yet employed;
  zero person-to-person swaps. A DM seat with a prior NULL-occupant span can retroactively GAIN historical
  credit under "today's wiring wins" — correct by design, but a live person's numbers change.

## Premises VERIFIED FALSE — do NOT work on these

- **Phase 7 "25 live areas sit outside their manager's region" → 0 rows.** Every area's
  `operational_region_code` matches its DM seat's `region_code`; the seat model is clean. "Weekly Sales
  scopes DM/RM by region label" → already seat-based (the hardcoded Pedia `["AB","D1","D2"]` is a documented
  fallback, not the primary path).
- **The blank-region exposure was a MEASUREMENT ERROR (I quoted the wrong column).** The scope engine reads
  `employees.region_name`, NOT `region_code`; on `region_name` only 1 of 17 DSMs is blank and that one holds
  a seat owning 6 areas so takes the seat branch — **nobody in production was fail-open.** The fail-closed
  guard shipped is a latent guard, not an active fix. (Still real: a fail-closed producer needs a fail-closed
  consumer — an empty `Set` is truthy, so "narrowed to nothing" was being handed back as the WHOLE LINE.)
- **Refuted fan-out claims:** `analytics.weekly_fact` 6.62x region fan-out (actual 0.908x — the view has
  FEWER rows), `sos_by_customer` 6.77x (actual 1.000x), validation_state divergence (all rows `valid`),
  discount-as-percentage (all 0–0.08).
- **Phase 10 "unify the two precedence chains" would rewrite a DEAD path** — the coded distributor-import
  inline resolution runs for ZERO production rows (every validated row uses `normalizer`,
  `office_allocation` or `direct_orders`). The real fix was the ONE missing cross-area guard on the coded
  auto-fill; do not touch `resolveBrick` (the live chain, 99.6% of rows).

## End state and the one live open item

All SoS code phases are done and merged; the four core migrations and the 1,698-row historical
customer-map reconciliation (geography moved, money did not) are on production. **As of 2026-08-01 the one
item NOT yet applied to production was the Direct-in-achievement migration** (`au.f_monthly_achievement`,
staging-verified: pedia +42.5%, anti_infective +≈32%, cns unchanged, no rep wrongly credited) — verify its
live state before assuming either way, given the age of this note. Phase 12 (`p_areas` for
`analytics_sos_by_customer`) needs a view re-cut (the source table has no area column).

Owner data tasks (no code): upload the missing months/distributor files; review the customer-map
disagreements. Related: [[sos-import-coverage-metric-was-fake]] · [[sos-unordered-pagination-lost-mappings]]
· [[dm-sales-scope-drops-out-of-region-areas]] · [[au-schema-is-the-org-sos-linkage]].

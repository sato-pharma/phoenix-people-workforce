---
name: sos-ims-ratio-storage
description: "IMS market-share ratios on the SoS geography master — fraction storage, the Others rule (owner chose region-level), and the percent column type"
metadata: 
  node_type: memory
  type: project
  originSessionId: 046c2623-cbf3-474b-84df-74cf5e16d2d3
  modified: 2026-07-27T19:34:44.753Z
---

Owner's IMS (market share) ratios now have a home on the SoS geography master. PR #1396
(branch `claude/sleepy-sutherland-16b409`, migration `20260727231518_source_of_sales_ims_ratio.sql`).
**APPLIED TO BOTH STAGING AND PRODUCTION 2026-07-27 (each owner-approved separately).** Verified on
both: 39 areas loaded, non-OT sum 0.950300, OT region 0.0497, total exactly 1, 0 OT areas with a
ratio, 0 active non-OT areas left NULL, 2/2 constraints. CHECK probed live on staging — 3.41 and
-0.01 both rejected. Advisors clean on both (0 lints referencing the change). **App code PR #1396
MERGED 2026-07-27 (`be349ea3` on main).** ~~Production deploy does NOT fire on merge — since 2026-07-26
`deploy-cloud-run.yml` runs on a 2-hourly schedule with a CI-conclusion gate on the exact commit,
so the console column goes live at the next window (or via workflow_dispatch).~~
**CORRECTED 2026-08-27:** true only in July, and the cadence was misremembered even then (the workflow moved to **4-hourly** on 2026-07-26, not 2-hourly). Production has been **Railway since 2026-08-01 and deploys on push to `main`** — there is no "next window" to wait for. This column shipped long ago.

- Stored as a **fraction** (0.0341 = 3.41%) on `public.source_of_sales_areas.ims_ratio`,
  nullable numeric + `CHECK 0..1`. Matches `formatPercent()` default `input:"ratio"` in
  `src/lib/sales/format.ts`. Unconstrained `numeric` on purpose — exact decimal, so the 39
  values sum to exactly 0.9503 with no float drift.
- **THE OTHERS RULE — owner chose option (b) on 2026-07-27** (I recommended (a); owner overrode):
  the OT residual 4.97% is stored **once** on the OT row of `source_of_sales_regions.ims_ratio`,
  which also gained the column. Every OT *area* stays NULL. Never split 4.97 per OT area.
- **The OT 3→9 split landed in prod MID-SESSION** (see [[sos-others-region-split-2026-07-27]]) —
  prod went 42→49 areas (39 non-OT + OT1, OT2, OT4-OT10; OT3 retired to "Aswan (Legacy)", inactive)
  while this branch was being written. Region-level storage absorbed it with **zero** migration
  change — that is the payoff of option (b). Re-verified after: 0 owner codes missing / inactive /
  moved into OT, 0 uncovered non-OT areas, no new columns or constraints on the table.
- Option (b)'s risk is the two halves drifting apart. Guarded twice: a `DO` block in the migration
  that `raise exception`s on bad totals, and `tests/sales-ims-ratio.test.ts` (mutation-proven to
  fail on a one-digit change). Live check: `checkImsRatioIntegrity()` in `src/lib/sales/ims-ratio.ts`.

**Why:** there was previously nowhere to store this — verified no ims/ratio/weight/share/potential
column in `public`, `au` or `analytics`; `au.monthly_targets` holds absolute targets, not percentages.

**How to apply:** the Database Mapping console got a new `percent` `MasterColumnType` — do NOT reuse
`number` for ratios, it renders as EGP currency, exports `#,##0.00` (0.0341→"0.03"), and rejects
blank cells (which would break every round-trip on the NULL OT rows). Deploy order mattered (migration
before app code, else bulk import fails "column does not exist" on every row) — **that gate is now
satisfied on both envs**, so #1396 is free to merge. Two things verified so they need not be
re-derived: the currently-deployed app ignores the new column (no `ims_ratio` in its `definitions.ts`),
and importing a workbook exported BEFORE the column existed does NOT wipe the ratios —
`importMasterWorkbook` falls back to `existingRow[column.key]` when `fileValues` lacks the key.
**MCP `apply_migration` version drift hit BOTH envs** (recorded its own timestamp, not the filename's
20260727231518); realigned by hand on both — always check `supabase_migrations.schema_migrations`
after an MCP apply. See [[database-mapping-edit-delete-module]], [[mcp-apply-migration-version-drift]],
[[sos-owner-standing-rules-from-session-369dd08d]], [[au-schema-is-the-org-sos-linkage]].

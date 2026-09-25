---
name: delta3-region-carveout
description: "How \"Delta (3)\" / D3 sales region was added (7th DSM) — forward-only brick carve-out, snapshot mechanism."
metadata: 
  node_type: memory
  type: project
  originSessionId: e377b5c4-4343-4dd8-a3dc-018878a2da24
  modified: 2026-08-28T08:20:00.000Z
---

> **⚠ READ THIS FIRST — 2026-08-28. Everything below is a DATED RECORD of June 2026, not live state.**
>
> **1. The D3 this file describes NO LONGER EXISTS.** It was purged 2026-06-27 (over-deleting 41 real
> bricks in the process) and deliberately folded back out on 2026-06-28. Production today has **0**
> `source_of_sales_regions` rows for D3. So "APPLIED TO PROD 2026-06-21 … 34 bricks in D3" below is
> true of that day and false of now. Full account: [[d3-over-deletion-and-rebuild]] — which this file
> did not link to, which is how the stale reading survives.
>
> **2. "Delta (3)" now means something DIFFERENT, in a different table, on a different line.** The
> live 2026-08 work is an **AU seat-model** move (`au.line_area_map`, `au.seats`) for the
> **Anti Infective** line — not a Source-of-Sales region carve-out, and not Pedia. Owner's words:
> *"Don't touch PDA or CNS PDA or CNS. This change is only in anti infective line."* Do not reach for
> the recipe below to execute it; almost none of it applies.
>
> **3. It is HALF applied — structure YES, territory NO.** Verified in production 2026-08-28, after
> PR #2499 ("open Delta (3) … as a vacant placeholder"). **LIVE:** `au.regions` D3, five `au.seats`
> rows (`SEAT-AIF-DM-D3` plus reps for D11, D24, D25, OT2), `source_of_sales_regions` D3, an
> `areas` row `delta_3`, the `position_vacancies` row, and `au.occupancy_history` hiring Samaa
> (`AI-0014`) into `SEAT-AIF-DM-D3` **effective 2026-09-01**. **NOT live:** `au.line_area_map` holds
> **0** rows carrying `operational_region_code = 'D3'`, and all five target rows are byte-identical
> to `au.bak_20260828_d3_line_area_map` — a backup taken for a change that was then never made.
> **Do NOT read #2499 as evidence the territory moved.** Its body says *"Only
> `line_area_map.operational_region_code` moves"*, but its migration contains **zero** occurrences
> of `line_area_map` and is **absent from the production ledger**. The territory move is gated on
> the August closing being published — closing golden rule, `AGENTS.md` §4 — and D11, D24, D25, OT2
> and OT9 stay where they are until then; August is computed on the **pre-split** geography. **The
> owed work is specified in full in `AGENTS.md` §4** (the five rows, their target values, and the
> open OT9-has-no-rep-seat question), which auto-loads with no truncation cliff. Recorded by #2537.
>
> **4. When it is applied, it must be scoped to the Anti Infective LINE, not to the areas.** `teams`
> is area-scoped, not line-scoped: teams 83/84/85 under those areas hold **4 CNS/Pedia reps**
> (B-100 Pedia, B-130 CNS, B-186 CNS, B-148 CNS). Moving the areas wholesale drags those four across
> the line boundary the owner explicitly drew.

Adding a new sales region = a Source-of-Sales geography carve-out, NOT a code change. DSM count and regions are fully data-driven (no hardcoded cap). Org/region structure lives in: `source_of_sales_regions` (codes CA/GZ/UE/AB/D1/D2/OT) → `_areas` → `_blocks` → `_bricks` (strict hierarchy; geography FKs are `ON UPDATE CASCADE`, single-col PKs). The employee Region field is FREE TEXT.

**Delta (3) / D3** added 2026-06-21 (PR #447, branch `codex/delta3-region-carveout`, migration `20260621123000_delta3_region_carveout.sql`) = Sharkia + Suez + Ismailia + Qaluebya:
- Qaluebya (area D11) carved out of D1; Sharkia (D24+D25) out of D2 — done by re-pointing the AREA's region_code (cascades to blocks+bricks); then refresh the denormalized `region_name` (cascade only moves region_code).
- Suez = ONLY brick `B122-12` (EL SEWIS) moved into new area D31/block B300; South Sinai (B123-*) stays in OT.
- Ismailia = empty placeholder area D32/block B301 (no bricks existed).

**Why forward-only works (KEY):** a sale's region is snapshotted onto `source_of_sales_import_rows` at upload time. The importer resolves a NEW row's region LIVE from the brick master (crosswalks.ts loads customer→brick_id only, then region via `brickById`), so re-pointing bricks affects only future uploads; history is untouched. CAVEAT: if a June-2026+ batch was already imported before applying, re-import it. See [[sos-brick-authoritative-geography]].

**Scope wiring:** DSM/reps added via employee UI (normal workflow). Region typed exactly `Delta (3)` (resolver `resolveRegionCodesForNames` matches region master `region_name` verbatim, lower/trim). Line = Pedia. No `sales_manager_region_scope` row needed — auto-resolves from region name (add explicit row later once HR_ID known). See [[sales-territory-scope-build]].

**Owner decisions:** carve-out without history (June 2026 start); reps are NEW hires; owner skipped staging dry-run and chose prod-direct.

**APPLIED TO PROD 2026-06-21** (NOT staging — staging still lacks D3). Critical gotchas hit during prod apply, all relevant for future SoS migrations:
- **Prod ≠ staging schema (dual-project drift, see [[supabase-dual-project-schema]]):** prod `source_of_sales_areas` has NO `region_name`; prod `_blocks` has NO `block_name`/`normalized_block_name`/`area_name`/`region_name` (only `description`/`normalized_description`); prod `_bricks` has NO `block_name`/`area_name`/`region_name`. The committed (staging-shaped) migration FAILS on prod with 42703. A staging dry-run would NOT have caught this. On prod, region NAME is read by joining brick.region_code→regions, so setting region_code is enough. I applied a hand-adapted, column-trimmed variant directly (transaction-wrapped, idempotent) then `supabase migration repair --status applied 20260621123000` so the staging-shaped repo file is never re-run on prod.
- **Prod is ~35 migrations behind main** (drift / reverted-day, see [[revert-2026-06-21-full-day]]). NEVER `supabase db push` to prod — it would apply all 35. Apply target migration surgically + repair.
- **Prod connection:** *(both halves of the next sentence are stale — corrected 2026-08-23. `izhmxvgiktiafqusolot` no longer exists; staging is `cifwmndunmlxjhyjugxa`. And **both named MCP servers now reach BOTH projects**, so the `project_id` argument — not the server name — is the only thing separating staging from production on every call. The `postgres(url)` / `$$` password gotcha below is still real and worth keeping.)* Supabase MCP only reaches staging `izhmxvgiktiafqusolot`. For prod (`ozucdzovmcqvepbozvqf`) the CLI is linked + creds in gitignored `.env.production.rls.local` → `PHOENIX_PRODUCTION_DATABASE_URL` (use **Session pooler** :5432, NOT transaction :6543). Password has `$$`; porsager `postgres(url)` does NOT URL-decode → parse via `new URL` + `decodeURIComponent` + explicit params, or the supabase CLI which does decode `%24`.
- Prod verify after apply: D3=Delta (3); D11/D24/D25→D3; B122-12→D3/D31; B123-14 stayed OT; 34 bricks in D3; areas D11,D24,D25,D31,D32. Centroid change rides the normal main→Vercel deploy. SECURITY: owner pasted the prod DB password in chat — should be rotated.

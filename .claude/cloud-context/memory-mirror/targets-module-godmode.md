---
name: targets-module-godmode
description: "Smart Phoenix-branded targets template + inline grid units-to-value + a names-not-codes fix; PR #1140 MERGED+LIVE (prod 8c92cd1d). The worktree _wt-targets-godmode is gone, so the \"awaits CLEAN\" note is closed. DURABLE: the codes leak was rollupAchievementByRegion joining on a composite key, so a names-not-codes report is worth checking there first."
metadata: 
  node_type: memory
  type: project
  originSessionId: a166f384-4598-4cc0-ac0a-b3317af08c86
---

**STATUS: MERGED + DEPLOYED (2026-07-18).** PR #1140 merged to main (merge commit 8c92cd1d); CI green; Cloud Run prod deploy succeeded (no-traffic→smoke→promote); prod verified — https://phoenix-hr.satopharma.com HTTP 200 and `/api/sales/targets/template?line=pedia` returns a clean 403 (auth-gated, not a crash). Worktree `_wt-targets-godmode` + local branch codex/targets-godmode CLEANED (owner said CLEAN 2026-07-18: verified clean + merged-to-origin-main + all .xlsx tracked, then `git worktree remove` + `rm -rf` leftover .next/node_modules + `git branch -d` + prune). Remote branch origin/codex/targets-godmode still exists on GitHub (harmless; PR merged).

Sales Targets module "god mode" (shipped to PR 2026-07-18). Rewrote `generateTargetsTemplate` (src/lib/sales/targets-template.ts) into a Phoenix-branded SMART workbook: pick Product/Area **names** from dropdowns → Product Code / Line / Area Code / Unit Price auto-fill via VLOOKUP; **Target Value = Units × factory_price**. Branded via the shared kit (`phoenixBandHeader`, palette, embedded rail-mark logo). Generated per line by new `loadTargetableProducts(line)` in monthly-targets.ts (reads `source_of_sales_products.factory_price`; excludes confidential LA003/LA004/SS001; maps anti_infective→normalized_line "anti infective"), wired into the template route (now always resolves a concrete line, default first).

Grid (targets-workspace.tsx) gained a **Target units** input + **Unit price** column with inline units→value (via `loadProductPriceMap()`); save now sends both units and value (the /save route already accepted targetUnits).

Parser hardened: `parseTargetsWorkbook` scans every sheet's first ~20 rows for the header (Period+Area+Product), so a brand banner above the header AND legacy row-1 templates both parse. Fixed a real latent bug: ExcelJS drops an empty-string cached formula result on write, so empty pre-wired rows parsed as "[object Object]" → would reject ~198 phantom rows per upload. `cellText` now treats a formula cell with no result (and any unknown object) as blank.

Validated: typecheck, lint, 397 test files (added tests/targets-template-roundtrip.test.ts), production build; plus a generate→parse→validate pipeline run against PRODUCTION refs for all 3 lines (CNS 15 products, Pedia 4, Anti-infective 2), 0 errors. Grid confirmed server-rendered with real prices (146 rows, 2026-06). Work done in worktree F:/Phoenix Workforce/_wt-targets-godmode (branch codex/targets-godmode off origin/main). **PR #1140 — NOT merged** (awaiting owner review/merge). Deliverable files in owner Downloads: targets-template-pedia-smart.xlsx and -v2.xlsx.

**Names-not-codes fix (2026-07-18, same PR):** owner reported "module using codes in some fields." Empirical sweep (replicating page.tsx resolution vs prod for all 3 lines × months) found the leak = the **"By region" summary card**. Root cause: `rollupAchievementByRegion` joins the composite key `lineCode + U+0001(SOH) + regionCode` (raw invisible control byte in source), and the page recovered the region via `key.slice(selectedLine.length)` — slicing only the line prefix left `"AB"`, which `regionName()` can't map → rendered the bare region code (AB/CA/D1…). Fixed by making `rollupAchievementByRegion` return clean `{lineCode, regionCode}` (type `RegionAchievement`, explicit `REGION_ROLLUP_SEPARATOR`), page uses `regionName(entry.regionCode)`. Grid rep/DM/area/product were already clean (0 leaks). Verified: rendered card shows Alex-BHR/Cairo/Delta 1…; 0 code-looking labels across all surfaces. Lesson: [[feedback-show-names-not-codes]] — composite rollup keys with a control-char separator silently leak the raw code when a consumer slices by prefix length; expose clean component fields instead.

Related: [[la003-la004-confidential-products]] · [[area-unification-42-areas-design]] · [[sales-permission-security-audit-2026-07]] · [[feedback-show-names-not-codes]] · [[dsms-performance-hyphen-stripped-hrid-bug]].

## 2026-09-04 — the worktree is gone; nothing outstanding

The description ended **"worktree `_wt-targets-godmode` awaits CLEAN."** That folder no longer
exists — `git worktree list` shows ten worktrees and none of them is this one. Retired.

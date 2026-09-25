---
name: weekly-excelforge-bi-hardening
description: "Weekly Sales BI Excel export (ExcelForge) — the rules that stop Excel \"repair\"; reusable for any ExcelForge workbook."
metadata: 
  node_type: memory
  type: project
  originSessionId: 4cbbcbdf-7abe-4293-9dfc-a49bf94e3069
---

The Weekly Sales export (`src/lib/sales/weekly/export-workbook.ts` + `export-kit.ts`, engine `@node-projects/excelforge@3.6.0`) has triggered Excel's "we found a problem… recover?" prompt **twice** (non-ASCII sheet name + pivot slicers; native sparklines). PR #614 (2026-06-29) added 11 analytics sheets and hardened the engine. Shared primitives + the hardening live in `export-kit.ts`.

**The repair-prevention rules (verified against the installed ExcelForge source):**
1. **Strip XML-illegal control chars + NBSP from every dataset string** (names → shared strings/criteria). A stray `\x00`-`\x1F` byte → malformed XML → guaranteed repair. `cleanText`/`esc` do this, built from `String.fromCharCode` so no control byte enters the source file (the Write tool decodes `\x00`/` ` escapes into literal bytes — never type them in source; the harness even flagged my first kit as binary for this).
2. **Every conditional-format rule needs a UNIQUE per-sheet `priority`** — ExcelForge defaults them all to 1 → duplicate priorities → repair once >1 rule/sheet. Use `makeCfPriority()` per sheet.
3. **`cell.hyperlink` is silently NOT serialised** by ExcelForge. Internal nav must use the `=HYPERLINK("#'Sheet'!A1","label")` worksheet function.
4. SUMIFS criteria match **CODE columns** (RegionCode/ProductCode/DistCode/BranchCode), never display names. Week = `Month`('YYYY-MM') AND `Week`('W{n}') matched together.
5. `setRow` REPLACES the row def (setRowHeight merges) → outline grouping reads-merges via `groupRow`; cap nesting at level 1; collapsed groups need explicit `hidden:true`.
6. iconSet cfvo count must equal the icon count (3-icon → 0/33/67). No secondary chart axis (Pareto stays REPT-emulated). No print-title repeat rows (use freeze).

**Outcome:** shipped 2026-06-29 (commit 2a31cc94), deployed to prod, and the owner confirmed the downloaded xlsx **opens clean in desktop Excel — no repair prompt** on real data. The hardening rules above are proven, not theoretical.

**Verification:** `_junk/verify-weekly-export.mjs` is an OPC/XML gate (jszip) that builds from a nasty synthetic dataset and asserts content-types, rels, declared rIds, shared-string range, table-ref width, unique CF priority, icon cfvo, **no raw `&`**, **no control bytes**. Run from the worktree root via the alias loader. The true final check is opening on REAL prod data in desktop Excel — both prior corruptions only surfaced on full data. See [[match-module-design-before-building-ui]].

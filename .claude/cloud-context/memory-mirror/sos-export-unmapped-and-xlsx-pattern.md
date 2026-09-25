---
name: sos-export-unmapped-and-xlsx-pattern
description: "SoS upload \"Export unmapped (XLSX)\" shipped to prod (PR #414)"
metadata: 
  node_type: memory
  type: project
  originSessionId: 2c186d13-a17e-487d-af05-ae6abe3da6c4
---

SHIPPED to prod 2026-06-21 (PR #414, squash-merged to main as commit 7d08006c): an **"Export unmapped (XLSX)"** button on the SoS upload verification step. It sits in the inline `UnmappedList` panel header (next to "Save mappings") inside `MonthlyUpload`, and exports all three unmapped categories (products + customers + territories) as one styled sheet: Type · Value in sheet · Name in sheet · Rows · Suggested code · Suggested name. File: `src/components/sales/sales-upload-workspace.tsx`.

**Reusable XLSX export pattern (use this for ANY "export this table" request):** `ExportXlsxButton` (`src/components/ui/export-xlsx-button.tsx`) takes in-memory `columns: ExportColumn[]` + `rows: ExportRow[]` and POSTs to `/api/exports/table`, which calls `buildPhoenixTableWorkbook` (`src/lib/export/table-workbook.ts`) → premium Phoenix-styled .xlsx (black header band, orange grid, SUM total row for `numeric` cols). Needs only a signed-in session (no extra permission, no new endpoint, no file re-upload). `ExportColumn`/`ExportRow` are `import type` so the client never pulls ExcelJS into its bundle.

**GOTCHA — SoS upload component is stale on work-from-production:** `main` has the 3-step **AI verify → strict validate → confirm** wizard (`verifyStep.panel` match/mismatch/unrecognized, inline `UnmappedList` editor, `UnknownItem` type already defined). `codex/work-from-production` still has the OLD pre-wizard `MonthlyUpload` (single warning callout, no inline editor). Build SoS upload changes against `origin/main`, NOT this branch. Reconfirms [[work-from-production-branch-is-stale]] (now 69 behind / 7 ahead of main). Related: [[sos-perfect-module-plan]], [[sales-upload-two-pages-weekly-wizard]].

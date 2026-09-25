---
name: sos-distributor-folder-labels-are-unreliable
description: "A `sato N-2026` folder does not mean the file inside is month N — April 2026 held May's data in production for a week"
metadata: 
  node_type: memory
  type: project
  originSessionId: 03cc2804-3d96-4252-be34-4b96ec5c0d6f
  modified: 2026-08-05T12:20:02.946Z
---

The owner's source files live in folders named `sato 1-2026` … `sato 7-2026`, but **the folder name
is not evidence of the month**. `Khaled Bedair\2026\sato 4-2026\customer sales.xlsx` contains
**2026-05** invoice dates, and it was the file imported into the April period.

Result, live in production from 2026-07-30 until 2026-08-05: **April held May's data.** April read
162,849 units / 31,082,821.76 EGP when its real figure is 254,380 units / 44,728,033.96 EGP — a 36%
understatement — and April and May showed near-identical totals (22 units and 924 EGP apart), which
is the symptom to watch for.

**Before importing any distributor file, read the invoice dates inside it** and confirm they are
wholly the intended month. `scratchpad/reimport-april.ts` refuses to commit unless
`inPeriod.length === coded.length`; keep that guard in any re-import script.

Fixed 2026-08-05 by re-importing from `SALES - DROP HERE\Copy of customer sales.xlsx` (32,209 rows,
100% dated 2026-04) via `normalizeUploadedFile` + `persistNormalizedBatch` — the same domain
functions the upload API calls, so mapping, validation and finalize behave exactly like a UI upload.
May was re-imported the same way from `SOS UPLOAD\5-customer sales MAY 26.xlsx`.

Related: [[sos-file-vs-db-gaps-are-ignore-mapped-products]],
[[closing-uses-total-qty-not-effective-units]].

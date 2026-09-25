---
name: published-and-uploaded-period-gates-must-never-be-unified
description: "vs-target.ts has TWO period gates that both return Set<string> and are NOT interchangeable — loadPublishedPeriodKeys returns `lineCode|period` for LIVE dashboards, loadUploadedPeriodsInRange returns BARE periods for HISTORY. Unifying them empties every history surface."
metadata: 
  node_type: memory
  type: project
  originSessionId: b999e9ef-030a-4843-87cb-dfb024f13c09
  modified: 2026-08-14T00:45:45.247Z
---

`src/lib/sales/vs-target.ts` deliberately carries **two** period gates. Both return `Set<string>`,
so **TypeScript cannot tell them apart** and swapping them is silent.

| Function | Reads | Returns | Floor | For |
| --- | --- | --- | --- | --- |
| `loadPublishedPeriodKeys` | `monthly_closing_publications` | **`lineCode\|period`** (`cns\|2026-07`) | `2026-07` | LIVE dashboards / keycards |
| `loadUploadedPeriodsInRange` | `source_of_sales_import_batches` | **bare period** (`2026-07`) | `2026-01` | HISTORY surfaces |

**Why they must stay separate:** production `monthly_closing_publications` held **only 2026-07**
(Anti Infective, CNS, Pedia) when measured 2026-08-14 — no H1 rows at all. Gating the history
surfaces on publication would erase **all of January–June** from employee-360, business-review-s1,
the monthly dashboard and the incentive helper.

The live gate is the owner's ruling (2026-08-13, PR #2102): a blank keycard is correct until a
period is published, never a live-but-unclosed number. That ruling is about LIVE dashboards, and
does not extend to history reporting.

**Why:** merging `main` into `codex/rule1-sos-migration` auto-merged this file **with no conflict**
and stitched `loadUploadedPeriodsInRange`'s name onto the publication body, deleting
`uploadedPeriodsOf` and `NON_DISTRIBUTOR_BATCH_CODES`. Every canonical surface would have rendered
**empty** — `.has("2026-07")` never matches `"cns|2026-07"` — and typecheck stayed green. Only the
missing const was machine-visible, and only because a pre-push hook ran `tsc`.

**How to apply:** after any merge touching `vs-target.ts`, diff **all** top-level declarations
(not just exported ones — the const that broke it was module-private) against the pre-merge commit,
and confirm each gate still reads its own table. Callers of the history gate test `.has(row.period)`;
callers of the live gate use `isRowPublished(row, keys)`. See
[[rule1-sos-migrations-applied-to-prod-2026-08-14]] and
[[sos-monthly-closing-is-the-only-sales-truth]].

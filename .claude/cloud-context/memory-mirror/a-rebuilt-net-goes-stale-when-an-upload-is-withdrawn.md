---
name: a-rebuilt-net-goes-stale-when-an-upload-is-withdrawn
description: "A store-split net rebuilt minutes after a book lands is stale the moment that book is withdrawn — September 2026 went 423 (stale code) → 492 (current code, EPDA-BULK in) → 449 (EPDA-BULK pulled) inside twenty minutes, and only the cell count tells the three apart."
metadata:
  node_type: memory
  type: project
  originSessionId: d5764c39-c02c-4dd4-a40d-70ad08cc490c
  modified: 2026-10-09T17:00:00.000Z
---

**2026-09's net was written three times in twenty minutes on 2026-10-09, and each count is a
different fact:**

| Cairo | rows | Pedia | Anti Infective | CNS | why |
| --- | --- | --- | --- | --- | --- |
| 19:35 | **423** | 87 | 47 | 289 | applied from the PRIMARY at `077e838dd` — no twelve stems, no طاى جروب, no `تامين` ([[a-rule-script-run-in-the-primary-reads-its-stale-checked-out-code]]) |
| 19:40:31 | **492** | 130 | 53 | 309 | current code, **and the EPDA-BULK book that landed at 19:40:22** |
| 19:56 | **449** | 87 | 53 | 309 | current code after that book was withdrawn at ~19:47 |

**Why:** the EPDA-BULK September batch (`c3e732e2`, 52 rows / 9,723 units / 1,082,980.26 EGP) was
uploaded at 19:40:22 and gone from `source_of_sales_import_batches` by 19:47, with **nothing in
`sales_audit_logs` or `system_audit_logs` recording the removal** — the owner pulling the book over a
unit discrepancy. Nine seconds of overlap was enough for a rebuild to freeze its IVYRONC Pedia
spread: **43 Pedia cells and 140,339.41 EGP of area movement** (Qalubeya −58,524.63, Cairo East 2
+57,605.58, Dakahlia 1 +54,248.67, Qena 1 +23,925.94), CNS and Anti Infective untouched because the
spread is Pedia-only.

**How to apply:** a net count is only ever true of one base — **say which books were in when you
quote it**, and re-read the batch list before trusting a number minutes old. The staleness is
invisible to the units-based publication drift check (every line's total units agree, by
construction) and is harmless while the period has **no live publication row**, because
`isFrozenStoreSplitPeriod` then returns false and every read recomputes live; the exposure is the
moment he publishes. `check-store-split-drift.ts` is what exposes it — "frozen 492 cells vs live
449" — and it must run from a tree on `origin/main`. Related:
[[publishing-one-line-freezes-the-whole-periods-store-split-net]],
[[a-closing-rule-that-moves-zero-may-simply-have-no-upload-yet]],
[[epda-bulk-is-allocated-like-office-on-pedia-from-september-2026]].

🔴 **AND THE REBUILDS ARE NOT SESSIONS — THE IMPORT PATH MAINTAINS THE NET ITSELF, ~15 SECONDS AFTER
EVERY UPLOAD, WITH PRODUCTION'S OWN CODE.** Measured the same night: the net was stamped 19:40:31
(EP-BK landed 19:40:22) and again 20:11:06 (the Office/Marcyrl book landed 20:10:51), and
`au.monthly_attribution_rollup_meta` for 2026-09 carries the same 20:11:06 — the rollup re-stamps with
it. So a manual `backfill-attribution-store-split.ts --apply` is **not** how a landed book reaches the
net, and the owner's "rebuild when the Office book lands" is satisfied by the upload itself; the one
gap the pipeline cannot close is a **WITHDRAWN** batch, which leaves the last import's net frozen in
place with nothing re-running (19:47 → 19:56 on 2026-10-09, 140,339.41 EGP of Pedia). Check
`check-store-split-drift.ts` after a withdrawal, not after a landing. Tonight's three manual applies
were each overwritten by the next import within minutes.

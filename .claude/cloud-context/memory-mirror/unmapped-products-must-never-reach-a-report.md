---
name: unmapped-products-must-never-reach-a-report
description: "Weekly Sales - any report/export MUST set excludeUnmapped, because an unmapped SKU double-counts against the real product it belongs to"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 79f3f577-f3d1-4ba8-9694-cc8af3320030
  modified: 2026-08-11T18:57:52.858Z
---

**Every Weekly Sales report/export must pass `excludeUnmapped: true` to `loadWeeklyDashboard`.**
The BI export has always done this (`app/api/sales/weekly/export/route.ts`). The Summarized Report
shipped without it and the owner caught it — this is the "main core we were building the module on".

**Why:** a distributor's raw SKU that never resolved to a mapped master product appears as its OWN
phantom product carrying units that belong to a real one. So the total is split across two names:
the phantom shows units, and **the real product reads SHORT by exactly that amount**. It is not
noise, it is double-counting plus an understated real figure.

Proven on overseas June W3 (2026-08-11): 635 units across 4 unmapped SKUs leaked in, including
`لاكتو ال اف لبن أطفال 400 جرام` (120 units) — a Lacto the master already lists as Lacto Advanced 1/2
and Lacto Basic 1/2. Those 120 units were missing from the real Lacto product.

Mechanics: `mappedCodes` = master products WITH a non-empty `line` (`service.ts`). A row survives
only if its `productCode` is in that set. Guarded on `mappedCodes.size > 0` so a failed master load
never wipes every row.

**Corollary the owner stated:** mapping is a precondition, not a nicety — an upload that cannot be
mapped should be BLOCKED at upload rather than reported with holes.

**How to apply:** when adding any new weekly export/report, set `excludeUnmapped: true` alongside
`includeFactRows: true`. Never build a product axis from the master either — see
[[weekly-product-axis-must-come-from-fact-rows]].

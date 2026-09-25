---
name: one-direct-order-makes-a-month-look-uploaded
description: "An approved Direct Order writes a real Source-of-Sales row the day Finance books it, so \"does this month have sales rows?\" answers yes for a month whose distributor files never arrived — and the month-picker helper does NOT filter it out."
metadata: 
  node_type: memory
  type: project
  originSessionId: a48b9591-8fac-4f77-9c69-34f06c7622a4
  modified: 2026-08-22T21:04:24.439Z
---

Direct Orders inject into `source_of_sales_fact_rollup` continuously under the pseudo-distributor
`DirectReq` (`is_direct = true`), and the legacy manual direct upload uses `DIRECT`. Both also create
a row in `source_of_sales_import_batches`. So **row-existence is never proof that a month's Source of
Sales has been uploaded.**

Proven on prod 2026-08-12: August 2026 held exactly ONE row — 20 units of Guamusin, 1,309.50 EGP,
area GZ1, booked 2026-08-10 as `DOP-000004`. That single row made Sales vs Target rank August as the
newest loaded month, so every company-scope viewer opened on **EGP 1,309.50 against a 17,508,935
target = 0.0% achievement** for every line, region, area and rep.

**Why:** `has_actual` from `au.f_monthly_achievement` answers "is there any sale", not "did the month
land". The two questions look identical for eleven months of the year and diverge exactly when
Finance books a direct order early.

**How to apply:** to ask "is period N loaded", count batches in `source_of_sales_import_batches` for
that period whose `lower(distributor_code)` is NOT in (`direct`, `directreq`). July 2026 = 16 such
batches; August 2026 = 0. `src/lib/sales/vs-target.ts` does this via `loadUploadedPeriods` /
`pickLandingPeriod`. Any other module that gates on "this month has sales" needs the same test.

**The month PICKER does not apply that test, and that is how this bit a second module.** Re-verified
on prod 2026-08-22: `listMonthlyClosingPeriods()` (`src/lib/sales/monthly-distributor-import.ts`)
returns every period holding a `status = 'validated'` batch, with **no distributor-code filter** — so
August 2026 is in the list on the strength of its one `DirectReq` batch. Anything that builds a
from/to picker from it therefore offers August, and anything that defaults to floor..ceiling opens on
it. Business Review did both: the default Jan–Aug window graded **39.30%** where the seven months
that actually landed grade **50.67%** — eleven points off the headline of a page built to be read in
front of a head of department, with nothing on it saying why. Fixed by `gradedRowsOf` in
`src/lib/business-review/canonical.ts`, which holds un-uploaded months out of the sales maths while
still feeding the full row set to attribution (drop them there and that month's visits lose their
area). **Keep the picker offering the month** — its CRM half is real (12,299 August visit rows,
6,410 doctors); it is only the sales half that has not landed.

Two traps found beside it, both still live: a month can hold targets and no sales at all (2026-09 has
669 target rows and 0.00 EGP actual, and is invisible only because it has no validated batch); and
`monthly_closing_publications` is NOT a completeness signal — on 2026-08-22 only 2026-07 was
published, for all 3 lines, while Jan–Jun were validated and never published. Do not reach for it to
mean "this month is finished" (see [[published-and-uploaded-period-gates-must-never-be-unified]]).

Related: [[direct-order-sales-month-is-a-finance-step-not-a-bug]],
[[closing-uses-total-qty-not-effective-units]], [[never-silent-drop-count-and-flag-instead]],
[[published-and-uploaded-period-gates-must-never-be-unified]].

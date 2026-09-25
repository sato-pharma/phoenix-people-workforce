---
name: outstation-nothing-ever-reaches-accepted-status
description: "No outstation request in production ever reaches an accepted_* status, so any filter keyed on it is dead code — this is what made the held-requests repair panel permanently empty."
metadata: 
  node_type: memory
  type: project
  originSessionId: 55af0704-e4b4-4fdf-bfae-439d4a2433f0
  modified: 2026-08-19T18:07:09.590Z
---

**`outstation_expense_requests.status` in production is only ever `submitted`, `approved` (3 legacy
July rows) or `rejected_by_admin`. Nothing has EVER been `accepted_by_system` or
`accepted_by_admin`** — 57 requests across two months, checked 2026-08-19.

The cause is deliberate: since the owner's 2026-08-08 change, `service.ts` sets
`const workflowStatus = "submitted"` unconditionally, so every submission waits for a human.
`calculation_status` still records `accepted_by_system` vs `submitted`, and that is the ONLY place
the distinction survives. An `accepted_*` status can now arise solely from `acceptOutstationRequest`,
which nobody has used.

**Why: any code keyed on `status.startsWith("accepted")` is therefore dead in practice.** That is
correct in `releaseOutstationRequestToPayrollIfReady` — it is the rule that only an accepted request
may be PAID, and it must stay. It was wrong in `listHeldOutstationRequests`, where the same test was
copied and made the "Held out of payroll" repair panel permanently empty. The screen built to make a
failed CRM grab visible could never show a row, which is why the 2026-08-19 workload repair had to be
driven from a script. Fixed in #2219 (live prod `92e9104c`): the panel now lists what the GATE holds,
excluding only rejected requests and trips that have not finished yet.

**How to apply:** before trusting any outstation filter that mentions `accepted`, check whether it
governs MONEY (keep it) or a LIST (it will show nothing). And when widening any such list, exclude
in-progress trips — the departure photo is not due until the employee leaves the destination, and the
panel offers a permanent photo waiver right beside each row. Related: [[outstation-expenses-two-data-models]],
[[outstation-payroll-import-is-locked-out-by-batch-status]].

## 2026-08-23 — FALSIFIED. One request DID reach an `accepted_*` status.

The headline above ("no outstation request in production ever reaches an `accepted_*` status") is no
longer true. Queried live against production (`ozucdzovmcqvepbozvqf`, resolved with `list_projects`):

| status | rows | first | last |
| --- | --- | --- | --- |
| `submitted` | 56 | 2026-07-22 | 2026-08-23 |
| `approved` | 3 | 2026-07-06 | 2026-07-15 |
| `rejected_by_admin` | 2 | 2026-07-29 | 2026-08-09 |
| **`accepted_by_admin`** | **1** | **2026-08-19** | **2026-08-19** |

**The precise truth now: `accepted_by_system` is still 0** — the automatic path has never once fired,
which is the part that was always the real finding. But a Super Admin accepted one by hand on
2026-08-19, the same day as the repair the gate's own comment describes. So a filter keyed on
`accepted_*` is no longer *dead* — it is a filter that matches exactly one row out of 62.

**How to apply.** Do not repeat "nothing ever reaches accepted" — say "`accepted_by_system` never
fires; `accepted_by_admin` is a manual override that has happened once." And re-run the count before
quoting it: this file pinned an absolute and the absolute broke within four days.
Note `src/lib/outstation/expense-gate.ts:203` still states the old absolute in a comment.

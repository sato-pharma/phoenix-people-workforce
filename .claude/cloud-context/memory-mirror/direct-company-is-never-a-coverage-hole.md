---
name: direct-company-is-never-a-coverage-hole
description: "The Direct fold is already SHIPPED — DIRECT and DirectReq are one key in every coverage module, so \"Direct (Company) is missing from September\" is always a reading defect, never a hole; owner re-confirmed 2026-10-09 that Direct Order Requests carries the channel."
metadata:
  node_type: memory
  type: project
  originSessionId: 61ac0cfb-9a45-4123-ac88-7f2173f492b1
  modified: 2026-10-09T17:31:22.813Z
---

**Direct (Company) can never be an outstanding book, and a report that says it is has hand-rolled
the rule.** `canonicalDistributorKey` in `src/lib/sales/direct-channel.ts` folds `DIRECT` (the
retired uploaded sheet, to 2026-07) and `DirectReq` (the Direct Request module, from 2026-08) onto
one key, and all three coverage consumers already go through it — `sos-coverage.ts`,
`source-coverage.ts` and `sos-month-complete.ts`. Asked as in-chat multiple choice on 2026-10-09,
the owner answered **"Direct Order Requests carries it now"**, which confirms the shipped behaviour
rather than asking for a change: no code was needed and no PR was opened.

Measured on production the same evening: the master row is `active = false` since 3 Sep 04:04 Cairo,
its monthly value collapsed from July's 1,276,548.15 EGP (46 rows) to August's 205,194.30 EGP (10
rows), and DirectReq has books for August and September.

**Why:** a scratchpad watcher computed its own expected set as "the distinct distributor codes
August had" — 18 codes including `DIRECT` — so `DIRECT` stayed in `missing` for ever while
September held `DirectReq`. The exit-2 "every book is in" alarm the owner was waiting on could
therefore never have rung, and the wrong figure (**3 outstanding**) was relayed to two peer sessions
and nearly put to him. The real figure, from `summarizeMonthCompleteness` on the same live rows, is
**2 — epda `EP` and mec `MC`**. `source-coverage.ts`'s own header records the identical defect
biting the Anti Infective August 2026 closing, which is why the fold exists at all.

**How to apply:** never compute an expected-source set by hand. Call
`summarizeMonthCompleteness({ batches, period, report: buildSosCoverageReport(batches) })`, or run
`scripts/check-sos-month-complete.ts <period>` — it carries the Direct fold, the merge carve-outs
(EPDA-BULK into EPDA-Pharmacies for 2026-07..2026-08) and the onboarding carve-outs, each of which a
hand-rolled set gets wrong in a different direction. A scratchpad `.mjs` can import the rule
directly under `--experimental-strip-types --experimental-loader ./tests/alias-loader.mjs`, run from
a worktree whose HEAD is `origin/main`. See [[never-hand-roll-a-rule-the-repo-already-implements]]
and [[a-rule-script-run-in-the-primary-reads-its-stale-checked-out-code]].

🔴 **AND IT IS BLIND IN THE OTHER DIRECTION TOO, WHICH IS THE HALF THAT CAN LOSE UNITS.** A set built
from last month's codes cannot contain a book this month invented: **`EP-BK` (EPDA-BULK) and `SF-T`
(Sofico Tender) are 2026-09 books August never had**, so they sat outside the expected set entirely —
and EPDA-BULK is the book the Ivyronc Pedia allocation depends on, the same book that vanished with
no audit trail at 19:47 Cairo. A withdrawal of either would never have been reported. Confirmed on
production the same evening from `source_of_sales_import_batches` (`status = 'validated'`): August
holds BOTH vintages (`DIRECT` *and* `DirectReq`) where September holds `DirectReq` alone, which is
where the phantom 18th code comes from; canonically each month holds **17** sources and the two sets
differ at four codes — out `EP`, `MC`, in `EP-BK`, `SF-T`. See
[[a-landed-import-book-can-vanish-with-no-audit-trail]].

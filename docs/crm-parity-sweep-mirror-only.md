# The parity sweep compares the vendor against the mirror table, not the unified view

Account for the rule in `.claude/rules/crm-sync.md`. Measured on production
(`ozucdzovmcqvepbozvqf`) on 23 October 2026, from the owner's "look into the CRM parity window the
sweep refused at 06:08".

## What was happening

`runIReports360ParitySweep` picks the stalest 30-day window of history, fetches that window from
iReports360, and compares the vendor's visit-id set against the mirror's. It read the mirror half
through `queryVisits`, which scans **`crm_visits_unified`** — and that view carries Phoenix-born
visits beside the mirrored iReports360 ones. A visit logged in Phoenix CRM has never been in
iReports360 and never will be, so every one of them counted as a row the vendor had **lost**.

That is the exact shape `decideParityAction` is built to refuse: more than `PARITY_MAX_DELETE_ROWS`
(250) rows present in the mirror and absent from the vendor's answer reads as a truncated fetch, so
the sweep refuses the window, logs `crm_parity_sweep_refused`, and repairs nothing.

## The numbers

Window `2026-09-28 → 2026-10-23`, read at 06:08 Cairo on 23 Oct:

| | rows |
| --- | --- |
| vendor answer | 7,345 |
| `crm_visits_unified`, `source = 'ireports360'` | 7,336 |
| `crm_visits_unified`, `source = 'phoenix'` | 4,780 |
| what the sweep read as "the mirror" | 12,116 |
| counted as missing from the vendor's answer | 4,779 |

The raw mirror table `ireports360_visits` held 7,345 rows for that window — the vendor's number
exactly. The first Phoenix visit landed **2026-10-03**, and the same window had already been refused
on 14 Oct at 2,013 extra rows, so the false surplus was growing by roughly 300 a day.

Seven refusals were logged between 3 and 23 Oct. Two are this defect (14 Oct, 23 Oct). The rest
predate Phoenix visits and are the guard working as designed: two of them (260 of 19,015, on 3 and
11 Oct) cleared on their own by 19 Oct, which is what a transient vendor truncation looks like.

## What it cost

- **The newest window could never be verified again.** It is refused on every rotation, for ever,
  by a margin that grows daily.
- **Real late saves were left out.** The same read found 8 visits the vendor returned and the mirror
  lacks. A refusal repairs nothing, so those 8 were not written.
- An error row and a wasted vendor fetch on every rotation that reaches that window.

**No data was deleted, and none was ever at risk.** The repair path (`syncIReports360Visits`) reads
and deletes only from `ireports360_visits`, where Phoenix rows do not exist, and it archives before
every delete. The 250-row ceiling is what stopped the sweep acting on a count it had no business
computing — the guard was never the problem, the comparison set was.

## The fix

`loadMirrorVisitIds` reads the window's ids straight off `CRM_VISITS_TABLE`
(`ireports360_visits`), keyset-paged by `crm_visit_id` the way the sync's own reconcile scan is —
`.range()` without an `ORDER BY` gives no stable order, and a skipped id here reads as a row the
vendor deleted.

Reading the table also removes the resigned-agent question: `queryVisits` needed
`includeResignedAgents: true`, because its default exclusion hides every visit whose resolved agent
has left and would have fabricated a mismatch of exactly that size on every window. The raw mirror
applies no exclusion, so there is nothing left to opt out of.

Pinned by `tests/crm-parity-mirror-excludes-phoenix-visits.test.ts`, which runs the incident's own
numbers through the decision core (unified-shaped → `refuse`, mirror-only → `repair`) and pins the
relation the scan names. Break-tested both ways on 23 Oct: pointing the scan at the unified view
fires "the sweep must never name the unified view", and restoring the `queryVisits` call fires "the
sweep must not call queryVisits".

## Still open, and not this defect

Window `2026-01-31 → 2026-03-01` holds 11,574 mirrored rows against 11,236 from the vendor — **338
rows the vendor does not return**, and no Phoenix rows at all. It refused at that identical number
on 7 Oct and again on 15 Oct, so it is stable rather than transient: either those 338 visits were
deleted or re-dated in iReports360, or the vendor serves that window short every time. The fix
above does not change it, and it stays refused — which is the correct outcome until somebody
decides which side is right.

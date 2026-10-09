---
name: there-is-no-re-run-path-for-the-office-allocation
description: The Office area spread is written only by the upload wizard, so the only "recompute" is re-uploading the file by hand — and that is not neutral, because the allocator drops any product whose net units are <= 0 and the output total comes out higher than the input.
metadata:
  type: project
---

`persistOfficeAllocation` is the only writer of the Office area spread, and it is called from exactly
one place: `src/lib/sales/office-upload.ts` (`commitOfficeAllocation`), reached from
`app/api/sales/monthly-sales/office/commit/route.ts` and the monthly-sales wizard. `scripts/check-office-allocation-drift.ts`
and `scripts/check-office-golden-rule.ts` only **read**. **There is no re-run script, and no API that
recomputes a stored month.**

**Why:** "re-run the Office allocation" is a natural thing to put in front of him and it names nothing
that exists — the only path is him re-uploading the file through the wizard, which is his hands and so
can never be the quoted words in a `Next step:` line. Worse, the re-upload is not a neutral restatement:
`allocateProduct` opens with `if (!(units > 0)) return [];` **inside the locked region**, so a re-run
drops every product whose net units for the period are ≤ 0 and the output total comes out **higher**
than the input — measured +7 units on 2026-02, from DO003 netting −7 across 173 rows. That trap is
written into `src/lib/sales/office-allocation-drift.ts`, which is also why the drift check applies
today's shares to the stored line total rather than re-running the allocator.

**How to apply:** the neutral remedy for a stale spread is the **read-time respread**
(`closing-office-respread.ts`, CNS only, from October 2026) — a net recomputed on every read cannot go
stale. Extending it to an earlier month is a one-line change to `OFFICE_RESPREAD_START_PERIOD` and takes
his own word: [[the-office-respread-ruling-rests-on-two-premises-that-both-inverted]].

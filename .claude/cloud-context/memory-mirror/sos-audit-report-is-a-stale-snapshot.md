---
name: sos-audit-report-is-a-stale-snapshot
description: "The Source of Sales audit report is a 2026-08-09 SNAPSHOT, not current state. Measured 2026-09-05: 3 CONFIRMED entries were already fixed, one filed 'latent' had gone LIVE, and one's stated scope had been narrowed by the owner since. Verify every entry against production BEFORE writing code."
metadata: 
  node_type: memory
  type: reference
  originSessionId: ad7f6844-5aef-4d22-9a7e-51c9934c566e
  modified: 2026-09-18T15:04:29.162Z
---

`F:\Phoenix Workforce\_audit-vault-sos-2026-08-09\sos-report-2026-09-04.md` is a good set of LEADS.
It is **not** a statement of current state, and treating it as one costs work or ships a wrong fix.

Measured on 2026-09-05, working through it entry by entry, it was wrong in **three distinct ways**:

**1. Already fixed — verify before starting.** Three CONFIRMED entries needed no work at all:
- the one remaining `critical` (dashboard totals summing blocked/pending batches) — the code now
  filters `status === "validated"`; the surviving "evidence" was the comment describing the old bug.
- `import_summaries` staleness — production showed **0 areas disagreeing, 0 rows, 0.00 EGP** across
  all eight periods, against the report's 40 areas / 1,172,838.83 EGP. Fixed 2026-09-05 by migration
  `20260905003000`, and pinned.
- the Targets Fayoum/Beni Suef grid — fixed earlier the same day.

**2. "Latent" had gone LIVE.** The vs-target brick drill-down was filed PLAUSIBLE and latent
"because no Pedia/CNS row exists in UE9 yet". They exist now: 2026-08 Pedia showed 3,047.63 with
**11,100.38 missing — 78.5% of the area**.

**3. A stated scope the owner had since narrowed.** The same entry says the merge covers "the pedia
and cns lines". True on 2026-08-09; the owner **removed CNS on 2026-08-30**. Trusting it would have
re-merged a line he deliberately split — silently, since the drill-down would simply have started
including rows the page shows separately, and CNS carries 96,807.38 in UE9 for July. Caught only
because the test asserted CNS folds and FAILED.

**So: re-measure every entry against production first.** The evidence-quote triage
(`evidence-check.mjs`) ranks reading order; it does not decide anything. And a measurement of your
own can be wrong too — a first pass here reported 143 areas and 123M EGP out of place because it
joined `group_key` (a composite like `AB3|Alex West|AB`) instead of `group_code`.

Resume protocol and the checkpoint that supersedes the report's own figures:
[[sos-audit-checkpoint-outside-the-repo]].

**Newest measure: `sos-remeasure-2026-09-18.md`**, in the F: vault and in the `sos-audit-2026-08-09`
mirror. It supersedes 09-06 (which AGENTS.md §4 still names) as the list to work from.

- **The backlog:** 93 open items (81 stand, 12 partly), 23 of them high severity.
- **Closed since 09-06:** 27 fixed, 4 dead (the frozen legacy import) and 2 owner-closed.
- **The 09-06 owner-deferred customer-map item is settled:** the owner merged #3561, and production has 0 mismatches.
- **Owner rulings made while working it** are in `sos-owner-rulings-2026-09-18.md`, beside the re-measure. **#20 FINAL (18:04 Cairo): make the Total sheet match the Closing Matrix.** After five mixed answers in three sessions, one clear English and Arabic question settled it. It is recorded in `sos-owner-rulings-2026-09-18.md`. Never ask again. **Lesson: when several sessions hold one item, put ONE question listing every earlier answer.**
- **For the next re-measure:** write a NEW file again. Judge migration-file findings from live `pg_get_functiondef`, never from the file, and confirm on production any FIXED verdict whose proof lives in the database.

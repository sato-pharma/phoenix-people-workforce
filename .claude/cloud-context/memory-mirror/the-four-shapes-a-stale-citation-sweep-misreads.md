---
name: the-four-shapes-a-stale-citation-sweep-misreads
description: "A memory-citation sweep's false positives have four recurring shapes — a retired citation that is the SUBJECT of its own sentence, an ABSENCE that is the claim, a title asserting what the description already retired, and elided-prefix shorthand that looks like a corrupted path. Measured 2026-10-01: 4 of 5 GONE citations and 19 of 25 absence false positives were one of these."
metadata:
  node_type: memory
  type: project
  originSessionId: 73e57dfd-59e9-4e08-8d24-cfbcccf853cf
  modified: 2026-10-01T04:32:10.822Z
---

🔴 **A SWEEP THAT JUDGES A CITATION BY WHETHER ITS TARGET RESOLVES WILL DELETE THE EXPLANATION
ALONG WITH THE STALENESS.** Measured 2026-10-01 across the whole memory directory, on the night the
`Dockerfile:N` sweep finished: of the five citations classified GONE, **one was real**, two were
dated records that must never be rewritten, one was already resolved in its own `description`, and
one was never broken at all. Of 25 false positives in the ABSENCE bucket, **19** were shape 2 below.
So the base rate of a plausible-looking stale citation being genuinely stale is low, and the cost of
being wrong is asymmetric: a stale number misleads, a deleted explanation cannot be recovered from
the memory that no longer contains it.

**The four shapes, each with its live instance:**

1. **The retired citation is the SUBJECT of the sentence.** `windows-dev-server-turbopack-switch`
   says "this memory used to say `Dockerfile:81`" — the number is what the sentence is ABOUT, so
   stripping it deletes the record of why it was dropped. Same in
   `sharp-is-a-devdependency…`, past tense: "the old failure mode was `Dockerfile:22`".
2. **The ABSENCE is the claim.** `field-workforce-pending-deductions` asserts that
   `crossCheck|punch_no_visits|visits_no_punch` are NOT in `recommendations.ts`;
   `bilingual-bodies` says "line 588 with no `dir`". A token missing near the cited line IS the
   finding, so "the symbol is not there" reads as staleness and is the opposite.
3. **The TITLE asserts what the DESCRIPTION already retired.** `two-live-deduction-engines-p0` is
   titled for two live engines while its own description opens "RESOLVED 2026-08-30 — the
   deduction-engine cutover is COMPLETE … Only the unified `src/lib/deductions` module is live", so
   `payroll-handoff.ts` being gone is the EXPECTED end state. `the-0655-crm-digest-is-refused-never-schedule-it`
   is the same shape in the other direction — the slug still says refused, the digest is live again.
   🔴 **Read the description before spending an investigation on the title.**
4. **Elided-prefix shorthand looks like a corrupted path.** `dm-sales-scope-drops-out-of-region-areas`
   read "Monthly Closing (`monthly-closing-portal.ts` / `-details.ts:418`)" — the second name shares
   the first's prefix, and both files exist. It was reported as a damaged line needing reconstruction.
   Expanded in full 2026-10-01 so no later sweep repeats that.

**What to do instead.** Judge a citation by its CLAIM, never by whether a path or symbol resolves —
the rule already at the top of the memory cluster. When a number has drifted, the house answer is to
**drop the line number and name the symbol or quote the string**, which is what #5014 did to 20
citations and #5029 to 132 more; a symbol survives a refactor and a number does not. Never rewrite a
dated record (§2.1). And the one bucket worth real attention is GONE, because only that one can hide
a dead code path rather than a stale number — the single real finding that night was
`sonar-gate-conditions-are-invisible-and-hotspots-need-a-human`, which described a CI gate that no
longer exists anywhere on `origin/main` and would have sent a session hunting an invisible gate
condition. A memory whose description claims a retired module is LIVE is the dangerous version of
shape 3: `analytics-open-to-all-scoped-plan` said sales analytics was open to portal sales roles
after the owner retired the whole module by Ruling 11, and a session acting on it would have tried
to undo his own ruling.

Related: [[verify-the-emitted-artifact-never-the-source]] ·
[[memory-reachability-classifier-reads-the-primarys-agents-md]]

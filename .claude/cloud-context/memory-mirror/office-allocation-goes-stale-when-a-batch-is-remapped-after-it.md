---
name: office-allocation-goes-stale-when-a-batch-is-remapped-after-it
description: "Office units are allocated at COMMIT time and nothing re-runs them, so any batch re-mapped afterwards leaves the spread on a base that no longer exists — August 2026 CNS 3,698 units (3.37%) at the batch, and September 2026 CNS 10,987 of 80,565 (13.64%, 48 areas) after the 9 Oct customer-map remap; FIXED read-time from October (#5676), DETECTED (#5679) and REPORTED on the needs-you board (#5694)."
metadata:
  node_type: memory
  type: project
  originSessionId: 61ac0cfb-9a45-4123-ac88-7f2173f492b1
  modified: 2026-10-09T18:02:12.871Z
---

The Office channel's value shares used to be computed when the Office file was uploaded and written
into the rows, and nothing re-ran them. So the "import Office last" discipline was necessary but not
sufficient: a distributor batch whose customers are re-resolved AFTER the Office upload moves the
non-Office value base, and the stored Office spread stayed on the old one.

**Measured on production, 2026-10-09, August 2026 CNS**, through the repo's own closing loader and
`buildOfficeRespread`. Office = 109,719 of 178,272 units (61.5% of the line); its last batch landed
10 Sep 20:15 Cairo, correctly after the brick-carrying channels, and the month was published 10 Sep
23:22. **6,834 packs — 6.23%, 548,777 EGP — are credited to a different area than today's base
gives them**, across 48 areas with 17 of them short; the largest single error is CA1 at +3,119 packs.
🔴 **TWO TRUE NUMBERS, ONE DEFECT — never "reconcile" them away.** `check-office-allocation-drift.ts`
(merged as #5679, another session) reports **3,698 units / 3.37%** by comparing the Office BATCH's own
rows with today's shares on the line's own stored total; **6,834 packs / 6.23%** is the same month
through the closing LOADER, after the city-split rails — where a reader meets the number, and what
this respread moves.

**FIXED, not outstanding.** `src/lib/sales/closing-office-respread.ts` recomputes the spread on every
closing READ as a net movement on the city split's rails — the locked golden rule itself is
untouched — from `OFFICE_RESPREAD_START_PERIOD = "2026-10"`, CNS only, so no published month moves.
It shares the largest-remainder engine (`contribution-respread.ts`) with
[[epda-bulk-is-allocated-like-office-on-pedia-from-september-2026]], which is why that rule must not
copy the upload-time design either.

**How to apply:** August stays as published — the 6.23% is the evidence for the rule, never a
backlog. 🔴 **SEPTEMBER IS SETTLED: he was asked and ruled "leave the Office respread at October"**
(2026-10-09), with September's state in front of him — CNS not published (only September Anti
Infective is, and that line has no Office channel), still importing, and ZERO Office rows because
its file has not landed. So the constant moves again only on **his own new word about September**,
never on a session's reading that the data makes it look safe, and it would also need September's
frozen net rebuilt first — see [[publishing-one-line-freezes-the-whole-periods-store-split-net]].

🔴 **THE OWNER CAN NOW SEE IT — AND THE PUBLISHED-CLOSING DRIFT CHECK NEVER COULD, BY CONSTRUCTION.**
`office-allocation-drift` is a needs-you board source since PR #5694 (9 Oct 2026): it reads the
latest period with an Office batch and the latest PUBLISHED one with an Office batch (3,225 ms
measured on production against the board's 8-second budget; all nine would be ~18 s), links to
`/sales/import` — the only screen anywhere that re-commits an Office book — reports units only, names
distributors rather than codes, and ages from the FIRST base move after the commit. **A published
month lands in `worth-knowing`, never `yours`:** re-committing it would restate an announced figure,
so it is not a decision waiting on him. Why nothing else could ever have caught it: today's side of
the publication drift comparison is today's shares applied to the line's **own stored Office total**,
so both sides hold identical units per line and that check compares exactly that one scalar — the two
reports are not in conflict and must never be "reconciled".

**The call graph, verified 9 Oct 2026 — and re-verified by a peer session, which caught a miss:**
`computeOfficeAllocation` has exactly TWO non-test callers, `src/lib/sales/office-upload.ts` (the
commit path — the only one that WRITES a spread) and `scripts/check-office-golden-rule.ts` (the
fingerprint check, which holds no Supabase client at all). 🔴 **A `git grep` pathspec of
`scripts/**/*.ts` silently missed the second one** — git fnmatch does not match a file sitting
directly under `scripts/` through `**/`, so scope a caller sweep to `-- scripts`, never to a `**`
glob. `refreshBatchRollups`
(`src/lib/sales/normalizer/customer-map.ts:904`) refreshes the fact, directory, ROI, channel,
distributor×product, store-split net, attribution and import-summary rollups and touches the Office
spread in none of them — so a reconcile/remap chain rebuilds every other number and leaves this one
stale, silently. Below `OFFICE_RESPREAD_START_PERIOD` the stored rows are what a reader gets.

**September 2026's Office book DID land** — committed 20:10:51 Cairo on 9 Oct, and the board read it
clean (0 drifted lines) at 20:30, which supersedes this note's earlier "ZERO Office rows". 🔴 **And
its only staling force is the 1,212-pair September customer-map remap another session ran the same
evening — NOT an arriving book:** he ruled the same day that *"ebda and mec are not comming this
month"*, so September is COMPLETE at 15 books and no further distributor file is owed
([[epda-and-mec-file-nothing-in-september-2026]]). **Nothing will re-run the spread** either way, by
his October ruling. See
[[a-rule-script-run-in-the-primary-reads-its-stale-checked-out-code]] — the drift script recomputes
the rule from its own checkout and joined the stale-tree guard in #5694.

🔴 **AND THE REMAP DID STALE IT — SEPTEMBER 2026 CNS IS 10,987 OF 80,565 OFFICE UNITS (13.64%) ACROSS
48 AREAS**, measured 9 Oct 2026 by the session that ran the remap, from its own worktree HEAD
`beeba7b6a` on `origin/main 4439685b5` after all eight rollup rebuilds settled. **Four times August's
3.37%**, because 968,448.03 EGP of base moved in one go with 783 rows crossing an area boundary. The
largest single cells: CA5 −5,550 against CA3 +4,997, UE5 −2,639 against UE6 +2,600. `line unit totals
agree on both sides: true`, which is exactly why no published-closing check can see it. All eight
distributors that moved the base wrote AFTER the Office commit (20:11:07 Cairo): **overseas 20:57,
EGD Branch 20:58, EGD 20:58, ramco 20:58, Ibn sina 20:59, sofico 20:59, Ramco Tender 20:59, Ibn Sina
Tender 21:00** — every one carries a real `distributor_name` on production, so the board row names
them rather than falling back to codes.

**So the board's first live row is September in the `yours` lane, not August in `worth-knowing`** —
September CNS is unpublished, which makes it the one case where re-committing the Office book is
genuinely his to decide. The remap itself was right and is not in question: Sohag 1 fell 291.3% →
246.3%, Sohag 2 rose 42.2% → 90.1%, Down town 207.2% → 140.6%, Cairo East 1 50.7% → 123.9%, with
national CNS unchanged at 11,885,444.55 EGP / 151,876 units — value moved between areas, none created.

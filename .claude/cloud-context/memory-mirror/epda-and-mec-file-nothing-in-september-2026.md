---
name: epda-and-mec-file-nothing-in-september-2026
description: "Owner, 2026-10-09 — \"ebda and mec are not comming this month\" — so September 2026 is COMPLETE with 15 books, not waiting on 17; declared in SOURCE_QUIET_PERIODS (sos-month-complete.ts), period-scoped so October expects both again, and the audit banner still counts them absent because September's totals genuinely lack their volume."
metadata:
  node_type: memory
  type: project
  originSessionId: 61ac0cfb-9a45-4123-ac88-7f2173f492b1
  modified: 2026-10-09T18:14:30.661Z
---

**epda (`EP`) and mec (`MC`) file nothing for September 2026, by his own word on 2026-10-09:
*"ebda and mec are not comming this month"*.** Both fed August, so the completeness gate expected
both and would have waited for ever — and the September store-split rebuild parked behind that gate
could never have fired. Declared in `SOURCE_QUIET_PERIODS` in
`src/lib/sales/sos-month-complete.ts` (PR 5696), which cites his words in the source.

September therefore reads **COMPLETE** with the books it has:

```
2026-09 is COMPLETE — every source still filing has landed. epda and mec file nothing this
month (owner, 2026-10-09: ...), so they are not owed.
sos-month-complete: COMPLETE 2026-09 missing=0 drift=26321.57 frozen=no
```

**Why:** this is the fourth kind of absence that is not a hole, after the Direct vintage fold
([[direct-company-is-never-a-coverage-hole]]), the EPDA-BULK merge window
([[epda-bulk-merged-into-epda-pharmacies-from-july-2026]]) and El Qema's onboarding. All four are
**declared, never inferred** — a quiet month and an un-uploaded month are indistinguishable in the
batch table, which is the whole reason the module refuses to guess.

**How to apply:**
- It is **period-scoped, never a retirement.** October expects both files again. Do not turn a
  one-month declaration into a permanent exclusion.
- **The data outvotes it.** A book that arrives late is simply present, so the declaration cannot
  hide an upload; it only stops the gate waiting.
- 🔴 **It is the GATE's carve-out, not the audit banner's.** `buildSosCoverageReport` still counts
  both as absent, deliberately: September's totals really do not contain their volume, so a
  month-over-month comparison is not like-for-like and the banner exists to say so. Do not "fix"
  that into agreement with the gate.
- The store split is **live, nothing published**, so there is nothing frozen to rebuild —
  26,321.57 EGP across 42 cells recomputes on every read. See
  [[publishing-one-line-freezes-the-whole-periods-store-split-net]].
- 🔴 **DO NOT CARRY THE "OFFICE DRIFT IS 0" READING — IT WAS TRUE FOR ABOUT FORTY MINUTES.** Two
  reads at ~20:55 and ~21:05 Cairo both said 0 on the final book set, and both were taken BEFORE
  the 1,212-pair customer-map re-resolution finished re-pointing 2,643 September rows between
  areas. Re-read from `af65d4906`: **10,987 of 80,565 CNS Office units — 13.64%, across 48 areas —
  are now stored in the wrong area**, worst CA5 −5,550 against CA3 +4,997, with eight distributor
  batches touched at 20:57–21:00, i.e. after the 20:10:51 Office commit. `line unit totals agree on
  both sides: true`, which is exactly why the publication drift check is blind to it. "The last
  books are in" never meant "the base is final" — a re-map moves the base too.
  [[office-allocation-goes-stale-when-a-batch-is-remapped-after-it]]

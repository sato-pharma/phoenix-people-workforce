---
name: epda-and-mec-file-nothing-in-september-2026
description: "Owner, 2026-10-09 — \"ebda and mec are not comming this month\" — so September 2026 is COMPLETE with 15 books, not waiting on 17; declared in SOURCE_QUIET_PERIODS (sos-month-complete.ts), period-scoped so October expects both again, and the audit banner still counts them absent because September's totals genuinely lack their volume."
metadata:
  node_type: memory
  type: project
  originSessionId: 61ac0cfb-9a45-4123-ac88-7f2173f492b1
  modified: 2026-10-09T17:57:05.202Z
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
- Two checks that read September on his word the same evening: the Office allocation drift is
  **0** on the final base (read twice, from a stale tree and from a current one), and the
  store split is **live, nothing published**, so there is nothing frozen to rebuild —
  26,321.57 EGP across 42 cells recomputes on every read. See
  [[publishing-one-line-freezes-the-whole-periods-store-split-net]].

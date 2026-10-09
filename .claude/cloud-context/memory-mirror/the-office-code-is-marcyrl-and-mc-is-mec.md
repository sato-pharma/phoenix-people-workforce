---
name: the-office-code-is-marcyrl-and-mc-is-mec
description: "`Office` IS Marcyrl and `MC` is mec — two different distributors, so \"Marcyrl's book\" and \"the Office book\" are ONE upload. Reading a distributor code's letters as its name reported a landed book as missing and told the owner he was wrong when he was right; resolve every code through source_of_sales_distributors, and never count `DIRECT` and `DirectReq` as two sources — the repo folds them onto one channel."
metadata:
  node_type: memory
  type: project
---

**What it cost (2026-10-09, ~20:20 Cairo).** He said *"Marcyrl's book and the Office book have both
landed"*. A session read `MC` as Marcyrl from its letters, found no `MC` batch for 2026-09, and told
him **"He was wrong about Marcyrl"** — and told two peer sessions to keep holding. Both halves were
wrong: `Office` **is** Marcyrl, it had landed at **20:10:51** (`Marcyrl 9.xlsx`, batch
`96e4f19f-fcb0-4260-aee0-7a60ab0f3016`, 3,920 rows, 80,565 units, 6,971,179.95 EGP), and the code
that was actually missing is `MC` = **mec**, a different distributor he had not claimed.

**The master, read from `source_of_sales_distributors` on production `ozucdzovmcqvepbozvqf`:**

| Code | Name | Active |
| --- | --- | --- |
| `Office` | **Marcyrl** | true |
| `MC` | **mec** | true |
| `EP` | epda | true |
| `EP-BK` | EPDA-BULK | true |
| `EP-PHS` | EPDA-Pharmacies | true |
| `SF-T` | Sofico Tender | true |
| `DIRECT` | Direct (Company) | **false** since 2026-09-03 04:04 — **folded onto `DirectReq`** |
| `DirectReq` | Direct Order Requests | true |

**How to apply:**

1. 🔴 **Never read a distributor code as a name.** `Office` looks like a channel and is a company;
   `MC` looks like Marcyrl and is mec. The "names, never codes" rule exists for exactly this, and the
   failure mode is not a cosmetic label — it misreports coverage and contradicts him.
2. 🔴 **MEC IS A SEPARATE DISTRIBUTOR — his own words, 2026-10-09: _“MEC is a separate distributor”_.**
   `MC`/mec is never one of Marcyrl's books, and "Marcyrl's book" and "the Office book" are the same single upload. An instruction naming both is one
   file, not two, and the Office *channel* work and the Marcyrl *book* are the same thing.
3. 🔴 **`DIRECT` and `DirectReq` ARE ONE CHANNEL — never count them as two sources.**
   `DIRECT_CHANNEL_ALIASES` in `src/lib/sales/direct-channel.ts` is `{DIRECT, DIRECTREQ}` and
   `canonicalDistributorKey` folds both onto `DIRECTREQ`, labelled **Direct (Company)**;
   `sos-coverage.ts`, `source-coverage.ts` and `sos-month-complete.ts` all read through it.
   **He settled it in chat on 2026-10-09: _“Direct Order Requests carries it now”_**, which confirms
   the shipped fold rather than asking for a change. A raw-code comparison reports Direct as an
   outstanding book while the month already holds it — it did on 2026-10-09, and
   `source-coverage.ts`'s own header records the same defect flagging the August Anti Infective
   closing incomplete when all four of its sources were in.
4. 🔴 **NEVER ASSEMBLE THE EXPECTED SET YOURSELF — the authority is `summarizeMonthCompleteness`
   (`scripts/check-sos-month-complete.ts <period>`).** A set built from "the distinct codes August
   had" counts a **phantom 18th code**, because August holds BOTH Direct vintages and September holds
   `DirectReq` alone. Measured on production 2026-10-09: 2026-08 is **18 raw codes but 17 canonical**,
   2026-09 is **17 raw and 17 canonical** — so the "17 in against August's 18" gap does not exist, and
   the months differ at four codes, not one count: **out `EP` (epda) and `MC` (mec); in `EP-BK`
   (EPDA-BULK) and `SF-T` (Sofico Tender)**, both September books August never had.
5. **A FIXED, hand-kept list of sources is wrong in the other direction too** — `EP-BK` and `SF-T`
   were new in September and no static list holds them. Both failures have one answer: read
   `summarizeMonthCompleteness`, which folds the aliases and takes the expectation from the data.

**He confirmed it himself on 2026-10-09, ~20:35 Cairo: _“office is another name for marcyrl”_.** A peer session wrote this same fact as a second note the same evening; both are folded into this one.

Related: [[a-closing-rule-that-moves-zero-may-simply-have-no-upload-yet]],
[[epda-bulk-merged-into-epda-pharmacies-from-july-2026]],
[[september-books-ownership-split-across-sessions]].
See also [[direct-company-is-never-a-coverage-hole]].

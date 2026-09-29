---
name: the-marketing-code-resolver-never-re-runs
description: "A marketing distributor code resolved once at capture keeps that verdict for ever, so a code entered before its pharmacy reaches the sales master reads untrackable long after it became traceable — and validation_notes may carry a signed human verdict that must not be overwritten"
metadata:
  node_type: memory
  type: project
  originSessionId: f151c304-4f1a-4527-86ae-ce961d80f72e
  modified: 2026-09-29T19:02:01.108Z
---

`phx_resolve_marketing_pharmacy_codes` runs **once, at capture**, and nothing re-runs it when the
sales master later learns the code. The verdict is frozen at the moment the rep pressed save.

**Measured 2026-09-29.** Ibn Sina `421993` («صيدليات لايف - د/ احمد علي حسين», Kafr El-Dawwar):

```
code row resolved   2026-08-24 12:34:50  ->  "unresolved"
master learned it   2026-09-18 22:28:25      25 days LATER
```

The rep's code was correct the whole time — master holds `IS 421993` = «احمد على حسين»,
«ش صلاح الدين مركزكفرالدوار», the same street he captured on. It simply read untrackable for a
month. **Seven code rows were in that state**, four of them inert import rows.

**Why:** any count of "codes whose sales cannot be traced" is inflated by rows that became
traceable after their one resolution. Reporting that number as a problem — or worse, mass
re-resolving to fix it — acts on an artefact.

**How to apply:**

- Before calling a code untrackable, check whether `source_of_sales_customer_map` knows it NOW,
  and compare `master_resolved_at` against the master row's `created_at`.
- Re-resolve a single row with
  `select * from phx_resolve_marketing_pharmacy_codes(array['<code row id>']::uuid[])` — the
  system's own function, never a hand-written mapping.
- 🔴 **NEVER mass re-resolve.** A code the master knows may belong to a DIFFERENT shop: `1536256`
  («صيدلية زمزم») resolves to «ايمن فايز / المهندسين», so a blanket sweep would attach that
  capture to someone else's sales.
- 🔴 **READ `validation_notes` FIRST — it can hold a signed human investigation, and `unresolved`
  may be the VERDICT, not a gap.** `0001570071` («خالد السيد موسى») carries Khaled Bedair's
  (SFE Manager, A-2) finding of 2026-08-26, proven by Pharma Overseas invoices `9114638229` and
  `9118278169`: the pharmacy has no 2026 trading, so it is `manual_approved` / `unresolved`
  deliberately, and its area `D12` is retained on purpose because it describes the venue GPS.
  Re-resolving it overwrites a person's considered decision with a value that note rejects.
- Re-resolving writes `mapped_*` only. Moving the venue's own `area_id` is a separate act, and the
  master's area can contradict the capture's GPS — `IS 421993` maps to `AB1` Alex East while the
  shop is in Kafr El-Dawwar, Beheira (`AB5`), where the owner filed it on 2026-09-29.

Companion: [[a-wrong-distributor-code-is-a-typo-not-a-rep-gaming-you]].

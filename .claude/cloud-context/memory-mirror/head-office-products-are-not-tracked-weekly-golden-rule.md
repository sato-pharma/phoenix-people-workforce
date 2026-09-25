---
name: head-office-products-are-not-tracked-weekly-golden-rule
description: "GOLDEN RULE - Head Office / confidential products are used in NEITHER Weekly NOR Monthly sales, so their missing area and region mapping is CORRECT and must never be reported as a fault"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 0ef3c838-df3a-4112-ac74-bca2e15e4f4b
  modified: 2026-08-30T16:15:39.610Z
---

# 🔒 GOLDEN RULE — locked by the owner 2026-08-26, extended to MONTHLY 2026-08-30

**Head Office / confidential products are used in NEITHER Weekly NOR Monthly sales. Their missing
area, region and manager mapping is CORRECT. Never report it as a fault.**

**2026-08-30 — the owner extended this to monthly, in his own words: _"The head office will not be
used in the weekly sales or monthly sales."_** The 2026-08-26 record below is weekly only and stands
as written; this line is the amendment, not a correction of it. So Head Office is out of **both**
reporting surfaces, and the monthly side is not a separate question to re-ask.

The monthly side was already true mechanically and is now true by decision: Head Office is **absent
from `phx_monthly_achievement`** — see [[head-office-sales-are-absent-from-phx-monthly-achievement]],
which is the trap that matters, because no rows reads as zero and once rendered 243,579 real July
units as `0`. Absent-by-accident and excluded-by-rule look identical in a query; this rule is why the
answer is "excluded, correctly" and never "the monthly data is broken".

**The weekly Line filter no longer offers Head Office at all (PR #2785, 2026-08-30).** He said
_"remove head office from the line filter"_, so the dropdown is now built by
`weeklyTrackedLineOptions()` in `src/lib/sales/weekly/tracked-lines.ts` and lists the three tracked
lines only. **Do not tell anyone to "just pick Head Office in the Line filter"** — that sentence was
true until this date, it was literally in `WEEKLY_TRACKED_SCOPE_NOTE`, and it is now a dead door. The
one remaining route is an explicit `?line=Head%20Office` on the API, which `includeUntracked` still
honours **on purpose**, so the weekly import and any admin check of a Head Office upload keep a way
in. A rule about REPORTING must not make data unreadable — but no screen can reach it by clicking.

The owner tracks weekly sales for **three lines only**:

| Tracked weekly | Not tracked weekly |
| --- | --- |
| **CNS** · **Anti Infective** · **Pedia** | **Head Office** — Lacto Basic 1 (`LA003`), Lacto Basic 2 (`LA004`), Satoslim (`SS001`), Royanoxicam (`RY001`) |

**Do not:**

- flag Head Office branches, areas or regions as unmapped, missing, broken or "needs mapping";
- "fix" it by mapping Head Office depots to areas — there is nothing to fix;
- include Head Office in any weekly total, KPI, ranking or regional cut meant to describe field
  performance.

**Why this matters so much:** Head Office is **EGP 297,229,509 — 78% of everything in the weekly
tables** (live prod, 2026-08-26). Any unscoped weekly number is dominated by a line the owner does not
follow. On 2026-08-26 an audit led with "80.8% of weekly money reaches no manager" and the owner
corrected it: scoped to the three tracked lines the real figure is **12.8% (EGP 10,723,951)**, and
**96% of that is one defect** — Anti Infective tagged `UE` when its organogram has only `UE-1`/`UE-2`.
The unscoped number was alarming and wrong-headed; the scoped one is small and fixable.

**Measured again 2026-08-30, on the NSM/DSM export, and it is worse than 78% by value.** Four books
built from the same August sheet, `excludeUnmapped` on: Head Office **EGP 37,568,199** against CNS
2,648,156, Pedia 831,362, Anti Infective 610,238 — Head Office is **90.2% of the four-line total**. And
**89.2% of Head Office (EGP 33.5M) sits at "Region level (no single area)"**, against 8.3% for CNS,
because Head Office has no sales territory at all: its masthead names no National Sales Manager where
CNS names Amr. **That 89% is the rule showing through, not a mapping defect** — do not offer to
attribute it to areas. It was offered once on 2026-08-30 and the owner's answer was this rule.

**How to apply:** every weekly AND monthly query, report, audit and dashboard cut gets
`official_line <> 'Head Office'` (or an explicit CNS / Anti Infective / Pedia filter) unless the owner
asks for Head Office by name. State the scope on the output. Asking for one Head Office book by name
is NOT a standing exception — it stays out of every total, ranking and comparison either way. Restricted-product visibility rules are a
separate matter and still apply — see [[weekly-sales-cannot-follow-the-organogram-it-is-depot-data]]
and [[weekly-area-coverage-judge-by-value-not-rows]].

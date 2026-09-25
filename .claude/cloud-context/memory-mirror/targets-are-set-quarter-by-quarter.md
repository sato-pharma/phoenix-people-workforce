---
name: targets-are-set-quarter-by-quarter
description: "Sales targets are loaded a QUARTER at a time — never a whole semester, never month by month. So a future month with no target row is normal, not a gap; do not pre-load it or offer to. The incentive is still PAID per semester: two different rhythms, and confusing them reads a healthy state as broken."
metadata: 
  node_type: memory
  type: project
  originSessionId: 9008386f-4dd8-4f8f-8fa8-06362f4739fe
  modified: 2026-09-05T12:13:55.023Z
---

**Owner, 2026-09-05, interrupting to correct me: "no in our company we move quarter by quarter."**

He said it to stop me loading October–December targets, which I had just recommended. Targets are set
one QUARTER at a time, near that quarter — not for a semester up front, and not month by month.

**The consequence that matters: a future month carrying no target row is the NORMAL state, not a gap
to close.** Do not offer to pre-load one, and do not report its absence as a data-quality finding.
The right moment for Q4 is Q4, and it is his call, not a backlog item.

## The data says the same thing, and it is the fastest way to re-confirm this

Per line, a quarter's three months are written in ONE sitting — `au.monthly_targets.updated_at`
shows CNS's 2026-07/08/09 all uploaded **within 35 seconds** on 2026-08-10, and Pedia's within four
minutes on 2026-08-04. That signature (three consecutive months, one timestamp cluster, one
`created_by`) is what a quarterly load looks like. As of 2026-09-05 the table holds **2026-01,
2026-02, 2026-07, 2026-08, 2026-09 only** — Q3 complete, Q4 not started, and Mar–Jun never loaded.

## Do not confuse this with the SEMESTER rhythm

The incentive is **paid** per semester — total sales ÷ total target, Jan–Jun and Jul–Dec
([[achievement-numerator-is-covered-actual-not-all-sales]] carries the numerator rule and the owner's
words). So targets arrive quarterly while the payout is measured semesterly. Both are true at once:
mid-semester, the semester denominator is legitimately incomplete, and that is not a defect either.

**Why it bites:** every "N months are missing targets" sweep reads a correct state as broken, and the
fix it proposes — pre-loading the rest of the semester — is the thing he stopped.

**How to apply:** before flagging or loading any target month, ask whether that quarter has started.
Anti Infective 2026-09 was a genuine exception worth fixing (its Q3 siblings had targets and it did
not, which distorted the semester denominator); Oct–Dec is not, because no line has Q4 yet.

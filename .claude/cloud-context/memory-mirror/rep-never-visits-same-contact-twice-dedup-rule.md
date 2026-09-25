---
name: rep-never-visits-same-contact-twice-dedup-rule
description: "Owner rule: a rep NEVER visits the same contact twice in a day or week — so the duplicate signal is same-contact, not same-comment; the live comment-based collapse destroys ~166 real visits/month"
metadata: 
  node_type: memory
  type: project
  originSessionId: 4f1ea15f-81e9-4172-888c-40dd3d8fefd9
  modified: 2026-08-01T08:29:45.956Z
---

**Owner's rule (stated 2026-08-01):** a medical rep *never* visits the same contact
twice in a day — "or even weekly, never". So in `ireports360_visits`, **same rep +
same contact + same day = a duplicate record**, and **different contact = a real,
separate visit**, no matter how similar the rows look.

This invalidates the fingerprint used by `collapseDuplicateDoubleVisitSubmissions`
in `src/lib/crm/reads.ts`, which groups on *rep + double partner + day + AM/PM +
identical comment* and **never looks at `contact_crm_id`**. Reps type the same
generic comment for every doctor (e.g. "اخدت وعد بالكتابه" = "took a promise to
prescribe"), so an ordinary day of fieldwork collapses to one row.

**Production evidence (July 2026, prod `ozucdzovmcqvepbozvqf`):**

| Burst groups | Groups | Rows | Median save-gap |
| --- | --- | --- | --- |
| All rows share ONE contact — genuine duplicate | 21 | 51 | **0.5 min** |
| Rows span DIFFERENT contacts — real visits | **98** | **267** | **12.7 min** (max 899) |

The old rule dropped 199 rows/month, which decompose exactly as **166 real visits +
33 true duplicates** (199 = 166 + 33). Worked case: rep B-124 + DSM B-118 on
2026-07-13 — 9 different doctors between 11:54 and 15:40, collapsed to 1. The
save-gap is an independent tell: real duplicates land ~30s apart, misclassified
ones ~13 min to 15 hours apart.

🔴 **`contact_crm_id` IS ONLY A REAL CONTACT ON `visit_type = 0`.** Production July 2026:
type 0 = 7,364 distinct contact ids / 14,097 rows / 100% `contact_name`-populated;
EVERY other type (-8 campaign, -11 meeting, -4 vacation, …) = **exactly 1 distinct
contact id, 0% named** — a sentinel. Keying anything on the contact for a non-regular
row means "same rep + same day", which squashes a whole day into one row. Real case:
rep Hayam.Eladel's 2026-07-30 prospection campaign = 6 different pharmacies (ص الهادي,
ص القاضي, ص الملكه والامير, ص نانسي, ص محمود فوزي, ص هدي), each named only in the
COMMENT, all on the sentinel contact. Fixed in `2c50a0a6` (#1572) — the collapse is
restricted to type 0. **Campaign identity lives in the comment, not the contact.**

**MERGED 2026-08-01 as `19fecd50` (PR #1567), corrected by `2c50a0a6` (PR #1572).**
Applies the rule keyed on
`agent + contact + day + visit_type`, to every visit including single-agent rows.
Rows dropped per month by visit type: **`-8` campaign = 3,064**, `-30` = 108,
**`0` regular = 15**, `-4` = 10, `-15` = 1. Double Visit Analytics' own population
(partner + type 0/-8) goes from 2,045 rows to 1,638 — a **20% reduction**. That
campaign figure is large and was reported to the owner as the visible consequence
of the rule they stated; if campaigns should be exempt it is a one-line change to
the group key, not a redesign.

Two details worth keeping: `visit_type` is IN the key, so a regular visit and a
campaign for one contact never merge; and the survivor prefers a row **with** a
double partner over an earlier solo row, otherwise collapsing would silently erase
the manager's ride-along/coaching credit while leaving the visit count unchanged.

**Why it matters:** every aggregate consuming this collapse — Team Calendar day
cells, Double Visit Analytics KPIs, FWC compliance, probation DV credit — has been
**undercounting** real fieldwork. It is a live miscount, not a display bug.

**How to apply:** treat `contact_crm_id` as the duplicate key. Never dedup CRM
visits on comment text. PR #1567 (`codex/team-calendar-dedup-drilldown`) was parked
as a **draft** for exactly this reason — it would have propagated the wrong rule
into the drill-down (took one rep-day from 13 real rows to 5). Related:
[[crm-export-streaming-corruption-incident]] (synthetic tests miss real-scale data
shape).

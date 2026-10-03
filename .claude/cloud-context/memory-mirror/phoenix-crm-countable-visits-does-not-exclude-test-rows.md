---
name: phoenix-crm-countable-visits-does-not-exclude-test-rows
description: "The view `phoenix_crm_countable_visits` does NOT filter `is_test` — every one of its rows in production is a test row, so reading it without `where not is_test` reports test entries to the owner as real field work. Its name is about countability, not about reality."
metadata:
  node_type: memory
  type: project
  originSessionId: 1e66550a-0561-4d35-bf39-b2bff9fb5c9a
  modified: 2026-10-03T05:20:54.790Z
---

Measured on production (`ozucdzovmcqvepbozvqf`) on 2026-10-03:

| source | rows | `is_test = true` | real |
| --- | --- | --- | --- |
| `phoenix_crm_visits` (base) | 9 | **9** | **0** |
| `phoenix_crm_countable_visits` (view) | 8 | **8** | **0** |

**Phoenix CRM has never recorded a real visit in production.** Every row is a test entry: three by
B-10's own test seats (`capture_source = slot`), four by Aya Ibrahim Mohamed Salam's test persona on
2026-09-30, and two by Ahmed Ashraf Mahmoud Elsayed's on 2026-10-03.

**The trap.** The view is named *countable*, which reads as "the visits that count" — so a query
against it looks like it has already excluded the things that should not count. It has not. It
excludes one base row (a removed or admin-captured one) and says nothing about `is_test`. The
`is_test` column is right there in the view's own column list, which is the tell: a view that had
filtered it would have no reason to carry it.

**What it cost.** Walking the Delta (1) exceptions board on its go-live morning, this view was read
without `not is_test` and the owner was told that *"Aya Ibrahim Mohamed Salam is the only rep with
visits on the last working day — 1 AM, 3 PM"*. That was her TEST persona. The true answer was the
much simpler and more useful one: **zero real visits anywhere**, so the board flagging every
territory was correct for a plainer reason than the one reported. A peer session reading the same
production through the rendered report (AM 0, PM 0, 111 rows "No visits") had it right, and
contradicted the database reading taken here.

**Why the two disagreed without either being broken:** the app's own readers DO filter test rows per
viewer (only a persona's own owner sees them), so the rendered report said 0 while a raw view query
said 8. A disagreement between the screen and the database on Phoenix CRM visit counts is this,
nearly every time — check `is_test` before concluding either is wrong.

**How to apply:** every ad-hoc read of Phoenix CRM visits gets `where not is_test` unless the
question is explicitly about test entries, and a count quoted to the owner as field work names the
filter it used. More generally: **a view's NAME is not its WHERE clause** — read the definition, or
group by the column you are assuming it removed. Related: [[the-test-suite-runs-with-production-credentials-and-app-env-production]],
and the opposite-direction error in [[head-office-sales-are-absent-from-phx-monthly-achievement]],
where absent rows were read as a real zero.

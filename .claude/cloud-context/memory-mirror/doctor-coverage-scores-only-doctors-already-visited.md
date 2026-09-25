---
name: doctor-coverage-scores-only-doctors-already-visited
description: "The /doctor-coverage board's denominator is built FROM visits, so a doctor nobody visited is invisible to it — it measures visit frequency, not the owner's coverage KPI. Same word, two boards: 44% here vs 70% on the plan-based one for August 2026. Also: HCP norms are 0 in live prod, so the board's Account-mix section can never populate."
metadata: 
  node_type: memory
  type: project
  originSessionId: 0d8c36aa-7d0d-40c0-ac9a-fdcb36dd9ea4
  modified: 2026-08-26T20:05:21.936Z
---

**The owner opened `/employee-portals/doctor-coverage` on 2026-08-26 and said it was "a very, very
different thing" from what he meant. He was right, and the mismatch is structural, not cosmetic.**

`src/lib/crm/sfe-doctor-coverage.ts` builds its panel **from `ireports360_visits` alone**
(`visit_type = 0`, 6-month scan). A contact enters the denominator *because someone visited it*.
So the question it answers is **"of the doctors we DID see, who is short of their visit norm?"** —
frequency and follow-up quality. It is **not** coverage against an assigned list, and it cannot
become that: a doctor nobody visited has no row anywhere in it.

**Measured live on prod (`ozucdzovmcqvepbozvqf`) for August 2026, company-wide:**

| | |
|---|---|
| board panel / covered / under-visited / lapsed | 9,023 · 4,011 · 1,486 · 3,526 → **44%** |
| planned rep→doctor pairs, and how many were visited | 6,388 of 9,163 → **70%** (the owner's KPI) |
| planned doctors **invisible** to the board (unseen 3+ months) | **1,286** |
| board-panel doctors on **nobody's** August plan | **2,820** |

**Two boards, one word.** `/admin/rep-doctor-lists` is the plan-based one and is what he means by
coverage ([[crm-coverage-and-frequency-are-two-kpis-that-disagree]]). It is **Super Admin only and
has NO portal twin** — `app/employee-portals/rep-doctor-lists` does not exist — which is why he
landed on Doctor Coverage instead. Never quote one board's % as the other's.

**Two live UI defects found in the same audit (both unfixed as of 2026-08-26):**

1. **The "Account mix — pharmacies, hospitals & contracts (HCP)" section can never populate.**
   `doctor_coverage_config.norms` in prod is `sp {A:2,B:1,C:1}` / **`hcp {A:0,B:0,C:0}`** (set
   2026-08-19 by `b-10`; also holds `line_overrides {"b155":[1,2]}`). `if (target <= 0) continue`
   runs *before* `doctors.push`, and `mixFor("hcp")` iterates `doctors` — so the section reads
   "No HCP accounts in this panel" forever while **2,503** graded HCP accounts are actively visited.
2. **"Lapsed" is not pace-adjusted.** The Coverage tile is pro-rated by elapsed days
   (`resolveCoveragePace`), but the Lapsed tile is hardcoded rose over `totals.red` = *zero visits
   so far this month*. Mid-month that counts every doctor merely **not due yet** — 3,526 on 26 Aug.

Also: the call list caps at 50 rows against a true 5,012 for a company-wide viewer (`callListTotal`
does report the real number).

Related: [[achievement-numerator-is-covered-actual-not-all-sales]] (same shape of error — a
percentage whose denominator is not the population it claims) ·
[[crm-visits-join-to-bricks-both-maps-now-filled]] · [[campaign-visits-make-a-working-rep-look-like-a-zero]]

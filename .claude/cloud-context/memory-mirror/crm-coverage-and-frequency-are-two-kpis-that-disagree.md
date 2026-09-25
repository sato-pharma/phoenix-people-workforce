---
name: crm-coverage-and-frequency-are-two-kpis-that-disagree
description: "The owner's two rep KPIs: coverage = touched the doctor at all; frequency = EXACT match to the planned call count, where over-visiting is a deviation too. ONLY regular visits (visit_type 0) enter either one - campaign (-8) is counted BESIDE them, never inside. Production runs 68% vs 39% - never quote one as evidence for the other."
metadata: 
  node_type: memory
  type: project
  originSessionId: ee8e1dd7-5943-412c-9063-b9a3827f3d74
  modified: 2026-09-04T00:00:00.000Z
---

**The owner's two KPIs (stated 2026-08-21, shipped in PR #2276 — LIVE in production the same day,
confirmed by `/api/healthz` reading revision `69884709`, not merely merged).**

- **COVERAGE** = `visitedDoctors / plannedDoctors`. Did the rep touch the doctor **at all** this month?
  His words: *"I'm not talking about grade. I'm talking about that he covered the doctor or no."*
  This already existed as **`adherencePct`** (PR #2259) under the wrong name — the maths never changed.
- **FREQUENCY** = `onPlanDoctors / (plannedDoctors − notDueDoctors)`. Did the CALL COUNT match the plan
  **exactly**? Verbatim: *"if he tell three times and visited four times, then there is here an issue."*
  **Over-visiting is a deviation, never a bonus** — this can never be written as a met-or-exceeded ratio,
  and the over bucket must never be toned green.

**They disagree hard, which is the whole point.** Production August 2026 to the 21st: coverage **68%**
(4,449 of 6,505 doctors), frequency **39%** (2,475 exact of 6,299 due). The strongest rep in the field is
**100% coverage / 70% frequency**. Never quote one as evidence about the other, and never reuse coverage's
80/50 colour bands for frequency — at 39% company-wide that paints the entire field force red
(the tone helper used 60/35 for frequency, deliberately).

**THE TONE HELPER IS GONE - 2026-09-02, PR #2938.** `src/components/crm/rep-doctor-kpi-tone.ts` was
deleted along with the Rep Doctor Lists board, because no route could open the board. Both KPIs above
are unchanged and still the owner's rules; what no longer exists is the code that coloured them.
**60/35 for frequency against 80/50 for coverage is now a rule for a rebuild, not a file you can read.**

**Scored against the PLAN, never the grade.** The A=3 / B=2 / C=1 convention the owner described is a habit,
not reality: measured across the mirror, grade A averages **2.04** planned calls against grade B's **2.03**,
the most common plan for a grade A doctor is **one** visit, and only **14** grade C doctors exist
company-wide. The configured norms in `doctor-coverage-config.ts` are **A=2/B=1/C=1**, not 3/2/1. Where a
plan asks for fewer calls than its grade norm it is reported as `underPlannedVsGrade` **beside** the KPIs —
a signal about the plan, never inside either percentage.

**Mid-month uses two different denominators on purpose.** Over is judged against the WHOLE month's plan
(irreversible); behind is judged against the plan **to date** (still time to catch up). Scoring a rep on
calls the plan plants next week would invent a deviation. On a closed month the two collapse into plain
exact-match. Measured: to-date basis moves exactly-on-plan from 27.0% to 32.1%, so **a running month's
frequency is not comparable with a closed one** and the UI marks it.

A doctor planned only for future days is `not_due` and held **out of the denominator** — counting him as
missed is an accusation about a call that is not late; counting him on-plan flatters the score.

**REAFFIRMED BY THE OWNER 2026-09-04, unprompted, as a standing rule:** *"campaign is counted, but in coverage and frequency only regular visits are counted."* Nothing changed - this is the 2026-08-27 ruling restated. Verified the same day that the code still honours it: `sfe-doctor-coverage.ts:794` is `if (visit.visit_type !== 0) continue;`, its header states campaign "can never enter the panel, the denominator or the coverage percentage", and `call-rate.ts:42` states both KPIs are structurally immune because they key on a contact id a campaign call does not have. **The one measure that DOES absorb campaign rows is CALL RATE** - it counts rows, which is exactly why that module reports verified / unverified / campaign as three numbers and never one total, with `verifiedRate` as the headline. Summing them back into one figure undoes the point.

**Campaign visits (`visit_type = -8`) can never satisfy a planned call** — all 31,322 carry
`contact_crm_id = 0`. Counted beside both KPIs so a campaign-only rep reads as working, not idle
([[campaign-visits-make-a-working-rep-look-like-a-zero]]).

The plan mirror now holds **Jan–Aug 2026, 155,789 rows** (backfilled 2026-08-21 by replaying the
upsert-only sync month by month). Before that it was August only.

Related: [[crm-month-over-month-does-not-compare-the-same-reps]] ·
[[crm-mobile-cards-are-module-wide-and-ci-enforced]] · [[dv-evidence-window-same-day-submits]]

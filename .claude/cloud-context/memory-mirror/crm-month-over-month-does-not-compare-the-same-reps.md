---
name: crm-month-over-month-does-not-compare-the-same-reps
description: "THE GUARD WAS DELETED 2026-09-02 (PR #2938) - rebuild it, do not assume it is live. Any CRM plan/visit trend across months silently changes population — departed agents are dropped from HISTORY too, so an early month is scored over survivors only and the line rises for reasons nobody performed. Always compute a like-for-like cohort."
metadata: 
  node_type: memory
  type: project
  originSessionId: ee8e1dd7-5943-412c-9063-b9a3827f3d74
  modified: 2026-08-21T09:38:32.771Z
---

> **THE GUARD IS GONE - 2026-09-02, PR #2938. Read this before acting on anything below.**
> `src/lib/crm/rep-doctor-lists-trend.ts` (455 lines), `src/components/crm/rep-doctor-trend-panel.tsx`
> (276) and `tests/crm-rep-doctor-trend.test.ts` (261) were ALL deleted with the Rep Doctor Lists
> board, because no route could open it. **The trap below is unchanged and still true of the data;
> what no longer exists is the code that handled it.** Anything rebuilding a CRM month-over-month
> view starts with NO like-for-like cohort and NO test pinning the two rules - re-implement them.
> (PR #2938 did the same thing in the repo: it replaced component pins in four suites with prose
> recording the rule for a rebuild.)

**The trap.** `getEffectiveExcludedAgentCrmIds()` removes departed agents from **every** month, including
months they actually worked. So a month-over-month CRM series is not a comparison of the same people, and
the company line moves for reasons that have nothing to do with anybody's performance.

**Measured in production 2026-08-21, `ireports360_plan_entries` after the Jan–Aug backfill:**

| month | agents in plan | of those, NULL `agent_hr_id` | still planning in Aug | reps the board could measure |
| --- | --- | --- | --- | --- |
| 2026-01 | 58 | **32** | 27 | 33 |
| 2026-04 | 82 | 28 | 59 | 53 |
| 2026-08 | 78 | **8** | 78 | 69 |

NULL `agent_hr_id` on a plan row means a LEAVER, not a defect ([[crm-null-plan-hrid-means-leaver-not-defect]]) —
`employees.crm_id` is cleared on exit. The count falls monotonically 32→8 as you walk toward today, because
the further back you look the more of that month's field force has since gone.

**What it produced.** Rep Doctor Lists coverage, raw company line: `59% → 56% → 57% → 81% → 81% → 79% → 78% → 68%`.
That **+24pt April jump reads as a turnaround and is almost entirely population.** On the like-for-like
cohort — the same 23 reps present in all eight months — it is `81% → 76% → 74% → 80% → 78% → 77% → 79% → 73%`:
flat-to-declining, **no April jump at all**. Frequency on that cohort is a genuine `25% → 39%`.

**The fix WAS `src/lib/crm/rep-doctor-lists-trend.ts` (PR #2276), deleted 2026-09-02 - see the banner.**
`stitchRepDoctorTrend` returned
`likeForLike` alongside `company` — reps with a non-null cell in EVERY month, re-aggregated from summed
COUNTS (never by averaging percentages: rep list sizes run 21→234). Two rules that must not be "simplified":

- **A rep with no plan in a month is `null`, never 0%.** Rendering 0 says "he reached none of his list"
  about a month he was never measured in. Was pinned by `tests/crm-rep-doctor-trend.test.ts`, deleted with it.
- **A rep with one measured month has `coverageChange === null`,** not a change against a month he was absent
  from.

Also: `totals.reps` counts anyone with ANY activity, so it stays near 80 even when the plan mirror holds 58
agents. Population checks must count `hasMeasurablePlan`, not `totals.reps` — an absolute headcount threshold
was tried first and fired on all eight months.

Related: [[crm-coverage-and-frequency-are-two-kpis-that-disagree]] · [[a-third-of-target-carrying-territories-have-no-rep]]

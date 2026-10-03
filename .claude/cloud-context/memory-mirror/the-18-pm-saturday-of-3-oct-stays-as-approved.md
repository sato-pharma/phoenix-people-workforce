---
name: the-18-pm-saturday-of-3-oct-stays-as-approved
description: "The one over-cap Phoenix CRM plan day on production — Yasmeen Samy Shawky Mahdy's Saturday 3 Oct 2026, 18 PM against a cap of 15 — is SETTLED, left as approved by the owner's own ruling; never \"repair\" it, and never ask him again."
metadata:
  node_type: memory
  type: project
  originSessionId: 0e0c03eb-4533-4483-94d2-c4690297c794
  modified: 2026-10-03T04:47:42.073Z
---

Owner ruling, **2026-10-03**, asked directly with the evidence and his recommended answer:
**"leave Yasmeen's Saturday 3 Oct as it is."**

The row: plan `206559bf-3155-4170-a0a7-3bb94b9d4af9`, seat `SEAT-CNS-REP-D11` (CNS, Delta (1)),
`week_start` 2026-10-03, status `approved`, holding **18 PM** on Saturday 3 October against
`phoenix_crm_settings.pm_daily_cap` **15**. It is the ONLY over-cap day in any real Phoenix CRM plan,
fleet-wide and across every week — so a session that finds it is finding this one, not a new defect.

**Why it stays.** 3 October WAS the day. Her plan was approved and she was working it, so taking
three customers off it would have turned three planned calls into *off-plan* visits needing her
district manager's and then SFE's approval — Golden rule #1 the wrong way round, landing work and an
approval chain on the rep for a repair she had no part in. By 4 October the day is past and locked
anyway. The whole cost of leaving it is that one day's PM count reads 18 instead of 15; the cost of
editing it was real work on her and two managers.

**Where it came from, so the row is not read as a live bug.** The items were re-parented onto the new
weekly plan rows by a repair during the 2026-10-02 weekly-plan rework — 62 of them carry a
`created_at` older than the plan row they hang on, all re-stamped in one write at 21:20 Cairo, ten
minutes before the send, with no `saved` event and no version bump. Two other seats show the same
shape (`SEAT-PED-REP-D13`, `SEAT-PED-REP-D16`) and only this one landed over cap. That repair is not
in the repository.

**The hole it came through is closed** (#5208, merged 2026-10-03 07:44 Cairo): the send re-checks the
whole week against the caps (`planSendCapRefusal`), so nothing over cap reaches a manager again. The
rule is in `.claude/rules/phoenix-crm.md` and the full account in
`docs/phoenix-crm-plan-cap-on-send.md`. A reviewer's `approve` is deliberately NOT refused — see the
account for why blocking it would have stranded exactly this plan.

Related: [[sos-monthly-closing-is-the-only-sales-truth]] — nothing in payroll or any money figure
reads a plan day's PM count, which is why this one was never urgent.

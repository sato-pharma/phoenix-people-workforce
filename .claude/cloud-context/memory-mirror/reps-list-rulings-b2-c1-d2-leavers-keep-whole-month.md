---
name: reps-list-rulings-b2-c1-d2-leavers-keep-whole-month
description: "Owner rulings 2026-09-21 on the call rate — leavers/new hires keep the WHOLE month's days (B2), a resigned rep is hidden once HR marks him (D2), and the rate stops at YESTERDAY on Reps List AND the KPIs board, call rate only (C1). Never re-propose prorating or keeping leavers."
metadata: 
  node_type: memory
  type: project
  originSessionId: 8a99af29-4b9c-4077-ab94-dcfe54196eb5
  modified: 2026-09-21T05:44:01.751Z
---

**OWNER RULINGS, 2026-09-21** — "fix Reps List with B2, C1 and D2", answering the Reps List / Reps
Plans audit of the same morning. He was offered the recommended B1 and D1 and **chose against both**.

- **B2 — a leaver or a new hire is divided by the WHOLE month's working days.** No proration to the
  days employed, and new hires are NOT hidden before their start date (Jonia Wageh and Esraa Awad,
  starting 1 Oct, showing as zero rows was the audit's example). This is the board's existing
  behaviour; it is DECIDED, not a defect — never re-propose proration.
- **D2 — a rep who leaves mid-month disappears from the call-rate figures once HR marks him
  resigned**, days worked included (it took 94 of Aml Mohamed's and 65 of Walid Fathy's September
  visits out of the team figures). Also existing behaviour, also DECIDED — do not "keep them to their
  last working day".
- **C1 — every CALL RATE scores through YESTERDAY** — Reps List (#4179, live 08:14 Cairo) and, on
  his word the same morning ("apply C1 to the KPIs board too"), the KPIs board's call rate:
  `CALL_RATE_THROUGH_YESTERDAY` in `src/lib/crm/reps-plans.ts` (renamed from `REPS_LIST_WINDOW`).
  On the KPIs board it is the CALL RATE ONLY — the legacy report, the Phoenix lanes
  (`window.callRateTo`) and the two KPI reports (`callRateTo`). **Coverage and frequency still count
  today's visits** (no day sits in their denominators). A period's first day shows an empty rate and
  no verdict. Never "align" coverage to yesterday, and never move the rate back to today. The Phoenix
  CRM pilot board took it too (#4186, `phoenixCrmCallRateWindow`; plan achieved also still counts
  today). The clean Phoenix CRM (`src/lib/phoenix-crm/`) has no per-day call rate, so nothing to apply.

**Why:** B and D were his to decide and he decided them; a later audit finding the same "defects"
would otherwise re-raise them.

**How to apply:** when auditing any call-rate board, list B/D behaviour as ruled, not as findings.
Related: [[gps-checkins-are-a-partial-feed-never-score-a-rep-on-them]] (ruling A1, same audit).

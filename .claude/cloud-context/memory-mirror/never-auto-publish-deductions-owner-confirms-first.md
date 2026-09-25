---
name: never-auto-publish-deductions-owner-confirms-first
description: "NEVER publish a deductions month. CRM-derived detections are only ~80% accurate — recommend, wait for the owner's explicit confirmation, then publish"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 2d66b5e6-1a1a-44ee-8e95-86506c216715
  modified: 2026-08-05T15:50:48.724Z
---

**Never publish a deductions month, and never approve a batch on your own initiative.** The order is
always: **you RECOMMEND → the owner CONFIRMS → only then publish.** Stated by the owner directly,
2026-08-05, in capitals.

**Why:** his words — *"you are not accurate because of CRM data"*, which he puts at roughly **80%**.
He is right, and the connector's own history is the evidence:

- **Suspect dates.** Company-wide CRM sync gaps look identical to mass absence. Three depressed
  Thursdays in July 2026 produced 78 of 247 flagged employee-days (62,435.47 EGP) from people
  following a company-wide pattern, and a same-weekday median could not flag them.
- **Zero CRM signal.** An employee whose `crm_id` logged nothing all month is a data-mapping gap,
  not absence — A-9 (20 days, 30,967.74 EGP) and A-8 (16 days, 22,193.55 EGP) were at work and
  punching in. B-112 was still charged 451.61 EGP on his final settlement from a candidate that
  predated the guard.
- **Mixed days.** A rep logging AM annual leave then working the afternoon was charged a full day —
  19 days across 17 people in July 2026, roughly one vacation day in four.
- **Two sources, one absence.** HR request + CRM annual-leave record double-charged 19 employee-days
  (8,822.54 EGP) before the vacation reconcile landed.

Every one of those looked like a confident, well-formed deduction until a human questioned it.

**How to apply:** present the set with per-employee totals, the money, and the pre-checks
(employee-day collisions, null amounts, anything that looks like a data gap rather than absence) —
then STOP and wait. Do not phrase the next step as "publish when ready"; phrase it as a
recommendation awaiting his decision. `publishMonth` freezes the numbers and locks the candidates,
so it is the least reversible action in the module. Related: [[deduction-raw-value-is-days-dates-is-not]].

---
name: crm-half-day-the-ampm-tag-is-not-the-clock
description: "Half Day (CRM) deductions — a CRM AM/PM tag is not the clock; check-ins and save times clear a \"missing\" half first (862 apparent → 308 real, Jun–Oct 2026); Thursday never judged; managers judged like anyone"
metadata:
  node_type: memory
  type: project
  originSessionId: 0677825c-5c92-4ca2-a42c-ebf53187526a
  modified: 2026-10-08T16:38:50.743Z
---

The Deductions module's **Half Day (CRM)** tab (category `crm_half_day`, owner ruling 2026-10-08) charges a district manager or rep 0.5 day for a field half (Sat–Wed) with nothing on file. Each row needs approval and is paid through the CRM column.

**The trap:** reading the AM/PM tag alone overcounts nearly 3×. On production, 1,962 PM-tagged visits in Aug–Sep 2026 carried the rep's own GPS check-in at that customer between 09:00 and 12:59. Before a half is charged, each of these clears it:
- his own check-in (05–15 clears the morning, 13 onward the afternoon);
- the rep's check-in on a visit he is credited on;
- the save time (06–12 clears the morning, 17 onward or next day before 04:00 clears the afternoon);
- a Phoenix CRM visit's capture time, read like a check-in. Phoenix `ampm` is the customer LIST, not the hour, and a started team has no iReports360 check-ins.

A Phoenix visit must have a location AND a time — "no negotiation" (owner, 2026-10-08). With no location (admin-entered, `location_flag` no_place) it counts for nothing.

A day whose GPS arrived short (the sync keeps visits when a check-in fetch fails) is never judged.

June 1 – October 7 went from 862 apparent half days to 308 confirmed (83 people, ≈105,758.60 EGP estimate).

**Why:** He demanded "more than 100%" accuracy. He also ruled that a manager is a normal employee: no team-size guard, but every day must be confirmed against double visits, including those on reps who later resigned.

**How to apply:**
- Never judge a half from the tag alone.
- Read visits through `scanVisitsForRangeIncludingDeparted` and check-ins with `includeResignedAgents: true`.
- Thursday (morning-only) is never judged.

Account: `docs/deductions-crm-half-day.md`. Related: [[approved-is-not-pushed-and-a-confirmed-step-freezes-the-zero]] (an approved row reaches payroll without a push).

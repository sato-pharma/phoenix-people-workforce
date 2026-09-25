---
name: crm-door-resigned-exclusion-costs-a-contact-read-1100-doctors
description: "A CONTACT-centric CRM read must opt in to includeResignedAgents: the default exclusion takes 1,100 of 15,125 GPS doctors to zero, because the rep who logged them left."
metadata: 
  node_type: memory
  type: project
  originSessionId: ef45b053-0c83-4e60-94b7-2083401c5d8b
  modified: 2026-08-21T08:59:37.401Z
---

Measured on PRODUCTION 2026-08-21, on `ireports360_checkins` rows that have GPS and a
`contact_crm_id`:

| | |
| --- | --- |
| GPS check-ins total | 105,413 |
| …from an excluded agent | **6,431** (6.1%) |
| Distinct contacts with GPS | 15,125 |
| …that survive the exclusion | 14,025 |
| **…that go to ZERO entirely** | **1,100** (7.3%) |

Those 1,100 are real doctors at real coordinates whose **only** GPS check-in came from a rep on the
static/live excluded list. The exclusion is agent-centric and correct for coverage, scoring and
reporting — see [[crm-resigned-agents-exclusion-list]] and [[crm-resigned-slot-reused-for-new-hire]],
where the same hard-floor list has hidden an ACTIVE rep six times.

**The rule:** if the SUBJECT of your read is the contact and the agent is never displayed, scored or
trusted, pass `includeResignedAgents: true` through the door. If the subject is the agent, never.
`queryVisits` always had that opt-in; `queryCheckins` gained it 2026-08-21 for Pharmacy Search's
"doctors near this pharmacy" read (PR #2270), which is exactly the contact-centric case.

Related: the door itself is [[crm-single-source-door-guardrail]] — extend `CrmCheckinFilter` /
`CrmVisitFilter` rather than hand-rolling a mirror query, or `tests/crm-single-source.test.ts` turns
the PR red. Check-ins remain [[gps-checkins-are-a-partial-feed-never-score-a-rep-on-them]], so an
empty proximity result means "no visit was recorded here", never "no doctor practises nearby".

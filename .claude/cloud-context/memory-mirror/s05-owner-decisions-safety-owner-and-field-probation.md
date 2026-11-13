---
name: s05-owner-decisions-safety-owner-and-field-probation
description: "Owner's S04/S05 decisions (13 Nov 2026) — Report It owner Samaa Mosaad (in-app + email, followed on her Report It desk), field-role probation, and the daily-jobs safe switch-over"
metadata:
  node_type: memory
  type: project
  originSessionId: d6cd0e8b-e41c-4195-bfe9-3759a7718c37
  modified: 2026-11-13T18:08:35.932Z
---

Owner's answers in the S04/S05 audit follow-up sessions, 13 Nov 2026, evening Cairo:

- **Report It (adverse drug reactions) owner = Samaa Mosaad Said Khalil (QPPV, hr_id A-3)**, the one person in `report_it_dashboard_access`. "Samaa, plus email": every NEW report reaches her by an in-app notice AND an email (link only, no patient data). Statuses: received → under assessment → closed. **She follows open reports and due dates on her Report It desk (a due-date view), NOT the Needs-you board — Needs-you stays Super Admin only.** (REC-033)
- **Automatic probation covers FIELD ROLES ONLY** — Medical Representatives plus district and area managers; office roles stay manual. (REC-074)
- **Daily-jobs split ships behind a SAFE SWITCH** (`PHOENIX_DAILY_JOBS_SPLIT`, off by default): the old single morning run keeps running all 30 jobs while the 30 new cron-job.org schedules are armed over two days (the account allows 100 API requests a day, arming needs ~120); then the switch flips and the old run stops. (REC-049)

**Why:** these were the owner decisions the S04/S05 plans needed.
**How to apply:** file each as a rule line in `.claude/rules/report-it.md`, `.claude/rules/probation.md` and `.claude/rules/platform-observability.md` in the PR that builds it. The Day 30/60/75 probation notices still go only to the owner, no CC. Never test-send the new email. See [[never-fire-bulk-emails-ever]].

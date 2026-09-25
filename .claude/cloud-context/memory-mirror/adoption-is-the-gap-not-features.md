---
name: adoption-is-the-gap-not-features
description: "Phoenix is 100% provisioned but only ~15% adopted; Medical Reps are at 4% and weekly actives have been flat for 10 weeks"
metadata: 
  node_type: memory
  type: project
  originSessionId: 8f74b582-4680-493e-8b8b-4f728d8bc1e6
  modified: 2026-07-30T05:30:06.292Z
---

Measured on production (`ozucdzovmcqvepbozvqf`) on 2026-07-30, ahead of the system launch meeting:

- **113 active employees, 112 active accounts** — 100% coverage. The only unprovisioned "active
  employee" is the `ADMIN-HR` system placeholder. All 112 have a password hash set; 0 locked;
  14 still flagged `force_password_reset`.
- **Weekly active users flat at 13–23 for 10 straight weeks** (17 in the week of 2026-07-27),
  against a capacity of 112. Query: `audit_logs where entity_type='auth_session'`.
- **30-day sign-in by role:** Medical Rep 3/71 (4%), District Manager 3/16 (19%),
  Employee 0/9, Manager 0/2, Finance Manager 0/1 — every other role (CEO, NSM, RM, SFE, PM,
  GPM, Marketing, Training, TA, Super Admin) is at 100%.
- **Workflow depth, 30d distinct users:** weekly plans 11, vacation 7, deduction decisions 5,
  excuse 4, outstation 2, coaching 1, marketing 1, probation 1.

**Why:** 87 of 112 seats are Medical Reps + District Managers, and between them 6 people signed
in that month. The platform has been proven by head office and never handed to the field. Ten
flat weeks means this is not a discoverability or bug problem — nobody has been told to come in.

**How to apply:** Stop treating feature gaps as the blocker for the field force. Before building
anything else "so reps will use it", check this number — shipping more modules will not move a
line that has not moved in ten weeks. The wedge is the three workflows that already have a pulse
(weekly plans, vacation, excuse), rolled out managers-first, with a dated cutover that kills the
parallel WhatsApp/paper channel. Watch [[resend-daily-100-cap-429-outage]] before mass-onboarding
— 87 password emails in one day will blow the cap. Respect [[one-prod-deploy-per-task]] and freeze
features during any rollout window. See [[user-overwhelmed-needs-lead-and-automate]].

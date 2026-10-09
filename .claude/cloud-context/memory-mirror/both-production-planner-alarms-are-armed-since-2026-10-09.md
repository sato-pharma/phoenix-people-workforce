---
name: both-production-planner-alarms-are-armed-since-2026-10-09
description: Both production-planner alarms are ARMED in production since 9 Oct 2026 — the reorder one sends daily at 06:11 Cairo, and the expiry one is now live too but stays silent until a lot comes inside the expiry window — widened from 90 to 180 days the same day, so the first one is due 10 Nov 2026
metadata:
  type: project
---

**The owner armed the EXPIRY alarm on 2026-10-09** ("arm the production planner's expiry alarm"),
right after the two alarm emails were made English (PR 5631). State in production
(`ozucdzovmcqvepbozvqf`) as of that date:

- `prodplan_settings`: `alarm_enabled = true`, `alarm_dry_run = false`,
  `expiry_alarm_enabled = true`, `expiry_alarm_dry_run = false`, `expiry_warn_days = 180` (was 90 until he widened it the same day).
- `email_templates`: `production_planning_reorder` active (it always was — which is why the Arabic
  email reached his inbox); `production_planning_expiry` had **no row at all**, so it fell back to
  the code default's `isActive: false`. Arming it meant INSERTING the row with every content
  column written and `is_active = true` — a minimal row would have activated to
  "Body content is not configured yet."

**Why:** all four fail-safes must agree, and the one that is invisible from the screen is the
template row. Reading `expiry_alarm_enabled` alone would say armed while `sendTemplatedEmail`
answers `skipped: template inactive`.

**How to apply:** the reorder sweep runs daily at **06:11 Cairo** and sends. The expiry sweep is
live but writes no verdicts until a lot is within 180 days — the soonest lot expires 2027-05-09 (Aspartame), which enters the window on **2026-11-10**, and Guaifenesin follows on 2026-12-26. Recipients for both, code-side and never a role: To Dr. Sahar
Khalil, Cc the CEO and the Finance and Admin Manager, Bcc the owner. Related:
[[never-fire-bulk-emails-ever]].

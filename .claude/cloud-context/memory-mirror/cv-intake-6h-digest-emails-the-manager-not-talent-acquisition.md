---
name: cv-intake-6h-digest-emails-the-manager-not-talent-acquisition
description: "The 6-hourly CV email digest goes to the hiring manager who received the push, never to Talent Acquisition"
metadata: 
  node_type: memory
  type: project
  originSessionId: 39ecca08-cf29-4a42-8536-318731476a3c
  modified: 2026-08-27T00:39:56.679Z
---

The 6-hourly CV intake digest (`src/lib/recruitment/inbound/cv-intake-digest-6h.ts`,
route `/api/cron/recruitment-cv-digest`, shipped in #2438 on 2026-08-27) emails **the hiring
manager who had candidates pushed to them** — keyed on `ats_candidates.manager_notified_hr_id`
where `manager_notified_at` is within the last 6h — a per-manager summary of how many CVs they
received and from whom (sender grouping joined from `ats_cv_intake_events.candidate_id`).

**Why:** the owner's instruction was explicit and corrected a first wrong build —
"NO THE RECEIVER OF THE CVS IS THE ONE WHO RECEIVES THE EMAIL." The obvious-looking design
(email the Talent Acquisition pipeline team) is WRONG; do not re-introduce it.

**How to apply:** CC rule is role-based on the *recipient manager's* role — District Manager and
Regional Manager CC their own manager, National Sales Manager does NOT, and
`omar.anwar@satopharma.com` is always CC'd. Silent when no manager received anything (no "0 CVs").
This is an EMAIL channel, separate from the existing daily in-app/Telegram/push CV digest
([[recruitment-cv-received-is-in-app-and-telegram-never-email]] governs that other one).

Live cron on cron-job.org: job **8334658** `phoenix-recruitment-cv-digest`, GET, 00:47/06:47/12:47/18:47
Africa/Cairo, auth `Bearer …ede6` (len 71) cloned from the recruitment-email-intake sibling. Never
fire it manually from the laptop — with the feature live it would send real off-schedule emails and
burn the per-manager+window idempotency key.

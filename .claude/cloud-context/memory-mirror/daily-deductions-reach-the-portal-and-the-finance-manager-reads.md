---
name: daily-deductions-reach-the-portal-and-the-finance-manager-reads
description: "Owner rulings 2026-11-07 — released daily deduction lines show on the employee's Deductions page; the Finance Manager reads the Daily Deductions page (read-only), still not the month Deductions screen."
metadata:
  node_type: memory
  type: project
  originSessionId: 81e5b0ae-3360-4870-830d-95028704bc19
  modified: 2026-11-06T23:07:32.187Z
---

Two owner answers of 2026-11-07, given as multiple choice after the Deductions audit (PR 72) and shipped in PR 74.

1. **"Show daily lines"** — the daily release email says "Open your Deductions page", so released daily lines now show there (`src/components/employee-portal/daily-deductions-section.tsx`, read by `getPortalDailyDeductions` in `app/employee-portals/deductions/page.tsx`). Only the RELEASED snapshot, self-only, never the running tally. The section says a day in both places is charged once — a daily release feeds no salary run.
2. **"Open the page read-only"** for the Finance Manager on `/admin/daily-deductions` — he is in `VIEW_ROLES` and no longer in the sidebar card's `excludedRoles`. He STAYS excluded from the month `/admin/deductions` screen (revoked 2026-08-11). Every mutating daily route still asserts approve/create plus Super Admin.

**Why:** both replace older decisions written in code comments (the portal reader was "latent" pending his call; the Finance Manager was revoked from both deduction screens).

**How to apply:** never re-hide daily lines from the portal or re-exclude the Finance Manager from Daily Deductions on the strength of the old comments. Pinned by `tests/daily-deductions-portal-and-readers.test.ts`. Related: [[a-thursday-holiday-bridge-day-is-a-full-day]].

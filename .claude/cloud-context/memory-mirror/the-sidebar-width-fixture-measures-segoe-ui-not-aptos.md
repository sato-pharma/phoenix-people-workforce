---
name: the-sidebar-width-fixture-measures-segoe-ui-not-aptos
description: "tests/fixtures/sidebar-label-widths.json holds Segoe UI widths from the laptop, because headless Chromium there cannot see Aptos, plus a `fallback` half in Arial since 3 Nov 2026; the width test holds both, and Helvetica Neue is still only stood in for."
metadata:
  node_type: memory
  type: project
  originSessionId: 764f34bd-2388-45ff-ba16-f8a75f3f3516
  modified: 2026-11-03T15:48:25.043Z
---

Measured 3 Nov 2026 in headless Chromium 153 on the laptop, at the admin rail's 13px/600/-0.01em. **Aptos is not visible to it**: it sits in the per-user cloud font folder, and a `"Aptos",monospace` probe returns the monospace width. So the stack resolves to Segoe UI, and that is what the fixture's `admin` and `portal` maps hold. `getComputedStyle` proves nothing here: it returns the family LIST, not the face that drew the text, so [[portal-sidebar-label-width-budget]]'s "confirmed Aptos" reading does not stand.

The fix, PR 67, merged 3 Nov 2026 at 17:37 Cairo and live: `scripts/measure-sidebar-labels.ts` also writes `fallback.admin` and `fallback.portal` in Arial and refuses to write if Arial is not visible; `tests/sidebar-label-width.test.ts` holds every row against its budget in both. It renamed Company Vacations, Attendance Review, Direct Reconciliation, Awareness Inbox and Field Compliance; Double Visit Integrity came first in PR 65. The phone bottom bar's own test still reads one font.

**Who reaches which font, production `activity_events`, 60 days to 3 Nov 2026:** Windows 52 people (16 on admin pages) never reaches Arial. Linux browsers 12 people, 0 on admin pages, all Medical Reps and District Managers on the portal, and at least one is really Android (its browser reports Samsung Internet). An automated headless browser signed in as Super Admin: 4,755 admin page events. Mac 5 people land on Helvetica Neue, which is not installed anywhere the script runs, so Arial only stands in for it. Read `activity_events` or `app_sessions` for this; `auth.sessions.user_agent` holds the server's agent, not the browser's.

**Why:** a guard that takes one measurement, in whichever face the measuring machine has, cannot see any other machine.

**How to apply:** when a press screenshot and the width test disagree, look for a face the fixture does not hold before calling it stale. To run the measure script when playwright's pinned Chromium is not installed, preload a module that passes `executablePath` to `chromium.launch` and leave the script unmodified. Re-measuring also corrects rows other sessions wrote, so its diff can touch labels you never edited.

---
name: the-sidebar-width-fixture-measures-segoe-ui-not-aptos
description: "tests/fixtures/sidebar-label-widths.json holds Segoe UI widths from the laptop, because headless Chromium there cannot see Aptos, plus a `fallback` half in Arial since 3 Nov 2026; the width test holds both, and Helvetica Neue is still only stood in for."
metadata:
  node_type: memory
  type: project
  originSessionId: 764f34bd-2388-45ff-ba16-f8a75f3f3516
  modified: 2026-11-03T20:28:02.861Z
---

Measured 3 Nov 2026 in headless Chromium 153 on the laptop, at the admin rail's 13px/600/-0.01em. **Aptos is not visible to it**: it sits in the per-user cloud font folder, and a `"Aptos",monospace` probe returns the monospace width. So the stack resolves to Segoe UI, and that is what the fixture's `admin` and `portal` maps hold. `getComputedStyle` proves nothing here: it returns the family LIST, not the face that drew the text, so [[portal-sidebar-label-width-budget]]'s "confirmed Aptos" reading does not stand.

The fix, PR 67, merged 3 Nov 2026 at 17:37 Cairo and live: `scripts/measure-sidebar-labels.ts` also writes `fallback.admin` and `fallback.portal` in Arial and refuses to write if Arial is not visible; `tests/sidebar-label-width.test.ts` holds every row against its budget in both. It renamed Company Vacations, Attendance Review, Direct Reconciliation, Awareness Inbox and Field Compliance; Double Visit Integrity came first in PR 65. The phone bottom bar's own test reads two fonts as well, since PR 70 (merged 3 Nov 2026, 21:47 Cairo). Its Arial half is measured at weight 700, not the label's 900: on Windows `Arial` at 900 draws Arial Black, a face nobody reaching the stack's Arial is served (worst bar 324px against a real 284px).

**What the live rail gave, read on production at 1440px on 3 Nov 2026, about 22:20 Cairo:** the 157px budget is not what every admin row gets. Inside a domain the row drops its icon (`hideIcon`, `sidebar.tsx`), so a label has 197px (177 with the hub arrow), and on the 320px phone drawer 255. **While the rail's search box holds text the domains switch off, so rows get the icon and the arrow: 137px.** `labelBudgetPx` charges a plain row 157 and never models that, so the guard cannot see it: 6 labels were cut in the laptop's font (Manager CV Engagement 148, Temporary Module Locks 145, Company Activity Report 144, Sales Import (Advanced) 141, Dev Preview (Real Data) 137.6, Notification Confidence 137.3) and 11 more in Arial. The fix is on `codex/sidebar-search-rows`, open and not merged when this was written (check its pull request before relying on it): a row left alone by a search is no longer a hub, so it gets the plain 157px. The old long names would have fitted the Super Admin's normal rail even in Arial (164 in 197), so PR 67's renames matter on the search rows and the rows with icons.

**Who reaches which font, production `activity_events`, 60 days to 3 Nov 2026:** Windows 52 people (16 on admin pages) never reaches Arial. Linux browsers 12 people, 0 on admin pages, all Medical Reps and District Managers on the portal, and at least one is really Android (its browser reports Samsung Internet). An automated headless browser signed in as Super Admin: 4,755 admin page events. Mac 5 people land on Helvetica Neue, which is not installed anywhere the script runs, so Arial only stands in for it. Read `activity_events` or `app_sessions` for this; `auth.sessions.user_agent` holds the server's agent, not the browser's.

**Why:** a guard that takes one measurement, in whichever face the measuring machine has, cannot see any other machine.

**How to apply:** when a press screenshot and the width test disagree, look for a face the fixture does not hold before calling it stale. To run the measure script when playwright's pinned Chromium is not installed, preload a module that passes `executablePath` to `chromium.launch` and leave the script unmodified. Re-measuring also corrects rows other sessions wrote, so its diff can touch labels you never edited.

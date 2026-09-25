---
name: blind-coordinate-clicks-fired-a-production-collection-run
description: "Driving a production-connected admin page with screenshot coordinates fired Run Collection twice on /admin/deductions, writing 28 real payroll candidates for an unfinished month."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: e82cba75-723e-4bcf-8f49-e265c1e2b4bb
  modified: 2026-08-02T21:13:55.930Z
---

On 2026-08-02 I created **28 real deduction candidates in production** (16 at 20:23 UTC, then
another 12 at 21:05 UTC after superseding the first batch) by clicking coordinates from a
screenshot on `/admin/deductions`. `.env.local` points at production, so a local dev server is
production. Nothing in the flow asked for confirmation.

**Why the mis-click is so easy here:** the month `<input type="month">` and the
**RUN COLLECTION FOR <MONTH>** button sit on the SAME row. Aim at the month field, land on the
button. It gets worse when the window has been resized or the page is still hydrating, because the
coordinates from the last screenshot no longer describe the layout you are clicking into.

**Why it mattered:** the run collects the CURRENT, unfinished month — every CRM candidate was dated
*that same day*. CRM is the **mandatory-unless-cleared** category, so those rows publish with **no
approval step**. 13 people were one Publish away from losing a day's pay for a day that had not
ended. See [[deductions-module-god-mode]] and [[deduction-rules-are-written-in-comments-implemented-half]].

**How to apply:**
- Never drive a production-connected admin page with `computer{left_click, coordinate}`. Use
  `javascript_tool` to find the element by its TEXT and click that — `[...document.querySelectorAll('main button')].find(b => b.textContent.trim() === 'CRM').click()` cannot hit "Run collection" by accident.
- Re-screenshot after ANY resize, navigation, or reload before trusting a coordinate. A stale
  coordinate is not a small error; it is a click on a different control.
- Before browser-verifying anything on a page that owns a write button, ask what the nearest
  destructive control is and how far it is from your target.
- The remedy that worked, and is reversible: `update deductions_candidates set superseded_at = now()`
  scoped by `created_by` + a tight `created_at` window. Never delete. Write matching `audit_logs`
  rows or the ledger shows an unexplained gap. Verify with `live = 0` and
  `rows_still_present = N`.
- `created_by` reads `dev.preview` for ANY dev-auth session, so it identifies the mechanism, not
  the person — do not use it to conclude "somebody else did it".

Related: [[local-env-already-points-at-production]],
[[headless-browser-never-fires-raf-react-suspense-reveal]], [[ai-tool-damage-prevention]].

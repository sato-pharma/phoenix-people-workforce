---
name: the-sidebar-width-fixture-measures-segoe-ui-not-aptos
description: "tests/fixtures/sidebar-label-widths.json holds Segoe UI widths, because headless Chromium on the laptop cannot see Aptos; a machine with no Segoe falls to Arial's metrics, which are wider, so a green width test does not mean the label fits there."
metadata:
  node_type: memory
  type: project
  originSessionId: 764f34bd-2388-45ff-ba16-f8a75f3f3516
  modified: 2026-11-03T15:04:06.269Z
---

Measured 3 Nov 2026 in headless Chromium 153 on the laptop, at the admin rail's 13px/600/-0.01em. **Aptos is not visible to it**: it sits in the per-user cloud font folder, and a `"Aptos",monospace` probe returns the monospace width. So the stack resolves to Segoe UI, and that is what the fixture holds. `getComputedStyle` proves nothing here: it returns the family LIST, not the face that drew the text, so [[portal-sidebar-label-width-budget]]'s "confirmed Aptos" reading does not stand.

"Double Visit Data Integrity" against the 157px budget: Segoe UI 154, Arial 159. On a copy of the real row at 272px it was cut in Arial and not in Segoe UI. That is why a runner press showed an ellipsis while `tests/sidebar-label-width.test.ts` stayed green. The runner's own font was not read; the expected fallback is Liberation Sans, which has Arial's metrics.

Still over 157 in Arial that day, all green in the test: Company Vacation Report 159, Direct Sales Reconciliation 164, Weekly Attendance Review 164. Tightest in Segoe UI: Weekly Attendance Review at 156.

**Why:** the guard takes one measurement, in whichever face the measuring machine has, so it cannot see any other machine.

**How to apply:** when a press screenshot and the width test disagree, measure the label in Arial before calling the fixture stale. To run the measure script when playwright's pinned Chromium is not installed, preload a module that passes `executablePath` to `chromium.launch` and leave the script unmodified. Re-measuring also corrects rows other sessions wrote, so its diff can touch labels you never edited.

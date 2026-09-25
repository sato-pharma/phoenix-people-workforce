---
name: a-minimized-window-makes-every-browser-test-lie
description: "A minimized/occluded Chrome window reports visibilityState hidden, which throttles setTimeout to ~1/s and stops requestAnimationFrame entirely - so drag tests, hydration reads and screenshots all return false failures. If no frame is ever forced the page component never hydrates and EVERY click is inert, which reads exactly like a feature you just broke."
metadata:
  type: reference
---

**Check `document.visibilityState` BEFORE believing any browser measurement.** When the Chrome
window is minimized or fully occluded it reads `hidden`, and Chrome then:

- throttles `setTimeout` to roughly **one call per second** (intensive throttling drops it to one
  per minute after ~5 minutes in background),
- stops `requestAnimationFrame` **completely** - measured **0 frames**, not slow frames,
- stops compositing, so `Page.captureScreenshot` **times out** (30s) and the Claude Browser pane
  reports "not displayed, so the page is not compositing frames".

On 2026-08-28 this produced four separate false diagnoses on `/admin/sidebar-layout` in one session:

- **"one mouse move costs 998ms"** - that was the 1-per-second timer throttle, not layout cost. With
  `setTimeout` replaced by a `MessageChannel` yield the same drag ran in **5 ms**.
- **"the drag freezes the browser permanently"** - nothing froze. `Runtime.evaluate` kept returning
  instantly the whole time, and the DOM was normal (3,314 elements, nothing oversized).
- **"it reproduces on production too, so it predates the branch"** - same artifact, same minimized
  window. Reproducing a bug on prod proves nothing if the window is hidden.
- **"the page never hydrates - the editor is inside `<div hidden>`"** - real reading, wrong cause:
  React's streaming splice and hydration had not completed *because no frame had been drawn*. Taking
  one screenshot forced a frame; immediately afterwards `editorInHidden` was `false` and clicks
  worked.

**dnd-kit cannot function at all in a hidden tab** - it measures droppables inside rAF, so `over` is
never computed and every drop is a no-op. **No drag-and-drop test is possible** in either surface
available here: the claude-in-chrome tab and the Claude Browser pane BOTH reported `hidden`.

**What still works when hidden, and is therefore safe to test with:** plain `.click()` on a button,
`MessageChannel` yields (React's own scheduler uses these, which is why React still commits), and
`Runtime.evaluate`. So **click-driven UI can be verified end to end; drag-driven UI cannot.** That is
a good reason to give any drag interaction a click-based equivalent - see
[[dev-auth-is-header-only-browser-pane-cannot-use-it]] for the other browser-surface limit here.

**AMENDED 2026-08-30 — "click-driven UI can be verified end to end" is only true AFTER a frame has
been forced, and that caveat is the whole rule.** The 2026-08-28 account above says clicks kept
working; re-read it and the reason sits in its own fourth bullet — *taking one screenshot forced a
frame*, and hydration completed at that moment. In a pane that stays hidden the entire time, no frame
is ever drawn, **the page's own client component never hydrates at all, and every click is inert.**
Measured 2026-08-30 on `/mailbox-offboarding` (Claude Browser pane; `browserOpen` true but the pane
reported "currently hidden", `visibilityState: "hidden"` throughout): 48 rows and 487 buttons present
in the DOM, `readyState: "complete"`, and **four** separate attempts produced no state change at all —
a plain `.click()`, a full `pointerdown/mousedown/pointerup/mouseup/click` gesture sequence, a
`location.reload(true)` hard reload, and a 12-second wait after load. All four read exactly like a
broken feature in freshly written code.

**THE DISCRIMINATOR — click a control you did NOT write, inside the SAME component.** This settles it
in one call and nothing else in this file does. The app shell's global search button opened its dialog
and moved focus into an `INPUT`, which looks like proof React is alive — it is not, because the shell
is a different client component that had already hydrated, and it says nothing about the page. The
page's own pre-existing status filter, a chip weeks older than the change, was **equally dead**: 48
rows before the click, 48 rows after. Same component, untouched code, no reaction — therefore the
pane, not the edit. Had that chip worked, the new code would have been the culprit.

**How to apply:** never conclude "the interaction I just wrote is broken" from a hidden pane. Force a
frame with one screenshot and retry; if the pane cannot be shown at all, find any control in the same
component that you did not touch and click that one first. If it is dead too, stop testing and report
what you can actually prove — DOM shape, CI, the file in the deployed tree — plus the plain statement
that the interaction is unverified and why. Do not rewrite working code, and do not claim the
interaction works either. On 2026-08-30 the owner confirmed the picker worked in production, against
a local session that had produced four consecutive dead clicks.

**Two smaller traps met on the way:**

- `javascript_tool` does **not await a returned promise** - an async IIFE returns `{}`. Kick the work
  off, stash the result in `localStorage`, and read it in a second call. Do **not** stash it on an
  attribute of `<html>`: React reconciles that element and the write silently reverts.
- The Chrome extension evaluates in an **isolated world**, so page expandos (`__reactFiber$…`,
  `__reactProps$…`) are invisible and every hydration probe built on them returns 0 regardless of
  truth. Judge hydration by BEHAVIOUR - click something and see if state changed.

**Why:** every one of these reads like a real product defect, and each one sent a session hunting
code that was fine. Two "fixes" were written and declared failures on the strength of a screenshot
timeout that meant nothing.

**How to apply:** first line of any browser probe is
`document.visibilityState` + a 4-frame rAF counter. If rAF reads 0, stop - take one screenshot to
force a frame, re-check, and only then measure. Never report a browser finding without stating the
visibility state it was taken under.

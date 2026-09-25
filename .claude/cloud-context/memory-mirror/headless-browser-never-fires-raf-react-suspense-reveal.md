---
name: headless-browser-never-fires-raf-react-suspense-reveal
description: "A non-compositing browser never fires requestAnimationFrame, so React 19.2 Suspense boundaries never reveal — a correct streamed page looks permanently stuck on the loading spinner."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: a35107f4-2f7c-4bdf-ad40-95392afe3200
  modified: 2026-08-02T19:47:27.004Z
---

The Claude Browser pane runs with `document.visibilityState: "hidden"` and **fires zero animation
frames** (measured: `rafCount` 0 after 1500ms). A backgrounded real-Chrome tab behaves the same.
The pane's screenshot tool says it outright: *"the Browser pane is not displayed, so the page is
not compositing frames."*

React 19.2 reveals a streamed Suspense boundary via **`requestAnimationFrame`**. From
`node_modules/react-dom/cjs/react-dom-server.node.production.js`:

```js
$RC=function(a,b){ ... $RB.push(a,b),
  2===$RB.length&&("number"!==typeof $RT
    ? requestAnimationFrame($RV.bind(null,$RB))
    : setTimeout($RV.bind(null,$RB), ...)) ... }
```

No frames ⇒ no reveal, forever. Signature: `<div id="S:0" hidden>` stays hidden, `<main>` measures
0px, the root `app/loading.tsx` fallback stays on screen, `$RB.length === 2`, `$RT === undefined`.

**Why:** on 2026-08-02 this made a *correct* fix (server-rendering the `/login` form) look broken,
and it was reverted on that false evidence. The DOM was healthy the entire time.

**How to apply:**
- `$RT === undefined` is **normal** for a `force-dynamic` route — the script that sets it
  (`requestAnimationFrame(function(){$RT=performance.now()})`) is itself inside a rAF.
- **`$RC` does not reveal anything** — it queues into `$RB` and only schedules when
  `2===$RB.length`. Calling it again makes the length 4 and schedules nothing. The real drain is
  **`$RV($RB)`** — call that to force a reveal in a non-compositing browser.
- Verify streamed/Suspense UI in **real displayed Chrome** (`mcp__claude-in-chrome__*`), or force a
  frame, or drain with `$RV($RB)` in the pane. Asserting `main.getBoundingClientRect().height > 0`
  in the pane will report a false failure.
- A static route (e.g. `/privacy`) rendering fine proves nothing — its boundary completes in-shell
  and never needs a reveal. Only routes that stream a pending boundary are affected.

**After the reveal, the accessibility tree is still dead.** `read_page` keeps returning
`(empty page)` / `Viewport: 0x0` even once `$RV($RB)` has made `<main>` measure 1517px, so `find`,
`form_input` and every `ref_N` are unusable, and `computer{action:"screenshot"}` still times out
("the Browser pane is not displayed"). Drive and measure the page with `javascript_tool` instead —
reading `innerText`/`getBoundingClientRect()` and calling `.click()` works perfectly. Measured DOM
numbers are better evidence than a screenshot anyway. For a **controlled** input, React needs the
native value setter plus **both** `input` and `change` events — dispatching only `input` let an
`<input type="month">` silently snap back to its old value (2026-08) while the click that followed
read the stale month.

**Authenticating the pane costs nothing if you pick the right route** (verified 2026-08-02):
`/api/dev-auth?role=Super%20Admin&next=/admin/deductions` is local-only, sets ONLY the
`phoenix-dev-preview` cookie, and revokes nothing. Its wrapper `/api/dev-auth/preview` is the
dangerous one — it calls `revokeAppSession(...)` and deletes the real session cookie, which is the
"cookie-based role switching logs the real user out" trap. The pane is a separate browser context
holding no production session, so the bare route is safe there.

Related: [[headless-preview-cannot-measure-data-driven-layout]], [[local-browser-verify-gotchas]],
[[prove-it-fails-verify-which-assertion-fired]].

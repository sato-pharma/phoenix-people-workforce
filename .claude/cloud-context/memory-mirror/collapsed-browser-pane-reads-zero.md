---
name: collapsed-browser-pane-reads-zero
description: "A collapsed/hidden Browser pane leaves a full reload stuck on the loading screen (the streamed reveal is rAF-gated) and every layout reading 0. Best fix: window.next.router.push(same path, new query) renders the REAL page with no rAF gate; fallback: remove the hidden ATTRIBUTE. It also freezes CSS animations (finish them before reading a rect), and a ref click at an emulated size bigger than the pane can miss - drive React checkboxes with element.click()."
metadata: 
  node_type: memory
  type: project
  originSessionId: ad7f6844-5aef-4d22-9a7e-51c9934c566e
  modified: 2026-09-30T19:31:17.708Z
---

With the Browser pane collapsed in the desktop app, `document.visibilityState` reads **`hidden`**,
rAF stops, and an admin page never leaves **"Loading workspace / Preparing the next Phoenix
Workforce view."** The server answers 200 and the content IS in the DOM — it just measures **0**.

`tabs_context` says "The Browser pane is currently hidden"; `tabs_select` does not help (it fronts a
tab WITHIN the pane). Only the app's own UI can open the pane.

**To measure anyway.** Next.js streams the page in as a `<div hidden>` under `<body>`, revealed by a
client transition that rAF never runs. Remove the **attribute**:

```js
const gate = [...document.body.children].find((el) => el.tagName === "DIV" && el.querySelector("<a selector in the real page>"));
gate.removeAttribute("hidden");           // NOT gate.style.display = "block"
void gate.offsetHeight;                    // force layout, then measure
gate.setAttribute("hidden", "");           // restore
```

Two traps that cost four attempts:
- **`style.display = "block"` does nothing** — `[hidden]` wins. The tell is a wrapper that reports
  `display: none` after you set it.
- **`.find()` on "first display:none div" grabs the wrong one.** There were 36 body children and
  several empty hidden divs; the real one was index 10, identifiable only by *containing the page*
  (`el.querySelector("table.phx-closing-grid")`), with 12,683 characters of text.

Say plainly in any report that the reading came from lifting that attribute — it is a real layout
measurement with the real stylesheet at the real emulated viewport, but it is not what a normal page
load does.

**Always carry a positive control**, because several readings here are silently bogus:
- `window.innerWidth` and `main.clientWidth` must match the size you emulated. A `vw: 0` /
  `mainClient: 24` reading appears right after `resize_window` preset `desktop` while the pane is
  hidden — the pane has no responsive size of its own, so set an EXPLICIT width instead.
- `main` can read clean while an inner container scrolls; measure the children's rects too.

**A hidden pane never advances a CSS animation either** (measured 2026-09-17). The employee portal's
`employee-portal-page-enter` sat at `currentTime 0`, holding the whole page at its first frame: a
0.994 scale at zoom 1, and about 0.795 instead of 0.8 under the display zoom. Every rect shrank
toward the centre, which hides a pixel or two of overflow, and placement arithmetic that reads the
zoom off a rect inherits the error. The tell is `rect.width / offsetWidth` missing the known zoom.
Run `for (const a of document.getAnimations()) a.finish()` before every measurement (and again after
opening or closing anything), wrapped in try/catch, since an infinite animation throws.

**Better than lifting `hidden`: navigate CLIENT-SIDE** (found 2026-09-30, Phoenix CRM plan board on
the preview box). A full reload in a hidden pane sticks on the route's `loading.tsx` ("Loading
employee portal page") although the server logged the page `200 in 1051ms` — the streamed reveal is
the rAF-gated part. `window.next.router.push("/same/path?v=2")` (the app router is exposed on
`window.next` in dev) renders the REAL page through a transition, with no rAF gate: the board came
up fully interactive, so ticks, saves and 375 px measurements were real rather than a lifted copy.
Change the query string or the router treats it as the page already shown. Two more habits:
- **Emulated sizes larger than the pane scale the page INSIDE the screenshot frame**, so a `ref`
  click can land on blank space; `form_input` then sets a checkbox's DOM `checked` without React
  ever hearing it. Drive React checkboxes with `element.click()` (reset `checked` first if a tool
  already flipped it), and use real typing for text.
- The mobile preset swaps the user agent, which is why it needs the reload that sticks — do the
  reload, then `router.push` once to get past it.

See [[never-horizontal-scroll-always-mobile-and-desktop-friendly]] and
[[monthly-closing-matrix-cannot-fit]].

**On production, where `window.next.router` is not there to use** (3 Nov 2026, Employee 360 on revision `abc39ee56`): `window.$RV(window.$RB)` runs React's own reveal for the queued streamed boundaries, in place, with no attribute lifting. Run it again after a few seconds for a boundary that streams late, then finish the animations and measure. A timed `fetch(location.href)` from the tab tells a slow server from a stuck reveal: here 4.2 s and the whole page, while the tab still said "Loading employee portal page".

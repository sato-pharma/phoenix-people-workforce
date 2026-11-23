---
name: his-screen-is-2390-css-px-wide-measure-there
description: "The owner's Chrome shows Phoenix at 2,390 CSS px wide (1920 screen at 80% zoom); a desktop layout must be measured at that width as well as 1440, and the live page can be measured read-only in his Chrome."
metadata:
  node_type: memory
  type: user
  originSessionId: fec79187-477a-4fee-951b-cd4da7bc020f
  modified: 2026-11-23T11:44:37.987Z
---

Read on 23 Nov 2026 in his own Chrome (Claude in Chrome, signed in to production): `innerWidth` 2,390 by 1,185,
`devicePixelRatio` 0.8, the window maximised on a 1920 by 1080 screen. The admin content column there is 1,760 px,
against 1,126 px on a 1440 page.

**Why:** a layout fix sized at 1440 can give a different result on his screen. The Place checks Filters line fitted
beside the last tabs at 1440 (82 px given back) but took a row of its own on his screen (39 px), because twelve
tabs fill his 1,760 px row to within 1 px.

**How to apply:** measure any desktop layout change at both widths and quote his screen's figure first. When this
laptop cannot hold a dev server (free memory fell to 1,553 MB compiling one page), open the live page in his
Chrome, set the fix's layout on clones of the page's own elements with `javascript_tool`, read before and after,
and press nothing. `resize_window` does not change a maximised window; narrow the board's container instead.
Related: [[never-horizontal-scroll-always-mobile-and-desktop-friendly]].

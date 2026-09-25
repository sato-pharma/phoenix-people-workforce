---
name: census-client-errors-by-stack-not-message
description: "Census client errors by their STACK, never their message — cross-origin masking blanks the Android and desktop messages and spares iOS WebKit's, so a problem on every platform reads as iOS-only and gets an iOS-only fix."
metadata:
  type: project
---

A client error thrown by a cross-origin script has its message emptied to `Script error.` (or an
extension's `~#!#~N~#!#~Script error.~#!#~`). **That masking is not evenly distributed across
platforms.** iOS WebKit hands back the real message — `null is not an object (evaluating
'z0[c].indexOf')` — while Chromium on Android and on desktop hands back the placeholder for the
same throw. So the readable rows are overwhelmingly iPhones, and **grouping by `message` makes any
cross-platform failure look like an iOS bug.**

Measured on production 2026-09-09, the 159 rows carrying a `maps.googleapis.com` frame over the
prior 60 days. **Every one also carried a `webgl.js` frame** — one root cause, Google's vector map
renderer:

| Platform | Rows | What the message said |
| --- | --- | --- |
| Android | 112 | masked, or `CompileError: call to WebAssembly.instantiate` |
| iOS | 39 | real code, `null is not an object (evaluating 'z0[c].indexOf')` |
| Windows | 8 | masked |

**Why:** this cost a wrong scope on a live fix. Only the iPhone samples were legible, so the map
failure was reported to the owner as an iOS problem and he approved "pin it to raster on iOS" — a
fix that would have left 112 of 159 rows in place while reading as done. The platform split was
only found because the census was re-run over the STACK. He was told, and chose all platforms.

**How to apply:** when counting client errors, group on a stack predicate (`stack like
'%webgl.js%'`, the frame host, the `/_next/` presence) and treat `message` as a display field only.
Never let a platform column earn a `case when user_agent ilike '%iphone%'` in the FIX — a
platform-predicated repair for a masked root cause is the failure mode itself. Related:
[[script-error-is-never-app-code-65pct-of-client-errors]] for the masking fingerprint, and
[[verify-the-emitted-artifact-never-the-source]] for the same distrust applied to output.

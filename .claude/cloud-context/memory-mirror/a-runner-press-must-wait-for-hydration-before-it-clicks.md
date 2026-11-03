---
name: a-runner-press-must-wait-for-hydration-before-it-clicks
description: "A real-browser press that clicks as soon as server-drawn text is visible can beat React's hydration, so the click sends nothing and a working feature reads as broken; wait for __reactProps on the control first."
metadata:
  node_type: memory
  type: reference
  originSessionId: 4b3a6477-f031-4f09-9f02-03501af86b55
  modified: 2026-11-03T11:48:58.125Z
---

On 3 Nov 2026 the first press of the Rep Exceptions page failed on the switch and the rep filter on desktop and phone, and the server log held no save request at all. The page was fine. The press clicked as soon as the server-drawn "Usual limit" text was visible, before the script attached. Waiting for a `__reactProps` key on the visible control made the same press pass all 23 steps, with the wait measuring 2.1 to 3.1 s.

**The tell:** a click with no request in the server log and no page error.

**Same run:** a role whose redirect fires from a page already streaming answers HTTP 200 and moves in the browser. Read the address after `waitForURL`, not straight after `load`. The CEO read as "not redirected" until that wait went in.

The job itself: [[a-real-browser-press-can-run-on-a-github-runner]]. This run's `press.mjs` was built from that note's copy.

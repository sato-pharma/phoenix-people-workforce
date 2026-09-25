---
name: territory-preview-link-must-never-show-the-line
description: "The public Territory Management preview link is pinned to Pedia server-side and must NEVER display or offer the line — owner rule, 2026-08-14"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: e400567f-2e00-4ccd-bf86-24bd61bcae42
  modified: 2026-08-14T21:50:36.819Z
---

The passwordless Territory Management preview link (`/share/territory/[token]`, live in prod
2026-08-15 via #2148) is pinned to **Pedia** on the row's `line_code`, and the owner's instruction
was: *"make by default the PD ... but do not show that this is PD aligned."*

So the public page has **no line filter and no line name anywhere** — not in the heading, not in a
badge, not in the JSON. The recipient only ever sees region → area → brick pins.

**Why:** an area's brick allocation only means something inside one line, so a link MUST pin one —
but the recipient is outside Phoenix and must not learn which line's territory he is looking at.
Hiding it in the UI would still ship it in the payload to an anonymous caller, so `line_code` is
absent from every type the domain returns, not merely unrendered.

**How to apply:** never add a line picker, line label, or `lineCode`/`lineName` field to the public
page, the public routes, or the exported types. `tests/territory-preview-link-controls.test.ts`
section 6 asserts the absence of "Pedia"/"CNS"/"Anti Infective"/`lineCode`/`lineName` in the types,
the page and the view — if that test goes red, the fix is to remove the disclosure, not to relax
the assertion. Related: [[owner-office-allocation-rule-value-share]],
[[railway-deploy-applies-no-migrations]].

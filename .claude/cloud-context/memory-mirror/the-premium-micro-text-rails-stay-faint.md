---
name: the-premium-micro-text-rails-stay-faint
description: "The Premium offer letter's micro-text frame is DELIBERATELY faint — owner ruling 2026-10-15, measured at 1.82-2.59:1 on white; never darken it, never \"fix\" it to clear 3:1."
metadata:
  node_type: memory
  type: feedback
  originSessionId: 69d45856-6378-4169-835a-2e7d99d4446c
  modified: 2026-10-15T19:01:00.747Z
---

The Premium offer letter (`offer_templates` row `6bd53cda-4abd-42e7-b733-8d47669d69c7`, variant
`premium`) prints "SATO PHARMA L.L.C. · HUMAN RESOURCES · HEAD OFFICE" repeatedly down both edges
and across the top of the sheet, plus a guilloche rope rule. Measured off the rendered page on
2026-10-15 (2x screenshot of the production render at `40f570ae0`): the rails are `#abc4d2` at
**1.82:1** on white and the rope `#5ea9d5` at **2.59:1** — the only type on any of the five live
letters below 3:1. Every other word on all five mastheads sits between 4.06:1 and 21:1.

The owner was shown those figures and ruled: **"leave the premium micro-text rails as they are."**

**Why:** it is a banknote-style security pattern, not text anyone is meant to read, and faintness is
the point. It is also his own design, and a design he hands over is final — defects are fixed, the
look is not changed ([[fix-means-fix-no-unrequested-work]]).

**How to apply:** never raise the contrast of `.micro`/the frame rails in the premium skin, never
report them as an accessibility defect, never put them in a `Next step:` line, and never let a
contrast sweep or a new ratchet pull them up. If a test is ever written over masthead contrast, it
must exempt the premium frame explicitly. Related: [[the-house-document-identity-standard]] and the
four frozen offer designs.

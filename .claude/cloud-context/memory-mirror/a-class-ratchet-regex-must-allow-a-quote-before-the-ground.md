---
name: a-class-ratchet-regex-must-allow-a-quote-before-the-ground
description: "A source ratchet matching `(?:^|[\\s`])border border-…` silently misses every class string that STARTS with the ground — the commonest flat shape — because position 0 is the opening quote, not the class; allow `[\"`] in the boundary and prove it with a break that turns a lifted template back into a plain string."
metadata:
  node_type: memory
  type: project
  originSessionId: c556d75c-2b85-462d-84be-feb9bbb9e05f
  modified: 2026-10-09T02:00:38.194Z
---

A test that ratchets a flat surface at zero by regexing class expressions needs the opening quote in
its boundary: `(?:^|[\s`"])border border-…`. With `(?:^|[\s`])` the anchor `^` lands on the `"` that
`classExpressions()` keeps, so a plain `"border border-slate-200 bg-slate-50 p-3"` never matches —
while the LIFTED form `` `border border-slate-200 … ${token}` `` does, because a backtick is in the
class. The ratchet then reads as healthy and measures only the surfaces that are already correct.

**Why:** caught on 2026-10-09 in `tests/recruitment-premium-depth.test.ts` (PR #5622) by the one
break-watch probe that turned a lifted template back into a plain string — 11/12 probes caught, that
one ESCAPED. The flat-vs-lifted counts agreed either way (87 lifted, 0 flat), so no count would have
exposed it; only the break did.

**How to apply:** when a ratchet regex has a boundary, include `"` and `` ` `` in it, and make one
break-watch probe revert a composed template to the plain literal it replaced — that probe is the
only thing that tests the boundary. See [[verify-the-emitted-artifact-never-the-source]].

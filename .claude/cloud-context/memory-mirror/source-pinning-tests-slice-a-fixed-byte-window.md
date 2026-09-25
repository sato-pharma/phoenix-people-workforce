---
name: source-pinning-tests-slice-a-fixed-byte-window
description: "86 test assertions pin source by slicing a FIXED byte count from a function — growing that function false-FAILS with a regression message that names a regression which never happened."
metadata: 
  node_type: memory
  type: project
  originSessionId: 4af20c72-b386-4e16-a92f-7a1d9d7f01fc
  modified: 2026-08-22T00:19:37.386Z
---

Many source-fingerprint tests extract "the function body" as
`source.slice(fnStart, fnStart + N)` — a magic byte count, not the real function end.
**86 such windows across 18 test files** (swept 2026-08-22 with
`git grep -E "\.slice\([A-Za-z0-9_]+, ?[A-Za-z0-9_]+ ?\+ ?[0-9]{2,}\)" -- tests`).

They fail in **both** directions:

- **False FAIL** — add a few lines to the pinned function and its marker slides past the
  window. The assertion then reports a regression that did not happen, in confident wording.
  Worse, the marker can be cut *mid-string*: in `tests/weekly-monthly-plans-v1.test.ts` the
  `rpcReplacePlanItems(` call sat at offset **2987** inside a 3000 window and still failed,
  because the 21-character marker ran to 3008. `acknowledgeEmployeePlan` is 2987 chars —
  it was **13 characters** from tripping the same cliff.
- **False PASS** — with no boundary, a function that genuinely lost its marker passes by
  spilling into the *next* function's copy of it. The window is silently the weaker check.

**Why:** the window measures source LENGTH, not the invariant the test claims to guard, so
its verdict drifts with unrelated formatting. Debugging costs a full CI cycle each time
because the message points at your change, not at the test.

**How to apply:** when a fingerprint test fails right after you added lines to the function
it pins, **measure the marker's offset before believing the message** — if it lands near the
window, that is the bug. Fix the extraction, do not shrink your change:

```ts
const rest = source.slice(fnStart + 1);
const nextFn = rest.search(/^export (?:async )?function /m);   // no \n — heredocs eat it
const fnEnd = nextFn >= 0 ? fnStart + 1 + nextFn : source.length;
const fnBody = source.slice(fnStart, fnEnd);
```

Fixed in `tests/weekly-monthly-plans-v1.test.ts` only (PR #2288, merged 2026-08-22).
**The other 85 windows are untouched and still armed** — `direct-orders-*` holds the most.
Prove any repair still has teeth per [[prove-it-fails-verify-which-assertion-fired]]:
break the marker and confirm *that* assertion, not a neighbour, is the one that fires.

Related: [[prove-it-fails-verify-which-assertion-fired]] ·
[[heredoc-eats-backslashes-and-makes-a-test-that-only-passes]] ·
[[local-validation-gates-are-gone-ci-is-the-gate]]

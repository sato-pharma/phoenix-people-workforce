---
name: a-source-assertion-is-satisfied-by-the-comment-explaining-the-call
description: "A test asserting source `includes(\"someCall()\")` is passed by the COMMENT that documents the call, so deleting the call stays green — assert against comment-stripped source, and assert the selector rather than the key."
metadata:
  node_type: memory
  type: project
  originSessionId: 49c63508-cfb2-4e16-af62-0961f3808359
  modified: 2026-10-03T20:17:10.600Z
---

A source assertion of the form `assert.ok(source.includes("someCall()"))` does not prove the call
happens. It proves the **string** appears — and in a well-commented module the comment explaining
the call contains that string. So the call can be deleted and the suite stays green. **The more
carefully the code is documented, the less its own source tests prove.**

**Measured 2026-10-03** in `tests/new-hire-mailbox-robot.test.ts`. `form.checkValidity()` in
`turbify-joiner.ts` was replaced with `return null` and the suite stayed **GREEN**, because the
comment above it (`🔴 checkValidity() DOES NOT SUBMIT and changes no value`) still held the string.
Two more of eight breaks failed for related reasons:

- **asserting a KEY is as weak as asserting a comment.** `driver.includes("controls:")` survived the
  control selector being gutted to `querySelectorAll("input")` — the object key stays while the
  reader reports an empty form. **Assert the selector, not the field name.**
- **`assert.equal` with no message cannot be tied to a break.** It fired on the right line but
  printed only "Expected values to be strictly equal", so the harness could not match it and scored
  it FAILED-WRONG-REASON. Every assertion a break is meant to trip needs its own message.

**The fix.** Keep two readings of the file and use them for different jobs:

```ts
const driver = readFileSync(path, "utf8");       // only for assertions about WORDING
const driverCode = stripComments(driver);        // every assertion that something RUNS
```

`tests/support/comment-strip.ts` already exists in this repo for exactly this. Six pre-existing
positive assertions in that one suite had the flaw; all six still passed after repointing, so the
calls were genuinely there — **but they were not being proved**, which is the state this leaves a
whole suite in silently.

🔴 **Negative assertions are safe either way.** `assert.equal(/banned/.test(source), false)` fails
loudly if a comment merely mentions the banned pattern — a false alarm, never a false pass. Only
positive ones need the stripped text. **But a false alarm still has a cost:** when the comment that
EXPLAINS a removal names the removed call, the guard cannot go green until the explanation is
deleted — which is how the explanation gets deleted. Strip for those too.

🔴 **THE SAME FAILURE WITHOUT A COMMENT: A VALUE READ TWICE.** Measured 2026-10-03 on
`src/components/new-hire-mailbox/*-card.tsx`. A guard that the hand-over sentence is still rendered
was written as `/result\.handover/` — and deleting the render stayed **GREEN**, because JSX reads
each value twice:

```jsx
{result.handover ? <p>{result.handover}</p> : null}
```

The bare-property pattern is satisfied by the **condition** while nothing is drawn. Matching the
braced child, `/\{(result|outcome)\.handover\}/`, is what distinguishes the render from its guard.
Generalises to any conditional render, and it is the same mistake as asserting an object key.

**So the family is: comment, object key, and conditional guard — three different things that hold
the string you are asserting while the behaviour is gone.** Ask what ELSE in the file contains this
text before trusting a positive source assertion.

Related: [[a-break-that-passes-may-be-rescued-not-correct]] is the same lesson one level up — a
break that goes green, or red for the wrong reason, is a broken test and not a working guard. Always
match the expected **message**, never just a red exit.

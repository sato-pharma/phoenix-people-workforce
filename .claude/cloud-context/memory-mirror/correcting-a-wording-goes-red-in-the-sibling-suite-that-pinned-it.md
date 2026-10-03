---
name: correcting-a-wording-goes-red-in-the-sibling-suite-that-pinned-it
description: "Correcting a refusal or message breaks whichever OTHER suite asserted the old string positively — a hand-picked set of suites is a guess at blast radius, so take it from the import graph with `git grep -ln <module> -- tests` and grep the retired wording across tests before pushing."
metadata:
  node_type: memory
  type: project
  originSessionId: 49c63508-cfb2-4e16-af62-0961f3808359
  modified: 2026-10-03T21:46:15.553Z
---

When you correct a refusal, an error message or any user-facing string, the change is not finished
when the suite you edited is green. **Some other suite asserts the old string positively**, and your
own new negative assertion cannot see it — a `assert.equal(/retired/.test(source), false)` in file A
says nothing about `assert.match(detail, /retired/)` in file B.

**Measured 2026-10-04, PR #5285.** Two refusals in `turbify-joiner.ts` /
`invite-inbox-runner.ts` were corrected, eight new assertions were added and proven by breaking each
one, and **four hand-picked suites ran green** — `new-hire-mailbox-robot`,
`new-hire-mailbox-invite-inbox-reader`, `new-hire-mailbox-adopt`, `turbify-click-delivery`. CI then
failed `validate` on **`tests/new-hire-mailbox-invite-inbox.test.ts:214`**:

```
AssertionError: The input did not match the regular expression /Phoenix cannot read the mailbox/
```

— a SIBLING suite demanding the exact claim the PR removed for being false. One wasted CI round
(~14 billable minutes on the PR), and the only reason it was one and not two is that the whole blast
radius was measured before the second push.

**Two cheap steps that would have caught it, in this order:**

```bash
git grep -n "<the retired wording>" -- tests src docs   # a POSITIVE assertion somewhere else
git grep -ln "<the module path>" -- tests               # every suite that imports it
```

Then run **all** of the second list, not a chosen few. A hand-picked set is a guess about blast
radius; the import graph is a measurement of it. Here that was 12 suites, and running them took
about as long as the one CI round it replaced.

🔴 **Note what did NOT help.** Breaking every new assertion and watching it fire proves the new
guards work — it says nothing about old guards elsewhere pinning the opposite, because a break
harness only ever runs the suites you pointed it at. `git grep` for the retired string is the step
that finds the contradiction, and it is the one to do FIRST, before the new assertions are even
written.

Related: [[a-source-assertion-is-satisfied-by-the-comment-explaining-the-call]] and
[[a-break-that-passes-may-be-rescued-not-correct]] are both about a guard that cannot fail; this one
is about a guard somewhere else that now fails correctly, for the old truth.

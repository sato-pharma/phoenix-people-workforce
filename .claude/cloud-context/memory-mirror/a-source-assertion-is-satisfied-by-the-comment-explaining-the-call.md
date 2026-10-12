---
name: a-source-assertion-is-satisfied-by-the-comment-explaining-the-call
description: "A test asserting source `includes(\"someCall()\")` is passed by the COMMENT that documents the call, so deleting the call stays green — assert against comment-stripped source, assert the selector rather than the key, and join `\" + \"` seams, because a phrase split across one hides from a negative assertion even after whitespace is collapsed; a QUOTED-ONLY positive check (`includes('\"' + name + '\"')`) is blind to the same name inside a backtick template, so measure whether a bare substring is safe and use that; a needle that is a SUFFIX of a longer identifier beside it (`product_manager_hr_id` ends in `manager_hr_id`, so `includes(\"manager_hr_id\")` and `[^)]*manager_hr_id` both stay true with that column deleted — boundary each side, left one optional); and SLICING a region is not a defence by itself — a window reaching a second call site of the same function passed while the first was deleted, so end the slice on a marker the behaviour must produce."
metadata:
  node_type: memory
  type: project
  originSessionId: 49c63508-cfb2-4e16-af62-0961f3808359
  modified: 2026-10-04T04:28:57.282Z
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

🔴 **AND THE MIRROR IMAGE: A CONCATENATION SEAM HIDES THE STRING FROM A *NEGATIVE* ASSERTION, SO
THE GUARD CANNOT FAIL AT ALL.** Measured 2026-10-04 while pinning two corrected refusals in
`turbify-joiner.ts` / `invite-inbox-runner.ts`. A refusal is assembled from fragments:

```ts
+ "Reading the mailbox is a separate question: an "
+ "app password survives a password change, so wherever Phoenix already holds one the "
```

so `/an app password survives a password change/` is **not** in the source text — the phrase
straddles a `" + "`. 🔴 **Collapsing whitespace does not fix it**, which is the trap: `/\s+/g → " "`
is the obvious normalisation and it leaves the `+ "` tokens standing, so the regex still misses and
a `assert.equal(/retired wording/.test(source), false)` passes against code that still says the
retired thing. Join the seams as well:

```ts
stripComments(readFileSync(path, "utf8")).replace(/\s+/g, " ").replace(/["`]\s*\+\s*["`]/g, "")
```

With that, 8 of 8 breaks fired on their own messages first time.

🔴 **A FIFTH SHAPE: THE QUOTES YOU WRAPPED THE NEEDLE IN NARROW IT TO ONE SYNTAX.** Measured
2026-10-04 pinning that a report's name is never written by hand in
`src/lib/phoenix-crm/server/reports-workbook.ts`. The guard was written as

```ts
assert.equal(names.includes(`"${title}"`), false, `"${title}" is still spelled out`)
```

and a break that put a heading back as `` title: `Grade against capacity · ${view.month.month}` ``
stayed **GREEN** — inside a template literal the name carries no double quotes at all, so the needle
could not match. The quoting looked like precision and was a blind spot: a name appears in this
repo's code as a double-quoted string, a single-quoted one, a bare template segment and a JSX text
node, and a pattern naming one of those excuses the other three. 🔴 **The fix is to drop the quotes
and match the BARE substring — but measure first that it appears nowhere legitimately**, because a
bare check over the wrong file is a false alarm: the same sweep found "What the field heard" living
legitimately in `reports-tab.tsx` while no title appeared at all in the workbook file the guard
reads. With the bare check the break fired on its own message.

**A sixth, and the one that is easiest to feel safe about: the REGION YOU SLICED contains another
call site of the same function.** 2026-10-04, the app-password capture. To prove a failed run writes
an audit row I sliced the route from `const driver = await createJoinerDriverFromEnv()` to the
success `return NextResponse.json({ result:` and asserted `/writeAuditLog\(/` inside it — but the
SUCCESS path's own `writeAuditLog` sits in that same window, so deleting the failure audit entirely
left the suite GREEN. Slicing is the standard defence against the other five shapes, which is
exactly why it reads as rigour; the slice is only as good as its END. Fixed by ending it at the
`throw error;` that the failure path must carry, which doubles as the rethrow assertion — its
absence fires there instead of silently widening the slice. 🔴 **So after slicing, ask the same
question of the region that you asked of the file: what else in HERE satisfies this?** And prefer an
end marker that the behaviour itself must produce.

🔴 **A SEVENTH, AND IT NEEDS NO COMMENT, NO SEAM AND NO SLICE: THE NEEDLE IS A SUFFIX OF A LONGER
IDENTIFIER STANDING RIGHT BESIDE IT.** Measured 2026-10-12 pinning that the off-plan board and the
decision path each load the companion columns in `src/lib/phoenix-crm/server/unplanned.ts`. The
three columns are `manager_hr_id`, `senior_hr_id` and `product_manager_hr_id` — and
**`"product_manager_hr_id"` ENDS IN `"manager_hr_id"`**, so

```ts
assert.ok(columns.includes(column), `the read must load ${column}`)
```

stayed GREEN with the manager's own column deleted from the select. The same hole sat in the
decision path's regex, `visit:phoenix_crm_visits!visit_id\([^)]*${column}`, where `[^)]*` walks
happily up to the product manager's column. Nothing was commented, nothing was concatenated, and
the needle was the exact column name — it is simply **not a token** unless you say so. One of three
assertions in a loop was vacuous and the other two were sound, which is why it reads as fine.

🔴 **And the obvious fix over-corrects: a boundary on the LEFT must be optional.** Demanding a
separator — `([^)]*(,|\s))` — made the assertion fail on CORRECT code, because the first column sits
immediately after the `(` that the pattern has already consumed. `(^|[^a-z_])` for a bare list, and
`\(([^)]*(,|\s))?` after an opening paren, is what fired on the break and passed on the fix. **A
column name is matched with a boundary on each side, and the left one is optional** — and whenever
a group of columns shares a suffix (`*_hr_id` here, and `*_decided_at`, `*_decided_by_hr_id` in the
same select), ask the file which of them contains which.

**So the family is: comment, object key, conditional guard — three things that hold the string while
the behaviour is gone — plus the concatenation seam, which hides the string while the behaviour is
still there, plus the quoting that narrows the needle to one of four syntaxes, plus a slice whose
window reaches a second call site, plus a needle that is a SUFFIX of a longer identifier in the
same file.** Ask what ELSE in the file contains this text, and whether the text is even contiguous,
before trusting any source assertion in either direction.

Related: [[a-break-that-passes-may-be-rescued-not-correct]] is the same lesson one level up — a
break that goes green, or red for the wrong reason, is a broken test and not a working guard. Always
match the expected **message**, never just a red exit.

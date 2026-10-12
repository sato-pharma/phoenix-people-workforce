---
name: a-new-source-pinning-test-must-use-the-shared-comment-lexer
description: "A new test that strips comments LINE-WISE is now REFUSED AT THE WRITE by `.claude/hooks/comment-strip-guard.mjs`, which names the one-line `stripComments` import (owner, 2026-10-12: \"fix the comment-strip ratchet so new test files use the shared stripper\") — the CI ratchet it fronts for is unchanged and still zero-tolerance, but it was the LAST assertion of a 977-test shard (5m34s on PR 5700) and four of the 25 red PR runs of 12 Oct were it; both read ONE detector, `.claude/hooks/lib/comment-strip-shapes.mjs`."
metadata:
  node_type: memory
  type: project
  originSessionId: 0b500f74-7bb4-401e-ad34-263d5c59974a
  modified: 2026-10-12T16:09:13.326Z
---

**🔴 THE SHAPE NO LONGER REACHES CI — read this first.** Since 2026-10-12,
`.claude/hooks/comment-strip-guard.mjs` (PreToolUse, Write/Edit/MultiEdit) refuses the text a call
would INTRODUCE into any `.ts` file under `tests/` when it strips comments line by line, and the
refusal carries the remedy. The owner asked for it in those words after being shown that four of the
twenty-five red PR runs of that day were this one gate. What it does NOT do: run a test, wait for a
box, or stand in front of a push — his 2026-10-04 *"keep the pre-push test as a rule, no guard"* is
about the test SUITE and is untouched ([[the-pre-push-remote-check-test-is-a-rule-never-a-guard]]).

- It reads only the NEW text, so an edit that removes a hand-rolled strip always passes — a guard
  that blocked its own remedy would have to be turned off to be obeyed.
- Scope is exactly the CI sweep's: `tests/**/*.ts` at any depth, minus the three sanctioned files
  (the stripper, the ratchet, and the guard's own test, whose fixtures ARE the shapes). `.tsx` is out
  because the sweep reads `.ts` only.
- **ONE detector:** `.claude/hooks/lib/comment-strip-shapes.mjs`. The ratchet imports it and defines
  none of its own, and `tests/comment-strip-guard.test.ts` fails if either side grows a copy back. A
  fourth file that must spell the shape out joins `SANCTIONED_TEST_FILES` there, never a list in the
  hook. Stand-down: `PHX_COMMENT_STRIP_OFF=1`. Account: `docs/hook-dispatcher.md`,
  "comment-strip-guard".

`tests/comment-strip-ratchet.test.ts` (headline: *no source-pinning test strips comments unsafely — a
regex that eats the code it pins, or a line filter blind to a comment block*) scans every test for a
line-by-line comment decision — a `.filter`, an `if (…) continue`, or a whole-line `.replace` — and
fails the required `validate` job naming the file and each site. On 2026-10-09 it caught
`tests/crm-integrity-signboard-cases.test.ts` at lines 149 and 235 on PR 5700 (`checks` was already
green; `validate` burned 5m34s first, and the assertion prints at the very END of shard 2 after 977
tests, so the run looks healthy until the last second).

**Why the ban is right, not pedantry:** a line judged by how it STARTS cannot know a block comment is
already open, so the body of a multi-line `{/* … */}` is scanned as code — and a "must not appear"
guard then passes or fails for the wrong reason. The replacement is one import:

    import { stripComments } from "./support/comment-strip.ts";
    const code = stripComments(source);

That module is a lexer, written after the naive `/\/\*[\s\S]*?\*\//g` was measured deleting 36-62% of
`system-navigation.ts`, `access-registry.ts` and `permissions.ts` — the very registries a pin gets
written against.

**The trap that makes this cost a CI round:** a source-pinning test needs comment stripping precisely
BECAUSE its own prose quotes the thing it forbids (here, the comment above `SFE_SOURCES` explaining
why `.eq("source", "photo")` went). The line filter is the obvious hand-rolled answer, it works on
the file in front of you, and only the ratchet knows better. See
[[never-hand-roll-a-rule-the-repo-already-implements]].

After swapping it, re-break each lexer-dependent assertion: both of mine still fired, which is the
only proof the swap kept the pin.

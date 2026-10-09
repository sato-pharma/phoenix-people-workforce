---
name: a-new-source-pinning-test-must-use-the-shared-comment-lexer
description: "A new source-pinning test that strips comments LINE-WISE (`.split(\"\n\").filter(line => !/^\s*(\/\/|\*)/)`) is refused by `tests/comment-strip-ratchet.test.ts` inside the required `validate` job — it named the file and both line numbers and went red after 5m34s; call `stripComments` from `tests/support/comment-strip.ts` instead, and the ratchet is the LAST thing in a 977-test shard, so nothing earlier warns you."
metadata:
  node_type: memory
  type: project
---

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

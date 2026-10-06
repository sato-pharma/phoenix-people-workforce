---
name: a-backtick-in-a-regex-literal-blinds-a-comment-only-guard
description: "A backtick inside a regex literal makes tests/support/comment-strip.ts read a template literal that never closes, so every comment BELOW it survives the strip and is handed to comment-only guards as code — 20 lines in one file, and tests/neutral-wording.test.ts named three of that file's own comments as offenders. Build the pattern with new RegExp over a double-quoted string, and pin it with a leak test."
metadata:
  node_type: memory
  type: project
  originSessionId: d41fb198-3176-4e92-bc56-71bb4d5b4227
  modified: 2026-10-06T10:51:03.072Z
---

`tests/support/comment-strip.ts` is a lexer and its header states that regex literals are
deliberately NOT tracked: telling `/` division from `/` regex needs the preceding token. Its scan
therefore treats a backtick in code position as opening a template literal, and its template state —
unlike its string states — does not recover at a newline. One stray backtick blinds the rest of the
file.

Measured 2026-10-06 on `src/lib/ceo-email/assist.ts`, whose fence-stripping regex matched a
three-backtick code fence off a model's reply: **20 comment lines survived the strip**, and
`tests/neutral-wording.test.ts` — which judges non-comment lines only, because the owner settled on
2026-10-05 that code comments are left alone — reported three of that file's own comments as
offenders. The failure points a session at prose that is explicitly out of scope.

**Why:** the guard cannot tell a leak from a real offender, and the stripper is working as
documented. Nothing is red in the stripper itself.

**How to apply:** write such a pattern as `new RegExp` over a double-quoted string, where the
backtick is lexed as ordinary string content. Then pin it in that module's own test with two
assertions: the string-built spelling is present, and every comment line strips to blank. Both fire
on the regex-literal spelling, which is the tidier-looking one a later session restores. Repairing
it has its own trap: see [[the-edit-tool-resolves-a-unicode-escape-into-the-character]]. Filed in
`docs/agents-session-traps-clusters.md` under Validation.

---
name: the-edit-tool-resolves-a-unicode-escape-into-the-character
description: A unicode escape typed into an Edit or Write string arrives in the FILE as the character itself, so a repair meant to REMOVE a character writes that very character while the diff you intended looks right — measured twice in one turn on a backtick (U+0060), in code and then in a doc. Read the region back from disk whenever the point of the edit is which bytes the file ends up holding.
metadata:
  node_type: memory
  type: feedback
  originSessionId: d41fb198-3176-4e92-bc56-71bb4d5b4227
  modified: 2026-10-06T10:50:38.951Z
---

A `\uXXXX` escape in the text handed to Edit or Write is resolved before it reaches the file: the
file receives the CHARACTER, not the six-character escape. Writing a doubled backslash instead
lands two literal characters, which inside a regex matches a backslash — also wrong.

Measured 2026-10-06 on `src/lib/ceo-email/assist.ts`: a regex matching a three-backtick code fence
had to stop containing a literal backtick (see [[a-backtick-in-a-regex-literal-blinds-a-comment-only-guard]]).
The repair was written as the unicode escape for U+0060, twice, and both times the file on disk came
back holding real backticks — including in the comment explaining why there must not be one. The
same thing happened again in a markdown doc, where the resolved backticks broke two inline code
spans and left the line with an odd number of them.

**Why:** the escape is interpreted by the tool's own string handling, not passed through. Nothing
reports it, and a re-read of the edit as you wrote it agrees with you.

**How to apply:** when the WHOLE POINT of an edit is which bytes a file ends up holding — an escape,
a delimiter, a quote, a zero-width or bidi character, a line ending — read the region back from disk
with `sed -n` or `cat -A` before believing it, and prefer a spelling that needs no escape at all. For
a backtick inside a pattern, build it with `new RegExp` over a double-quoted string; in prose,
describe the character by name instead of writing it.

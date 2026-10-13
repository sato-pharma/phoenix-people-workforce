---
name: a-long-bash-heredoc-is-truncated-and-bash-blames-eof
description: "a bash heredoc past roughly 90 lines arrives truncated and bash reports `unexpected EOF` — long file content goes through Write, never `cat <<'EOF'`"
metadata:
  node_type: memory
  type: feedback
  originSessionId: 80bbcbc4-703f-4b1f-9bdd-6a91483ffac6
  modified: 2026-10-13T01:43:38.322Z
---

A `cat <<'EOF' > file` whose body runs past roughly 90 lines does not reach bash whole: the tail is
cut, so the closing `EOF` never arrives and bash reports `syntax error: unexpected end of file` —
which reads like a quoting mistake in the content and sends the session hunting through the body for
a stray quote or backtick. It bit twice in one session (13 Oct 2026) while writing a PR body and a
docs section.

**Why:** the failure names the wrong cause. Nothing in the content is wrong, and shortening the body
"to find the bad line" appears to fix it, which teaches the wrong lesson for next time.

**How to apply:** write any multi-line file content with the **Write** tool, or build it in a small
`.mjs` script in the scratchpad that holds the text in a template literal and calls
`fs.writeFileSync`. Keep heredocs for a handful of lines — a commit message, a short SQL statement.
Related: [[heredoc-eats-backslashes-and-makes-a-test-that-only-passes]],
[[a-heredoc-collapses-a-double-backslash-in-a-regex-class]],
[[a-python-heredoc-writes-real-control-chars-into-regex-literals]].

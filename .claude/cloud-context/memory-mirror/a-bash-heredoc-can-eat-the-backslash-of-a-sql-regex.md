---
name: a-bash-heredoc-can-eat-the-backslash-of-a-sql-regex
description: "A SQL regex written through the Bash tool into a JS template reached Postgres as s+ instead of \\s+, and the count fell from 759 to 164 with no error."
metadata:
  node_type: memory
  type: feedback
  originSessionId: 0b2851ca-8456-43cd-8140-cf3c46b2dd82
  modified: 2026-11-01T09:35:13.316Z
---

On 2026-11-01 a scratch script's `'\s+'`, inside a JS template literal, was sent to Postgres as `'s+'` (JS cooks `\s` to `s`), and writing `\\s+` through a Bash heredoc still landed in the file as `\s+`. The query ran clean and returned 164 same-name pairs instead of 759. Production's own `\s` was fine: sent through `String.raw`, it matched.

**Why:** nothing errors. `s+` is a valid pattern, so the wrong number looks like a finding, and a wrong number was nearly shown to the owner. See [[same-name-on-a-seat-does-not-prove-the-same-doctor]].

**How to apply:** in a scratch SQL script use `[[:space:]]+`, which has no backslash, or write the file with the Write tool and use `String.raw`. When a re-count disagrees with an earlier one, explain the difference before quoting either. Never blame the database or the connection until a direct test of the literal says so.

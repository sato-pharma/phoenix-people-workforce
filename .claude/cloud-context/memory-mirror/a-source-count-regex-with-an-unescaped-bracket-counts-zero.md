---
name: a-source-count-regex-with-an-unescaped-bracket-counts-zero
description: "A source-pinning test that counts a call with a regex like /.eq(\"owner_hr_id\", ownerHrId)/g treats the brackets as a GROUP and counts 0 for ever — count literal call text with split(text).length - 1, and break each fix separately when one check function holds several assertions, because its first failure hides the rest."
metadata:
  node_type: memory
  type: feedback
  originSessionId: 66a89f4f-2303-4993-98ac-46a08f51bbff
  modified: 2026-10-16T21:47:18.965Z
---

On 2026-10-17 (PR 6021, the Visit report's saved views) `tests/phoenix-crm-visit-report.test.ts` asserted
`(service.match(/.eq("owner_hr_id", ownerHrId)/g) ?? []).length === 3`. The `(` is unescaped, so the regex
is `.eq` followed by a capture group — it needs the text WITHOUT brackets and matched nothing: `0 !== 3`
against a service that held exactly three such calls. Two earlier box runs never reached it, because the
shard stopped at an unrelated failure first ([[a-shard-aborts-at-its-first-failure-so-the-second-cause-is-invisible]]).

**Why:** a regex literal that pins a CALL reads like the call, so the missing backslash is invisible in
review, and the failure looks like the code is wrong rather than the test.

**How to apply:**
- Count literal call text with `source.split('.eq("x", y)').length - 1`; reach for a regex only when the
  pattern is genuinely variable, and then escape every `(` `)` `.` `[`.
- A test that gathers failures per check FUNCTION (`Visit report failures:` lists one line per check)
  still reports only that function's FIRST failure. Two breaks inside one check — the position filter and
  the dashboard recount, both in `checkFilters` — show as one; break the second alone and watch its own
  assertion fire before calling it pinned.

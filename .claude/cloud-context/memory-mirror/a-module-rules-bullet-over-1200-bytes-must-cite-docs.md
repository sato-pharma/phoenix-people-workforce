---
name: a-module-rules-bullet-over-1200-bytes-must-cite-docs
description: "`tests/agents-long-hooks-cite-docs.test.ts` gates `.claude/rules/*.md` bullets too, not just AGENTS.md — one over 1,200 bytes that names no `docs/*.md` file reddens `validate`, and the fix is to relocate the account into a docs file FIRST, then trim the bullet to a cue plus the pointer."
metadata:
  node_type: memory
  type: project
  originSessionId: 5566e73c-38c0-4e93-b3c8-7857c2ef20ff
  modified: 2026-10-09T21:06:38.709Z
---

The check reads the `## Rules` block of **every** `.claude/rules/<module>.md` (between the
`module-memory:rules:begin` / `:end` markers) alongside AGENTS.md §2 and §4, and refuses any
top-level `- ` bullet over **1,200 bytes** that contains no `docs/<name>.md` pointer. It runs in the
required `validate` job.

**Why it exists:** a long rule is carrying its own evidence, and module memory is re-sent on every
request. The remedy it names is always safe — move the account out, keep the hook — because the
cheapest route to green under a size gate is deleting a rule, which AGENTS.md §2.2 forbids.

**It cost a red `validate` on PR 5716** (2026-10-09): a new `phoenix-crm` bullet at 1,641 bytes with
the whole account inline. Fixed by writing `docs/phoenix-crm-test-rows.md` and trimming the bullet to
892 bytes with the pointer on the end.

**Two things to know before writing a long bullet:**

- 🔴 **RELOCATE FIRST, TRIM SECOND.** The obvious order destroys evidence that exists nowhere else —
  #3451 found nine such rules, two of them naming the only record of production recovery tables.
- The second assertion is a ratchet: fewer than a tenth of all hooks may exceed the threshold. On
  2026-10-10 that read **48 of 501, with 50 the ceiling** — two bullets of headroom in the whole
  repository, so a long one now pushes some other module's over the line.

Running it alone, without the suite:

```bash
node --experimental-strip-types --experimental-specifier-resolution=node \
  --experimental-loader ./tests/alias-loader.mjs --input-type=module \
  -e "const m=await import('./tests/agents-long-hooks-cite-docs.test.ts'); m.runAgentsLongHooksCiteDocsTests();"
```

It reads from the current directory, so run it at the worktree root. Related:
[[a-sharded-test-jobs-log-tail-is-the-other-shard]].

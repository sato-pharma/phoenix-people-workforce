---
name: rollup-superseded-is-file-overlap-not-content
description: "rollup-prs.mjs calls a PR SUPERSEDED when another PR touches the same FILES and changes more — it never reads whether that PR contains the lines that matter, so merging the \"superseding\" one can leave the gap wide open"
metadata:
  node_type: memory
  type: project
  originSessionId: dd8bfcde-b7de-4cc2-9390-5e9a641ada7d
  modified: 2026-10-23T07:57:21.337Z
---

`node scripts/rollup-prs.mjs` judges supersession by **path overlap plus size**, not by content.
Measured 2026-10-23: it marked both #6319 and #6321 (each adding two `ACKNOWLEDGED_EXCEPTIONS`
entries to `scripts/lib/migration-inventory.ts`) as `SUPERSEDED  every file it touches is in #6320,
which changes more` — while #6320 contained **neither** filename. It only edited the same file for an
unrelated CRM cache. Merging #6320 and closing the other two on that line would have left the
production drift gap open and the nightly sweep red.

**Why:** the tool exists to stop the owner triaging many PRs, so it compares file sets, which is cheap
and content-blind. A file that several PRs append to — `migration-inventory.ts`, `ACKNOWLEDGED_EXCEPTIONS`,
any shared tail — makes every appender look like a subset of the largest one.

**How to apply:** before acting on a `SUPERSEDED` line, grep the superseding branch for the thing the
superseded PR actually adds (`git fetch origin <branch>` then `git show FETCH_HEAD:<file> | grep <token>`).
Only close a PR as superseded once that grep finds its content. Related: [[acknowledged-exceptions-tail-conflicts-on-every-parallel-append]].

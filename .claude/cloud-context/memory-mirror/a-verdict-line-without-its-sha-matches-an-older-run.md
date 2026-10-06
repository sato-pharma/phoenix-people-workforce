---
name: a-verdict-line-without-its-sha-matches-an-older-run
description: grepping an append-only check log for `^remote-check: (PASS|FAIL)` without anchoring the SHA reads a PREVIOUS run's verdict as this one's — a watcher bailed with "BOX SAID FAIL — not pushing" on a verdict about a commit that had already been fixed, while the real run was still going; anchor every verdict match to `— <sha>` and take the newest match, never `tail -1` of the bare pattern.
metadata:
  type: project
---

A chain armed to push on the box's verdict wrote the PREVIOUS run's summary into the same output
file as a header (`--- dogfood verdict --- / remote-check: FAIL — 8658ca19f`), then waited on
`grep -E "^remote-check: (PASS|FAIL)"`. It matched the header instantly and refused to push — about
a sha whose one error had already been fixed and committed, while the run it was actually waiting
for had not reached its typecheck yet.

**Why:** a verdict line is only a statement about the sha it names, and a check log is append-only,
so any file that has held more than one run holds more than one verdict. `tail -1` does not save
you: if the newest run ends in a REFUSAL it prints no verdict at all, and `tail -1` then returns the
older one — the same false reading, now shaped like a fresh answer.

**How to apply:** build the pattern around the sha you are deciding about —
`grep -hE "^remote-check: (PASS|FAIL) — $SHA\$"` where `$SHA` is `git rev-parse --short HEAD` read
in the same script — and treat "no line for this sha" as a third outcome (ask the box again), never
as a fail. Same rule for `gh run list`, `verify-shipped` loops and anything else whose output
accumulates. Related: [[a-padded-short-sha-422s-and-a-fallthrough-watcher-calls-it-green]].

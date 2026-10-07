---
name: a-skipped-ci-step-is-0001-01-01-not-null
description: "GitHub reports a skipped job or step with `startedAt: \"0001-01-01T00:00:00Z\"`, not null — subtracting it yields ~63 billion seconds, so max-by-duration names the step that NEVER RAN as the one that dominated the job."
metadata:
  node_type: memory
  type: project
  originSessionId: a77de15c-0ebe-49a8-bdd3-4bb32a1960ae
  modified: 2026-10-07T22:24:13.604Z
---

**`gh run view --json jobs` spells a skipped job or step `"0001-01-01T00:00:00Z"`, never `null`.**
Subtract that sentinel from a real `completedAt` and you get about 63 billion seconds, so any
`max_by(.secs)` over the steps reports **the step that did not run** as the step that dominated the
job.

Measured 2026-10-08: a first cut of `scripts/slow-audit.mjs` reported `main`'s `validate` job as
**719s of "Test"** on a run that had actually run `Build` for 246s and skipped `Test` entirely —
because on a **push** event the Test step lives in `checks`, while on a **pull_request** it lives in
`validate` (`ci.yml` gates both on `github.event_name`). The figure would have sent someone to
optimise a step that does not run on that event.

**The guard is needed TWICE** — on jobs as well as on steps, because a wholly skipped job
(`full-e2e`, `mobile` on a PR) carries the sentinel at job level too. A plain `fromdate` on it also
throws outright: `strptime("%Y-%m-%dT%H:%M:%S%z") cannot be applied to: string
("0001-01-01T00:00:00Z")`, which is how the shape first shows itself.

This is the fail-open family in the Validation cluster — **an ABSENT answer arriving in the shape of
a very large one**, the sibling of `a-field-that-does-not-exist-is-a-silently-dead-branch` and of
the `| tail` exit-code trap. **Do the arithmetic in Node, not in a `gh --jq` expression**, so a
fixture can reach it: `summarizeRun()` in `scripts/slow-audit.mjs` filters on
`conclusion == "success"` and rejects a timestamp starting `0001`, and `tests/slow-audit.test.ts`
feeds it that exact payload.

**And keep the two CI figures apart while you are in there:** the *critical path* is the slowest job
(the wait, since jobs run in parallel); the *billed* figure is the sum with every job rounded **up**
to a whole minute. On a three-job run the bill always exceeds the wait, and reporting one as the
other is how a wait gets blamed on a bill.

Related: [[disk-idle-is-not-evidence-against-paging]] ·
[[a-field-that-does-not-exist-is-a-silently-dead-branch]] ·
[[mains-required-checks-are-four-not-six-checks-carries-the-suite]]

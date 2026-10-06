---
name: a-padded-short-sha-422s-and-a-fallthrough-watcher-calls-it-green
description: "A full sha invented by padding a short one 422s on every GitHub API call and fails `merge-base --is-ancestor` for ever — and a watcher that waits on a deny-list reads that error as \"settled\", so the deploy gate reports clean on evidence that does not exist."
metadata:
  node_type: memory
  type: feedback
  originSessionId: 9b1f32ba-c588-4171-a196-696433a69083
  modified: 2026-10-06T09:51:20.590Z
---

`gh pr merge` and `gh pr view` print a **9-character** sha. Writing a 40-character one from it by
padding — `bdbe09ed5` → `bdbe09ed5bb4ca2ad0ee26a1b1ba79dc1b4a4f17` — produces a sha that exists
nowhere, and it fails in two directions at once, both of them quietly:

- `gh api .../commits/<sha>/check-suites` answers **422 `No commit found for SHA`**. With `--jq` the
  error body still lands on stdout, so the variable is a non-empty JSON string, not empty.
- `git merge-base --is-ancestor <sha> <rev>` exits non-zero for ever, so the "has it shipped?" test
  can never become true no matter what production serves. Every `does not contain the merge yet`
  line it prints is uninformative, not evidence.

**The compounding error is the watcher's shape, and it is the one that produced a false report.**
A loop that `continue`s on a DENY-list of unfinished states (`*queued*|*in_progress*|""`) matches
none of them against `{"message":"No commit found...","status":"422"}`, falls out of the loop, and
executes the success line — printing `all non-third-party suites settled` for a commit the API
cannot even see. That was relayed to the owner as *"main's check suites all settled clean, so the
deploy is not withheld"*, which nothing had established. The real state at that moment was
`github-actions: in_progress`.

**Why:** this is the engineering rule *a CI watcher allow-lists `SUCCESS` and never deny-lists the
unfinished states* (`.claude/rules/engineering.md`, Validation) meeting a second failure it was not
written for — the deny-list was built to catch `queued` and `in_progress`, and an **error response**
is neither. Silence and an error look identical to a deny-list; only an allow-list can tell them
apart. Same family as [[a-selftest-probed-with-the-wrong-flag-reads-as-no-selftest]], where an
absent mode and a mis-invoked one also produce identical evidence.

**How to apply:** resolve the full sha with `git rev-parse <short>` — never type or pad one — and
assert it locally before a watcher uses it (`git cat-file -e <sha>^{commit}`). Build the wait on an
allow-list: advance only on an explicit `completed/success` for the `github-actions` suite with no
`queued`/`in_progress` remaining, treat an unreadable or error answer as *keep waiting*, and keep
the four permanently-`queued` third-party suites (`sentry`, `claude`, `vercel`, `railway-app`) out
of the decision. The same shape bites `gh api` anywhere a sha is interpolated, including
`actions/runs?head_sha=`, which answers `total_count: 0` for a short sha and reads exactly like a
missing run.

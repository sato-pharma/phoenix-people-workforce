---
name: relay-carries-work-and-limits-between-accounts
description: "What the account relay in ~/.claude/relay does, how it is wired, and the honest limits of its token numbers — built 2026-08-13 so the owner's second Max account picks up mid-session work."
metadata: 
  node_type: memory
  type: project
  originSessionId: 9680c8dc-ecf5-4c20-a573-acb18754d37e
  modified: 2026-08-13T15:29:11.597Z
---

Built 2026-08-13. Files: `~/.claude/hooks/relay-lib.mjs` (shared), `relay-capture.mjs` (Stop hook),
`relay-inject.mjs` (SessionStart hook), `relay-cli.mjs` (the `/relay` skill's engine). Data in
`~/.claude/relay/` — `accounts.json`, `usage/<uuid>.ndjson`, `batons/<project-slug>.{json,md}`,
`state/<session>.json`. Both hooks are registered in `~/.claude/settings.json` alongside the
existing `memory-guard.mjs` and `next-step-capture.mjs`.

**What it does.** After every reply, a "baton" for the folder is rewritten — account, branch, HEAD,
working-tree counts, his last request verbatim, where the reply stopped, open tasks, next step,
`--resume` id. At SessionStart the next session is handed that baton, loudly when the account
changed. The statusline gains `acct <label> | 5h <spend> | resets <time> | alt <other account>`,
red when the account is hot or limited.

**Why it captures continuously instead of on request:** the moment it is most needed is the moment
the account dies at its limit, and at that moment he cannot ask for anything.

**Traps to respect if this is ever changed:**

- **Token totals are a relative gauge, not an allowance.** Percentages exist only after he runs
  `/relay limit` at a real wall; before that there is no honest number and the code says so. See
  [[switching-max-accounts-never-loses-the-transcript]].
- **The last request is captured from the INCREMENTAL slice, not a tail.** This session's
  transcript passed 512 KB within an hour, which pushed the opening request outside any affordable
  tail — it is read from the new bytes on the turn it was typed, then persisted in the state file.
- **`relay-capture` parses the next step itself** rather than reading `next-step-capture.mjs`'s
  output: both are Stop hooks in the same array and may run in parallel, so reading it would race
  and hand over the previous turn's recommendation.
- **git runs with `--no-optional-locks`** because a parallel session is often mid-push in the same
  checkout and a status refresh must never contend for `.git/index.lock`.
- Usage counting **includes subagent transcripts** (`<session>/subagents/**.jsonl`) — those tokens
  bill against the same limit — and dedupes by `message.id`, because a streamed message is written
  more than once.
- `RELAY_DEBUG=1` turns the Stop hook's swallowed errors back on. It is silent by default because a
  Stop hook that prints on failure is noise after every single reply.

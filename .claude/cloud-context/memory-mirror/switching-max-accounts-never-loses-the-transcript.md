---
name: switching-max-accounts-never-loses-the-transcript
description: "Transcripts are keyed by project folder, not by account, so `claude --resume` works across a /login switch between the owner's two Max accounts; the relay in ~/.claude/relay carries the working state and limit windows that resume does not."
metadata: 
  node_type: memory
  type: project
  originSessionId: 9680c8dc-ecf5-4c20-a573-acb18754d37e
  modified: 2026-08-13T15:28:54.117Z
---

The owner runs **two Claude Code Max accounts** and switches when one hits its limit. Verified
2026-08-13 on this machine:

- `~/.claude/projects/<slug>/` held **520 top-level transcripts and not one carried an
  `accountUuid`** — they are keyed by PROJECT FOLDER, not by account. So after `/login` on the
  other account, **`claude --resume` in the same folder still lists every earlier session**,
  including the other account's, and restores it verbatim. History was never being lost.
- `~/.claude.json` has exactly **one `oauthAccount` slot**, overwritten on every switch. That is
  why nothing on disk remembered the other account, its usage, or its reset time.
- **Claude Code does not persist rate-limit or reset data to disk.** The only `rate_limit` string
  in `~/.claude.json` is a promo-notice feature flag. Any usage figure must be counted from the
  transcripts' own `usage` blocks, and any percentage is empirical — measured against the spend at
  his OWN recorded limit hits, never an official Anthropic threshold.

**Why:** he believed switching accounts lost the work ("I find the other account as he doesn't
know the app"). It never did — a fresh session simply lacks the WORKING state (branch,
half-finished change, last request, next step), which reads identically to amnesia.

**How to apply:** when he mentions shifting accounts, tell him `claude --resume` first. The relay
built for this lives in `~/.claude/hooks/relay-{lib,capture,inject,cli}.mjs` with data in
`~/.claude/relay/`, is wired as a SessionStart + Stop hook pair, shows account and window on the
statusline, and is driven by `/relay` — see [[relay-carries-work-and-limits-between-accounts]].
Both accounts must run `/relay` once each before the "which account has headroom" comparison works
at all, because an account is unknown until it has been seen.

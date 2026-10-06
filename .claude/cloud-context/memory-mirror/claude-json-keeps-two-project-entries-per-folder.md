---
name: claude-json-keeps-two-project-entries-per-folder
description: "`~/.claude.json` keeps TWO `projects` entries for this folder — one keyed with forward slashes and one with backslashes — so a `/mcp disable` recorded under the wrong one silently never applies, and the server keeps loading."
metadata:
  node_type: memory
  type: project
  originSessionId: 233ae337-84f9-4af9-a56d-0a851765addf
  modified: 2026-10-06T07:27:49.421Z
---

`~/.claude.json` holds both `F:/Phoenix Workforce/phoenix-workforce` and
`F:\Phoenix Workforce\phoenix-workforce` as separate `projects` keys. Per-project state lives under
one of them, so a decision recorded under the other is dead config that reads as applied.

Measured 2026-10-06 by `/doctor`: the forward-slash entry listed six `disabledMcpServers`
(`ask-gpt`, `4e789c13…`, `6f616b42…`, `b345e47e…`, `claude.ai Canva`, `claude.ai Supabase`) while the
backslash entry listed **none** — and `mcp__visualize__*` (the `6f616b42…` connector) still had full
tool schemas resident in the session's tool list, ~1.2k est. tokens a request, months after being
disabled. Mirrored onto both entries the same day, minus `b345e47e…`, which AGENTS.md §8 requires
stay allowed (owner decision 2026-10-05) and which was therefore also **removed** from the
forward-slash entry's disable list so it cannot come back if that key becomes the live one.

**How to apply:** never read a single `projects` entry as this folder's state — resolve by normalising
the separators and check both keys, then write both. `/mcp disable` is per-project either way, so it
has to be repeated in every folder the server should be off in. The same split can hide
`disabledMcpjsonServers`, `enabledMcpjsonServers` and trust-dialog state.

Related: [[two-session-stores-two-retention-keys]] — the same shape one layer up, where one store
looking empty is not evidence the other is.

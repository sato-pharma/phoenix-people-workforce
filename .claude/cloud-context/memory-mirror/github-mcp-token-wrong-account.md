---
name: github-mcp-token-wrong-account
description: "The GitHub MCP server (plugin_github_github) authenticates as bot account Phoenix-HR, which has no access to it-gawish-hr/phoenix-people-workforce — use the gh CLI instead"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 742e83f7-58dc-4dcf-883f-cf319a67cadc
  modified: 2026-07-29T08:10:43.549Z
---

`mcp__plugin_github_github__get_me` returns login `Phoenix-HR` (id 280721756), not `Gawish-1997`. Every call against `it-gawish-hr/phoenix-people-workforce` — `create_pull_request`, `list_pull_requests`, even a plain `GET` — 404s, confirming it's an access gap, not a wrong repo name.

`gh auth status` shows two logged-in accounts on this machine: `Gawish-1997` (active, full `repo`+`admin:org` scopes) and `Phoenix-HR` (inactive). The git remote (`origin`) is `https://github.com/it-gawish-hr/phoenix-people-workforce.git`.

**Why:** the MCP server's token was never granted access to this personal-account repo; `gh` is the one already correctly authenticated as the repo owner.

**How to apply:** for this repo, skip the GitHub MCP tools for PR/issue/branch operations and use `gh pr create` / `gh issue ...` via Bash instead — matches the system prompt's own fallback instruction. Re-check `get_me` if a future session reports a different login before assuming this is still broken.

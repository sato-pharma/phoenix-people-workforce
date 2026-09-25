---
name: supabase-access-and-prod-token-are-one-token
description: SUPABASE_ACCESS_TOKEN and SUPABASE_PROD_TOKEN are the same Supabase personal access token under two names, and both repos' .mcp.json expand them from the Windows user environment
metadata:
  type: project
---

`SUPABASE_ACCESS_TOKEN` and `SUPABASE_PROD_TOKEN` in `HKCU:\Environment` hold the **same
value** (identical SHA-256, measured 2026-09-17) — one Supabase personal access token wearing
two names. Each name is load-bearing for a different repository:

- `F:\Phoenix Workforce\phoenix-workforce\.mcp.json` → `Bearer ${SUPABASE_PROD_TOKEN}` for
  **both** `supabase-production` and `supabase-staging`.
- `F:\FTP 2026\FTP PORTAL\.mcp.json`, that repo's `scripts/prod-query.mjs` /
  `area-normalization-check.mjs`, and three project entries in `~/.claude.json` →
  `${SUPABASE_ACCESS_TOKEN}`.

**Why:** the expansion reads the *process* environment, so a tidy-up that deletes either name
from the Windows user environment silently kills Supabase MCP in that repo at the next app
start — and because the two names look like a duplicate, deleting "the redundant one" is the
natural mistake.

**How to apply:** never remove either name, and never treat them as two credentials. Rotating
the token means replacing **both** names plus the FTP Portal's own copies, and every running
session keeps the old value until it restarts. Encrypted pre-rotation copies of the five
credentials that were in that registry key live in
`~\.secrets\windows-user-env-credentials-2026-09-17.dpapi.json` (DPAPI, this Windows account
only). Removed from the environment the same day because nothing read them:
`OPENAI_API_KEY` (every repo script runs `--env-file-if-exists=.env.local`, which has it),
`CLOUDFLARE_API_TOKEN`, `SUPABASE_STAGING_TOKEN`.

---
name: a-denied-mcp-connector-still-appears-in-the-tool-list
description: "A permissions.deny rule blocks CALLING an MCP tool, not advertising it — the denied b345e47e connector still shows up in every session's tool list, and that is NOT evidence the deny was removed."
metadata: 
  node_type: memory
  type: project
  originSessionId: dd293066-cd14-41c4-aac2-96098035af02
  modified: 2026-08-19T18:41:46.559Z
---

`permissions.deny` is an **invocation-time** block. It does not disconnect the MCP server, does not
unregister it, and does not hide its tools. So `mcp__b345e47e-3198-4b48-97cc-07b47bbb3087__*` keeps
appearing in the deferred-tool listing — often mid-session, when the connection settles — with all
30-odd write tools (`execute_sql`, `apply_migration`, `delete_branch`, `pause_project`) named.

**Verified live 2026-08-19, both denies present and no allow anywhere:**

| where | entry |
| --- | --- |
| `.claude/settings.json` (project) | `mcp__b345e47e-3198-4b48-97cc-07b47bbb3087__*` |
| `~/.claude/settings.json` (user) | `mcp__b345e47e-3198-4b48-97cc-07b47bbb3087` |

It is **not configured on this machine at all** — absent from `.mcp.json` (which holds only
`supabase-staging` and `supabase-production`), absent from `~/.claude.json`, and
`enabledMcpjsonServers` lists only those same two. It is a **claude.ai account-level connector**, so
it attaches from the account side and no local file will ever explain "why it is back". Nothing
local can turn it off either — that is Settings → Connectors on claude.ai. Note both Max accounts
share one local config ([[both-max-accounts-share-one-local-config]]), so whichever account the
session authenticates as decides what attaches.

**Why:** AGENTS.md §8 says to flag this connector if it reappears, which reads like "seeing it means
something changed." It does not. A session that reports "the deny was removed / something re-enabled
it" sends the owner hunting for a config change that never happened — that exact false alarm was
raised on 2026-08-19 and had to be retracted.

**How to apply:** seeing the tools listed proves nothing; **read the two deny entries before saying
anything about them.** Report it as "still denied, still advertised" — worth a mention only because
the owner may want it disconnected account-side so it stops being offered at all. Never call it to
"test" whether the deny works. Its trusted sibling `mcp__45bb6356-…` (the owner's own connector, §8
exception, callable) did **not** surface in that session — so presence in the list tracks what the
account has attached, not what the repo trusts.

Related: [[ask-deny-strip-is-committed-not-live]] (a genuinely stale permissions note — re-read the
file, do not trust the description), [[permission-allowlist-user-level-2026-08-01]].

---
name: both-max-accounts-share-one-local-config
description: "Both of the owner's Max accounts run from ONE local config on this machine — /login swaps only the token, so there is never anything to \"copy from the other account\"; what differs is server-side only."
metadata: 
  node_type: memory
  type: reference
  originSessionId: 6796632f-f080-4e9e-8cee-93af8f3cbe33
  modified: 2026-08-14T01:59:37.192Z
---

Both Max accounts (`oagaweesh@gmail.com` / "Omar", `phoenixx.oag@gmail.com` / "Gawish") run on the
same Windows profile `C:\Users\satoh` and read the **same** config files. Switching accounts changes
only the OAuth token in `~/.claude/.credentials.json`.

Verified 2026-08-14:
- `CLAUDE_CONFIG_DIR` unset → config dir is `C:\Users\satoh\.claude`, the only one.
- `C:\Users` has exactly one real profile (`satoh`). The `F:\...\.claude` folders are **project**
  `.claude` dirs, not user configs.
- No managed/policy settings (`C:\Program Files\ClaudeCode\` and `C:\ProgramData\ClaudeCode\` both absent).
- `~/.claude/relay/accounts.json` logs switches between the two accountUuids with the **same `cwd`** —
  same machine, same folder.

So `settings.json` (permissions, `defaultMode: auto`, hooks, statusLine, `enabledPlugins`,
`autoMode` grants) and `~/.claude.json` (`mcpServers`, incl. the local stdio `ask-gpt` bridge) are
**identical on both accounts by construction**. There is no second file to copy.

**Why:** the owner has twice perceived a per-account config difference and asked to copy settings
across — once when `ask_gpt` "was missing" (it was only a deferred tool not yet loaded via
ToolSearch), once asking to copy permissions wholesale. Both times the local config was already
identical and the real cause was elsewhere.

**How to apply:** never hunt for, diff, or copy a second settings file. When the owner reports the
two accounts behaving differently, the cause is one of the three genuinely **server-side**,
per-account things — no local edit can move them:
1. **Extra usage / Fast mode** — `oauthAccount.hasExtraUsageEnabled` + `cachedExtraUsageDisabledReason`
   in `~/.claude.json`. On the Gawish account this reads `org_level_disabled` (he is `organizationRole:
   admin` of his own org, so he can change it in claude.ai billing). See [[relay-and-account-switching]].
2. **claude.ai cloud MCP connectors** — the UUID-named servers (`mcp__45bb6356-…` etc.) are fetched
   from the logged-in account, so they must be reconnected per account at claude.ai → Connectors.
   The named `supabase-staging`/`supabase-production` servers and `ask-gpt` are local, so they are
   always on both. See [[supabase-mcp-and-cli-revoked-2026-08-02]].
3. **Model access, rate-limit tier, usage window** — per account by definition.

Read `~/.claude.json` `oauthAccount` to see which account is live and its true billing state before
answering any "why is X greyed out / missing on this account" question.

---
name: permission-allowlist-rules-can-embed-a-live-secret
description: "A Claude permission allow-rule is the literal command you approved, so any command run with an INLINE env var bakes that credential into settings.local.json in plaintext — grep every settings file for '=' secrets before copying, merging, sharing or committing one."
metadata: 
  node_type: memory
  type: project
---

**A permission allowlist is a list of literal command strings, so it stores whatever you typed —
including secrets.** Approving a command like `FOO_TOKEN=abc123 node script.mjs` writes an allow
rule containing `abc123` verbatim into `.claude/settings.local.json`.

**Found 2026-08-19** while merging a retired worktree's config into the primary checkout. Of 27
rules the primary lacked, one was:

```
Bash(TELEGRAM_BOT_TOKEN='<live bot token>' node scripts/setup-telegram-bot.mjs --status)
```

A working Telegram bot token, in plaintext, in a settings file — and the rule was useless anyway,
since an exact-match rule only ever matches that one command string again.

**Why it is easy to miss:** `settings.local.json` is gitignored, so secret scanning and CI never see
it, and nothing warns you. The file is also large (260+ rules here), so the credential is one line
among hundreds. It only surfaces when someone reads or copies the file.

**How to apply:**
1. **Before copying, merging, sharing or attaching any `settings.*.json`, grep it for `=` inside
   rule strings** — `TOKEN=`, `KEY=`, `SECRET=`, `PASSWORD=`, `_API_`. Skip those rules; never
   propagate them.
2. **Merge by bucket, never flattened.** Compare `allow`/`deny`/`ask` separately — a set union
   across all three can silently promote a `deny` rule into `allow`. (Checked here: the source had
   0 deny and 0 ask, so all 27 were genuinely allow.)
3. **Prefer a wildcard rule to an inline-secret rule.** `Bash(node scripts/setup-telegram-bot.mjs *)`
   grants the same thing without storing a credential.
4. Back the target up first and validate the JSON after writing — 263 → 289 rules here, with
   `skillOverrides` preserved and the token confirmed absent from the result.

Related: [[permission-allowlist-user-level-2026-08-01]], [[claude-config-audit-2026-07-31]],
[[both-max-accounts-share-one-local-config]], [[ask-deny-strip-is-committed-not-live]],
[[env-file-reads-fully-auto-approved-2026-08-09]].

---
name: the-spare-laptop-keeps-its-own-env-local
description: "The spare laptop's D:\\Phoenix\\phoenix-workforce\\.env.local is a separate copy, not the shared hard-linked file — every production secret rotation must also be pushed to it; task \"Phoenix Spare Database Password Refresh\" did the 19 Nov 2026 database password."
metadata:
  node_type: memory
  type: project
  originSessionId: 9dcd167c-57b6-4a45-b46a-2fab7931a78b
  modified: 2026-11-19T01:36:09.489Z
---

The 15 hard links of `.env.local` cover the primary checkout and its worktrees on THIS laptop only. The spare laptop (ssh `phoenix-spare`, user TransferUser) has its own `D:\Phoenix\phoenix-workforce\.env.local`, so a rotation that rewrites the shared file leaves the spare holding the old value.

- 19 Nov 2026: the production database password was replaced (~02:20 Cairo). The spare's `SUPABASE_DB_URL` kept the old, refused one. The spare had not answered since 14 Nov 19:06 Cairo, because this laptop was on a phone hotspot (172.20.10.x) while the spare is on the home network (192.168.1.x).
- Fix, automated: scheduled task "Phoenix Spare Database Password Refresh" runs `~/.claude/scripts/spare-db-password-refresh.ps1` → `.mjs` every 10 min. It finds the spare with `spare-address.ps1`, sends the password only inside the script text on SSH stdin (`node --input-type=module -`), rewrites only production-project postgres URLs in place, proves a TLS login, then unregisters itself. Log: `~/.claude/logs/spare-db-password-refresh.log`.
- The spare's dev server does not use the database password (it uses HTTPS keys), so it kept working meanwhile; only scripts run on the spare that open Postgres were refused.

**Why:** a rotation "done" on this laptop silently breaks the spare's database scripts.
**How to apply:** at the next rotation of any production secret, also push it to the spare (reuse the `.mjs` pattern: stdin, never arguments), or check it with `spare.ps1`. Related: [[production-database-refuses-unencrypted-connections]].

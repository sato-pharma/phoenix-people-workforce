---
name: the-spare-laptop-was-reinstalled-2026-11-20
description: "20 Nov 2026 the owner reinstalled Windows on the spare laptop; a one-paste bootstrap plus the self-removing 'Phoenix Spare Rebuild' task rebuild it — the host key, maybe the user name, and everything on C: are new"
metadata:
  node_type: memory
  type: project
  originSessionId: 13be9376-17b9-44e2-82bc-bc64a093c5df
  modified: 2026-11-20T10:01:52.554Z
---

Owner, 20 Nov 2026 ~11:15 Cairo: "the spare laptop Windows was down, so I reinstalled its Windows ... I hate manual work. Automate." Everything on its C: is gone (OpenSSH, Node, Git, pnpm, the "Phoenix Dev Server" and "Phoenix Spare Browser Guard" tasks); D:\Phoenix may have survived if D: is its own partition.

What was built (main laptop, `~/.claude/scripts`):
- `spare-bootstrap.ps1` (v4) — the ONLY manual step: he copies it from the private page https://claude.ai/artifact/DT7E3hkLztzXPUquwSLEBe ("Spare Laptop Setup", a one-line base64 `iex`) into Terminal (Admin) on the spare. Remote login (key only, LocalSubnet), Git, Node.js 24 from nodejs.org with checksum, pnpm 11.13.1, `safe.directory *` and `core.longpaths` system-wide, awake on AC with the lid shut, D: mapped to C:\PhoenixDrive when no D: exists, then restarts. Its banner reads `phx-user=<user> phx-spare=4`. The 7 Nov page 4SS7iLMwM1R3qxQktqfBFR now answers 404.
- `spare-rebuild.ps1`, run every 5 min by task "Phoenix Spare Rebuild": finds the spare by that pre-sign-in banner (the old host-key anchor cannot match a fresh Windows), trusts the new host key on first sight, rewrites the three `phoenix-spare` lines in known_hosts (old copy `known_hosts.bak-20261120-rebuild`), writes `spare-address.txt`, `spare-user.txt`, HostName/User in ~/.ssh/config; keeps or re-sends D:\Phoenix\phoenix-workforce (bundle only with 2.5 GB free here); sends .env.local when missing or not production; registers "Phoenix Dev Server" (S4U, at startup, runs D:\Phoenix\dev-server-run.ps1); starts the follow task, which installs packages and the browser guard. On healthz 200 it restarts "Phoenix Spare Tunnel", logs DONE and unregisters itself. Log: `~/.claude/logs/spare-rebuild.log`.
- Every spare script (`spare.ps1`, `spare-address.ps1`, `spare-tunnel.ps1`, `spare-follow-production.ps1`, `spare-test.ps1`, `spare-db-password-refresh.mjs`) now reads the user from `spare-user.txt`, default TransferUser (backups `.bak-20261120-before-user`).

First live run, 20 Nov ~11:55 Cairo: the spare is now host **Gawishhh**, user **satoh**, at 192.168.1.48; D: (and D:\Phoenix\phoenix-workforce with a production .env.local) SURVIVED; drives C–G exist. Three traps hit and fixed: (1) `npm notice` on stderr + PS 5.1 `$ErrorActionPreference='Stop'` + `2>&1` killed the pnpm step — npm now runs via Start-Process (bootstrap v4.1); (2) Windows `ssh-keyscan` returns NOTHING — the host key is taken with `StrictHostKeyChecking=accept-new` into a private file; (3) a `Log` that used Write-Output inside a function became its return value and wrote blank HostName/User/anchor — Log is Write-Host now, and Save-Spare refuses a half-found spare. pnpm 11.13.1 was then installed over SSH; sshd sessions do not see the user's `%APPDATA%\npm` until a restart, so checks prepend it. v4.1 restarts only when it installed something and restarts sshd only when its config changed, so a second paste is safe. The power settings (awake on AC, lid) never ran — only his re-paste can set them.

**Why:** a fresh Windows breaks the trust anchor silently — `spare-address.ps1` just says "not found" forever.
**How to apply:** if the spare is ever reinstalled again, re-run the same page and re-register "Phoenix Spare Rebuild"; never hand-edit the anchor. Related: [[the-spare-laptop-changes-address-it-is-not-off]], [[the-spare-laptop-keeps-its-own-env-local]].

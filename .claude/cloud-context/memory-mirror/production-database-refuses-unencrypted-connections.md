---
name: production-database-refuses-unencrypted-connections
description: Production Postgres has SSL enforcement ON since 19 Nov 2026 02:04 Cairo — a script connection without TLS is refused; a checkout older than PR 550 has scripts that will be refused.
metadata:
  node_type: memory
  type: project
  originSessionId: 9dcd167c-57b6-4a45-b46a-2fab7931a78b
  modified: 2026-11-19T00:06:21.653Z
---

Production (`ozucdzovmcqvepbozvqf`, "Phoenix HR") has "Enforce SSL on incoming connections" ON since **19 Nov 2026, 02:04 Cairo** — the owner switched it in the dashboard after the credentials audit (finding 2). `supabase ssl-enforcement get --project-ref ozucdzovmcqvepbozvqf --experimental` reads `{"database":true}`.

- Switching it restarted the database's front door: PostgREST answered 503 to 87 requests between 02:04:01 and 02:04:05 Cairo, then reconnected over TLSv1.3. Turning it off or on again costs the same few seconds.
- What still connects and is encrypted: the release gate's psql (`PGSSLMODE: require` in ci.yml), the nightly database backup (its URL carries `sslmode=require`), every `postgres()` call on `main` (`ssl: "require"`, pinned by `tests/postgres-connections-use-tls.test.ts`). The website opens no Postgres connection (HTTPS only).
- 🔴 **A script run from a checkout older than PR 550 (merge ee85423c2) connects in plain text and is REFUSED** — postgres.js ignores PGSSLMODE. The fix is to update the checkout to `origin/main`, never to drop enforcement or add `ssl: false`.
- Changing the switch from a session is blocked on purpose by the `.claude/settings.json` deny rule for `supabase ssl-enforcement update` (PR 542) — the owner flips it himself.

**Why:** the database used to accept plain-text logins, so ~17 script connections sent the database password and rows unencrypted.
**How to apply:** a script failing to connect to production with an SSL / "no encryption" / pg_hba refusal is this — check the checkout's age and the call's `ssl` option first. Related: [[github-holds-a-workflow-that-reads-every-secret-as-malicious]].

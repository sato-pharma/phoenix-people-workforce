---
name: never-rotate-the-supabase-db-password-with-alter-role
description: "The Supabase DB password must be reset from the dashboard, not ALTER ROLE - Supavisor holds its own copy of the tenant credential and desyncs"
metadata:
  type: project
---

`SUPABASE_DB_URL` in `.env.local` points at the **Supavisor pooler**
(`aws-1-eu-central-1.pooler.supabase.com:5432`, user `postgres.ozucdzovmcqvepbozvqf`), not at
`db.<ref>.supabase.co` — that direct host no longer resolves at all, because Supabase retired IPv4
for it. A `getaddrinfo failed` on the direct host is therefore normal, not a symptom.

**Never rotate this password with `ALTER ROLE postgres WITH PASSWORD`.** Supavisor stores its own
copy of the tenant credential; changing it in SQL alone desyncs the pooler from the database and can
lock out the only remaining connection path. Reset it from the dashboard
(`/project/ozucdzovmcqvepbozvqf/settings/database`), which updates both.

**How to tell a stale password from a wrong host, without ever printing the credential:** try the
`aws-0-eu-central-1` host as well. The pooler answers `XX000 tenant/user … not found` for a wrong
host but `28P01 password authentication failed for user "postgres"` when the host and tenant are
right and only the password is wrong. Note the error names bare `postgres` even though the username
sent was `postgres.<ref>` — Supavisor forwards it that way, so that is not evidence of a malformed
username. Also check the password's character classes before blaming the driver: `pg8000` skips
SASLprep, so a non-ASCII password fails there but works under libpq. On 2026-08-23 the stored value
was 26 pure-ASCII alphanumerics, which ruled that out and proved the value itself was stale.

**Why:** rotating it looks scary but is not — **nothing outside this laptop uses it.** Verified
2026-08-23: no GitHub Actions secret holds a DB URL or password (CI uses
`SUPABASE_SERVICE_ROLE_KEY`), no workflow references one, and the running app connects over the REST
keys. The only consumers are `.env.local` and the local `scripts/phase*` tooling.

**Rotated and working again 2026-08-23.** Two false starts first: the dashboard shows the generated
password *before* you confirm, so copying it and closing the panel gives a valid-looking string the
server never stored. Prove the reset landed without touching the secret -
`select left(md5(rolpassword),12) from pg_authid where rolname='postgres'` fingerprints the SCRAM
verifier; take it before and after, and an unchanged value means the reset never applied.

**Write the URL with port 5432, not 6543.** Right after a reset the pooler accepts one port before
the other, so a script that tries 5432 then 6543 can land on 6543 - transaction mode, which silently
breaks `supabase db push` and prepared statements. Re-test both once things settle and prefer 5432.

**Never read a password through the console prompt on Windows** - pastes into `getpass` fail
invisibly and cost several rounds. Have the owner save it to a file and pass `--from-file`; decode
`utf-8-sig` first, because Notepad's BOM corrupts the first character with no error.

**How to apply:** when a session needs bulk rows out of production and this credential is dead, do
not chase it — stage the result in a scratch table and read it over PostgREST with the service-role
key, or page it through `execute_sql`. If you stage a table, `revoke all … from anon, authenticated`
in the same transaction: ad-hoc tables here are anon-readable by default, see
[[ad-hoc-backup-tables-are-anon-readable]]. Related:
[[windows-env-var-shadows-every-env-local-key]], [[env-file-reads-fully-auto-approved-2026-08-09]].

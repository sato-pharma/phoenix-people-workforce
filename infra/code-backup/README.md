# Nightly code backup

This service makes two backups each night: the code (this part) and, since 13 Nov 2026, the database (the
second part of this page).

A one-shot Railway service, `phoenix-code-backup`, in Europe. Railway starts it at `17 0 * * *` UTC and it
exits when done. Railway's schedule has no setting in `.railway/railway.ts`, so it is set with GraphQL
`serviceInstanceUpdate { cronSchedule }`. Railway skips a run while the last one is still going.
Its watch pattern, `infra/code-backup/**`, means only a change in this folder rebuilds it; every other merge
shows as skipped. A rebuild does not start a backup.

Each night it makes one file on the app's Drive, `phoenix-code-backup/daily/code-backup-YYYY-MM-DD.tar.age`:
a verified `git bundle` of every repository the token can see on the two owners (`sato-pharma`, which holds Phoenix since 6 Nov 2026, and the personal account `Omar-3-xx`, which holds the launcher and the website), the `hmdm-android` release files, and a
`manifest.tsv` listing each repository's refs and size, with `releases.tsv` listing each release file and its size. It keeps 7 daily and 4 weekly files.
Since 7 Nov 2026 every bundle, release folder and manifest line is named `OWNER/NAME`, so a restore knows which account each repository goes back to.
`phoenix-code-backup/frozen-2026-10-26/` is never pruned: the repositories that had no copy off this disk.

**Not covered:** unpushed commits and `.env` files. Restoring code does not restore secrets.

**What watches it:** `/api/cron/code-backup-verify` reads Drive from production every day and fails when the
newest file is over 36 hours old, too small, or Drive cannot be read. A run that fails prunes nothing.

## Variables

| Name | Value |
| --- | --- |
| `GITHUB_BACKUP_TOKEN` | A CLASSIC GitHub token (`repo` scope) that sees every owner in `CODE_BACKUP_OWNERS`. A fine-grained token reaches one owner only, so with two owners the night is refused |
| `CODE_BACKUP_AGE_RECIPIENT` | The PUBLIC age key. The private key is never on Railway |
| `CODE_BACKUP_MIN_REPOS` | Refuses the night if the token sees fewer repositories than this |
| `CODE_BACKUP_OWNERS` | Optional. The owners backed up, space-separated; default `sato-pharma Omar-3-xx`. The night is refused if the token sees no repository of one of them. The retired `CODE_BACKUP_OWNER` is ignored, with a warning in the log |
| `CODE_BACKUP_RELEASE_REPOS` | Optional. The repositories whose release files are kept, each `OWNER/NAME`; default `Omar-3-xx/hmdm-android`. A bare name is refused |
| `GOOGLE_DRIVE_OAUTH_CLIENT_ID`, `_CLIENT_SECRET`, `_REFRESH_TOKEN` | Railway references to the app's own, so a rotation reaches them |

## Restoring

The owner holds the private key. On Windows, set long paths first or a clone silently returns 0 refs.

```bash
git config --global core.longpaths true
```

```bash
rclone copy "drive:phoenix-code-backup/daily/code-backup-YYYY-MM-DD.tar.age" .
```

```bash
age -d -i age-key.txt code-backup-YYYY-MM-DD.tar.age | tar -xf -
```

```bash
git clone bundles/OWNER/NAME.bundle NAME
```

Then compare the clone's `git for-each-ref` count with that repository's `OWNER/NAME` line in `manifest.tsv`, and push it back to
that OWNER. A file made before 7 Nov 2026 has `bundles/NAME.bundle` and bare names instead.

## The nightly database backup

Since 13 Nov 2026 the same nightly run makes a second file, after the code backup:
`phoenix-db-backup/daily/db-backup-YYYY-MM-DD.tar.age`, the whole production database. Production has no
point-in-time recovery, and its seven daily backups are kept by the same provider as the database. This file
is the company's own copy. It keeps 7 daily and 4 weekly files, in its own Drive folder, so neither backup can
prune the other's.

The start command is `run.sh`: the code backup first, then `db-backup.sh`. One failing never stops the other,
and the run ends red if either failed.

**What is in the file:** `database.dump` (every schema, `pg_dump` custom format), `manifest.tsv` (every table
with its row count, counted in the same snapshot the dump read), `roles.sql` (the roles, no passwords),
`cron-jobs.tsv` (the database's own scheduled jobs, which a dump does not carry) and `meta.tsv`.

**Not covered:** the files in Supabase Storage (the dump holds their list, not their bytes) and every secret
on Railway.

**Its login reads everything and writes nothing.** The role `phoenix_backup_reader` comes from the migration
`…_phoenix_backup_reader_role.sql`, with no login. The login and password are set on production
only, by `scripts/set-backup-reader-login.mjs`. 🔴 Treat `DB_BACKUP_DATABASE_URL` like the service-role key: it
reads payroll and the sign-in tables. It is on this one Railway service and nowhere else.

**It steps aside.** While it counts and dumps it holds a read lock on every table. A migration that alters a
table would wait for that lock, and everything reading the table would wait behind the migration. So the
backup looks every 3 seconds for anyone waiting behind it. When it sees one twice running it ends its own
sessions, uploads nothing, prunes nothing and exits 75. `run.sh` tries again 10 minutes later, three times in
all. A night that stepped aside three times ends red and keeps the older files.

**What watches it:** the same daily call, `/api/cron/code-backup-verify`, reads this folder too and reports
it as `phoenix-db-backup-verify`: over 36 hours old, under 165.6 MB (half of the first full file, 13 Nov 2026), under half the night before, or Drive
unreadable.

**What rehearses it:** `.github/workflows/backup-image.yml` runs `ci/rehearse.sh` on every pull request that
touches this folder. It builds this image and proves the backup, the restore drill and the step-aside on a
throwaway PostgreSQL 17. It reaches no real database and holds no secret. The service runs as an unprivileged
user, never root (the image's `USER phoenix`), and the rehearsal fails if that is ever undone.

### Its variables

| Name | Value |
| --- | --- |
| `DB_BACKUP_DATABASE_URL` | The read-only login's URL through the session pooler. Set by `scripts/set-backup-reader-login.mjs`, never by hand. A password a URL would have to escape is refused |
| `CODE_BACKUP_AGE_RECIPIENT` | The same PUBLIC age key as the code backup |
| `DB_BACKUP_MIN_TABLES` | Optional, default 500. The night is refused if the login sees fewer tables: a login that lost its rights would otherwise back up less in silence |
| `DB_BACKUP_DRIVE_FOLDER` | Optional, default `phoenix-db-backup` |
| `DB_BACKUP_RETRY_WAIT_SECONDS` | Optional, default 600. The wait before the next try after a step-aside |
| `DB_BACKUP_REMOTE`, `DB_BACKUP_READ_AS_ROLE`, `DB_BACKUP_WATCH_SECONDS` | For the rehearsal only. The nightly service sets none of them |

### Setting or rotating the login

From the main checkout. It prints no password and no URL. Not between 02:15 and 03:00 Cairo: Railway redeploys
the service, and a redeploy during the night's run would cut it off.

```bash
node scripts/set-backup-reader-login.mjs --confirm-production
```

It sets a new password on production (the old one stops working at once), signs in as the role to prove it
reads and cannot write, then writes the URL to the Railway variable through stdin. If the last step fails,
run it again.

### The restore drill

`restore-drill.sh` proves a backup file can be restored, and says how long it took. It decrypts the file,
restores it into a new database on a server you name, counts every table and compares each count with
`manifest.tsv`. It passes only when every table is there with exactly its rows, then drops the database it
made. 🔴 The target is a throwaway PostgreSQL 17 server. Production is refused by name. Not staging either:
the restored copy is as large as production. This script is not in the image: the service that makes the
backups can decrypt none of them.

```bash
rclone copy "drive:phoenix-db-backup/daily/db-backup-YYYY-MM-DD.tar.age" .
```

```bash
RESTORE_DRILL_TARGET_URL="postgresql://USER@127.0.0.1:5432/postgres?sslmode=disable" bash infra/code-backup/restore-drill.sh --file db-backup-YYYY-MM-DD.tar.age --identity age-key.txt
```

**Measured on the first full file, 13 Nov 2026:** `db-backup-2026-11-13.tar.age` (331,201,672 bytes) restored in
2 minutes 49 seconds on a laptop, 1,411 of 1,411 tables and 5,694,838 rows, into a database of 2.99 GB. Fetching
the file from Drive took another 123 seconds. Allow 3 GB of disk for the restored copy.

A server without Supabase's own extensions reports those objects as refused. They are counted and shown, and
they hold no table the manifest lists, so they do not fail the drill. A missing or short table does.
**The refused number is approximate.** It counts the restore tool's error lines, and with more than one worker
those lines run into each other: three drills of the first full file printed 17, 23 and 20, and every reason
named the scheduler (`pg_cron`) or the vault (`supabase_vault`). Read the reasons, not the number.

### A real restore

🔴 Never into the live project, and never without the owner's word in the conversation
(`docs/disaster-recovery-runbook.md`, section 4). Decrypt as above, then `pg_restore` the tables that are
needed into a NEW project or a scratch schema, compare the counts with `manifest.tsv`, and only then move
data. `cron-jobs.tsv` lists the scheduled jobs to put back by hand.

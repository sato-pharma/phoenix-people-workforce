# Nightly code backup

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

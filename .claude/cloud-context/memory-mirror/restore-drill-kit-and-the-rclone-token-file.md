---
name: restore-drill-kit-and-the-rclone-token-file
description: "Where the database restore drill kit lives on the laptop, how to run one night's drill, and the rclone trap that leaves a Drive token on disk"
metadata:
  node_type: memory
  type: reference
  originSessionId: 10ba1c01-8641-48a5-97e7-a15f406ecef1
  modified: 2026-11-14T00:30:56.990Z
---

**The restore drill for a nightly database backup is one command** (built 13 Nov 2026 for the owner's "run the restore drill on tonight's scheduled backup after 02:17"):

`bash /c/Users/satoh/.claude/scripts/restore-drill/tonight.sh YYYY-MM-DD` (Git Bash, backgrounded, about 15 to 25 minutes).

- It checks free memory (3,000 MB) and disk, fetches `db-backup-<date>.tar.age` from Drive through `railway run -s phoenix-code-backup -e production` (run from the primary checkout, where the CLI is linked), restores into a throwaway PostgreSQL on 127.0.0.1:54329, compares every table's row count with the backup's manifest, stops the server and removes its data. Log: `drill-<date>.log` beside it.
- Exit: 0 passed, 1 failed, 3 too little memory or disk, 4 the file is not on Drive, 5 something missing.
- The folder holds its own copy of `infra/code-backup/restore-drill.sh` (from `origin/main` at `1ee972793`), because the primary checkout can be far behind `main` and then has no such file. Refresh that copy if the script changes on `main`.
- The key is `C:\Users\satoh\.secrets\code-backup\code-backup-age-key.txt` (moved off the F: root on 14 Nov 2026, the owner's "move the GitHub token and key off the F: root"; the folder is readable only by his account and SYSTEM); never print it.
- The nightly backup runs at `17 0 * * *` UTC = 02:17 Cairo. The hand-made 13 Nov file was 331,201,672 bytes.

🔴 **rclone trap:** with the remote set by environment variables and `RCLONE_CONFIG` pointing at a path that does not exist, rclone CREATES that file and writes the refreshed Drive token into it. Only the names `notfound`, an empty string or the null device keep the config in memory. `fetch.sh` uses `RCLONE_CONFIG=notfound`; after any fetch, check no config file was left in the folder.

**Why:** the first rehearsal left `no-such-rclone.conf` holding a `token =` line in the drill folder (removed at once, never printed).
**How to apply:** use the kit instead of rebuilding the steps; keep `notfound` in any new rclone helper.

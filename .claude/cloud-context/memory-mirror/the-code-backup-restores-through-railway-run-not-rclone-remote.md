---
name: the-code-backup-restores-through-railway-run-not-rclone-remote
description: "How to start the nightly code backup by hand and restore it on this machine; the README's rclone route and .env.local's Drive login both fail here."
metadata:
  node_type: memory
  type: project
  originSessionId: 3881682b-219d-457b-9086-74f9eb37981b
  modified: 2026-11-03T19:53:47.173Z
---

First real run of `phoenix-code-backup` 2026-11-03 17:54 Cairo, restored and compared the same evening: 7 of 7 manifest rows matched, 1,984 Phoenix refs, 3 release files.

- **Start one run by hand:** `railway api` with `mutation{deploymentInstanceExecutionCreate(input:{serviceInstanceId:"c5d37290-da69-4937-894c-59ca783b784c"})}`. A rebuild does NOT run the job and leaves no logs; since 2026-11-03 only a change under `infra/code-backup/` rebuilds it (watch pattern). The run took about 2 minutes.
- **Restore here:** local rclone has no remotes (the README's `drive:` fails) and `.env.local`'s Drive login answers 401. Run the restore under `railway run --service phoenix-code-backup --environment production`, which supplies the working login, and build rclone's `RCLONE_CONFIG_BACKUP_*` from it as `backup.sh` does.
- **Clone with `--mirror`:** no working tree, so no long-path trouble and no protected document types on disk. Needs ~1.8 GB free RAM; it held ~2.1 GB throughout.
- **Reading the comparison:** "in backup but gone live" on Phoenix is branches deleted since the run, not a loss. `hmdm-android`'s bundle is 1,254 bytes by nature: its content is the APK release files.

**Why:** the first attempts cost a refused login and a wrong service id (`railway status`'s top-level id is not the GraphQL service id).
**How to apply:** use this route for any restore test; the private key `F:\GitHub-move-backup\code-backup-age-key.txt` is passed to `age -i` and never printed.

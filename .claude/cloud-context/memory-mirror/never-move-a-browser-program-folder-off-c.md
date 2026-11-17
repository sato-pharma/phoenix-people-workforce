---
name: never-move-a-browser-program-folder-off-c
description: "Moving a Chromium browser's Program Files folder to D via a junction breaks its saved passwords (app-bound encryption path check)"
metadata:
  node_type: memory
  type: feedback
  originSessionId: 18b04bb2-59ea-441e-9862-1916ca829140
  modified: 2026-11-16T22:40:15.742Z
---

Never move Chrome, Edge, Brave (any Chromium browser) program folder out of `C:\Program Files` into `D:\C-Offload` or anywhere else with a junction, when freeing C: space.

**Why:** On 2026-11-12 08:40 the "Clean RAM heavily" session junctioned `C:\Program Files\BraveSoftware` to `D:\C-Offload\ProgramFiles\BraveSoftware`. Brave's app-bound password key checks the real folder the exe runs from, so the lock failed with "Unable to decrypt key … 0x8004A007 (validation did not pass)" and Brave showed 0 passwords. Fixed 2026-11-17 by copying it back (elevated robocopy, junction removed with `cmd rmdir` without `/s`). The D copy is kept as a fallback. Chrome and Edge only needed a full restart on the right profile ("Default" in Chrome, "Profile 2" in Edge). A password backup is in `C:\Users\satoh\Browser-Password-Backup-2026-11-17`.

**How to apply:** Moving a browser's User Data is not the risk here; its program folder is. To diagnose, start the browser with `--enable-logging=file --log-file=<path>` after killing every one of its processes, then search the log for `app_bound_encryption_provider_win`.

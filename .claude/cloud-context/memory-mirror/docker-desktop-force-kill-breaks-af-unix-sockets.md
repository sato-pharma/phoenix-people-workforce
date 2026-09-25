---
name: docker-desktop-force-kill-breaks-af-unix-sockets
description: "RESOLVED 2026-07-11. Force-killing Docker Desktop mid-restart triggered a cascade: AF_UNIX socket deletion broken across AppData (except Temp), PLUS an accidentally-created admin-settings.json forcing sign-in enforcement, PLUS a junction workaround that broke WSL2 VHD mounting. Working fix: junction ONLY Docker\\run and docker-secrets-engine (not Docker\\wsl) out of AppData, delete admin-settings.json, enable ExposeDockerAPIOnTCP2375 for vector logs. Full working sequence documented below."
metadata:
  node_type: memory
  type: feedback
  originSessionId: f780d6cd-755d-4c24-a5b5-ed61d321d53c
---

## RESOLUTION SUMMARY (read this first)

This incident had **three independent compounding causes**, discovered in this order but not necessarily
in causal order — don't assume the first thing found is the whole story:

1. **AF_UNIX socket deletion is broken across this machine's entire `AppData` folder except `Temp`**
   (proven with a native .NET `UnixDomainSocketEndPoint` bind+delete test — see body below). Root cause
   still unknown (survived reboot, chkdsk, DISM/SFC, Defender exclusion test) — likely a low-level
   Windows/filter-driver quirk specific to this machine. **Fix: junction `AppData\Local\Docker\run` and
   `AppData\Local\docker-secrets-engine` to plain folders outside AppData** (e.g. `C:\DockerData\run`,
   `C:\DockerData\secrets`). This alone stops the "Access is denied removing dockerInference/engine.sock"
   crash loop.
2. **Do NOT also junction `AppData\Local\Docker\wsl`** (the WSL2 VHD directory). Unlike the socket files,
   Hyper-V's HCS mount API fails to attach a VHD reached through a directory junction/reparse point —
   `Failed to attach disk '...\ext4.vhdx' to WSL2: Access is denied` — **even after granting
   `icacls ... "NT VIRTUAL MACHINE\Virtual Machines:(OI)(CI)F"` on the target folder**. This is a different,
   unrelated Windows limitation from cause #1. Leave `Docker\wsl` in its normal AppData location; it doesn't
   hit the socket-deletion bug (a WSL2 VHD isn't an AF_UNIX socket file).
3. **A self-inflicted `C:\ProgramData\DockerDesktop\admin-settings.json`** (created mid-incident to try
   disabling the Inference feature) has a side effect completely separate from its content: **its mere
   presence on disk forces Docker into mandatory Sign-In enforcement** (`restricting proxy`,
   `restricting idle` in the backend log) which stalls WSL engine provisioning indefinitely with no error
   dialog — looks identical to "still starting up" for 10+ minutes. **Fix: delete the file entirely**
   (requires elevation) unless you actually need an org-enforced admin policy.

**The actual working end state:** `Docker\run` and `docker-secrets-engine` junctioned out; `Docker\wsl` left
alone; `admin-settings.json` deleted; `ExposeDockerAPIOnTCP2375: true` added to
`%APPDATA%\Docker\settings-store.json` (fixes the unrelated `vector` container restart-loop — Supabase
local dev's log-tailing sidecar needs the Docker API on TCP 2375, off by default; this is a real
unauthenticated-port security tradeoff, confirm with the user before enabling). Verified end-to-end: full
`supabase start` from a truly wiped volume (`supabase stop --no-backup`, confirmed via
`docker volume ls --filter label=com.supabase.cli.project=...` empty) completed with zero errors, all 12
containers healthy.

**Traps that wasted time — don't repeat these:**
- After using `DockerCli.exe -Shutdown` / `wsl --shutdown` repeatedly across many rapid restart cycles, the
  backend can genuinely wedge (`-Shutdown` itself returns "context deadline exceeded" / exit 1, not just
  slow). At that point graceful shutdown is exhausted — get explicit user approval before
  `Stop-Process -Force`, since that's the same action that started this whole incident, but sometimes it's
  the only way out of a truly hung backend. Confirm the `run`/`secrets` junctions survive the kill
  (`Get-Item ... | Select LinkType`) before relaunching — they do, since they're filesystem structure, not
  process state.
- `docker ps -a` succeeding with an empty container list IS the daemon being healthy — don't misread "no
  containers yet" as "daemon still broken."
- When many background shell tasks pile up from repeated launch/check cycles, stale completion
  notifications from long-dead attempts arrive interleaved with the live one. Always re-verify current
  process/container state directly rather than trusting which notification just arrived.

---

## Original incident writeup (kept for detail on the AF_UNIX investigation)

2026-07-11: compacted the Docker WSL2 data disk (`AppData\Local\Docker\wsl\disk\docker_data.vhdx`) via
elevated `diskpart compact vdisk` after `wsl --shutdown`. The vhdx shrank fine (14.67GB → 12.61GB), but
restarting Docker Desktop afterward (`Start-Process "Docker Desktop.exe"`) silently no-op'd against the
already-running single-instance app instead of doing a real relaunch — `dockerd` never came back up inside
the `docker-desktop` WSL VM (confirmed via `wsl -d docker-desktop -- dmesg`: only the small utility disk
mounted, the big data disk never re-attached).

To force a clean restart, ran `Get-Process | Where-Object {...docker...} | Stop-Process -Force` then
relaunched. This is what actually broke things: Docker Desktop then crashed on startup with
`initializing Inference manager: listening on unix://...\Docker\run\dockerInference: remove ...: The file
cannot be accessed by the system.` — a stale AF_UNIX socket reparse-point file that the forceful kill left
behind mid-write.

**Escalation attempted, in order, all failed with the identical Error 1920 (ERROR_CANT_ACCESS_FILE):**
`Remove-Item`, `cmd /c del`, `fsutil reparsepoint delete`, starting the privileged `com.docker.service`
(was Stopped, Manual) then retrying, a **full OS reboot** (confirmed clean — zero Docker processes running
post-boot), and finally elevated `takeown /r` (ownership transfer succeeded) + `icacls /grant` + `robocopy
<empty-dir> <run-dir> /MIR /PURGE` (the standard "impossible to delete" workaround). Every single one hit
the same error on the same two files (`dockerInference`, `userAnalyticsOtlpHttp.sock`). This is not a
transient lock, not a permissions problem (ownership change succeeded), and not stuck kernel socket state
that a reboot clears — it is likely genuinely corrupted/unresolvable NTFS reparse-point metadata.

**Why:** Windows' AF_UNIX socket files under `AppData\Local\Docker\run\` are NTFS reparse points. Killing
the process that owns one with `-Force` mid-write can corrupt the reparse point's tag data rather than just
leave it "locked" — and corrupted reparse data is a *filesystem* problem, not a process/kernel-session
problem, which is why a reboot (which only resets process/session state) didn't help.

**How to apply (superseded by the RESOLUTION SUMMARY at the top — kept here as historical detail only):**

At the time this was written, uninstall/reinstall and vendor support looked like the only remaining paths —
that turned out to be a dead end too (reinstalling across two different Docker Desktop versions hit the
identical crash, confirming it wasn't a version bug). **The actual fix that worked** was the junction
workaround in the RESOLUTION SUMMARY above, discovered only after also finding and fixing the unrelated
admin-settings.json sign-in-enforcement issue. Don't stop at "uninstall/reinstall" or "reboot" as the answer
for this specific error signature — read the resolution summary first.
- When Docker Desktop needs a full restart (e.g. after `wsl --shutdown` for vhdx maintenance), prefer
  Docker Desktop's own quit path (`DockerCli.exe -Shutdown`) over `Stop-Process -Force` on its processes —
  but if `-Shutdown` itself starts returning "context deadline exceeded" / exit 1 after many rapid restart
  cycles, the backend may be genuinely wedged and graceful shutdown exhausted; get explicit user approval
  before force-killing in that specific situation.
- If `Start-Process "Docker Desktop.exe"` appears to no-op (same PIDs/start times as before) because it's a
  single-instance app already running, diagnose with `wsl -d docker-desktop -- dmesg` (check the data disk
  actually mounted) — do NOT reach for `Stop-Process -Force` as the first fix.
- Vhdx compaction itself (diskpart `compact vdisk` after `wsl --shutdown`) worked cleanly and is safe to
  reuse — the failure mode here was entirely in the *restart* step afterward (specifically the force-kill),
  not the compaction.

Related: [[localappdata-temp-is-live-tool-state]] (same underlying class: user-space tool state that isn't
safe to touch/force the way a name like "Temp" or a routine restart suggests).

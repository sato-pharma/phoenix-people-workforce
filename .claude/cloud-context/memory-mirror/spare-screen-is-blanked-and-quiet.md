---
name: spare-screen-is-blanked-and-quiet
description: "The spare's own monitor goes dark after 1 minute and shows only critical kernel messages (owner, 27 Nov 2026); never install a desktop on it"
metadata:
  node_type: memory
  type: project
  originSessionId: fecd28e5-0f28-4426-8a9e-0a0fa6018762
  modified: 2026-11-27T13:55:56.653Z
---

On 27 Nov 2026 (~15:05 Cairo) the owner sent a photo of the spare's monitor full of kernel out-of-memory lines (the
Engineering Hub's `hubqa` screenshot job hitting its own 4 GB cap at 13:11 — the live dev server was never touched)
and said "blank the spare's screen and quiet its messages". Installed by `~/.claude/scripts/spare-console-quiet.sh`:
`/etc/sysctl.d/90-phoenix-quiet-console.conf` (`kernel.printk = 3 4 1 3`) and `phoenix-console-blank.service`
(setterm on tty1: blank after 1 min, panel powered down). The journal still keeps every message (`journalctl -k`).

Same day, "Ignore power taps": a short power-button press powered the spare off at 15:20:22 (back 15:20:41).
`~/.claude/scripts/spare-power-key.sh` installed `/etc/systemd/logind.conf.d/phoenix-power-key.conf`
(`HandlePowerKey=ignore`, `HandlePowerKeyLongPress=poweroff` — a 5-second hold still powers off). Wake the dark
screen with a KEY, never the power button.

**Why:** he asked whether a light desktop (Xfce/LXQt) would help; it would take 300-600 MB of the spare's ~2.2 GB free
for nothing he uses — he reaches the spare only over the network.

**How to apply:** never install a desktop on the spare; an OOM line on its screen is not the dev server dying —
read `journalctl -k | grep oom_memcg` for WHICH cgroup was killed first. See [[the-spare-runs-ubuntu-server]].

---
name: the-spare-laptop-changes-address-it-is-not-off
description: "The spare laptop's home-network address moves (192.168.1.53 <-> .60); since 14 Nov 2026 the spare scripts find it themselves through spare-address.ps1 — never write the address into a script again, and never tell the owner to switch it on before the finder has looked."
metadata:
  node_type: memory
  type: project
  originSessionId: 283de2a8-dd61-47fa-a0bb-e400c486949f
  modified: 2026-11-14T02:25:49.749Z
---

The spare laptop (hostname `Gawish`, SSH user `TransferUser`, `D:\Phoenix`) gets its address from the home router and it MOVES: `.60` → `.53` on 8 Nov 2026, `.53` → `.60` on 14 Nov 2026 at about 04:02 Cairo, while the laptop stayed up the whole time (boot time 13 Nov 13:37).

On 14 Nov I read "no ping, no port 22" on `.53` and told the owner to switch the laptop back on. That was wrong: it was on, at `.60`. He then asked, in his words, "Make it follow" (the box's question was "Make the spare scripts find the laptop when its address changes?").

**What exists now (built 14 Nov 2026, 04:20-04:25 Cairo):** `~/.claude/scripts/spare-address.ps1` prints the spare's current address. Exit 0 = it answers there; exit 1 = not found, and the line is the last known address.
- Fast path: the last address in `spare-address.txt` (beside it), when its SSH port answers and it is not one of this laptop's own addresses.
- Otherwise it tries port 22 on every address of this laptop's own /24 and signs in to each that answers with the spare's key, checking the host key against the three `phoenix-spare <type> <key>` lines in `~/.ssh/known_hosts` (`HostKeyAlias`). The host key decides, never the address.
- On a new address it writes the address file, gives that address the same keys in `known_hosts`, and rewrites `HostName` under `Host phoenix-spare` in `~/.ssh/config`. Moves are logged in `~/.claude/logs/spare-address.log`.
- `spare.ps1`, `spare-test.ps1`, `spare-tunnel.ps1` and `spare-follow-production.ps1` all ask it; none holds an address. The repo's `on-spare.ps1` finds no address in `spare.ps1` any more and takes its own fallback, the `phoenix-spare` shortcut (proved with an scp through it).

**Why:** the address used to be written in five places, so one move silently killed the dev server at `localhost:3000`, the tests on the spare and the 10-minute follow task (whose log only said "spare laptop did not answer").

**How to apply:**
- Never write the spare's address into a script, a doc or a command. Ask the finder: `& ~/.claude/scripts/spare-address.ps1`, or use `ssh phoenix-spare`.
- "The spare does not answer" is only true when the finder exits 1. Only then is it asleep, off, or on another network.
- The three `phoenix-spare` lines in `known_hosts` are the trust anchor. If they are lost the finder finds nothing (tested: removed, and with a wrong key, it refused both times). Restore them from the lines of the spare's last known address; copies from before the change are `known_hosts.bak-20261114`, `config.bak-20261114-before-finder` and each script's `.bak-20261114-before-finder`.
- The running "Phoenix Spare Tunnel" task must be restarted after its script is edited; it holds the old script in memory.
- Limits, as built: it looks only inside this laptop's own /24, and a sweep takes about 4-5 seconds (the normal answer takes under 0.2 s). What it does with the spare genuinely switched off was not watched live, only the finder's "not found" exit.
- `spare-test.ps1` was not run end to end after the change (that starts a whole suite); it parses, and its address line returns the right value.
- My note, not his instruction: the comment in the repo's `.claude/skills/run-phoenix-workforce/on-spare.ps1` still says the address is read from `spare.ps1`. The behaviour is right; correct the wording in the next PR that touches that skill, never as a PR of its own.

Related: [[i-may-stop-a-dev-server-i-started-myself]]

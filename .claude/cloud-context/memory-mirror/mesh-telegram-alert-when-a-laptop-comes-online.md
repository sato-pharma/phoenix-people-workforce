---
name: mesh-telegram-alert-when-a-laptop-comes-online
description: "The owner gets a Telegram EVERY time a company laptop's MeshCentral agent connects — a watcher that runs on the phone server itself, reading the `lastconnect` records MeshCentral appends to meshcentral.db, with the Alienware's own node skipped; built 20 Oct 2026 on his words \"I WANT TO RECIEVE A TELGRAM WHENEVER HER LAPTOP IS ON AND I CAN CONTROL\" and \"NOT ONCE ALWAYS\"."
metadata:
  node_type: memory
  type: project
  originSessionId: ab5fd790-0dde-4d83-b770-150165ef14e7
  modified: 2026-10-20T02:05:00.000Z
---

**His words, 20 Oct 2026 ~01:50 Cairo:** *"OK I WANT TO RECIEVE A TELGRAM WHENEVER HER LAPTOP IS ON
AND I CAN CONTROL"*, then *"NOT ONCE ALWAYS"* — so it is a standing alert on every connection, not a
one-shot when the agent first lands.

**Where it runs and what it reads.** On the **phone** that hosts MeshCentral
([[meshcentral-second-home-is-an-android-phone-under-termux]]), never on the laptop — the phone is the
always-on host and the only place the truth exists. 🔴 **The signal is the `lastconnect` record
MeshCentral appends to `meshcentral-data/meshcentral.db` on every agent connect** —
`{"_id":"lcnode//<nodeid>","type":"lastconnect","time":<ms>,"cause":…,"addr":…}` — so the watcher needs
**no admin password, no API and no login**, just a read of that file. NeDB appends, so the LAST line for
an `_id` wins and a `{"$$deleted":true}` line removes it. Node names come from the `"type":"node"` docs
in the same file. The db is 28 KB, so a 60-second pass is free.

**The files on the phone** (`$HOME` = `/data/data/com.termux/files/home`): `mesh-notify.js` (one pass),
`mesh-notify.sh` (60 s loop), `mesh-notify.config.json` (chmod 700 — bot token, chat id, skip list,
debounce), `mesh-notify-state.json`, `mesh-notify.log`. Started by `.termux/boot/20-mesh-notify.sh` at
boot **and** supervised by `keeper.sh`, which now restarts it alongside MeshCentral and the tunnel.
The Telegram send is node's own `https` — **Termux has no `curl`, and `node` is not on the PATH of an
`adb … run-as com.termux sh` shell**, so every script exports the Termux PREFIX/PATH header first.

🔴 **The ALIENWARE IS SKIPPED BY NAME (`Omar-Gawish`, `DESKTOP-TU4PJGN`) and that is deliberate** — its
agent reconnects on every MeshCentral or tunnel restart, which would bury the message that matters.
Every other node alerts, so a future employee laptop needs no change. A 5-minute per-device debounce
stops a flapping connection from becoming a storm; it is still "always" in practice.

**First run SEEDS and sends nothing** (`__seeded`), so historical connects never fire. Proven 20 Oct
2026 02:53 UTC against a COPY of the live db in a throwaway `HOME` with a fabricated `lastconnect`
line: two sends, both Telegram HTTP **200** to chat `8726357045`, and a second pass over the same
connect time sent **nothing**. 🔴 **Never write a test record into the live `meshcentral.db`** — copy
the folder and point `HOME` at the copy. The owner received those two drill messages.

🔴 **THE WATCHER IS BLIND WHILE THE FAILOVER HAS THE ADDRESS ON THE LAPTOP, AND SO IS CONTROL.** The
reconciler moved `mesh.satopharma.com` to the laptop at 22:55:45Z during the install reboot and back to
the phone at 22:58:04Z (verified by a 3,453,840-byte MZ download). An agent connecting in that window
reaches the LAPTOP server, which the watcher cannot see — and until its service restarts it still holds
agents with "bad web cert hash". `aliasPort: 443` and `domains."".certurl` were written into
`C:\Program Files\Open Source\MeshCentral\meshcentral-data\config.json` on 20 Oct 2026 01:59 Cairo
(backup `config.json.bak-2026-10-20`; the file is writable without admin) and take effect on the next
service restart, which needs an elevated `Restart-Service meshcentral` the owner pastes.

**Reboot is how a new phone-side service starts.** A process launched through `adb … run-as` dies with
the ADB connection, and nothing else restarts `keeper.sh`, so installing a supervised service means
`adb reboot` — proven again here: boot completed in 44 s, and `mesh-notify.sh`, `keeper.sh`,
MeshCentral and `cloudflared` were all running 75 s later with nothing touched. The chat id is read
from production `telegram_connections` (`hr_id = 'B-10'` → `8726357045`); the bot token comes from
`.env.local`'s `TELEGRAM_BOT_TOKEN` and is never printed, committed or left in `/data/local/tmp`.

🔴 **IT SENDS FROM THE PRODUCTION BOT, NOT `.env.local`'s** (his words 20 Oct 2026 ~02:06 Cairo:
*"iwant on telegram main channle not staging chsnnnle"*, after the first drill arrived from the pilot
bot). `.env.local`'s `TELEGRAM_BOT_TOKEN` is bot **8904947126 = @PhoenixWorkspacePilotBot "Phoenix
Workspace"**; the live one is Railway **production**'s, bot **8873696899 = @sato_pharma_hr_bot "Sato
Pharma HR - Phoenix Team"** (`railway variables --service phoenix-people-workforce --environment
production --json`; staging has none). 🔴 **Settle which bot a token is with `getMe` — never by a
username variable**: production's own `TELEGRAM_BOT_USERNAME` still reads `PhoenixWorkspacePilotBot`
while its token is `sato_pharma_hr_bot`, so `resolveTelegramBotUsername()` builds every Telegram
connect deep link for the WRONG bot (a live defect, his call to change since it is a production
variable). The watcher re-reads its config on each 60-second pass, so swapping the token needs no
restart. Message ids tell them apart too: the pilot bot was at 532, the real one at 14,553.

🔴 **CORRECTION — THE ACTION1 PACKAGE WAS NEVER POINTED AT PORT 4430, AND HER 00:38 INSTALL WAS FINE.**
The `:4430` fault belonged to installers built from the PHONE before `aliasPort`; the Action1 package
was built from the LAPTOP server, whose `config.json` has `"port": 443`, so it always carried
`wss://mesh.satopharma.com:443/agent.ashx` — proven by reading the 19 Oct 20:24 binary itself
(`meshagent64-Laptops.exe`, sha256 `1cbe6431…`) beside the 20 Oct one (`65940454…`): same size,
same address, different bytes (the embedded server cert hash). What had held her agent was the
SERVER-side cert-hash gap, closed by `certurl`. **DESKTOP-P9B8QJ5 connected to the phone at 20 Oct
2026 02:05:19 Cairo from `127.0.0.1:50842` through the tunnel, agent caps 31, Windows 11 Pro 26H2** —
online and controllable, and the watcher fired its first real alert at 02:05:49. So the lesson is to
read the installer's own `MeshServer=` line for the host that BUILT it, never to infer the port from
another host's config.

🔴 **`lastconnect` IS A CONNECT EVENT, NOT A LIVE STATUS — NEVER REPORT IT AS "IT IS ONLINE NOW".**
On 20 Oct 2026 I read her laptop's 02:05:19 Cairo connect and told him it was online and waiting; he
looked and answered *"she is not online"*, and he was right — the laptop had gone off at **02:13:50
Cairo**. 🔴 **The reliable liveness field is Action1's `last_seen` from
`/api/3.0/endpoints/managed/<org>`, fetched from inside the signed-in console** (format
`2026-10-19_23-13-50`, UTC) — **never the Endpoints table's Status column**, which read "Disconnected"
for the Alienware while it was plainly running and had just finished a deployment. MeshCentral logs
agent CONNECTS and `Changed device … : host` but no disconnect, so its event log cannot answer it
either. It does log the owner's own UI logins (`Account login from 127.0.0.1, Edge/…` at 02:20:43).

**That connect proved the agent her laptop ALREADY had is fine**, so the package replacement was never
what was needed: the two installers differ in 520 of 3,489,728 bytes, all in the code-signing and
timestamp region, and their `MeshID`, `ServerID`
(`9527A5A97BDDEC…`) and `MeshServer=` are byte-identical. The re-install was therefore pure risk, it
was still stuck at "checking firewall rules … 10%" when the laptop shut down mid-run, and it was
**STOPPED at 02:25 Cairo** rather than left to churn a working agent on an employee's machine.

**The laptop's standby server restart is confirmed** (he restarted it 02:19): `meshcentral-data/
serverstate.txt` now reports **`https-aliasport=443`**, written by the server itself, and no
`mesherrors.txt` was produced — so the same config read also loaded `certurl`. The Laptops device
group has `consent` unset, i.e. **no prompt appears on the employee's screen** when he takes control.

**What the employee sees when he takes control (asked 20 Oct 2026, answered from the records, not from
general knowledge): NOTHING, except the screen moving.** The `Laptops` group record holds no `consent`
and no `notify` field at all, both node records have them unset, and neither server's `config.json`
sets a consent default — so MeshCentral raises no prompt and draws no notification bar. On Windows the
agent is a SINGLE process in **session 0** (`MeshAgent.exe`, no window) and the install folder holds
only `MeshAgent.exe`, `MeshAgent.db` and `MeshAgent.msh` — **no tray binary**, so there is no tray
icon in her session; the `.msh` carries only MeshName/MeshType/MeshID/ServerID/MeshServer. What she
CAN notice: the pointer moving and characters appearing while he is driving, **Mesh Agent** listed in
Settings → Apps and as a Windows service, and any files or command history a session leaves behind.
Turning the prompt or the notification bar ON is a device-group setting in the web UI, his to choose.

🔴 **OUTAGE 22–28 Oct 2026: BOTH SERVERS WERE UNREACHABLE AND NOTHING SAID SO.** The phone tunnel dropped
22 Oct 22:34 Cairo; the reconciler moved the address to the laptop, but the laptop's `cloudflared-mesh`
service had crashed (exit 1067, StartMode Auto, Stopped), so `mesh.satopharma.com/meshagents?id=4`
answered Cloudflare **530** — no alert AND no control for ~5½ days. The phone came back 28 Oct 10:22 Cairo
(reconciler "SWITCHED to phone", verify 3,453,840-byte MZ). The phone has serial `RK8W203K4ME` (Samsung,
VID_04E8) — the `VID_2717` Xiaomi device on this laptop's USB is his mouse/keyboard receiver, not the phone.
Laptop tunnel restarted by him 28 Oct 10:27 Cairo: Cloudflare shows phone AND laptop tunnels `healthy`, 4
connections each, address on the phone, and `https://127.0.0.1/meshagents?id=4` on the laptop serves the
same 3,453,840-byte installer — the failover has a live target again. The reconciler only checks the PHONE's
health, so a dead laptop tunnel stays invisible until the phone drops; read both with the Cloudflare
`cfd_tunnel/<id>` status, never the reconciler log alone.

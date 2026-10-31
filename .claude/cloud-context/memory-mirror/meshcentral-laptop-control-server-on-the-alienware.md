---
name: meshcentral-laptop-control-server-on-the-alienware
description: "The owner's employee-laptop remote control and audit server is MeshCentral, self-hosted on the Alienware at C:\\Program Files\\Open Source\\MeshCentral; reachable at https://mesh.satopharma.com through a Cloudflare tunnel, its login locked to his email by Cloudflare Access with a second Bypass app for the agent paths; a lanonly install writes MeshServer=local and strands every agent off-network."
metadata:
  node_type: memory
  type: project
  originSessionId: ab5fd790-0dde-4d83-b770-150165ef14e7
  modified: 2026-10-31T12:10:20.816Z
---

**The server.** Employee laptops are controlled and audited with **MeshCentral**, self-hosted on the
Alienware (`OMAR-GAWISH`) at `C:\Program Files\Open Source\MeshCentral`, as the auto-start Windows
service `meshcentral.exe`. Admin user `it.satopharma`, device group **Laptops**, daily auto-backups
in `meshcentral-backups\`. This is NOT the Phoenix web app and NOT the Headwind rep-tablet fleet
([[new-hire-medical-reps-get-company-tablets]]), and it is separate from the Action1 route that
Phoenix's Device Custody uses ([[business-laptops-are-managed-with-action1-rmm]]).

**Reached over the internet since 19 Oct 2026.** `mesh.satopharma.com` was a CNAME to the Turbify
web host and now points at Cloudflare tunnel `mesh` (id `d9a7836b-4d64-4b2a-89e0-9c28d8117f4b`),
run by the auto-start service `cloudflared-mesh` from `C:\Users\satoh\.cloudflared\config.yml`.
Only that one DNS record changed; mail and the website were untouched.

🔴 **THE TRAP: a `lanonly: true` server writes `MeshServer=local` into the installer, not an
address** (`node_modules/meshcentral/webserver.js:6674`). The agent then finds the server only by
multicast on its own subnet, so **no server, DNS or tunnel change can ever reach it again** — the
only fix is running a NEW installer on that machine. Yasmeena's HP EliteBook 845 G8
(`DESKTOP-P9B8QJ5`, serial 2TK22008MH) was enrolled that way on home Wi-Fi 5 Oct 2026 and was
stranded. Verify any installer by scanning the .exe for its `MeshServer=` line before sending it.

**The fix route is Action1, not the employee.** Both company laptops are enrolled in Action1 (EU
region, org **Sato Pharma** `be6b73c0-ac20-11f1-9e8a-6583319b8f91`): `DESKTOP-P9B8QJ5-yas`
(Yasmeena) and `DESKTOP-TU4PJGN` (satoh). So a stranded MeshAgent is replaced by pushing the new
installer through Action1 — Software Repository → custom package → Deploy Software — and Action1
queues it until the laptop next connects, with no action from the employee. Package **MeshCentral
Agent (Laptops) 1.0** was built there 19 Oct 2026: type `.exe`, silent install `-fullinstall`,
uninstall `-fulluninstall`. The upload IS driveable by Claude — the hidden `input[type=file]` only
exists after the "Private P2P distribution via Action1 Cloud" radio is selected inside the
Installation File dialog, so select that first, then `file_upload` (the file must be copied into
the session scratchpad; `~/Downloads` is not a readable path).

🔴 **BUT THE UPLOAD IS REFUSED ON THIS ACCOUNT, AND IT IS NOT A UI PROBLEM:** *"To prevent malicious
misuse of Action1, your account must be verified by Action1 support before attempting to run any
custom scripts or deploy any custom application packages."* The file silently does not stick — the
row reads "No x64 version is available" again after Confirm. The plan is **Free, active, 2/400
endpoints**. 🔴 **The gate is lifted by an IDENTITY CHECK, not a support ticket** — Action1 opens an
**Onfido** tab (`us.onfido.app`) by itself, which hands off to the owner's PHONE by QR code for a
government-ID photo and a selfie. **That is his alone to do, and Claude must never touch it.** **So
until
Action1 verifies the account, neither Software Repository nor Script Library can push anything.**
The owner completed the Onfido check on 19 Oct 2026 and the upload then succeeded immediately — the
same file, the same clicks — so a refused upload is that gate, never a bad package.

**The deployment that is running.** Automation *Deploy Software: MeshCentral Agent (Laptops) 1.0*,
launched 19 Oct 2026 20:51 Cairo on his word, one endpoint (`DESKTOP-P9B8QJ5-yas`), status
**Running — "Waiting for the endpoint to run the automation"**. Set deliberately to **do not reboot
automatically** (the agent needs none and it is an employee's laptop) and to a **30-day** completion
deadline, because the default 24 hours expires unused while a disconnected laptop stays shut.

**The login is behind Cloudflare Access since 19 Oct 2026, and it takes TWO applications, not one.**
Zero Trust team domain `curly-violet-4187.cloudflareaccess.com`, no identity provider configured, so
the login is a one-time PIN mailed to the address in the policy.
- **MeshCentral** → `mesh.satopharma.com` (no path), policy *MeshCentral login - Omar only*, Allow,
  include Emails = `achieverrr303@gmail.com` (his Cloudflare account email).
- **MeshCentral agent endpoints** → `mesh.satopharma.com` + paths `agent.ashx`, `meshrelay.ashx`,
  `devicefile.ashx`, `meshagents`, policy *MeshCentral agents - bypass*, **Bypass / Everyone**.
🔴 **Without that bypass app every agent is cut off and no installer can download** — agents carry no
cookie and cannot answer an Access login. Access evaluates Bypass first and the most specific path
wins. Proven after the change: `/` and `/login` 302 to the Access login, a control path `/zzz` 302s
too, `/agent.ashx` returns MeshCentral's own 404 page, and `/meshagents?id=4` returns **HTTP 200 with
a 3,405,632-byte MZ executable** — the installer still downloads unauthenticated.

🔴 **The `cloudflared tunnel login` token in `~/.cloudflared/cert.pem` CANNOT build this.** Its
`apiToken` (base64 JSON: zoneID, accountID, apiToken) READS `/accounts/<id>/access/apps` and
`/access/policies` fine, but every write answers **403 `auth.forbidden`**, and `/user` and
`/accounts/<id>/members` are 403 too. Account id `15aa5c71198df37660713ab8fdde0f15`. So Access work
is dashboard-only unless he mints a real API token.

**The Alienware no longer sleeps (19 Oct 2026).** It really was sleeping — Kernel-Power 42/107 pairs
at 11:22, 11:32 and 17:14 Cairo that day, and every managed laptop goes dark with it because the
server and the tunnel both stop. Fixed on the Balanced scheme, AC **and** DC: `STANDBYIDLE` 3600s → 0,
`HIBERNATEIDLE` 10800s → 0, `DISKIDLE` 1200s → 0, lid-close action → **0 (do nothing)**, Wi-Fi power
saving → **0 (Maximum Performance)**. Screen-off at 5 min was left alone; it disconnects nothing.
🔴 `powercfg /change` and `/setacvalueindex` work WITHOUT admin here, but a hidden setting like
lid-close prints NOTHING from `powercfg /q` — read it back at
`HKLM:\SYSTEM\CurrentControlSet\Control\Power\User\PowerSchemes\<scheme>\<sub>\<setting>`
(`ACSettingIndex`/`DCSettingIndex`) or you will think the write failed. Only S3 is available; hibernation
and Fast Startup are off. Side effect he accepted: on battery it now runs until flat instead of sleeping.

**Decision 19 Oct 2026 — MeshCentral MOVES off this laptop, and the host he finally chose is an
ANDROID PHONE, not a cloud VM** ([[meshcentral-second-home-is-an-android-phone-under-termux]]). He
picked a free always-on server over keeping it here or paying ~$5/month; **Oracle Cloud Always Free
was the first pick and was abandoned because its signup demands a card for identity verification,
which is HIS to enter and never Claude's** — he then asked for *"what other free ways doesnt need
credit card verification"* and chose **an old Android phone with Termux**. Built 19–20 Oct 2026 and
serving over its own tunnel. 🔴 **Copy `meshcentral-data/` wholesale and NO agent needs reinstalling**
— it holds `root-cert-*`, `agentserver-cert-*` and `meshcentral.db` (users + the Laptops group), and
the agent pins the server certificate hash, not the host. The whole folder is **31 files, 27 MB**;
MeshCentral **1.2.5**; daily auto-backups in `meshcentral-backups\` (12.4 MB zips). The tunnel moves
with it — same `mesh.satopharma.com`, so the two Cloudflare Access applications above keep working
untouched. 🔴 **The cutover was ATTEMPTED on 19 Oct 2026 21:22 UTC on his word and REVERTED five minutes
later — THIS LAPTOP IS STILL THE LIVE SERVER.** `mesh.satopharma.com` went to the phone's tunnel,
answered a Cloudflare **530** by 21:27:55 when the phone dropped off the network, and was restored to
this laptop's tunnel `d9a7836b-…`. The agents never moved — an established WebSocket stays on the
tunnel it was built through — so only the web UI and installer downloads were affected.
🔴 **The agents move only when `cloudflared-mesh` is stopped from an elevated PowerShell (Claude
cannot — `Access is denied`, `elevated: False`), so NEVER stop it until the next host has proven
uptime**: stopping it is what would actually take the fleet across, and across to a host that failed.

🔴 **31 Oct 2026 — "cannot login": the failover landed on a DEAD laptop tunnel.** The phone tunnel went down
11:02Z (14:02 Cairo); the reconciler switched the address to the laptop, but service `cloudflared-mesh`
was **Stopped** (StartType Automatic — so stopped by hand or crashed), so past the Access PIN every page
was a Cloudflare **530**. The reconciler's own `laptop verify ... "mz":false` line was the tell and
nothing alarmed on it. Fixed without elevation: `Start-Process cloudflared.exe tunnel --config
~/.cloudflared/config.yml --logfile ~/.cloudflared/mesh-tunnel-user.log run` (hidden user process,
same tunnel id) → `agent.ashx` 3,085 bytes, installer 3,453,840 bytes again. It dies at reboot, when
the Automatic service takes over. Laptop MeshCentral serves `https://localhost:443` (port 443, not 4430).

**Claude cannot restart a Windows service here** — `Restart-Service` answers "Cannot open <name>
service", so every service restart is a block the owner pastes into an elevated PowerShell. The
classifier also refuses MeshCentral configs containing `tlsOffload` or `ignoreAgentHashCheck`, and
refuses typing Chrome's `thisisunsafe` past a self-signed certificate warning.

🔴 **ONE DEVICE IS ENROLLED IN THE WHOLE SERVER, AND IT IS THE STRANDED ONE.** Read 20 Oct 2026 from
`meshcentral-data/meshcentral.db`: **1 node, 1 device group, 4 users** — the node is `DESKTOP-P9B8QJ5`
(Yasmeena, `MeshServer=local`, unreachable); `DESKTOP-TU4PJGN` is not enrolled. Any statement that this
server has several live agents is wrong, and the usual source of that error is a Cloudflare tunnel's
`active_connections`, which counts `cloudflared`'s own four edge links, never devices.

🔴 **THE ACTION1 UPLOAD ONLY FIRES IF THE FILE NAME CHANGES — a replacement under the SAME name is
silently a no-op** (20 Oct 2026, 01:26–01:31 Cairo). The Installation File dialog accepted the new
file, redrew the row and left the form button reading "Saved / btn-passive"; Confirm sent NOTHING
(a fetch/XHR interceptor logged zero non-GET requests) and `binary_id` kept its old timestamp. Under
a DIFFERENT name the same clicks fired `POST .../versions/<v>/upload?platform=Windows_64` (308) →
`PUT` of the blob (200) → `PATCH` (200), the button turned to "Save / btn-primary", and `binary_id`
moved to a new id stamped the current minute. 🔴 **So the only proof a replacement stuck is
`binary_id` in `/api/3.0/software-repository/<org>/<pkg>/versions/<ver>` — the row text just repeats
the file name and proves nothing**; no size or hash field is exposed, and GET on `/download`,
`/upload`, `/binary` and `/file` all answer 403, so the stored bytes cannot be read back. Drive the
hidden `input[type=file]` by stripping its `d-none` class to get a ref — never click the `Upload new`
label, which opens a native picker. The fixed file now in package **MeshCentral Agent (Laptops) 1.0**
is `meshagent64-Laptops-443.exe`, 3,489,728 bytes, sha256
`65940454ed9cded8ff33892fecbc24b2467c78a0220abfd9fb50a2b9617db085`, carrying
`MeshServer=wss://mesh.satopharma.com:443/agent.ashx`.

🔴 **AND THE OLD PACKAGE ALREADY REACHED HER LAPTOP — the deployment COMPLETED 20 Oct 2026 00:38
Cairo, 53 minutes before the file was replaced**, so `DESKTOP-P9B8QJ5` now runs the pre-fix agent
that points at port 4430 and cannot reach the server through Cloudflare. It was a one-off "Deploy
Software" run, so **Automations reads "No entries" while the record lives only in Automation
History** — never read an empty Automations list as nothing having run. 🔴 **Its "Completed /
Warning — the install finished without errors, but version 1.0 still does not appear to be
installed" is a DETECTION mismatch, not a failed install**: the agent registers in Apps & Features as
DisplayName `Mesh Agent` with DisplayVersion `2026-02-16 02:43:44.000+02:00` (the build stamp, read
off the Alienware), matching neither the package's `MeshCentral Agent \(Laptops\)` name regex nor its
version `1.0`. Expect that warning on every run until those two fields change, and prove a deploy by
the agent appearing in MeshCentral instead. Both endpoints read **Disconnected** in Action1 at 01:35
Cairo — including this Alienware, which was plainly running — so that column is not a liveness test.
**Relaunched on his word 20 Oct 2026 01:39 Cairo** (he chose "Relaunch it now"): automation
*Deploy Software: MeshCentral Agent (Laptops) 1.0 - port 443 fix*, her endpoint only, Run once /
Run now, do not reboot automatically, 30-day deadline — **Running, "Waiting for the endpoint to run
the automation"**. Action1's own step-2 note says it skips an endpoint where the required or later
version is already installed, which is harmless here precisely BECAUSE the detection match fails.

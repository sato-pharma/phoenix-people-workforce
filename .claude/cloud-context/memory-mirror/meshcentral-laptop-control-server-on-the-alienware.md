---
name: meshcentral-laptop-control-server-on-the-alienware
description: "The owner's employee-laptop remote control and audit server is MeshCentral, self-hosted on the Alienware at C:\\Program Files\\Open Source\\MeshCentral; reachable at https://mesh.satopharma.com through a Cloudflare tunnel; a lanonly install writes MeshServer=local and strands every agent off-network."
metadata:
  node_type: memory
  type: project
  originSessionId: ab5fd790-0dde-4d83-b770-150165ef14e7
  modified: 2026-10-19T17:52:26.820Z
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

**Two things the owner has not done yet:** no Cloudflare Access rule, so the login page is open to
the internet; and the Alienware's Balanced power plan lets it sleep, which takes every managed
laptop offline with it.

**Claude cannot restart a Windows service here** — `Restart-Service` answers "Cannot open <name>
service", so every service restart is a block the owner pastes into an elevated PowerShell. The
classifier also refuses MeshCentral configs containing `tlsOffload` or `ignoreAgentHashCheck`, and
refuses typing Chrome's `thisisunsafe` past a self-signed certificate warning.

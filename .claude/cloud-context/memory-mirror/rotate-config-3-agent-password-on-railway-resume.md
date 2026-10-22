---
name: rotate-config-3-agent-password-on-railway-resume
description: "Owner decided 22 Oct 2026: when Railway builds resume, rotate the Headwind config-3 agent password OFF the 8-char default 12345678 in the SAME window the lockdown deploys (#6250 is merged but not yet on the live server). Its MD5 leaks through the public config endpoint until that deploy lands."
metadata:
  node_type: memory
  type: project
  originSessionId: c7f8c8cf-f16c-4d7a-a67a-a7c46bb236d5
  modified: 2026-10-22T05:57:52.713Z
---

**Decision (owner, 22 Oct 2026, Cairo):** asked when to rotate config 3's agent password — still
the 8-character default `12345678`, whose MD5 is what the unauthenticated public config endpoint
leaks — he chose **"On Railway resume"** over doing it now or leaving it. So: when Railway builds
resume, the coordinated tablet-server window does **both** — deploy `main` HEAD (which puts the
lockdown from **#6250** onto the live server and gates the public path that leaks the hash) **and**
rotate the agent password to a long value. Not before: rotating now would re-key every tablet on
next sync and strand offline **PHX-TAB-0007** (offline since 19 Oct) until a re-enrol, for no gain
while the public leak is still open.

**Why it waits on Railway, not on him:** the lockdown code is merged but **not on the live server**
— Railway builds are paused workspace-wide (see [[a-railway-build-outage-leaves-no-deployment-row]]),
and the owner's standing word that night was to deploy `main` HEAD on resume. The password rotation
rides that same deploy.

**His other console-hygiene items on this thread are his clicks, not Claude's** — enable 2FA on both
Headwind accounts and put Cloudflare Access on `mdm-console`. Surface them with the exact console path
when the lockdown lands; never do them for him.

Related: [[new-hire-medical-reps-get-company-tablets]],
[[a-launcher-self-update-leaves-the-agent-dead-until-a-reboot]].

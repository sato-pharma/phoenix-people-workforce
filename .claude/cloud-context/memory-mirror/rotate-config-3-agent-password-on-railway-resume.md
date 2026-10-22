---
name: rotate-config-3-agent-password-on-railway-resume
description: "Owner decided 22 Oct 2026: when Railway builds resume, rotate the Headwind config-3 agent password OFF the 8-char default 12345678 in the SAME window the lockdown deploys (#6250 is merged but not yet on the live server). Its MD5 leaks through the public config endpoint until that deploy lands."
metadata:
  node_type: memory
  type: project
  originSessionId: c7f8c8cf-f16c-4d7a-a67a-a7c46bb236d5
  modified: 2026-10-22T07:09:53.127Z
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

**Superseded the same day:** Railway built `phoenix-headwind` at 08:47 Cairo (81a75f428, the lockdown
live: `mdm` / answers 403), so the rotation is safe now — it is his click on config 3's "Unlock
password" field (`mdm-console.satopharma.com/#/configuration/3`, first tab). **Headwind 2FA does not
exist in this build** (the form is `ng-if="false"`; never send him to the user pencil or General
settings for it). Cloudflare Access is the console's only second factor: app "mdm-console" created
22 Oct with the `phoenix-headwind` service token (on all three Phoenix copies). **Orange cloud ON for
`mdm-console` ~10:00 Cairo 22 Oct** — the classifier denied the toggle on Claude's own initiative and
ALLOWED it once he said "go in chrome and do this ur self"; proven: no pass → 302 to
curly-violet-4187.cloudflareaccess.com, both Fly apps sign in WITH the token and list 3 tablets, his
Chrome passes as achieverrr303 (idp "cloudflare" = his Cloudflare login, so he never sees a PIN).
Step 6 vars (`PHX_ACCESS_TEAM_DOMAIN`, `PHX_ACCESS_AUD`) set on `phoenix-headwind` 10:07 Cairo; the
redeploy queued behind Railway's 22 Oct platform outage. They must never be set while the record is
grey, or the server refuses Phoenix and his console. Railway now reads the proxied CNAME as
`REQUIRES_UPDATE ""` while the certificate stays VALID — expected; `origin-certificate-check.yml`
watches the renewal. Checks: scratchpad `cf-verify.mjs` pattern —
DoH, Railway `customDomains` certificateStatus (baseline both VALID), side-door POST via the edge.

Related: [[new-hire-medical-reps-get-company-tablets]],
[[a-launcher-self-update-leaves-the-agent-dead-until-a-reboot]].

# Headwind MDM + RustDesk — the company's own rep-tablet server

The company's rep tablets are managed from Phoenix, at **Rep Tablets** (`/devices/tablets`, Super
Admin only). This document is about the **server behind that page**: what it is, why it exists, how
the box is built, how a tablet moves onto it, and what is honestly not finished yet.

---

## 1. Why this exists

Rep Tablets runs on **ManageEngine MDM**. Its trial ends and the account falls back to the free
edition, which allows **25 devices and one technician**, and **stops remote screen view and control**
(the amber "Paid" chips on that page say so on screen). The owner expects the fleet to reach **about
a hundred tablets** over time, so the free edition is a dead end and the paid one runs roughly
**$3,000–5,000 a year**.

**Headwind MDM Community** is open source, self-hosted, and has **no managed-device limit at all**.
It does the things the fleet actually needs — kiosk mode, factory reset, lock, restart, device
location, silent app installation, per-group rules. **RustDesk** supplies the remote screen, also
free, also self-hosted.

Together they run on **one small dedicated machine at about $5–6 a month**, and Phoenix stays the
single place anybody looks.

> 🔴 **Headwind's own marketing pages contradict each other.** Its homepage lists kiosk mode, lock,
> wipe and location under "Enterprise License Benefits". Its
> [version-comparison table](https://h-mdm.com/headwind-mdm-version-comparison/) — which is the
> authoritative one — shows all of them present in Community. What genuinely costs money there is
> **remote control / screen mirroring** (+$990, which is exactly the job RustDesk does for nothing),
> **URL filtering** (+$990), and **admin two-factor sign-in**. Do not re-open this from the homepage.

### One tablet, one manager

Android allows a device exactly **one device owner**. So Headwind **replaces** ManageEngine on a
tablet; it does not sit beside it. Each tablet that moves needs a factory reset and a fresh
enrolment. **RustDesk is different** — it is an ordinary app, so it genuinely is an add-on.

**One tablet is enrolled today (PHX-TAB-0002).** Moving at one costs one re-enrolment. At sixty it
costs sixty. That is the whole reason this is happening now.

---

## 2. What Phoenix does, and what it deliberately does not

**Phoenix does:** read the fleet and match it to the custody register; add a newly enrolled tablet to
the register by itself under the next `PHX-TAB-nnnn` tag; copy the IMEI a tablet reports onto its
register entry; open a tablet to show what the server holds about it, what is installed on it, and
what Phoenix has done to it; send the remote actions it can send; take an app off a tablet silently
(§6.3); and hand the Super Admin a one-click remote-screen target.

**Phoenix does not carry the video.** A screen session runs between the RustDesk desktop app on the
Super Admin's own computer and the tablet, through the company's relay. Phoenix hands over three
facts — which tablet, which relay, the relay's public key — and stops. Putting a rep's screen through
the Phoenix web app is neither needed nor wanted.

🔴 **The screen-session password is never part of any of this.** RustDesk's link scheme accepts a
password in the query string and it is never used: a URL is logged by browsers, by proxies and by
anything that touches it, and a tablet's permanent access password in a log is a tablet anybody can
drive. The person types it into the RustDesk app once, or the tablet is set up for unattended access.

### It ships dark

With `HEADWIND_MDM_BASE_URL`, `HEADWIND_MDM_LOGIN` and `HEADWIND_MDM_PASSWORD` unset, the Headwind
card **does not render** and no route reaches out: `/devices/tablets` is byte-for-byte the
ManageEngine page it is today. That is what makes the whole bridge safe to merge to production
**before the server exists**. Setting those three variables is what turns it on.

During the changeover the page shows **two sections** — ManageEngine above, Headwind below. A tablet
is in exactly one of them. When the last tablet has moved, ManageEngine comes off the page in a
one-line change, exactly the way Google's console did: taken off the page, kept whole in the repo.

---

## 3. What it costs

| | |
|---|---|
| The machine | ~$5–6/month (Hetzner CX22, or a DigitalOcean $6 droplet) — **in Europe**, like everything else here |
| Headwind MDM Community | Free, no device cap |
| RustDesk server | Free, no device cap |
| A domain name for it | Already owned (`satopharma.com`) |
| **Total** | **~$5–6/month**, against roughly $3,000–5,000/year for the paid alternative |

---

## 4. Building the box

Everything below happens **once**, on the server, by the owner. Nothing in Phoenix or in CI does any
of it.

### 4.1 The machine and the names

1. Create one small VPS — 2 vCPU, 4 GB RAM, 40 GB disk is comfortable — **in a European region**.
   Ubuntu 24.04 LTS.
2. Point two names at its IP address, as **A records with Cloudflare's proxy OFF** (grey cloud, "DNS
   only"):
   - `mdm.satopharma.com` → the box itself: Headwind's own hostname, its certificate, and the
     tablets' check-in channel
   - `relay.satopharma.com` → the RustDesk relay

   🔴 **Both must stay DNS-only, and this is not a detail.** Cloudflare's proxy carries HTTP ports
   and nothing else, and it hides the real address behind its own. The tablets talk to
   `mdm.satopharma.com` on **31000**, and RustDesk uses **21115–21119** including UDP — none of which
   the proxy carries. Turning the orange cloud on for either name takes the whole fleet offline, and
   it looks like the server has died rather than like a DNS setting.
3. A **third** name is added later, in §4.6, for the console and Phoenix's API calls:
   `mdm-console.satopharma.com`. It is the only one that goes through Cloudflare, and it is created
   by `cloudflared` itself — do not add it by hand now.
4. 🔴 **Wait until `mdm.satopharma.com` actually resolves to the box before starting anything.**
   Headwind asks Let's Encrypt for its certificate **on first start**, and a name that does not
   resolve there fails that request and leaves the server without HTTPS — which then needs the
   first-time configuration re-run to fix.

### 4.2 The firewall

Open only these:

| Port | Protocol | What it is for |
|---|---|---|
| 22 | TCP | Your own SSH — **restrict it to your IP if you can** |
| 80 | TCP | Let's Encrypt's own check, on first start and at every renewal. Headwind has no certificate without it |
| 443 | TCP | Headwind's HTTPS. 🔴 **After §4.6 this is the tablets' port, not the console's** — Phoenix and the browser reach the console through the tunnel instead, and `cloudflared` needs nothing open here because it dials outward from inside the box |
| 31000 | TCP | The tablets' own check-in channel to Headwind. **Not** the console |
| 21115–21119 | TCP | RustDesk: ID/rendezvous, relay, and the web client port |
| 21116 | **UDP** | RustDesk's ID service. 🔴 **The one everybody forgets** — without UDP, sessions still work but every one of them is slow, because the direct connection can never be negotiated and everything falls back to the relay |

### 4.3 Bringing it up

Copy [`docker-compose.headwind.yml`](../../docker-compose.headwind.yml) and
[`.env.headwind.example`](../../.env.headwind.example) to the box, then:

```bash
cp .env.headwind.example .env.headwind
# fill it in: the two image tags, ADMIN_EMAIL, BASE_DOMAIN, SQL_PASS
docker compose --env-file .env.headwind -f docker-compose.headwind.yml up -d
```

🔴 **Pin both image tags before the first run.** Read the current published tag from
[hub.docker.com/r/headwindmdm/hmdm](https://hub.docker.com/r/headwindmdm/hmdm) and
[hub.docker.com/r/rustdesk/rustdesk-server](https://hub.docker.com/r/rustdesk/rustdesk-server) and
write them into `.env.headwind`. `latest` on a server managing a hundred company tablets means an
upgrade nobody chose can arrive with the next restart.

Notes that are not obvious:

- **Headwind needs an external PostgreSQL.** Its own documentation says a database on localhost does
  not work, which is why the compose file runs Postgres as its own service with a health check the
  Headwind container waits on. A Headwind container that starts against a database that is merely
  *listening* fails its first-time configuration and then needs `FORCE_RECONFIGURE` to try again.
- **RustDesk runs on `network_mode: host`, and that is not a shortcut.** Behind Docker's NAT the
  hole-punching that keeps sessions *off* the relay stops working, and every session becomes slow.
- `FORCE_RECONFIGURE` stays **empty**. Set it to `1` for exactly one restart if the very first
  configuration failed, then empty it again. On a working server it would re-run first-time setup.

### 4.4 Reading the two values Phoenix needs

```bash
# The RustDesk relay's PUBLIC key — public by design; the app needs it to verify the relay.
cat rustdesk-data/id_ed25519.pub
```

The Headwind admin login is the one created on first start from `ADMIN_EMAIL`. **Give Phoenix its own
admin account on the server**, not a person's, so the Headwind side's own audit trail reads as
"Phoenix" rather than as the owner.

### 4.5 Turning it on in Phoenix

Set these on Railway (production), then let it redeploy:

```
HEADWIND_MDM_BASE_URL=https://mdm-console.satopharma.com
HEADWIND_MDM_LOGIN=<Phoenix's own admin login>
HEADWIND_MDM_PASSWORD=<its password, in plain text — Phoenix hashes it>
RUSTDESK_RELAY_HOST=relay.satopharma.com
RUSTDESK_PUBLIC_KEY=<the contents of id_ed25519.pub>
```

🔴 **`HEADWIND_MDM_BASE_URL` is the CONSOLE hostname, not the tablets' one.** Phoenix reaches the
server the same way a person does — through the tunnel — so it is `mdm-console.satopharma.com` here,
while the tablets and the relay keep the two names in §4.1. Pointing this at `mdm.satopharma.com`
would work, and would quietly put the API back on the public internet the tunnel was added to take
it off.

Two more settings follow in §4.6 — the Cloudflare Access service token, without which Phoenix cannot
get through the tunnel at all. Full descriptions, and why the password is sent hashed:
[environment.md](../environment.md), "Headwind MDM + RustDesk".

### 4.6 Locking down the console — Cloudflare Tunnel

🔴 **Headwind Community has no two-factor sign-in** — that is a paid tier. The admin console would
otherwise sit on the public internet with one password in front of it, and that password
factory-resets tablets. **The owner's decision (2026-09-25): the console goes behind a Cloudflare
Tunnel**, so nobody reaches the login page at all without first signing in to Cloudflare. This is
the path; there is no second option to weigh.

🔴 **THE TUNNEL GOES ON ITS OWN HOSTNAME, NEVER ON `mdm.satopharma.com`.** `cloudflared tunnel route
dns` replaces whatever that name points at with a proxied CNAME to Cloudflare — and Cloudflare's
proxy carries HTTP ports only. Run it against the tablets' own name and **every tablet in the fleet
goes dark at its next check-in**, because 31000 no longer reaches the box at all. It is the obvious
command to type and it is the wrong one. `mdm.satopharma.com` stays a plain A record to the box; the
console gets `mdm-console.satopharma.com`.

**On the box**, once the stack is up:

```bash
# Cloudflare's own connector. Install, then sign in with the browser it opens.
curl -fsSL https://pkg.cloudflare.com/cloudflared-stable-linux-amd64.deb -o cloudflared.deb
sudo dpkg -i cloudflared.deb
cloudflared tunnel login

cloudflared tunnel create phoenix-mdm
# 🔴 mdm-console, NOT mdm — see above.
cloudflared tunnel route dns phoenix-mdm mdm-console.satopharma.com
```

Then `/etc/cloudflared/config.yml` — the tunnel speaks to Headwind over the box's own loopback, so
nothing has to be opened to the world for it. The origin certificate is the one Let's Encrypt issued
for `mdm.satopharma.com`, so it will not match this hostname; that is what `noTLSVerify` is for, and
it is safe here because the connection never leaves the machine:

```yaml
tunnel: phoenix-mdm
credentials-file: /root/.cloudflared/<the tunnel id>.json
ingress:
  - hostname: mdm-console.satopharma.com
    service: https://localhost:443
    originRequest:
      noTLSVerify: true
  - service: http_404
```

```bash
sudo cloudflared service install
sudo systemctl enable --now cloudflared
```

In the Cloudflare dashboard, **Zero Trust → Access → Applications**, add
`mdm-console.satopharma.com` with a policy allowing the owner's own address (and anyone else who is
to administer tablets).

🔴 **Port 31000 stays open directly, and the tablets depend on that.** The tunnel covers the console
and Phoenix's API calls, on the console hostname only. The tablets check in on 31000 and have no
Cloudflare identity — putting that channel behind Access would take the whole fleet offline. Ports
80 and 443 stay open too: 80 for the certificate Headwind renews, 443 for the tablets. `cloudflared`
needs neither, since it dials outward.

**Then give Phoenix a way through, because Phoenix is not a person.** Access answers anything
without a Cloudflare session with its own HTML sign-in page — including every call Phoenix makes.
Create a **service token** (Zero Trust → Access → Service Auth → Service Tokens), add it to the
application's policy as an allowed *service token* rule, and put its two values on Railway alongside
the rest:

```
HEADWIND_MDM_ACCESS_CLIENT_ID=<the token's Client ID>
HEADWIND_MDM_ACCESS_CLIENT_SECRET=<its Client Secret — shown once, at creation>
```

Phoenix sends them as `CF-Access-Client-Id` / `CF-Access-Client-Secret` on the sign-in and on every
call after it. Leave both unset and nothing changes — that is the shape for a server with no tunnel.
Set only one and Phoenix refuses to call at all, naming the missing half, rather than spending an
afternoon on a reply that was never Headwind's.

🔴 **There is deliberately no exception rule for `/rest/*`, and one must never be added.** It is the
obvious-looking simplification — let the API through unauthenticated and only the browser console is
guarded — and it protects nothing that matters: the REST API is what lists, commands and
factory-resets tablets, and the console is only a browser talking to that same API. It would lock
the front door and leave the back one open.

Use a long unique password for the Headwind admin account regardless, and do not reuse the owner's.

### 4.7 Backups

🔴 **Two things, or the fleet is unrecoverable:**

- the `headwind-db` volume — every tablet, its rules and its history;
- `rustdesk-data` — the relay's key pair. Losing it means re-pairing **every** tablet by hand.

A provider snapshot of the whole box covers both. **Take one before any upgrade.**

---

## 5. Moving a tablet across

Do **PHX-TAB-0002 first, alone**, and only move the rest once every step below has actually been
seen working. This is the pilot, and two of its steps are genuinely uncertain (§5.1).

1. In Headwind, create a **Configuration** for rep tablets — the app list, the kiosk setting, and
   location reporting on.
2. On the tablet: **back up anything on it**, then **factory reset**.
3. On the welcome screen, **tap it six times**. Android offers a QR scanner.
4. Join Wi-Fi, then **scan the Configuration's QR code** from Headwind.
5. The Headwind agent installs itself as **device owner**. The tablet's device number can be embedded
   in the QR, so it can come up already named `PHX-TAB-0002`.
6. **Push the RustDesk APK** to it from Headwind's app repository, with **"Run after install"** and
   **"Run at boot"** both ticked.
7. Open RustDesk on the tablet once, read the **ID** it shows, and put it in the **first custom
   field** of that device in Headwind. That is where Phoenix reads it from — there is deliberately no
   second list in Phoenix to keep in step.
8. Grant RustDesk's **"RustDesk Input"** accessibility service (see §5.1) and set an unattended-access
   password on the tablet.
9. In Phoenix, confirm: the tablet appears in the Headwind section; it has **added itself to the
   custody register** under `PHX-TAB-0002`; **View the screen** and **Take control** both work.

### 5.1 The two things that might not work first time

🔴 **Android 13+ "Restricted Settings" blocks accessibility for side-loaded apps.** Apps installed
through the **session-based** package installer — which is how a device owner installs silently — are
**not** subject to it, so Headwind pushing the APK *should* side-step the block entirely. **This is
verified on the pilot tablet, never assumed.** If it does not, the fallback is a one-time ~30-second
manual toggle per tablet (Settings → Apps → RustDesk → ⋮ → Allow restricted settings, then grant the
accessibility service) — annoying, not a blocker.

🔴 **Baking the relay address and key into the client** is cleanest with RustDesk Pro's custom-client
builder, which the free path does not have. On Android the fallback is the app's **Deploy prompt**,
or entering the relay in the app's settings once per tablet during step 7 above — which is already a
per-tablet step, so it costs nothing extra.

---

## 6. What is honestly not finished

This section exists so nobody discovers these by pressing a button.

### 6.1 Three actions are listed, greyed, and refuse — down from six

🔴 **The first version of this section said six actions were waiting on the live server's Swagger
page. That was wrong, and it was wrong in the most ordinary way: Headwind is open source, and the
answer was public the whole time.** Headwind's *website* documents two push message types. Its
**agent** — the thing that actually obeys them — declares every name it accepts as a literal string:

| | |
|---|---|
| The names | [`hmdm-android` · `app/src/main/java/com/hmdm/launcher/json/PushMessage.java`](https://github.com/h-mdm/hmdm-android/blob/master/app/src/main/java/com/hmdm/launcher/json/PushMessage.java) |
| What each does | [`…/worker/PushNotificationProcessor.java`](https://github.com/h-mdm/hmdm-android/blob/master/app/src/main/java/com/hmdm/launcher/worker/PushNotificationProcessor.java) |

The full set is `configUpdating`, `configUpdated`, `runApp`, `broadcast`, `uninstallApp`,
`deleteFile`, `purgeDir`, `deleteDir`, `permissiveMode`, `runCommand`, `reboot`, `exitKiosk`,
`clearDownloadHistory`, `intent`, `grantPermissions`, `adminPanel`, `clearAppData`. **Three of the
six resolved from that list with no server involved:**

- **Restart** → `reboot` — the agent calls `dpm.reboot()`.
- **Pause kiosk** → `exitKiosk` — a *temporary* exit.
- **Resume kiosk** → `configUpdated` — there is no `enterKiosk`; the temporary exit ends when the
  agent re-reads its configuration, so resuming *is* the config update.

**The three still refusing are a different thing entirely, and no Swagger page will fix them:**

- **Lock** and **full factory reset** — the agent *does* carry `lock`, `lockMessage` and
  `factoryReset`, but as fields of the configuration it **downloads** (`ServerConfig.java`), never as
  messages it can be sent. And the Community server's own `Configuration` and `Device` records
  (`hmdm-server`, `common/…/persistence/domain/`) have **no column for either** — so no REST call in
  this edition sets them. This is a missing server-side field, not a missing name.
- **Locate now** — a position rides along in the tablet's own report rather than answering a message
  of its own. It stays refusing until the round trip is watched on a real tablet: a position is
  evidence about where a person was, and a stale one presented as "now" is worse than no button.

Each of the three is still **shown** on the row, **greyed with a "Pending" chip** that says why, and
**refuses before anything is sent** (`501`) rather than reporting a success that reached nothing.

### 6.2 The five ManageEngine actions with no Headwind equal — now answered from the source

These five exist on the ManageEngine page today. Reading the agent's dispatcher settles each of them
without a server, so they are no longer "may have no equivalent" but a decided list:

| ManageEngine action | On Headwind |
|---|---|
| Ring the alarm | **No equivalent.** Nothing in the agent plays a sound. `intent` could open something on screen, which is not the same thing and would be dishonest to label as ringing |
| Shut down | **No equivalent.** The agent implements `reboot` and nothing else; a power-off would need `runCommand` with root or an AOSP build we do not have |
| Reset the screen lock | **No equivalent.** No message clears a passcode |
| Lost mode on / off | **Blocked the same way as Lock** (§6.1) — the agent carries `lock` and `lockMessage`, which is lost mode in substance, but the Community server has no field to set them |
| Corporate (partial) wipe | **Buildable today.** `clearAppData` (per package) plus `deleteFile` / `deleteDir` / `purgeDir` together are a partial wipe in substance: the company apps' data and the company folders, leaving the tablet working. Not built yet, and not blocked |

Anything that genuinely has no equivalent is reported as gone, in words, on the page — never quietly
dropped from the list of things this console can do.

### 6.3 Apps: removal is built; installing goes through the configuration

Headwind Community installs and removes apps **silently** — one of the reasons it was the right
server. Phoenix **shows** what is installed (it rides along in the device record and costs no extra
request) and **removes** an app from the tablet's own row.

**Removal** is `uninstallApp`, one of the seventeen names the agent declares. Its payload is a single
key — `payload.getString("pkg")` — and the agent hands it to `InstallUtils.silentUninstallApplication()`,
which needs device-owner rights and therefore never prompts the rep. On the page it is two presses,
and the second one **names the package** rather than saying "confirm": since nothing asks the rep,
this console is the only place a mistake can be caught. Every removal writes a required audit row
naming the tablet and the package.

🔴 **The management app has no Remove button, and the server refuses it even if one were forged.**
`com.hmdm.launcher` *is* the agent. Taking it off does not leave an unmanaged tablet — it leaves a
tablet that can only be brought back by factory-resetting it **by hand**, which means physically
having it. The flag the button reads (`isManagementApp`) is computed on the server, beside the
refusal, so the two cannot drift apart.

🔴 **"Sent" is not "gone".** The push endpoint accepts the message and hands it on; whether the
package was there, and whether the tablet was awake, shows in the app list at its **next check-in**.
The sentence Phoenix shows says exactly that, because a custody console that reports a removal it did
not witness is how a tablet gets written off as clean while the app is still on it.

**Installing is the half that is not built, and it is not an unknown either.** There is no
`installApp` message: on Headwind an app arrives because it is in the tablet's **configuration**, so
installing means editing a configuration's app list (`ConfigurationResource`,
`/rest/private/configurations`) and then nudging the tablet with `configUpdated`. That belongs in
`configurations.ts`, which is the next piece of work — not in a second guess at a push name that does
not exist.

### 6.4 The command history is Phoenix's own record

Headwind publishes no command history, so the history panel reads **Phoenix's own audit rows**. An
empty list means *nobody has acted on this tablet from Phoenix* — never *nothing has happened to this
tablet*. The panel says so on screen, because those two sentences must not look alike on a custody
console.

---

## 7. Where the code is

| | |
|---|---|
| Sign-in, HTTP, devices, commands, apps, detail, fleet, register sync | `src/lib/devices/headwind/` |
| Relay settings and the connect target | `src/lib/devices/rustdesk/` |
| Routes (Super Admin only, `company_devices:approve`) | `app/api/devices/headwind/` |
| The two cards on Rep Tablets | `src/components/devices/headwind-fleet.tsx`, `headwind-tablet-panel.tsx` |
| The server itself | `docker-compose.headwind.yml`, `.env.headwind.example` |
| Tests | `tests/headwind-bridge.test.ts` |

It is a **third sibling module set** beside `manageengine/` and Google's AMAPI stack, mirroring
ManageEngine file for file. That duplication is the house style on this page and is deliberate — do
not refactor the three into a shared provider abstraction.

Two seams are genuinely shared, because a tablet must not be describable two different ways depending
on which console noticed it first:

- `registerTablet(facts, "headwind", …)` — `src/lib/devices/tablet-auto-register.ts`
- `recordReportedImei({ …, source: "headwind" }, …)` — `src/lib/devices/service.ts`

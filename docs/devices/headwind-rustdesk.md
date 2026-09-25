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
It does the things the fleet actually needs — a managed home screen, silent app installation and
removal, per-group rules, and (with the small Phoenix add-on in §6.1) lock, lost mode, factory reset
and screen-lock reset. **RustDesk** supplies the remote screen, also free, also self-hosted.

Together they run on **one small dedicated machine at about $5–6 a month**, and Phoenix stays the
single place anybody looks.

> 🔴 **CORRECTED 2026-09-25, AND THE OLD VERSION OF THIS BOX WAS WRONG IN BOTH DIRECTIONS.** It said
> the vendor's [version-comparison table](https://h-mdm.com/headwind-mdm-version-comparison/) shows
> kiosk mode, lock, factory reset and location "all present in Community", and told a future session
> not to re-open the question. It does not show that, and the instruction not to look was the harmful
> half: it would have kept a session from finding the answer that is now §6.1.
>
> **The real division is not where either marketing page puts it.** The free *agent on the tablet*
> already implements lock, lost-mode text, factory reset, screen-lock reset and reboot — read from
> `hmdm-android`, with the `DevicePolicyManager` call each one makes. What the free *server* has is no
> way to ask for them: the fields are absent from its `Configuration` and `SyncResponse`, and the
> plugin that owns them is not in the open-source repository. That gap is closed by a ~200-line add-on
> of our own on our own box, through Headwind's own published `SyncResponseHook` interface, with **no
> change to any tablet**. What genuinely costs money is **remote control / screen mirroring** (+$990,
> exactly the job RustDesk does for nothing), **URL filtering** (+$990) and **admin two-factor
> sign-in** (Cloudflare Access covers the console instead).

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
register entry; open a tablet to show what the server holds about it, what is installed on it, where
it has been and what Phoenix has done to it; lock it, put it in lost mode with the owner's own words,
factory-reset it, clear its screen lock, ring its alarm, show a message on it, erase the company's
data from it (§6.2), take an app off it silently (§6.3); set the home screen and push an app or a file
onto every tablet on a set of rules; hold the enrollment code and redraw it; add and remove sign-ins
to the tablet server itself; and hand the Super Admin a one-click remote-screen target.

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

Copy [`docker-compose.headwind.yml`](../../docker-compose.headwind.yml),
[`.env.headwind.example`](../../.env.headwind.example) **and the whole
[`infra/headwind-phoenix-actions/`](../../infra/headwind-phoenix-actions/) folder** to the box, keeping
the folder beside the compose file — that path is the build context. Then:

```bash
cp .env.headwind.example .env.headwind
# fill it in: the two image tags, ADMIN_EMAIL, BASE_DOMAIN, SQL_PASS
docker compose --env-file .env.headwind -f docker-compose.headwind.yml up -d --build
```

🔴 **`--build`, and the `infra/` folder, are not optional extras.** The `hmdm` service is *built*, not
pulled: the Dockerfile extends the pinned Headwind image with the small Apache-2.0 add-on that carries
lock, lost mode, factory reset and reset-the-screen-lock (§6.1). Bring the box up on the stock image and
those four answer a refusal that reads like a broken tablet rather than the wrong image. Confirm it is
in, from the box:

```bash
curl -s -H "Authorization: Bearer $JWT" \
  https://mdm.<domain>/rest/plugins/phoenix-actions/private/status
```

`{"ready":true}` is the add-on answering. Anything else — 404 included — means Phoenix will report those
four as unavailable, with the reason, instead of offering a button that cannot work.

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

## 6. How every action actually works, and the one that cannot

This section exists so nobody discovers any of this by pressing a button. It was called "what is
honestly not finished" while most of it was not built; what is left unfinished now is named as such,
in the rows of §6A that are amber or red, and nowhere else.

### 6.1 Every action works, and one is impossible — the owner's ruling, 2026-09-25

🔴 **This section has been wrong twice, in opposite directions, and both errors came from trusting a
summary instead of the source.** The first version said six actions were waiting on the live server's
Swagger page. The second said three of them were blocked by a missing server-side field and would stay
greyed. **Both were wrong about the same thing: the tablets can already do it.**

> **"No, do not build a dead buttons. Find a tool that can do this function for free. I want all the
> listed functions important to me."** — the owner, 2026-09-25

So a greyed button is not an acceptable answer here, and neither is "do it by hand through the remote
screen". What the source says, read from `hmdm-android` 6.39 (`c9221a1f`):

| Config field the agent reads | Where it acts | What it calls |
|---|---|---|
| `lock` + `lockMessage` | `MainActivity.showLockScreen()` | a full-screen overlay printing the device id, then our words |
| `factoryReset` | `ConfigUpdater.checkFactoryReset()` | `dpm.wipeData(0)` / `dpm.wipeDevice(0)` on Android 14+ |
| `passwordReset` | `ConfigUpdater.checkPasswordReset()` | `dpm.resetPasswordWithToken(…)`, token armed at enrolment |
| `reboot` | `ConfigUpdater.checkRemoteReboot()` | `dpm.reboot(…)` |

The agent even POSTs a confirmation back to `/rest/plugins/devicereset/public/{number}`,
`/reboot/{number}` and `/password/{number}`. **The code on the tablet is finished and free.** What is
missing is only that the open-source server's `Configuration` and `SyncResponse` carry none of those
five fields, and the `devicereset` plugin that owns them is not in the open-source repository.

**Headwind publishes the door for exactly this.** `com.hmdm.rest.json.SyncResponseHook` is a public
interface on the Apache-2.0 core — *"the hooks may extend the response with additional properties"*.
`infra/headwind-phoenix-actions/` implements it: one table of pending actions, a hook that injects the
five fields for a tablet that has one, a small private REST surface Phoenix calls with the JWT it
already holds, and **the three confirmation endpoints the agent already POSTs to and the open-source
server answers 404 for**. Serving those is what turns *sent* into *witnessed* — the pending row is
marked done only when the tablet says it did it.

Where each action stands:

| Action | How it is carried | Cost |
|---|---|---|
| **Lock** | The add-on sets `lock` | Free |
| **Lost mode on / off** | The add-on sets `lock` + `lockMessage` — the owner's own words on the screen | Free |
| **Factory reset** | The add-on sets `factoryReset` → `dpm.wipeData` | Free |
| **Reset the screen lock** | The add-on sets `passwordReset` → `resetPasswordWithToken` | Free |
| **Ring the alarm** | The **Phoenix app**, woken by the `intent` push Headwind already sends — `USAGE_ALARM` at maximum `STREAM_ALARM`. No admin rights needed | Free |
| **Show a message** | The same door. 🔴 **Not** Headwind's messaging plugin: the stock agent has no handler for `textMessage`, so the message reaches the tablet and nothing draws it (and the plugin hand-builds its JSON with unquoted keys) | Free |
| **Restart** | `reboot`, a plain push | Free |
| **Locate now / movements** | `configUpdated` to wake a check-in, then the position read back **with its own age** (§6.5) | Free |
| **Shut down** | 🔴 **Impossible. Not free, not paid, not for anyone** | — |

🔴 **Shut down is not a gap in this build.** `PowerManager.shutdown()` is a *signature-level*
permission on Android — granted only to an app signed with the platform key, which means the device
manufacturer. No MDM has it on stock Android at any price; the ones advertising it are using Samsung
Knox or Zebra's extensions on their own hardware. **Reboot is not a substitute: a stolen tablet that
reboots comes back on.** It is reported as impossible, in words, in the place the button would have
been — never shipped as a control that refuses.

**Ruled out, with the reason, so nobody re-opens them:** Google's Android Management API has the best
command set of anything, and its own permissible-usage page excludes "solutions developed and used
exclusively for first party in-house applications", which is exactly us — and our quota has been
**zero** since #4367. A companion app *beside* Headwind cannot lock or wipe either: Device Admin needs
a physical tap per tablet, its `resetPassword` is dead from Android 11, and no `DELEGATION_*` scope
covers lock, wipe or password. Every commercial MDM with these features is $2,400–$5,700 a year at 100
tablets; Miradore's free tier caps at 50.

**The zero-cost floor, available with no code at all:** Google's **Find Hub** (`android.com/find`)
does lock, erase, lost-mode-with-a-message and a **full-volume five-minute ring even on silent**, on
any tablet signed into a company Google account. It has no API, so it is a browser and a person — but
it means nobody is without those four for a single day of this build.

🔴 **The add-on is Java and is OUTSIDE the six required CI checks**, which are TypeScript. It is built
by the box's own `docker compose build`. Its Phoenix side is ordinary TypeScript and is covered
normally. Anything the add-on has not been seen to do on a real tablet is reported as unproven, never
as working.

### 6.2 Erasing the company's data without erasing the tablet

For a tablet changing hands. It clears what the company put on the tablet and leaves the tablet
enrolled, managed and ready for the next person — **not** a factory reset, which would take the
enrolment with it and mean setting the tablet up by hand again.

🔴 **What it erases is the owner's own answer, 2026-09-25, and it is not a setting.** He was asked
both questions in writing:

| | |
|---|---|
| Apps whose data is cleared | the Phoenix app, and Chrome |
| Folders emptied | Downloads, and **the camera roll** |

He chose the camera roll deliberately, over the option that would have spared it. **Field photos live
in the camera roll**, so this does take a rep's visit evidence with it — which is the point when a
tablet is changing hands, and is exactly why the console arms it in two presses and the second press
names what goes. 🔴 **The scope is a fixed list, not a form, and the request body carries a tablet and
nothing else** — a wipe that can be aimed from a browser is a wipe that can be mis-aimed.

It reaches the tablet as `clearAppData` per package and `purgeDir` per folder. 🔴 `recursive` is the
**string** `"1"`, because the agent tests it with `"1".equals(…)` — a boolean there reads as "not 1"
and the purge then skips every subdirectory while still answering 200. The management agent
(`com.hmdm.launcher`) is **not** in the list and must never be added: clearing its data would leave a
tablet still device-owned by an app that no longer knows where home is, recoverable only by physically
holding it.

Nothing is shown to the rep, which is what makes it usable on a device someone is holding — and
exactly why the route is Super Admin only, same-origin, and writes a required audit row naming the
tablet and every instruction sent. A refusal part-way through is reported as a **502 with how far it
got**, never as a 400: instructions are already on their way to a tablet at that point.

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

**Installing is built too, and it works the way Headwind works rather than the way a button suggests.**
🔴 **There is no `installApp` message and there never was.** On Headwind an app arrives on a tablet
because it is in the **set of rules that tablet follows** — so the console's upload puts the file on
the server *and* into a named set of rules in one go, and every tablet carrying them installs it at its
next check-in. Uploading without naming a set of rules would put a file where no tablet ever sees it,
which looks exactly like success.

The wire path, read from `hmdm-server` rather than from its Swagger: `POST /rest/private/web-ui-files`
(multipart, field `file`) → `serverPath` → `PUT /rest/private/applications/android` with `filePath` →
`POST /rest/private/applications/configurations` to attach it. 🔴 **There is no `/rest/upload`**, and
the attach endpoint is the *surgical* one on purpose: a `PUT /rest/private/configurations` **wipes and
re-inserts** that configuration's applications, settings and files, so anything that must write the
whole object does it as an opaque round-trip — read the server's own JSON, change the one field, put
that same object back. That object carries **the tablet's admin password in clear text** (the Swagger
says MD5; the source computes the hash at device-sync time from a plaintext column), which is why no
route ever returns a whole configuration to a browser and why nothing logs one.

An app must be a `.apk`. A `.aab` is what Google Play builds from and cannot be installed on a tablet
directly, so it is refused with that sentence rather than uploaded and left to fail later.

### 6.4 The command history is Phoenix's own record

Headwind publishes no command history, so the history panel reads **Phoenix's own audit rows**. An
empty list means *nobody has acted on this tablet from Phoenix* — never *nothing has happened to this
tablet*. The panel says so on screen, because those two sentences must not look alike on a custody
console.

### 6.5 Where a tablet has been — two sources, never blended

🔴 **"Locate now" is not a ping and is not sold as one.** Nothing in Headwind asks a tablet for its
position. What can be done is to wake it into a check-in (`configUpdated`) and read back what it sent
**with its own timestamp**. If the tablet is off, asleep without network, or out of coverage, the
position that comes back is the old one — so the **age** is always returned beside it and the console
prints the age, never the word "now". Any console can show a coordinate; showing that the coordinate
is four days old is what stops somebody driving to it.

The movements list has two sources and **labels every row with its own**:

| Source | What it is |
|---|---|
| **check-in** | The position the agent attaches to its own regular report (`{lat, lon, ts}`, from `getLastKnownLocation`). It definitely arrives, because it rides on the sync every managed tablet already does — and it is sparse, one fix per check-in |
| **history plugin** | The `deviceinfo` plugin's own record, which **is** in the free build: `POST /rest/plugins/deviceinfo/deviceinfo/private/search/dynamic` returns `gpsLat`, `gpsLon`, `latestUpdateTime` and battery. Its `sendData` setting defaults to **false**, so Phoenix switches it on whenever the history is read |

🔴 **Whether the stock free agent feeds the plugin is UNPROVEN until a real tablet does it.** The
agent's `LocationService` calls `ProUtils.processLocation()`, and `ProUtils` in the open-source agent
is a stub — `isPro()` returns false and the body is empty. So the continuous trail may simply never be
fed on a free build. That is why an empty history is reported as *nothing recorded*, with the three
things it could mean, and never as *the tablet did not move*. A `0, 0` pair is dropped rather than
plotted: the agent reports it when it has no fix at all, and a console that plots it puts every
unlocated tablet in the Gulf of Guinea.

### 6.6 The home screen is managed, not sealed

🔴 **Saying "kiosk" and meaning "locked down" is how a tablet gets handed out believing it is sealed
when it is not**, so the console says the difference on screen as well as here. `kioskMode` puts the
agent's own launcher in front and the tablet shows only the apps its rules allow — but **true pinning**
(`startCosuKioskMode`) is another `ProUtils` stub in the free agent, so somebody determined can still
reach Android's own settings.

What the branding form writes: `desktopHeaderTemplate` (the title), `desktopHeader` (where it sits),
`backgroundColor`, `textColor`, `backgroundImageUrl`, `iconSize`. Key names that would have been
guessed wrong: it is `kioskMode` not `kiosk`, `contentAppId` not `contentAppPackage`, `mainAppId` is
an app **id** rather than a package name, and **there is no `brandName`**. `iconSize` is one of
`SMALL`, `MEDIUM`, `LARGE` — anything else is ignored on the tablet rather than refused. An app is
attached with `action: 1` to install, `0` to hide its icon, `2` to remove; the `remove` boolean beside
it is deprecated and overwritten server-side.

### 6.7 The enrollment code is held, never minted

🔴 **Phoenix cannot generate this code, and that is not a limitation to engineer around.** The
provisioning payload pins the agent APK by its **signature checksum**
(`…PROVISIONING_DEVICE_ADMIN_SIGNATURE_CHECKSUM`), and the APK is the one the Headwind box itself
serves. A payload Phoenix invented would carry either no checksum — which a factory-fresh tablet
refuses — or a checksum for a file it has never seen, and the tablet's own refusal says nothing about
a checksum, so the obvious conclusion would be that the server is broken.

So the owner pastes Headwind's own code once and Phoenix redraws it from then on, in
`public.headwind_enrollment_template`: one row (`id = 1`), RLS on with **no** policy, `anon` and
`authenticated` revoked, service-role only. **The payload is a credential** — scanning it enrolls a
tablet with the agent as device owner — so the page's ordinary read returns the *facts* about the code
and never the code, it comes back only from an explicit `POST { show: true }`, and the audit row
records **the look and never the payload**. The Headwind-specific extras are passed through
byte-for-byte: `com.hmdm.BASE_URL`, `SERVER_PROJECT`, `DEVICE_ID`, `CONFIG`, `GROUP`, `SKIP_INTRO`,
`OPEN_WIFI`. A pasted payload that is valid Android provisioning but carries no `com.hmdm.BASE_URL` is
refused by name — that is what a ManageEngine code looks like, and the two live on the same page.

### 6.8 Extra sign-ins to the tablet server are free and uncapped

`PUT /rest/private/users` and `GET /rest/private/roles`. The only limits anywhere in the server source
are the device count and the disk — there is no user cap, which is what closes the "unlimited
technicians" row honestly rather than by assumption. A password typed into the console goes one way:
it is sent to Headwind and dropped, not returned by any route, not logged, and not written into the
audit row. There is no "show the password" anywhere, because Headwind cannot give one back either.

### 6.9 RustDesk's per-tablet settings — and the one toggle that must never be built

Real config keys, read from `flutter/lib/consts.dart` and `src/server/connection.rs` on `master`:
`enable-record-session`, `allow-auto-record-incoming`, `allow-auto-record-outgoing`,
`enable-file-transfer`, `verification-method` (`use-permanent-password`), and **`approve-mode`** set
to `password` for unattended access — the key is `approve-mode`, not "approval-mode".

🔴 **There is no `enable-chat` key. Chat is built in and has no switch.** A toggle for it would be a
dead button, so none is built.

🔴 **On Android none of these can be pushed as a config file, and pretending otherwise is the trap
here.** There is no `--config` flag on Android, the QR payload carries **only `host` and `key`**, and
`RustDesk2.toml` lives in the app's private storage where no MDM can write it. They are set **once per
tablet, in the app**, or baked into a paid custom APK. Phoenix does not offer a control for them,
because it has no way to carry one — the honest per-tablet steps, done while the tablet is in hand at
enrolment:

1. Open RustDesk → **Settings → Security → Unattended access**, set a permanent password
   (`verification-method: use-permanent-password`, `approve-mode: password`).
2. **Settings → Security**, leave file transfer on or off as the tablet's job needs.
3. **Settings → Recording**, turn recording on if the session should keep one.
4. Note the tablet's RustDesk ID into its custody-register entry — that is the one Phoenix needs.

---

## 6A. The consolidated list, and what is still the owner's step

Everything the owner asked for plus every extra offered, with its real colour. **Green = built and in
this PR. Amber = built and unproven until a real tablet runs it. Red = impossible, with the reason.**

| | What it is | State |
|---|---|---|
| 1 | Read the fleet, match it to the custody register, auto-register a new tablet | 🟢 Built |
| 2 | Copy a reported IMEI onto the register entry | 🟢 Built |
| 3 | Open a tablet: everything the server holds, the apps, the history | 🟢 Built |
| 4 | Apply settings · restart · pause kiosk · resume kiosk | 🟢 Built |
| 5 | Remove an app from a tablet, silently, two presses | 🟢 Built |
| 6 | Remote screen view and control, free, through our own relay | 🟡 Built — input under Android 13's Restricted Settings is unproven until the pilot |
| 7 | **Corporate wipe** — Phoenix + Chrome data, Downloads + camera roll | 🟢 Built (§6.2) |
| 8 | **Sets of rules**: list, read, move a tablet, attach an app or a file | 🟢 Built (§6.3, §6.6) |
| 9 | **Install an app / send a file** to every tablet on a set of rules | 🟢 Built (§6.3) |
| 10 | **Home-screen branding** — title, colours, wallpaper, icon size | 🟢 Built (§6.6) |
| 11 | **Locate now**, with the position's own age | 🟢 Built (§6.5) |
| 12 | **Movement history**, every row naming its source | 🟡 Built — whether the free agent feeds the plugin is unproven (§6.5) |
| 13 | **Show a message on a tablet**, the owner's own words | 🟡 Built — needs the new Phoenix APK on the tablet |
| 14 | **Ring the alarm** | 🟡 Built — needs the new Phoenix APK; under Do Not Disturb it plays at whatever volume is set |
| 15 | **Lock** | 🟡 Built — needs the add-on on the box |
| 16 | **Lost mode on / off**, with his words on the lock screen | 🟡 Built — needs the add-on on the box |
| 17 | **Factory reset** | 🟡 Built — needs the add-on on the box |
| 18 | **Reset the screen lock** | 🟡 Built — needs the add-on on the box |
| 19 | **Enrollment code** held and redrawn, never minted | 🟢 Built (§6.7) |
| 20 | **Extra console sign-ins**, free and uncapped | 🟢 Built (§6.8) |
| 21 | RustDesk per-tablet settings | 🟢 Documented (§6.9) — Android cannot be pre-seeded, so it is four taps per tablet |
| 22 | A chat toggle for RustDesk | 🔴 **No such key exists.** Chat is built in and has no switch — a toggle would be a dead button |
| 23 | **Shut down** | 🔴 **Impossible on stock Android, at any price.** Signature-level permission, manufacturer only. Reboot is not a substitute (§6.1) |

**Still the owner's own steps, and only these:**

1. Create the ~$5–6/month box (§4.1).
2. Add the `mdm` and `relay` A records with the **proxy off** — the orange cloud takes the whole fleet
   dark (§4.1).
3. Run the one `docker compose` command, **built from the Phoenix image** so the add-on is in it
   (`infra/headwind-phoenix-actions/`).
4. Set the `HEADWIND_MDM_*` variables on Railway (§4.5).
5. Approve the merge.
6. Run the pilot on PHX-TAB-0002.

---

## 7. Where the code is

| | |
|---|---|
| Sign-in, HTTP, devices, commands, apps, detail, fleet, register sync | `src/lib/devices/headwind/` |
| The corporate wipe, its scope and its 502-with-how-far-it-got | `src/lib/devices/headwind/wipe.ts` |
| Sets of rules: list, read, move a tablet, attach an app or a file, branding | `src/lib/devices/headwind/configurations.ts` |
| Uploading an APK or a file, and attaching it | `src/lib/devices/headwind/uploads.ts` |
| Locate now, and the movement history's two sources | `src/lib/devices/headwind/locations.ts` |
| Lock · lost mode · factory reset · reset the screen lock · message · alarm, and the catalogue the console reads | `src/lib/devices/headwind/actions.ts` |
| The enrollment code Phoenix holds and redraws | `src/lib/devices/headwind/enrollment.ts` |
| Extra console sign-ins | `src/lib/devices/headwind/users.ts` |
| Resolving a device number against the live fleet, once, for every mutation | `src/lib/devices/headwind/target.ts` |
| Relay settings and the connect target | `src/lib/devices/rustdesk/` |
| Routes (Super Admin only, `company_devices:approve`) | `app/api/devices/headwind/` — `actions/`, `configurations/`, `enrollment/`, `upload/`, `users/`, `wipe/` |
| The four cards on Rep Tablets | `src/components/devices/headwind-enrollment.tsx`, `headwind-fleet.tsx`, `headwind-tablet-panel.tsx`, `headwind-server-settings.tsx` |
| The one `useRead` every panel shares, and `CannotDo` | `src/components/devices/headwind-panel-kit.tsx` |
| The server itself | `docker-compose.headwind.yml`, `.env.headwind.example` |
| 🔴 The add-on that carries lock, lost mode, factory reset and password reset — **Java, outside the six CI checks**, built by the box's own `docker compose build` | `infra/headwind-phoenix-actions/` |
| The alarm and on-screen message on the tablet itself | `mobile/plugins/with-phoenix-device-actions.js` |
| The enrollment template's table | `supabase/migrations/20260925193000_headwind_enrollment_template.sql` |
| Tests | `tests/headwind-bridge.test.ts` |

It is a **third sibling module set** beside `manageengine/` and Google's AMAPI stack, mirroring
ManageEngine file for file. That duplication is the house style on this page and is deliberate — do
not refactor the three into a shared provider abstraction.

Two seams are genuinely shared, because a tablet must not be describable two different ways depending
on which console noticed it first:

- `registerTablet(facts, "headwind", …)` — `src/lib/devices/tablet-auto-register.ts`
- `recordReportedImei({ …, source: "headwind" }, …)` — `src/lib/devices/service.ts`

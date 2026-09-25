# Headwind MDM + RustDesk — the company's own rep-tablet server

The company's rep tablets are managed from Phoenix, at **Rep Tablets** (`/devices/tablets`, Super
Admin only). This document is about the **server behind that page**: what it is, why it exists, how
it is stood up, how a tablet moves onto it, and what is honestly not finished yet.

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
and screen-lock reset. **RustDesk** supplies the remote screen, also free.

🔴 **Neither of them costs a new machine.** Headwind runs on **Railway**, beside the Phoenix app, on
a bill the company already pays and in the region it already uses; RustDesk uses **its own free EU
relay**, which is end-to-end encrypted and therefore carries nothing it could read. Phoenix stays
the single place anybody looks. §3 and §4 are the whole of it, and §4.5 is why there is no relay to
build.

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
Super Admin's own computer and the tablet, through whichever relay the fleet is set to — **RustDesk's
own by default, the company's if one is ever configured (§4.5)**. Phoenix hands over which tablet,
and the relay's address and public key when there is a private one to name, and stops. Putting a
rep's screen through the Phoenix web app is neither needed nor wanted.

🔴 **The default relay is not a weaker option, and the page says so in words rather than implying
it.** RustDesk is NaCl end-to-end encrypted: the relay moves ciphertext it holds no key for. A
private relay buys **custody and an SLA**, not privacy.

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
| The machine | **None rented.** Headwind runs on Railway — already paid for, already `europe-west4` — as one more service beside the app. It costs that service's own usage, on a bill the company already receives |
| Headwind MDM Community | Free, no device cap |
| RustDesk relay | **Free, and no server at all** — RustDesk's own EU relay (§4.5) |
| A domain name for it | Already owned (`satopharma.com`) |
| **Total** | **A few dollars a month of existing Railway usage**, against roughly $3,000–5,000/year for the paid alternative |

🔴 **This replaced a rented VPS on 2026-09-25, at the owner's instruction, and the reason is worth
keeping.** The plan was one ~$5–6/month box in Europe running Headwind and RustDesk together. It
cost an evening across three providers — Hetzner's verification refuses Egyptian customers and takes
no PayPal, and OVH split an account across two regions that do not share a sign-in — and it bought
nothing the company did not already have. Railway was already paid for and already in Europe, and
RustDesk's public relay is **NaCl end-to-end encrypted**, so it carries ciphertext it cannot read.
Self-hosting the relay buys custody and an SLA. It does not buy secrecy, because the secrecy was
never the relay's to give.

---

## 4. Standing it up on Railway

Everything below happens **once**, in the Railway dashboard, by the owner. Nothing in Phoenix or in
CI does any of it, and there is no machine to rent, no SSH key, no firewall and no Let's Encrypt.

🔴 **Why the owner and not a session.** Creating a Railway service is a money move and a production
one: `railway service source connect` is **not** environment-scoped, and on 2026-09-16 it repointed
**production** while being run with `--environment staging`. So every step here is his click, with
the exact values written out. A session prepares; it does not press.

### 4.1 The service and its database

In the **existing** Phoenix Railway project — the one already serving
`phoenix-hr.satopharma.com` — so that the region is inherited and stays `europe-west4`:

1. **New → Database → Add PostgreSQL.** Name it `headwind-db`. Headwind's own documentation is
   explicit that a database *inside* the application container does not work, so this is a real
   separate service, exactly as it was a separate container before.
2. **New → GitHub Repo → `Gawish-1997/phoenix-people-workforce`.** Name the service
   `phoenix-headwind`.
3. On that service, **Settings → Build**:
   - **Root Directory** = `infra/headwind-phoenix-actions`
   - **Builder** = Dockerfile *(it should pick this up from
     [`railway.toml`](../../infra/headwind-phoenix-actions/railway.toml); confirm rather than assume)*
4. 🔴 **Settings → Build → Watch Paths = `infra/headwind-phoenix-actions/**`.** Without it, **every
   merge to `main` rebuilds and restarts the MDM server** — a hundred tablets lose their check-in
   channel for the length of a build, forty-six times a day, for changes that have nothing to do
   with them.

🔴 **The image is BUILT, not pulled, and that is the whole point.** The Dockerfile extends the pinned
Headwind image with the small Apache-2.0 add-on that carries lock, lost mode, factory reset and
reset-the-screen-lock (§6.1). On the stock image those four answer a refusal that reads like a broken
tablet rather than like the wrong image. The tag is pinned to a default in the Dockerfile — Railway
passes no build args, so a bare `ARG` with no default would resolve to `headwindmdm/hmdm:` and fail.

### 4.2 The variables

On `phoenix-headwind` → **Variables**. `${{...}}` is Railway's own reference syntax — it reads the
value from the Postgres service rather than copying a password into a second place:

| Variable | Value |
|---|---|
| `HEADWIND_IMAGE_TAG` | `0.1.9` |
| `PROTOCOL` | `http` |
| `BASE_DOMAIN` | `mdm.satopharma.com` |
| `ADMIN_EMAIL` | the address the first admin account is created for |
| `SQL_HOST` | `${{headwind-db.PGHOST}}` |
| `SQL_PORT` | `${{headwind-db.PGPORT}}` |
| `SQL_BASE` | `${{headwind-db.PGDATABASE}}` |
| `SQL_USER` | `${{headwind-db.PGUSER}}` |
| `SQL_PASS` | `${{headwind-db.PGPASSWORD}}` |

🔴 **`PROTOCOL=http` is what makes Railway possible at all, and it is Headwind's own supported
setting, not a workaround.** Its published Docker README documents `http` for exactly this case — an
external SSL terminator in front — and tells you to leave the certbot section out. Railway terminates
TLS at its edge, so the server behind it speaks plain HTTP and never asks Let's Encrypt for
anything. That single variable removes the certificate, the renewal, port 80 and the "the name must
already resolve here before you start" trap that the rented-box path carried.

🔴 **`FORCE_RECONFIGURE` is not set here.** It re-runs the whole first-time configuration. If the very
first deploy fails its setup, add it as `1`, redeploy **once**, then delete the variable again.

### 4.3 The name, the port, and reading a deploy honestly

1. **Settings → Networking → Custom Domain** → `mdm.satopharma.com`. Railway gives a CNAME target;
   add it in Cloudflare with the **proxy OFF** (grey cloud, "DNS only"), because Railway terminates
   TLS itself and an orange cloud in front of it is a second terminator nobody asked for.
2. ✅ **The port is 8080, and both custom domains are now SET to it** (2026-09-26, via
   `railway domain update <host> --port 8080 --service phoenix-headwind --environment production`).
   Read from the container's own startup log: `Initializing ProtocolHandler ["http-nio-8080"]`,
   `Starting ProtocolHandler ["http-nio-8080"]`, `Server startup in [5417] milliseconds`. Both
   domains had been left at Railway's default guess of **8443** since they were added on
   2026-09-25 — nothing was listening there (see point 3), so neither hostname answered at all
   until this was fixed.
3. ⚠️ **Tomcat also fails to start an HTTPS connector on every boot, and that is harmless:**
   `Failed to initialize component [Connector["https-openssl-nio-8443"]]` →
   `java.io.FileNotFoundException: /usr/local/tomcat/ssl/hmdm.jks (No such file or directory)`. The
   stock image expects a keystore that only its own certbot flow creates. Tomcat logs it `SEVERE`,
   continues, and starts 8080 anyway — and Railway terminates TLS at its edge, so 8443 is not wanted
   here. **Do not go looking for a certificate to satisfy it.**

#### 🔴 Railway's green tick watches the CONTAINER, not the application

Builds four and five were both reported `SUCCESS` by Railway — and green on the PR — while the
server served nothing at all. The container was up; Tomcat's *context* had failed. Railway cannot
tell those apart, and neither can the PR.

Worse, **Tomcat writes web-application failures to `logs/localhost.<date>.log` inside the container**,
which on Railway nobody can open: Railway captures stdout only, and `railway ssh` first wants an SSH
key registered on the account. So the one line naming the cause was being written to a file that does
not leave the box. The image now appends `java.util.logging.ConsoleHandler` to
`org.apache.catalina.core.ContainerBase.[Catalina].[localhost].handlers` in `conf/logging.properties`
(a duplicate key later in a `java.util.logging` file wins, so it appends rather than editing), which
puts that log on stdout permanently. It reads like noise someone would tidy away later — it is the
only reason the next failure will be diagnosable, and `tests/headwind-bridge.test.ts` pins it.

**So a deploy is proven by the log, never by the tick:** look for `Server startup in [...]` with **no**
`Context [] startup failed` after it.

✅ **That is what the sixth build shows** (2026-09-26, commit `04fbaff7f`):
`Deployment of deployment descriptor [/usr/local/tomcat/conf/Catalina/localhost/ROOT.xml] has
finished`, then `Starting ProtocolHandler ["http-nio-8080"]` and `Server startup in [5795]
milliseconds` — with `filterStart`, `Context [] startup failed`, `ClassReader` and
`ResourceConfig.scanClasses` all **absent** from the whole log, and
`Phoenix actions add-on: table ready.` present. The only `SEVERE` left is the harmless 8443 keystore
above.

🔴 **Still unproven, and it needs a published name:** that the server answers an HTTP request. The
service has **no domain yet** (`serviceDomains: []`), and Railway's private network is reachable only
from another service in the same project, so there is nothing to `curl`. The first request is
therefore part of step 1 of this section, not something that could be checked ahead of it.

⚠️ **And when you read those logs through Railway's GraphQL API rather than the CLI: the session
token in `~/.railway/config.json` lives ONE HOUR** (`user.tokenExpiresAt`). A watcher that reads it
once at start-up dies mid-poll with `"message": "Not Authorized"` on a query that worked ten minutes
earlier — which reads exactly like a permissions problem and is not one. Re-read the file each call,
and refresh it by shelling out to any authenticated CLI command (`railway whoami` is the cheapest);
the CLI spends the refresh token and rewrites the file.

🔴 **And the trap that cost those two builds: the add-on must compile to Java 8 bytecode.** Headwind
runs **Jersey 2.25.1**, which scans every jar in `WEB-INF/lib` for `@Path` using a repackaged **ASM 5**.
ASM 5 reads class files up to major 52 and throws a bare `IllegalArgumentException` — no message, no
class name — on anything newer; Java 11 emits major 55. A jar it cannot read does not merely fail to
load: Jersey aborts the whole scan, the `HMDMApplication` filter fails to start, and Tomcat kills the
entire context. Every one of Headwind's own 255 classes is major 52, measured from the WAR. `pom.xml`
carries `<maven.compiler.release>8</maven.compiler.release>` and the account of why.

### 4.4 🔴 The push channel, and what is genuinely lost

**Railway allows one HTTP domain per service and no second port.** The rented box published **two**:
443 for the console and the tablets' sync, and **31000** for Headwind's own push channel — the
server's way of *waking* a tablet immediately rather than waiting for it to call in.

So on Railway, **31000 is not published, and push is not available**. What that costs, stated
plainly:

- **Nothing is lost.** Every command — lock, wipe, lost mode, install, the lot — still reaches the
  tablet, because the agent applies them from the configuration it downloads at check-in.
- **What changes is *when*.** A command lands at the tablet's next scheduled check-in instead of
  within seconds. That interval is Headwind's own setting, and it is the knob to turn if the delay
  matters.
- 🔴 **It is therefore an SLA question, not a capability one** — and it is the second real reason
  (after the relay, §4.5) that the company might one day want its own box. Both are written down
  rather than discovered during an incident.

🔴 **Unproven, and must be read from the pilot rather than assumed:** whether the stock agent tolerates
an unreachable push port quietly, or logs an error on every attempt. It is expected to fall back
silently. Watch PHX-TAB-0002's own logs on the pilot and write the answer here.

### 4.5 The remote screen — there is nothing to stand up

🔴 **RustDesk uses its own free relay, and that is a decision, not a gap.** Taken 2026-09-25 by the
owner. Two facts carry it:

- **RustDesk is NaCl end-to-end encrypted.** The relay carries ciphertext it has no key for. Running
  your own buys **custody and an SLA — it does not buy secrecy**, because the secrecy was never the
  relay's to give.
- **Railway cannot host it anyway.** The relay needs **21115–21119 TCP plus 21116 UDP**, and Railway
  allows one TCP proxy port per service and **no UDP at all**. The UDP port is the hole-punching that
  keeps sessions peer-to-peer; without it every session falls back to the relay and is slow. That is
  a platform limit, not a configuration one.

So there is nothing to create, and in Phoenix **`RUSTDESK_RELAY_HOST` and `RUSTDESK_PUBLIC_KEY` are
left EMPTY**. 🔴 **Empty is the working setting, not a missing one** — the code reads both-empty as
"the public relay" and works. The only shape it refuses is **half** of a private relay: one set and
the other not, which would point a client at a relay it cannot verify, and that does not fail
loudly — it quietly connects somewhere else and nobody notices.

The day the company wants its own relay, it wants a box, and
[`docker-compose.headwind.yml`](../../docker-compose.headwind.yml) plus
[`.env.headwind.example`](../../.env.headwind.example) are kept in the repository for exactly that —
unchanged, and labelled as the optional path.

### 4.6 Turning it on in Phoenix

Set these on the **Phoenix app's** Railway service (production) — not on `phoenix-headwind` — then
let it redeploy:

```
HEADWIND_MDM_BASE_URL=https://mdm-console.satopharma.com
HEADWIND_MDM_LOGIN=<Phoenix's own admin login>
HEADWIND_MDM_PASSWORD=<its password, in plain text — Phoenix hashes it>
```

**Give Phoenix its own admin account on the Headwind server**, not a person's, so the Headwind side's
own audit trail reads as "Phoenix" rather than as the owner. The first admin account is the one
created on first start from `ADMIN_EMAIL`; extra logins are free and uncapped (§6.8).

🔴 **`HEADWIND_MDM_BASE_URL` is the CONSOLE hostname, not the tablets' one** — see §4.7. Pointing it
at `mdm.satopharma.com` would work, and would quietly put the API back on the public internet that
§4.7 exists to take it off.

🔴 **Nothing about RustDesk goes here.** Both variables stay unset; §4.5 is why. Full descriptions of
all five, and why the Headwind password is sent hashed: [environment.md](../environment.md),
"Headwind MDM + RustDesk".

Two more settings follow in §4.7 — the Cloudflare Access service token, without which Phoenix cannot
reach the console at all.

### 4.7 Locking down the console — Cloudflare Access

🔴 **Headwind Community has no two-factor sign-in** — that is a paid tier. The admin console would
otherwise sit on the public internet with one password in front of it, and that password
factory-resets tablets. **The owner's decision (2026-09-25): the console goes behind Cloudflare
Access**, so nobody reaches the login page at all without first signing in to Cloudflare. This is
the path; there is no second option to weigh.

**On Railway there is no tunnel and no `cloudflared` daemon** — there is no box to run one on, and
none is needed. Railway already publishes the service on a public hostname; Access goes in front of
that hostname. It is the same protection with three fewer moving parts: no connector to install, no
service to keep running, no loopback certificate to wave past with `noTLSVerify`.

🔴 **NEITHER HOSTNAME HAS A CERTIFICATE YET, AND THE CAUSE IS ONE STEP BEFORE PROXY MODE —
missing ownership-verification TXT records.** Found 2026-09-26, after fixing the port above:
`railway domain status <host>` reads `Verified: no`, `Certificate status:
CERTIFICATE_STATUS_TYPE_VALIDATING_OWNERSHIP` for **both** `mdm.satopharma.com` and
`mdm-console.satopharma.com`, and neither of the TXT records Railway asks for exists in Cloudflare
at all (`nslookup -type=TXT` on both returns nothing, not even a stale value) — so this is not the
grey/orange-cloud ordering mistake below, it is that the verification record was never created in
the first place. Nothing proxy-related blocks a TXT lookup; Railway simply cannot finish issuing a
certificate for a domain it cannot confirm ownership of, and every HTTPS request to either hostname
fails at the TLS handshake until this is added. Add both, in Cloudflare, **DNS only** (a TXT record
is never proxied):

| Record | Value |
|---|---|
| `_railway-verify.mdm.satopharma.com` TXT | `railway-verify=3d1ad21c6d65300892b8e58913c23ce008afaa9f087f009bf58fb6e28b5b75b3` |
| `_railway-verify.mdm-console.satopharma.com` TXT | `railway-verify=c0e5991c2a09312710ba50cc662a6a92cf9b7fcc12367bf2285e8f36a837864a` |

`railway domain status <host>` turns `Verified: yes` once Cloudflare answers; re-run
`railway domain certificate retry <host>` if the certificate does not then issue on its own.

🔴 **TWO HOSTNAMES ON ONE SERVICE, AND ONLY ONE OF THEM IS PROXIED.** Both are added under Railway →
`phoenix-headwind` → Settings → Networking → Custom Domain:

| Hostname | Cloudflare | Behind Access | Who uses it |
|---|---|---|---|
| `mdm.satopharma.com` | **proxy OFF** (grey cloud) | **no** | the tablets, at every check-in |
| `mdm-console.satopharma.com` | proxy **ON** (orange cloud) | **yes** | the owner's browser, and Phoenix |

🔴 **NEVER PUT ACCESS ON `mdm.satopharma.com`. It is the obvious-looking simplification — one
hostname, one rule — and it takes the whole fleet dark at its next check-in.** A tablet has no
Cloudflare identity and never will; Access would answer its sync with a sign-in page, and a hundred
tablets would go quiet at once while the server itself looked perfectly healthy. The two hostnames
exist for exactly this reason.

**The order matters, and getting it wrong looks like a broken certificate:** add
`mdm-console.satopharma.com` to Railway **grey-cloud first**, wait until Railway reports the
certificate issued, and only then turn the orange cloud on. Railway's own certificate request cannot
complete through Cloudflare's proxy. Once it is proxied, set that hostname's **SSL/TLS mode to Full
(strict)** — Flexible would send plaintext to the origin, which is precisely the thing being
prevented.

Then, in the Cloudflare dashboard, **Zero Trust → Access → Applications**, add
`mdm-console.satopharma.com` with a policy allowing the owner's own address (and anyone else who is
to administer tablets).

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
call after it. Leave both unset and nothing changes — that is the shape for a server with no Access
in front of it. Set only one and Phoenix refuses to call at all, naming the missing half, rather than
spending an afternoon on a reply that was never Headwind's.

🔴 **There is deliberately no exception rule for `/rest/*`, and one must never be added.** It is the
obvious-looking simplification — let the API through unauthenticated and only the browser console is
guarded — and it protects nothing that matters: the REST API is what lists, commands and
factory-resets tablets, and the console is only a browser talking to that same API. It would lock
the front door and leave the back one open.

Use a long unique password for the Headwind admin account regardless, and do not reuse the owner's.

### 4.8 Backups

🔴 **One thing, and the fleet is unrecoverable without it: the `headwind-db` Postgres service.** It
holds every tablet, its configuration, its rules and its history. Railway takes its own backups of a
Postgres service — **check on the service that they are actually enabled and note the retention**,
rather than assuming, and **take one by hand before any image-tag change**.

🔴 **The relay key pair is no longer a thing that can be lost, and that is a real gain from §4.5.**
On the rented box, losing `rustdesk-data` meant re-pairing **every** tablet by hand. On the public
relay there is no key pair to hold, so there is nothing to lose. The day the company takes the relay
in-house, that risk comes back with it — it is written into
[`docker-compose.headwind.yml`](../../docker-compose.headwind.yml) where it belongs.

🔴 **Railway's backups are NOT Phoenix's backups, and this one has no PITR either.** It is a separate
Postgres service from the payroll database, deliberately — a device-management server talking to reps'
tablets all day does not belong beside payroll — so nothing about Supabase's backup story covers it.

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

### 5.1 The things that might not work first time

🔴 **Android 13+ "Restricted Settings" blocks accessibility for side-loaded apps.** Apps installed
through the **session-based** package installer — which is how a device owner installs silently — are
**not** subject to it, so Headwind pushing the APK *should* side-step the block entirely. **This is
verified on the pilot tablet, never assumed.** If it does not, the fallback is a one-time ~30-second
manual toggle per tablet (Settings → Apps → RustDesk → ⋮ → Allow restricted settings, then grant the
accessibility service) — annoying, not a blocker.

✅ **The relay no longer has to be entered on each tablet at all.** This used to be the second
uncertain step: RustDesk cannot be pre-seeded on Android — there is no `--config`, the QR payload
carries only `host` and `key`, and `RustDesk2.toml` lives in private storage — so a private relay
meant typing it into the app on all hundred tablets, or paying for the custom-client builder. On
RustDesk's own relay (§4.5) the app is already pointed at it out of the box, and step 7 is reduced
to reading the ID. **It comes back the day the company takes the relay in-house**, and that is part
of that decision's cost.

🔴 **Whether Headwind's push channel being unavailable on Railway is quiet or noisy is unproven
(§4.4).** Commands still arrive — at the next check-in rather than in seconds. Watch this tablet's
own log during the pilot and write the answer into §4.4.

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

#### 🔴 Five things about that add-on that are not guessable, and were read out of the WAR

Measured 2026-09-26 from `hmdm-5.40.1-os.war` itself — the shipped bytecode, not the project's
published source or its documentation, which differ from it in every place that mattered here. The
first four, got wrong, produce **a green build, a clean start, no log line, and four buttons in
Phoenix that silently do nothing**; the fifth takes the entire server down while Railway still
reports `SUCCESS`. All five are pinned in `tests/headwind-bridge.test.ts`.

1. 🔴 **The add-on lives in `com.hmdm.plugins.phoenix`, and that is a requirement, not a courtesy.**
   `com.hmdm.plugin.PluginList` discovers plugins with
   `new ClassGraph().enableAllInfo().whitelistPackages("com.hmdm").scan()`. A class outside that
   subtree is **invisible to the scan** — there is no list to add to and no descriptor file to write.
   The first draft of this add-on lived in `com.satopharma.phoenix.headwind` and would never have
   been constructed. It is the package every shipped Headwind plugin uses, for the same reason.
2. 🔴 **What the scan looks for is an implementation of `PluginConfiguration`, and nothing else.** A
   bare Guice module in the jar is picked up by **nothing**. `PhoenixPluginConfigurationImpl` is the
   single reason any of the rest exists; delete it and the jar loads and does nothing.
3. 🔴 **The sync hook must be a MULTIBINDING.** `SyncResource` injects `Set<SyncResponseHook>`, and
   Guice fills a `Set` only from a `Multibinder`. A plain `bind(SyncResponseHook.class).to(…)` binds
   a key nothing injects: it starts cleanly, the set stays empty, and the hook is never called.
4. 🔴 **`PluginAccessFilter` is DELIBERATELY not on our private path, and the cost is written down.**
   Every shipped Headwind plugin filters through it; it refuses any user without a per-customer
   permission row in Headwind's own `plugins` table. This add-on does not write that row, so the
   filter would refuse **every** caller — including the only account that exists. What we lose by
   omitting it: any authenticated Headwind user can call these endpoints, rather than only one
   holding a plugin permission. The path is still behind `JWTFilter`, `AuthFilter` and
   `PrivateIPFilter`, and behind Cloudflare Access on top of that.
5. 🔴 **The jar must be Java 8 bytecode, and getting this wrong kills the WHOLE server, not the
   add-on.** Headwind runs **Jersey 2.25.1**, whose `ResourceConfig.scanClasses` reads every jar in
   `WEB-INF/lib` looking for `@Path` through a repackaged **ASM 5**. ASM 5 refuses anything above
   major 52 with a bare `IllegalArgumentException` — no message, no class name — and Java 11 emits
   major 55. Jersey then aborts the scan, the `HMDMApplication` filter fails to start, and Tomcat
   kills the context: `Context [] startup failed`. **Every one of Headwind's own 255 classes is major
   52** (common, platform, jwt, messaging and the 73 loose classes in `WEB-INF/classes`, without an
   exception), so matching them is the requirement. `pom.xml` uses
   `<maven.compiler.release>8</maven.compiler.release>` rather than `source`/`target`, because those
   two compile old syntax against the **JDK 11** class library — a Java 11-only method then resolves
   at build time and `NoSuchMethodError`s in production. Builds four and five were both lost to this,
   green the whole way.

**And one string that is a wire contract in three places at once.** The plugin id `phoenix-actions`
is the `<id>` in `/rest/plugins/<id>/private/…`, which is (a) what `getPluginId()` returns, (b) the
path the filters in `PhoenixRestModule` are registered against, and (c) the URL Phoenix calls.
Change it in one place and the other two give a **404 that looks exactly like an add-on which failed
to load**.

One thing the interface does *not* have, which the web copy of it does: **`SyncResponseInt` declares
no `getDeviceId()`** — 66 getters, and not that one. The tablet is identified only by the `int
deviceId` the hook is handed, which is Headwind's own `devices.id`; the store joins `devices` on it
to reach the device number the agent posts back.

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
by **Railway**, from the Dockerfile, when the `phoenix-headwind` service deploys (§4.1) — so a green
PR says nothing at all about it, and the first proof it compiles is that deploy. Its Phoenix side is
ordinary TypeScript and is covered normally. Anything the add-on has not been seen to do on a real
tablet is reported as unproven, never as working.

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

✅ **No relay address or key is typed at any point**, because the fleet is on RustDesk's own relay
(§4.5) and the app already points there. That was the *fifth* per-tablet step in the rented-box plan,
and it is the one that came back a hundred times. It returns the day the company takes the relay
in-house.

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
| 6 | Remote screen view and control, free, through RustDesk's own EU relay (§4.5) | 🟡 Built — input under Android 13's Restricted Settings is unproven until the pilot |
| 7 | **Corporate wipe** — Phoenix + Chrome data, Downloads + camera roll | 🟢 Built (§6.2) |
| 8 | **Sets of rules**: list, read, move a tablet, attach an app or a file | 🟢 Built (§6.3, §6.6) |
| 9 | **Install an app / send a file** to every tablet on a set of rules | 🟢 Built (§6.3) |
| 10 | **Home-screen branding** — title, colours, wallpaper, icon size | 🟢 Built (§6.6) |
| 11 | **Locate now**, with the position's own age | 🟢 Built (§6.5) |
| 12 | **Movement history**, every row naming its source | 🟡 Built — whether the free agent feeds the plugin is unproven (§6.5) |
| 13 | **Show a message on a tablet**, the owner's own words | 🟡 Built — needs the new Phoenix APK on the tablet |
| 14 | **Ring the alarm** | 🟡 Built — needs the new Phoenix APK; under Do Not Disturb it plays at whatever volume is set |
| 15 | **Lock** | 🟡 Built — needs the add-on, which the Railway service builds in (§4.1) |
| 16 | **Lost mode on / off**, with his words on the lock screen | 🟡 Built — needs the add-on, which the Railway service builds in (§4.1) |
| 17 | **Factory reset** | 🟡 Built — needs the add-on, which the Railway service builds in (§4.1) |
| 18 | **Reset the screen lock** | 🟡 Built — needs the add-on, which the Railway service builds in (§4.1) |
| 19 | **Enrollment code** held and redrawn, never minted | 🟢 Built (§6.7) |
| 20 | **Extra console sign-ins**, free and uncapped | 🟢 Built (§6.8) |
| 21 | RustDesk per-tablet settings | 🟢 Documented (§6.9) — Android cannot be pre-seeded, so it is four taps per tablet |
| 22 | A chat toggle for RustDesk | 🔴 **No such key exists.** Chat is built in and has no switch — a toggle would be a dead button |
| 23 | **Shut down** | 🔴 **Impossible on stock Android, at any price.** Signature-level permission, manufacturer only. Reboot is not a substitute (§6.1) |

**Still the owner's own steps, and only these.** 🔴 **Shorter than it was on 2026-09-25 — there is no
box to rent, no card to enter, no SSH key, no firewall, no `docker compose`, no `cloudflared` and no
relay:**

1. In the existing Railway project: add a **PostgreSQL** service, and a service from this repo with
   **Root Directory `infra/headwind-phoenix-actions`** and **Watch Paths** set (§4.1).
2. Set its variables — the nine in §4.2, `PROTOCOL=http` among them.
3. Add the two hostnames (§4.3, §4.7): `mdm.satopharma.com` **grey cloud** for the tablets, and
   `mdm-console.satopharma.com` **grey first, then orange**, behind a Cloudflare Access application.
   🔴 Never put Access on the tablets' hostname — it takes the whole fleet dark.
4. Set the port Railway asks for from **the first deploy's own logs** (§4.3) — it is the one value
   here nobody has yet seen.
5. Set the `HEADWIND_MDM_*` variables on the **Phoenix app's** service (§4.6), plus the two Access
   token values. 🔴 **Nothing RustDesk** — both its variables stay empty, and empty is the working
   setting.
6. Approve the merge.
7. Run the pilot on PHX-TAB-0002.

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
| Relay settings and the connect target — **empty means RustDesk's own relay, and that is the working setting** | `src/lib/devices/rustdesk/` |
| Routes (Super Admin only, `company_devices:approve`) | `app/api/devices/headwind/` — `actions/`, `configurations/`, `enrollment/`, `upload/`, `users/`, `wipe/` |
| The four cards on Rep Tablets | `src/components/devices/headwind-enrollment.tsx`, `headwind-fleet.tsx`, `headwind-tablet-panel.tsx`, `headwind-server-settings.tsx` |
| The one `useRead` every panel shares, and `CannotDo` | `src/components/devices/headwind-panel-kit.tsx` |
| **The server as it actually runs** — the Railway service's build settings | `infra/headwind-phoenix-actions/railway.toml` |
| The optional self-hosted box, kept for the day the company wants its own relay (§4.5) | `docker-compose.headwind.yml`, `.env.headwind.example` |
| 🔴 The add-on that carries lock, lost mode, factory reset and password reset — **Java, outside the six CI checks**, built by Railway from the Dockerfile | `infra/headwind-phoenix-actions/` |
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

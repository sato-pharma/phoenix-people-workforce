# Headwind MDM + RustDesk — the company's own rep-tablet server

The company's rep tablets are managed from Phoenix, at **Rep Tablets** (`/devices/tablets`, Super
Admin only). This document is about the **server behind that page**: what it is, why it exists, how
it is stood up, how a tablet moves onto it, and what is honestly not finished yet.

---

## 1. Why this exists

> 🔴 **ManageEngine is gone (2026-10-23).** It came off the Rep Tablets page on 2026-10-22, once every
> rep tablet was enrolled in Headwind as device owner, and its code — the bridge, its seven
> `/api/devices/manageengine/*` routes and its four cards — was deleted from the repo on 2026-10-23 at
> the owner's word. The last copy is commit `78a9f90ba`. What follows is the account as it stood.

Rep Tablets ran on **ManageEngine MDM**. Its trial ends and the account falls back to the free
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
> exactly the job RustDesk does for nothing) and **URL filtering** (+$990). 🔴 **Admin two-factor
> sign-in was listed here as paid too, and that is not the real story** — the Community build ships
> the 2FA code with its console UI hard-disabled, so it is unavailable to us either way (§4.7,
> corrected 2026-10-22). Cloudflare Access is the console's second factor.

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
one-line change. (It came off on 2026-10-22, and unlike Google's console its code was then deleted, on
2026-10-23.)

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
`phoenix-hr.satopharma.com`:

🔴 **THE REGION IS NOT INHERITED. This section said it was, and that was false — both Headwind services
ran in the United States from 2026-09-25 until 2026-09-28.** A new service in this account is created in
`sfo` whatever the project's other services do, and **a volume's region is fixed when the volume is
created**, so a database cannot be moved afterwards by scaling — it has to be created in the right
region or migrated by dump and restore. The live services are now `phoenix-headwind` and
`headwind-db-eu`, both in `europe-west4-drams3a`; the original `sfo` database `headwind-db` was deleted
on 2026-09-28 once the move was verified, so `postgres.railway.internal` no longer resolves.

1. **New → Database → Add PostgreSQL**, and **set its region to EU West in the dashboard's own picker
   before it is created.** Name it `headwind-db-eu`. Headwind's own documentation is
   explicit that a database *inside* the application container does not work, so this is a real
   separate service, exactly as it was a separate container before.
   🔴 **The CLI cannot do this one** — `railway add` has no region flag, so a CLI-created database lands
   in `sfo` with its volume pinned there. The API can: `VolumeCreateInput` takes a `region`, so the
   working order is service with **no source** → variables → `volumeCreate` with
   `region: "europe-west4-drams3a"` → only then set the image, so the first boot happens in the right
   place. Railway co-locates a container with its volume, and `serviceInstance.region` reads `null` even
   when it is correct — **read the VOLUME's region, or `railway status`, never that field.**
2. **New → GitHub Repo → `sato-pharma/phoenix-people-workforce`.** Name the service
   `phoenix-headwind`.
3. On that service, **Settings → Build**:
   - **Root Directory** = `infra/headwind-phoenix-actions`
   - **Builder** = Dockerfile *(the `phoenix-headwind` block of
     [`.railway/railway.ts`](../../.railway/railway.ts) holds it since `railway.toml` was retired on 2026-10-23; confirm rather than assume)*
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
| `ADMIN_EMAIL` | your own address — but see the 🔴 below: it does **not** reach the admin account |
| `SQL_HOST` | `headwind-db-eu.railway.internal` |
| `SQL_PORT` | `5432` |
| `SQL_BASE` | `railway` |
| `SQL_USER` | `postgres` |
| `SQL_PASS` | `${{headwind-db-eu.POSTGRES_PASSWORD}}` |

🔴 **These are LITERALS on the live service, not `${{headwind-db.*}}` references — this table used to
show references and they no longer resolve, because the service they named was deleted on 2026-09-28.**
Read the live values before trusting any of them. The one that matters is `SQL_HOST`: the 2026-09-28
cut-over to EU West changed **only** that variable, because the new database was given the old one's
`POSTGRES_*` values deliberately so no password had to be handled. Set it with `skipDeploys` and let the
region change be the single redeploy.

🔴 **`PROTOCOL=http` is what makes Railway possible at all, and it is Headwind's own supported
setting, not a workaround.** Its published Docker README documents `http` for exactly this case — an
external SSL terminator in front — and tells you to leave the certbot section out. Railway terminates
TLS at its edge, so the server behind it speaks plain HTTP and never asks Let's Encrypt for
anything. That single variable removes the certificate, the renewal, port 80 and the "the name must
already resolve here before you start" trap that the rented-box path carried.

🔴 **`FORCE_RECONFIGURE` is not set here.** It re-runs the whole first-time configuration. If the very
first deploy fails its setup, add it as `1`, redeploy **once**, then delete the variable again.

#### 🔴 THE SERVER COMES UP WITH `admin` / `admin`, AND `ADMIN_EMAIL` NEVER REACHES IT

Read out of the first run's own Liquibase output, 2026-09-26, not from the project's documentation —
which says the opposite. The **only** `INSERT INTO users` in the entire first run is Headwind's own
seed:

```
INSERT INTO users(login, email, name, password)
  VALUES ('admin', 'fast.daemon@gmail.com', 'admin', '21232f29…801fc3')
```

Three separate things a reader would otherwise get wrong:

1. **That hash is MD5 of the word `admin`.** The console that can factory-reset a hundred tablets ships
   answering to the most-guessed password there is.
2. **The email is hardcoded upstream — it is the project author's address, not yours.** Six
   `UPDATE users` statements run after that insert and **not one touches the email or the password**,
   so `ADMIN_EMAIL` is read by the setup script for other purposes and never lands on the account.
   Leaving it is a stranger's address on the recovery path of your fleet console.
3. **So the order of §4.3 is a security order, not a convenience one.** Do **not** publish
   `mdm-console.satopharma.com` and then go looking for the password screen: Railway's certificate has
   to be issued through a grey cloud, so there is a window where a name anyone could guess answers to
   `admin`/`admin` with no Cloudflare Access in front of it.

   **Close it by using a name nobody can guess instead.** Settings → Networking → **Generate Domain**
   → port **8080** gives a random `…up.railway.app`. Sign in there, change the password, put your own
   email on the account, and only then add the two custom hostnames and delete the generated one.

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

✅ **And the server answers — proven 2026-09-26, over a Railway-generated domain.** A
`serviceDomainCreate` on port 8080 published the service, and the first two requests ever made to it
returned:

| Request | Result |
|---|---|
| `GET /` | **200**, and the body is the console itself — `<html ng-app='headwind-kiosk'>`, `<title>MDM server</title>` |
| `GET /rest/public/sync/configuration/PHX-TAB-0002` | **200** — the endpoint every tablet calls at every check-in |

That is the whole chain finally closed: image builds → container starts → Tomcat's context starts →
Jersey's scan survives → the application serves. Nothing between the WAR and a tablet is unproven any
more. **Use the generated domain for this**, not a custom hostname: it needs no DNS, no certificate
wait and no Cloudflare, so it isolates "does the server work" from "is the name wired up".

✅ **And the same chain survived a real code change — the seventh build, merge commit `8b5208d11`,
2026-09-26 03:36 Cairo.** This is the first merge to `main` that touched
`infra/headwind-phoenix-actions/**` since the service existed: the three before it were all marked
`SKIPPED` because the watch path did not match, so this one is also the proof that the watch path
works. It went `SUCCESS`, printed `Phoenix actions add-on: table ready.` again at `00:36:52.787` and
`Server startup in [11411] milliseconds`, and both `GET /` and
`GET /rest/public/sync/configuration/PHX-NOPE-0000` answered **200** afterwards.

🔴 **On this build that log line carries one more fact: `ensureSchema()` ran the new
`alter table phoenix_pending_actions add column if not exists confirmed_from`.** The live table was
created 2026-09-25, and `create table if not exists` skips the statement **whole** — columns included —
so widening the create block would have added nothing and every statement naming the new column would
have failed inside the hook's swallowed catch, on the fleet's hottest path. The alter is why it did not.

✅ **And the add-on is serving, not merely loaded** — same session, no tablet and no sign-in needed:

| Request | Result | What it proves |
|---|---|---|
| `POST /rest/plugins/devicereset/public/{number}` | **200** `{"status":"OK"}` | the three confirmation paths the agent POSTs to are **live** — the stock open-source server 404s all three (§6.1) |
| `POST /rest/plugins/devicereset/public/reboot/{number}` | **200** `{"status":"OK"}` | |
| `POST /rest/plugins/devicereset/public/password/{number}` | **200** `{"status":"OK"}` | |
| `GET /rest/plugins/phoenix-actions/private/status` | **403** | the private surface is registered **and closed** to a caller with no session |
| `GET /rest/plugins/not-a-real-plugin/private/status` | **404** | the control — so that 403 is a real route, not a blanket refusal |

**Probe with a device number that cannot exist** (`PHX-PROBE-NONE`, not a real tablet): `confirm()`
marks a pending row consumed, so against a real number it would quietly eat a command that had been
sent. With no such device it is an `UPDATE` matching nothing.

That is "sent" becoming "witnessed" proven on the server side. What a tablet does with the five
injected fields is still the pilot's job (§5).

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

### 4.5.1 Screen recording — on-demand capture, filed in Phoenix (the launcher contract)

Owner, 2026-10-22: after live view and control he asked for screen **recording** too, **on-demand into
Phoenix** — the Super Admin presses Record on one tablet, the tablet records its own screen for a set
length and uploads the file to Phoenix, and he plays it back in the dashboard whenever he likes, with
nobody watching live. Calls and messages are never recorded; they do not exist in this stack.

**The Phoenix side is built (this PR).** The pieces, all behind `company_devices:approve`:

- `device_screen_recordings` table + a private `device-screen-recordings` bucket (mp4/webm, 256 MB) —
  migration `20261022170000_tablet_screen_recordings.sql`.
- `src/lib/devices/headwind/recordings.ts` — `requestRecording` (opens a slot, pushes the record
  intent, audits it), `listRecordings` (rows + short-lived signed playback links), `ingestRecording`
  (the device's upload door), and the pure `recordingUploadDecision` the upload is judged by.
- Routes: `POST /api/devices/headwind/record` (Super Admin, same-origin) starts one; the dashboard's
  `GET /api/devices/headwind?view=recordings` lists them; `POST /api/devices/recordings/upload` takes
  the file. A `RecordingsPanel` on the tablet drill-down drives and plays them.

**Why the capture is NOT in the Phoenix app.** The alarm and message actions push an `intent` to
`com.satopharma.phoenixworkforce`, the Expo app under `mobile/` — which is **frozen**, so it cannot
grow a screen-capture handler. The capture therefore belongs in the **Phoenix RustDesk-fork launcher**,
which already runs Android MediaProjection for live view and already holds the one-time capture grant.
The record push is aimed at the RustDesk package (`rustDeskPackageName()`), never the frozen app.

**The device-side contract (to build in the RustDesk fork's own repo — NOT here, NOT in `mobile/`):**

1. **Trigger.** Phoenix sends `POST /rest/private/push` with `messageType: "intent"`, `deviceNumbers:
   [<this tablet>]`, and a `payload` (a JSON **string**) of
   `{ "action": "com.satopharma.phoenix.tablet.RECORD_SCREEN", "pkg": "<rustdesk package>", "extra":
   { "recordingId": "<uuid>", "token": "<hex>", "uploadUrl": "https://…/api/devices/recordings/upload?recordingId=<uuid>",
   "durationSeconds": <n> } }`. The fork registers the receiver/activity for that action.
2. **Capture.** Record the screen via the MediaProjection session the fork already owns for live view,
   for `durationSeconds` (5–300), to an mp4 (or webm).
3. **Upload.** `POST` the file to `uploadUrl` **exactly as given** — it carries `?recordingId=` — as
   multipart `file`, with form fields `token` and `capturedSeconds` (a `recordingId` field may be sent
   too, but must be the same id, or the upload is refused `400`). No bearer and no session — the
   `token` IS the credential, matched once against the slot's stored hash inside a 15-minute window,
   then burned. The door reads the slot the address names **before it reads the body**: no id or a
   malformed one is refused `400`, an unknown slot `404`, a handled one `409`, a spent or expired one
   `410`, and a slot that cannot be read `503` (retry) — so a caller without a live slot can never
   make the server hold a 256 MB body.
   Send it with a **`Content-Length`** — a chunked body is refused `411` before it is read, and a
   request over 256 MB plus 64 KB of framing is refused `413`. One address may make **10 uploads a
   minute** (`429` with `Retry-After` past that; `503` when the limit cannot be checked — retry). The
   token is claimed once, atomically: a second upload on the same slot gets `409` and never touches
   the first file (stored with no overwrite). This route is left out of the proxy matcher, whose 10 MB
   body copy used to cut every real recording short (audit, 2026-10-26, point 24).

**The exposure, stated plainly.** A tablet's Headwind configuration is world-readable (§8.3), so no
long-lived secret may travel to a device. The per-recording token travels in the push instead: random,
single-use, short-lived, and worth at most one capture slot for minutes if it leaked. The size filed
is the byte count of the file that actually arrived, never a number the tablet sends (this line used
to say the stored object was re-read, which it never was). The `/rest/videos` path this feature does **not** use is the server's own
unauthenticated video endpoint, deliberately 403'd by the §8.3 Tomcat rule; recording uses the
authenticated Phoenix door above, never that hole.

### 4.6 Turning it on in Phoenix

Three variables on the **Phoenix app's** Railway service (production) — not on `phoenix-headwind`.
✅ **One of them is already set, 2026-09-26:**

```
HEADWIND_MDM_BASE_URL=https://mdm.satopharma.com   ✅ SET (skipDeploys — see below)
HEADWIND_MDM_LOGIN=<Phoenix's own admin login>     ← his, one field
HEADWIND_MDM_PASSWORD=<its password in plain text — Phoenix hashes it>   ← his, one field
```

🔴 **All three are required together and there is no partial state.** `isHeadwindConfigured()` returns
false unless all three are non-empty, so the base URL sitting there alone leaves the page **exactly as
dark as it was** — it cannot half-open anything, which is why setting it needed no approval and no
deploy. It was upserted with `skipDeploys: true`: it is inert until the other two exist, and the save
that adds them is the deploy that lands all three at once.

**The two that are left are the owner's, and not for a policy reason.** A Headwind admin login is a
password that factory-resets tablets. Typed into Railway's own variable screen it goes straight to the
secret store; pasted into a chat it is in a transcript forever. So those two fields are typed once,
there, by him — and nothing needs to be sent here first.

**Give Phoenix its own admin account on the Headwind server**, not a person's, so the Headwind side's
own audit trail reads as "Phoenix" rather than as the owner. Extra logins are free and uncapped
(§6.8). The account that already exists is the seeded `admin`, which is **not** created from
`ADMIN_EMAIL` and arrives with a default password — §4.2's 🔴 block, and deal with that before this.

🔴 **Set them on `phoenix-people-workforce` / `production`, and type them into Railway's own field —
never through `railway variables --stdin`, which stores a BOM INSIDE the value** (§2.3). A leading
byte no screen displays would make every sign-in fail while the password looked perfectly correct.

#### ✅ ONE COMMAND DOES ALL OF IT — `scripts/headwind-bootstrap.mjs`

Doing this by hand cost the owner an hour at 05:00 on 2026-09-26, and none of it was carelessness: the
console's **Role** field is mandatory and a save without it fails in a way that looks like a form that
did nothing, so `HEADWIND_MDM_LOGIN=phoenix` pointed at an account that had never been created. The
server said so plainly — and nobody was reading its audit log.

```bash
node scripts/headwind-bootstrap.mjs
```

It asks for the Headwind **admin** password at a hidden prompt, then signs in, lists the roles, creates
`phoenix` with a **generated** 24-character password, proves that account can sign in, and writes both
variables into Railway — the login with `--skip-deploys` and the password without, so exactly one
redeploy lands the pair. `--reset` gives an existing account a new password; `--skip-railway` stops
after the account; `--role "<name>"` overrides the role it picks.

🔴 **Neither password is ever printed, logged or stored.** The generated one goes straight into
Railway's secret store and is then forgotten — there is no copy to leak from a transcript or a shell
history, and if you need it later you reveal it in Railway or run the script again with `--reset`.
Pinned by `tests/headwind-bridge.test.ts`, including that no line which prints may carry a password.

#### 🔴 THE TOKEN COMES BACK AS `id_token`, AT THE TOP LEVEL, WITH NO ENVELOPE — THE FAULT THAT COST A NIGHT

Measured against production on 2026-09-26, with the service's own injected variables:

```
POST https://mdm.satopharma.com/rest/public/jwt/login
  ->  HTTP 200  application/json   { "id_token": "<195 chars>" }
      no status, no message, no data
```

Phoenix read `data.authToken`, `data.token`, a bare `data` string and a top-level `token` — **and not
`id_token`**. So a sign-in that SUCCEEDED was reported as *"The Headwind server refused the Phoenix
sign-in — check HEADWIND_MDM_LOGIN and HEADWIND_MDM_PASSWORD"*, and the account, the password, the
hostname and the hash form were each searched in turn for a fault none of them had. **The server's own
audit log recorded every one of those attempts as `errorCode=0`.** With `id_token` read,
`GET /rest/private/users/roles` answers 200 and lists `Admin · User · Observer`.

🔴 **The lesson is bigger than the key name: when a page says a credential was refused and the server
says `errorCode=0`, believe the server and go looking at the REPLY SHAPE.** Never narrow the candidate
list in `tokenFromLogin` to one spelling; pinned by `tests/headwind-bridge.test.ts`.

#### 🔴 THE PASSWORD GOES ON THE WIRE AS **UPPER-CASE** MD5

Read from the console the live server serves — the authoritative client, not the documentation:
`login.controller.js` sends `md5(password).toUpperCase()`, and `users.controller.js` stores a new
password the same way. **Phoenix sent lower-case until 2026-09-26**, which would have refused a
perfectly correct password, and the failure it produces is the cruellest one available: "password
wrong" against a password that is right. `headwindPasswordHash` upper-cases, and a test pins it.

#### 🔴 THE SERVER'S AUDIT LOG IS THE ONLY HONEST DIAGNOSIS — READ IT FIRST

`railway logs --service phoenix-headwind --environment production` prints an `AuditLogger` line for
every sign-in, with an `errorCode` whose meanings were measured here on 2026-09-26 (a deliberately
nonexistent login for `2`, the owner's own mistyped admin password for `1`):

| action | `errorCode` | what it means |
| --- | --- | --- |
| `jwt.login` (Phoenix) | `0` | signed in |
| `jwt.login` (Phoenix) | `2` | **the sign-in was refused — and that is ALL it tells you** |
| `user.login` (console) | `0` / `1` | signed in / refused |
| `update.user` (console) | `0` | the edit was saved |

🔴 **`2` DOES NOT MEAN "NO SUCH LOGIN", AND READING IT THAT WAY COST AN HOUR ON 2026-09-26.** A
session probed six spellings of the login, got `2` for every one, and told the owner the account had
never been created — while the audit log's own `update.user` line showed it created 90 seconds earlier
with `login: "phoenix"`, `id: 2`, role `Admin`. On the `jwt.login` path a wrong password and a login
that does not exist both answer `2`; only the console's `user.login` separates them. **Never conclude
an account is missing from a `2`.**

**What the log DOES answer, and nothing else does:** the `update.user` line carries the whole user
record as JSON — `login`, `id`, `userRole`, `allDevicesAvailable`, `allConfigAvailable`,
`passwordReset`, `twoFactor`, `lastLoginFail`. Read that, not the error code, to know what the account
actually is. The service to read is `phoenix-headwind`, never the Phoenix app.

🔴 **AND A PASSWORD CHANGED IN THE CONSOLE DOES NOT REACH RAILWAY.** The console's edit screen sends
`newPassword` on every save, so saving the user for any reason — a role tweak, clearing
`passwordReset` — can replace the password Phoenix is still sending. That is what a fresh `2` after a
working `0` means: the two sides have drifted, not that anything is broken.

🔴 **AND IF THE SIGN-IN IS REFUSED, THE REPLY IS AN HTML PAGE, NOT JSON — WHICH IS NOT EVIDENCE OF
CLOUDFLARE.** Measured 2026-09-26 against this very server: `POST /rest/public/jwt/login` with a login
that does not exist, and no Cloudflare anywhere in the path, answers a **Tomcat HTML 401** error page.
Phoenix's own diagnostic used to read that as an Access sign-in page and tell the reader to check
`HEADWIND_MDM_ACCESS_CLIENT_ID` and `HEADWIND_MDM_ACCESS_CLIENT_SECRET` — **two variables that are not
set on the service at all**, so the one plausible failure of this step sent whoever hit it to a dead
end. It now decides by whether a service token is configured: with none, it names
`HEADWIND_MDM_LOGIN` and `HEADWIND_MDM_PASSWORD` and says the page came from Headwind's own Tomcat.
Pinned in `tests/headwind-bridge.test.ts`.

#### 🔴 WHY THE TABLETS' HOSTNAME, AND A CORRECTION TO WHAT THIS SECTION USED TO SAY

🔴 **SUPERSEDED BY THE HOST SPLIT (§8.3, 22 Oct 2026).** Everything below was true while one Tomcat served
everything on every name. Once the host split deploys, `mdm.satopharma.com` serves the tablets' paths and
nothing else, so Phoenix MUST use `https://mdm-console.satopharma.com`, with the two
`HEADWIND_MDM_ACCESS_*` values once Access is on — §8.10 says in which order.

This section used to instruct `https://mdm-console.satopharma.com` and warn that `mdm.satopharma.com`
"would quietly put the API back on the public internet that §4.7 exists to take it off." **That
sentence was wrong, and it is worth saying why rather than quietly deleting it.**

**One Tomcat serves `/rest/*` on every hostname pointed at the service** — measured again 2026-09-26,
both hostnames answer an identical Tomcat 403 on `/rest/private/devices/search` unauthenticated. And
`mdm.satopharma.com` **must** stay open, with no Access, forever, or the whole fleet goes dark. So the
private REST surface is reachable on a public name whatever this variable says: **the choice of base
URL changes nothing at all about what is exposed.** Access on the console protects the console's *web
UI* from strangers; it never took the API off the internet, and it cannot.

What the choice does change is coupling, and that decides it:

- `https://mdm.satopharma.com` — **Access can never be put on it** (hard rule), so Phoenix needs no
  service token, today or ever. Proven answering over a valid certificate.
- `https://mdm-console.satopharma.com` — breaks Phoenix the moment Access goes on, unless the two
  `HEADWIND_MDM_ACCESS_*` values are set and kept correct. A whole failure mode bought for nothing.

Both are HTTPS and both carry the same JWT. **So the tablets' hostname is the setting**, and turning
Access on later cannot break Phoenix.

#### ⭐ Better still, once somebody can prove it: both services are in one Railway project

Read from Railway 2026-09-26 — `phoenix-people-workforce` and `phoenix-headwind` are the same project
and the same `production` environment, and Railway has already minted the private hostname:

```
phoenix-headwind:          RAILWAY_PRIVATE_DOMAIN = phoenix-headwind.railway.internal
phoenix-people-workforce:  RAILWAY_PRIVATE_DOMAIN = phoenix-people-workforce.railway.internal
```

So there is a third possible value:

```
HEADWIND_MDM_BASE_URL=http://phoenix-headwind.railway.internal:8080
```

Its one real advantage over the setting above is that Phoenix's calls **never cross the public
internet at all** — not the Access coupling, which the tablets' hostname already avoids. `http` and
`8080` are right here: the private network is inside the project, there is no TLS on it, and 8080 is
the Tomcat port proven in §4.3.

🔴 **It is NOT the current setting, and it should not be set on a hunch.** The gain is modest and the
risk is total — a base URL that does not resolve means every tablet action fails — so it waits for
proof, and the proof is one command.

⚠️ **Unproven from inside the container, and it has to be said rather than assumed.** Railway's private
network is **IPv6-only**, so this rests on the Phoenix container resolving an AAAA-only hostname; Node's
own `fetch` does, but nothing here has watched it. The proof is one command, and it could not be run
now because the Railway account has **no registered SSH key** — and registering one is an account
credential, not a session's to add:

```
railway ssh --service phoenix-people-workforce --environment production -- \
  node -e "fetch('http://phoenix-headwind.railway.internal:8080/rest/public/sync/configuration/PHX-NOPE-0000').then(r=>console.log(r.status))"
```

**`200` means the internal route is real and may be switched to; anything else means leave it on
`https://mdm.satopharma.com`, which is where it is now.** Either way this is one variable and nothing
else on the page — and if it is ever switched and the name does not resolve, the failure now explains
itself instead of saying `fetch failed`: `callHeadwind` answers a transport failure with a 502 naming
the address, the IPv6-only network, the fact that no laptop can reach it, and the public fallback
(`unreachableMessage`, pinned in `tests/headwind-bridge.test.ts`).

#### 🔴 AND A 403 ON A PRIVATE PATH DOES NOT PROVE THE ADD-ON IS LOADED

Measured 2026-09-26: unauthenticated, **both** `/rest/private/devices/search` and
`/rest/plugins/phoenix-actions/private/status` return the **same Tomcat HTML 403** — not Headwind's JSON
envelope, and not a 404. Authentication intercepts before routing, so a 403 says only that something
is guarding the path. **It is not evidence that the add-on is there**, and reading it as such is the
easy mistake to make from outside. A **404** would be real evidence of absence; only an authenticated
`GET .../phoenix-actions/private/status` returning `{"ready":true}` is evidence of presence, and
Phoenix's own page asks exactly that before it offers the four actions.

🔴 **Nothing about RustDesk goes here.** Both variables stay unset; §4.5 is why. Full descriptions of
all five, and why the Headwind password is sent hashed: [environment.md](../environment.md),
"Headwind MDM + RustDesk".

✅ **Measured 2026-09-26: none of the three is set on `phoenix-people-workforce` yet**, which is the
ships-dark state §2 describes — so nothing renders and no request leaves Phoenix until they are.

Two more settings follow in §4.7 — the Cloudflare Access service token — **needed only if
`HEADWIND_MDM_BASE_URL` goes to the public console name** rather than the internal one above.

### 4.7 Locking down the console — Cloudflare Access

🔴 **CORRECTED 2026-10-22: HEADWIND 2FA CANNOT BE TURNED ON FROM THIS CONSOLE AT ALL, AND IT WOULD
NOT GUARD THE PHOENIX BRIDGE EITHER WAY. CLOUDFLARE ACCESS IS THE CONSOLE'S SECOND FACTOR — NOT
HEADWIND 2FA.** Three claims this page made are each wrong and are corrected below. The two-factor
*code* does exist, so "2FA is a paid tier" was wrong — but the vendor hard-disabled its UI in this
Community build, there is no per-account version of it, and the endpoint Phoenix uses never consults
it. All of this is read from the upstream source, `h-mdm/hmdm-server`, not from the console's screens.

🔴 **THERE IS NO OWNER CLICK HERE — THE CONSOLE OFFERS NO WAY TO ENABLE IT.** The whole two-factor
form in `server/src/main/webapp/app/components/main/view/settings/language.html` is wrapped in
`<form class='form-horizontal' ng-if="false">` — line 197, and the form runs to line 241, holding the
title, the checkbox, the QR code and the Verify button. AngularJS therefore renders none of it, and
the checkbox is simply not on the general-and-language tab. 🔴 **This page used to say "turn it on;
Settings → the account → two-factor": there is no such screen, and no reachable screen anywhere.**
The server endpoints do still answer (`/rest/private/twofactor/qr/{user}`, `.../set`,
`.../verify/{user}/{code}`), but **do not drive them by hand to force 2FA on** — enrolment would be
half-built with no supported recovery path, and the realistic outcome is locking the owner out of his
own console. **Treat Headwind 2FA as unavailable in this build.**

**And were it ever reachable, it is server-wide, not per account.** The enable flag is
`settings.twoFactor` — `db.changelog.xml` adds it as `ALTER TABLE settings ADD COLUMN twoFactor
BOOLEAN NOT NULL DEFAULT false`, and `CommonMapper.setTwoFactor` writes one row per `customerId`.
What the `users` table gets is only `twoFactorSecret` and `twoFactorAccepted` — each console user's
own TOTP secret and whether they finished enrolling. 🔴 **So there is NO per-account 2FA toggle, and
"turn it on for one account but not the other" is not an available action.** The `twoFactor` field
that appears on a user record — including in the audit log's `update.user` JSON that §5.3 reads — is
marked in `User.java` as *"a transient parameter, no db entry"*: computed per login, never stored,
and no evidence of a per-user setting.

🔴 **AND IT WOULD BE HARMLESS TO THE BRIDGE — ANY WARNING THAT IT WOULD DARK THE FLEET IS WRONG.**
The switch is read by the CONSOLE's browser login only: `AuthResource` fetches the customer's
settings and, when `settings.isTwoFactor()`, sets `twoFactorNeeded` on the session plus the transient
`user.twoFactor` flag that `login.controller.js` reads to send the person to the challenge screen.
The endpoint Phoenix uses is a different class — `POST /rest/public/jwt/login` is
`JWTAuthResource.login`, which injects no `SettingsDAO` at all: it matches the MD5 password, calls
`tokenProvider.createToken` and returns a bare `{ id_token }`, after which `JWTFilter` trusts the
bearer token alone. It never reads `settings.twoFactor`, `twoFactorSecret` or `twoFactorAccepted`.
**So 2FA, if it were ever enabled, would not affect the account in `HEADWIND_MDM_LOGIN` (`phoenix`,
read live off both Fly services 2026-10-22) and would not interrupt the custody sync, the fleet reads
or any tablet command.** That account never signs in through a browser anyway.

⚠️ **Do not read `demandFromLogin` as evidence to the contrary.** `src/lib/devices/headwind/auth.ts`
has a `data.twoFactor` branch answering *"use an account without it for the bridge"*; both of its
branches read the enveloped `{ status, data }` shape the console returns, so on the JWT endpoint the
branch cannot fire at all, and its advice names a per-account choice that does not exist. It is a
harmless guard, never a measurement.

**So the console's lock is Cloudflare Access, and it is the whole lock.** Headwind 2FA would in any
case protect only the login *page* and not the token endpoint — which is why that endpoint has to
come off the public tablet hostname (see §8). The admin console otherwise sits on the public internet
with one password in front of it, and that password factory-resets tablets. **The owner's decision
(2026-09-25): the console goes behind Cloudflare Access**, so nobody reaches the login page at all
without first signing in to Cloudflare. With Headwind's own 2FA unreachable, Access is not a belt
beside a brace — it is the only second factor the console has, which is why §8.10 treats it as
required rather than as hardening.

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

⚠️ **A merge to `main` does NOT redeploy this service, and that is deliberate.** Measured
2026-09-26: `phoenix-headwind` has `rootDirectory: infra/headwind-phoenix-actions` and
`watchPatterns: ["infra/headwind-phoenix-actions/**"]`, so Railway marks every other commit
`SKIPPED` — which is why the add-on's own merge showed a `SKIPPED` deployment beside the real one and
had to be deployed by hand. **Do not "fix" that by clearing the watch pattern:** it would rebuild and
restart the server the tablets talk to on every unrelated commit to the repository, several dozen
times a day.

🔴 **BUT THE WATCH PATTERN IS A FOLDER, NOT A FILE TYPE — SO EDITING THE README IN THERE RESTARTS THE
FLEET'S SERVER.** `infra/headwind-phoenix-actions/**` matches **everything** under that folder,
`README.md` and `schema.sql` included. Measured the hard way 2026-09-26: #4451 changed that README and
nothing else in the folder — no Java at all — and Railway still built the image and replaced the
container (`SUCCESS`, not `SKIPPED`), taking the console and the device sync API down for the restart.
A session that had just written "this is docs only, it will not restart that server" was wrong by the
time the sentence was finished.

**So a typo fix in that README costs the tablets a real restart**, and two of them in a row cost two.
It is seconds, not minutes, and a tablet that misses one check-in simply retries — but say it out loud
before merging rather than discovering it in a deployment list, and **put prose that does not need to
ship with the Java in THIS runbook instead**, which sits outside the watch path and restarts nothing.
Do not narrow the pattern to `**/*.java` to dodge this: `Dockerfile`, `pom.xml` and `schema.sql` all
have to trigger a build, and a pattern that misses one of those ships a server that does not match its
own source.

🔴 **Each hostname gets its OWN CNAME target, and they are not interchangeable.** Railway issues a
separate random `…up.railway.app` name per custom domain on the same service — measured 2026-09-26,
`mdm-console` and `mdm` were given two different ones. Copying the first target into both records is
the obvious-looking shortcut and it leaves the second hostname stuck at
`CERTIFICATE_STATUS_TYPE_VALIDATING_OWNERSHIP` forever. Read each one from its own row in Railway.
While a record is missing, Railway reports `currentValue: ""` and
`DNS_RECORD_STATUS_REQUIRES_UPDATE` — and because `satopharma.com` is on Cloudflare, the unconfigured
hostname answers with **Cloudflare's own 404**, which is not the server refusing anything.

**The order matters, and getting it wrong looks like a broken certificate:** add
`mdm-console.satopharma.com` to Railway **grey-cloud first**, wait until Railway reports the
certificate issued, and only then turn the orange cloud on. Railway's own certificate request cannot
complete through Cloudflare's proxy — measured 2026-09-26: while that record was orange, Railway read
`currentValue: ""` / `DNS_RECORD_STATUS_REQUIRES_UPDATE`, and it went to
`DNS_RECORD_STATUS_PROPAGATED` within one poll of the cloud being turned grey. The grey record then
resolves all the way through to Railway's own address on both Cloudflare's and Google's public
resolvers, which is how to tell a saved change from a rendered one.

#### 🔴 THE ORANGE CLOUD DOES NOT BECOME SAFE ONCE THE CERTIFICATE EXISTS — IT PUTS THE RENEWAL AT RISK

The measurement above *is* the mechanism, and it does not expire: Railway proves ownership by reading
the CNAME's own value out of DNS, and through the proxy it reads `""`. Nothing observed here says that
check stops running at renewal time — and a renewal that quietly fails is invisible in a browser,
because once the record is orange **Cloudflare serves its own edge certificate** and the padlock stays
green while the *origin* certificate expires underneath it. `satopharma.com` is Full (strict)
zone-wide (below), so an expired origin certificate surfaces as a **526** on the console, sixty-odd
days after anybody touched anything, with nothing else changed to explain it.

**So turning the cloud orange belongs to the Access step, not to a tidy-up before it.** It buys
nothing while there is no Access policy to enforce, and it costs that risk from the moment it is on.
Both records are grey today — read back from Cloudflare's own resolver 2026-09-26 as `69.46.46.117`
and `69.46.46.125`, Railway addresses in no Cloudflare range.

🔴 **And there is no precedent on this zone to lean on, which is the part worth knowing before the
flip.** `phoenix-hr.satopharma.com` — the live production app, a Railway custom domain that has been
renewing for months — is **grey too**: measured 2026-09-26, it answers with the CNAME
`xok6ir4p.up.railway.app` and a Railway address, and Railway reads its `currentValue` correctly and
holds it at `CERTIFICATE_STATUS_TYPE_VALID`. So **every** Railway hostname on `satopharma.com` is
DNS-only, nothing here has ever renewed *through* the proxy, and the console would be the first. That
also means Cloudflare's WAF is not something Phoenix relies on anywhere today — putting the console
behind Access is a new dependency, not an extension of an existing one.

**When one does go orange, do not check it with a browser.** Ask Railway what *it* thinks of its own
certificate, which is the only reading the proxy cannot flatter:

```
domains(projectId, environmentId, serviceId){ customDomains{ domain status{ certificateStatus } } }
```

`CERTIFICATE_STATUS_TYPE_VALID` is healthy; anything back at `VALIDATING_OWNERSHIP` on a hostname
that has been live for weeks is a renewal that has started failing, and the fix is the same grey
flip that made issuance work the first time.

##### ✅ AND NOBODY HAS TO REMEMBER TO ASK — `.github/workflows/origin-certificate-check.yml`, daily

The paragraphs above describe a failure that arrives roughly sixty days after somebody flips a cloud,
with **no deploy, no merge and no red check to connect it to**. Every signal this repository already
has would stay green through it: `/api/healthz` answers from *behind* Cloudflare, CI knows nothing
about certificates, and the deploy drift check compares SHAs. A paragraph in a runbook is not a
detection, so this is a workflow.

**How it sees past the proxy — the one non-obvious part, and it is proven.** It does not resolve the
hostname. It connects to that domain's own **Railway edge target** with SNI set to the custom
hostname, so Railway serves the certificate it holds *for that hostname* — the one whose renewal is at
risk — whether the Cloudflare record is grey or orange:

```bash
openssl s_client -connect iul4dp7h.up.railway.app:443 -servername mdm.satopharma.com </dev/null \
  | openssl x509 -noout -subject -issuer -enddate
```

Verified against all three live hostnames 2026-09-26: each returns `subject=CN=<that custom host>`
with a Let's Encrypt issuer. It also reads what a browser sees, so the alert can name the gap instead
of implying the two agree.

**What it covers and what it costs.** All three Railway custom domains — `phoenix-hr.satopharma.com`
first, because the production app is the expensive one — under 21 days to expiry, alerting on the
owner's existing `TELEGRAM_BOT_TOKEN` / `TELEGRAM_ALERT_CHAT_ID` channel with `deploy-drift-check.yml`'s
own streak-age block. No checkout, no Node, no pnpm: curl, openssl and date, a few seconds a day.

🔴 **The edge targets are pinned in the workflow, and that is deliberate** — a proxied record hides its
CNAME from public DNS, which is exactly the condition this check has to work in, so it cannot look them
up. **Railway mints a new random target whenever a domain is removed and re-added**, so if a hostname
is ever re-created the check fails loudly with the GraphQL query to run and the line to update. A
connection failure there is a real signal, never noise.

Tested rather than assumed, the same day: today's real run reads origin 34d / 89d / 89d with the edge
identical on all three (which is what "all grey" looks like), raising the threshold to 40 fired
`ALARM FIRED: phoenix-hr.satopharma.com origin 34d < 40d`, and a nonexistent target took the
NO-ORIGIN-CERTIFICATE branch. A dispatch with `test_alert` proves the Telegram channel without waiting
for a certificate to nearly expire.

✅ **`satopharma.com`'s SSL/TLS encryption mode is already Full (strict)** — read from the zone
2026-09-26, "Mode last changed · 45 days ago". There is nothing to set here, and it is **zone-wide**,
not per-hostname: it also fronts `phoenix-hr.satopharma.com`. Read it before touching it, and never
move it to satisfy one new hostname.

⚠️ **`CERTIFICATE_STATUS_TYPE_VALIDATING_OWNERSHIP` sits there for a long time and looks broken. Four
checks tell "slow" from "broken", and all four are cheap:**

| Check | Healthy answer | What a different answer means |
|---|---|---|
| `curl http://<host>/` (port **80**) | **301** to `https://` | anything else — Railway's edge does not know the hostname yet; routing, not the certificate |
| `curl http://<host>/.well-known/acme-challenge/anything` | **404** | a **301** means the challenge path is being redirected and issuance can never finish |
| `curl https://<host>/` | a TLS **wrong-principal** failure (`SEC_E_WRONG_PRINCIPAL` on Windows) | a *connection* failure is routing; a wrong-principal failure is only the missing certificate |
| `CAA` on the zone and the host | **no CAA records at all** | a CAA record that does not authorize Let's Encrypt blocks issuance silently and forever |

Measured 2026-09-26 with all four healthy and both names still `VALIDATING_OWNERSHIP` a quarter of
an hour in: **it was simply slow.** `customDomainIssueCertificate(id)` nudges it; nothing else needs
doing, and re-adding the domain would only cost a new CNAME target and a second DNS edit.

#### 🔴 ACCESS CANNOT BE SWITCHED ON BY A SESSION — IT STARTS WITH A PLAN, WHICH IS THE OWNER'S

Zero Trust is **not onboarded on this account**, and the first screen of onboarding is *Choose a
plan* — Zero Trust **Free, $0 / seat / month, 50 seats**, which is ample for tablet administrators.
$0 or not, that is an account-level subscription: **no session selects it.** Until the owner does,
`Zero Trust → Access → Applications` does not exist to add anything to, and the console has no
Access in front of it whatever the table above says.

#### 🔴 ACCESS ON `mdm-console` DOES NOT SEAL THE CONSOLE — ONE TOMCAT SERVES BOTH NAMES

The table above splits the hostnames by *audience*, and it is easy to read it as splitting them by
*surface*. It does not. Headwind is one web application on one port: it serves the console at `/`
and the tablets' API under `/rest/*`, **on every hostname pointed at the service**. So while
`mdm.satopharma.com` is grey — which it must be, forever, for the tablets — the admin console is
reachable there too, with no Access in front of it.

**Which makes the admin password the real boundary, not Access.** Access raises the cost of finding
the console; only the password decides who gets in. Read
[§4.2's `admin`/`admin` block](#-the-server-comes-up-with-admin--admin-and-admin_email-never-reaches-it)
before publishing either name, not after.

🔴 **And that is why a certificate must not be allowed to issue onto a guessable name while the
password is still `admin`.** The moment Railway issues one, `mdm.satopharma.com` and
`mdm-console.satopharma.com` enter the public **Certificate Transparency** logs, which are scanned
continuously and automatically; a default-credentialled MDM console on a pharmaceutical company's
domain is exactly what that scanning is for. A Railway-generated `…up.railway.app` name is **not**
CT-logged — Railway serves it from a wildcard — which is why the generated domain is the safe place
to do the first sign-in and the password change.

**To hold the publish without unpicking the DNS,** point both custom domains at a port nothing
listens on and let the certificates finish behind a shut door:

```
customDomainUpdate(environmentId, id, targetPort: 8443)   # 8443 is the connector that always fails — see §4.3
```

Railway keeps validating and issuing; any request to those names reaches a dead port instead of a
login form. Putting them back is the same call with `targetPort: 8080`, and it needs no DNS change,
no new CNAME target and no second certificate. **Do it in that order — password first, port second.**

✅ **Measured end to end, 2026-09-26, and the hold cost nothing.** Both names went to
`CERTIFICATE_STATUS_TYPE_VALID` *while pointed at the dead port* — so a shut door does **not** stall
issuance — and the moment they went back to 8080 both answered **200** on `/` and **200** on
`/rest/public/sync/configuration/{number}` over a certificate `curl` verified without `-k`. The
whole hold is two API calls and no DNS work.

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

🔴 **AND ACCESS ALONE IS A FRONT DOOR WITH A SIDE DOOR ON RAILWAY — SO THE SERVER CHECKS THE PASS TOO**
(owner, 2026-10-22: shut the back door at the server). Access acts only on traffic that comes through
Cloudflare. Railway's edge answers anyone who connects to it directly with the console's name — exactly
the connection `origin-certificate-check.yml` makes every day — and that request never meets Cloudflare.
So the add-on's `AccessGateFilter` verifies Cloudflare's signed pass (`Cf-Access-Jwt-Assertion`: RS256,
the team's published keys, `iss`, this application's `aud`, `exp`) on every request to
`mdm-console.satopharma.com`, once `PHX_ACCESS_TEAM_DOMAIN` and `PHX_ACCESS_AUD` are set on the service; the
build proves it refuses twelve kinds of forgery (`AccessVerifierCheck.java`). The host split (§8.3)
makes sure no other name serves the console, so there is no third way in.

🔴 **There is deliberately no exception rule for `/rest/*`, and one must never be added.** It is the
obvious-looking simplification — let the API through unauthenticated and only the browser console is
guarded — and it protects nothing that matters: the REST API is what lists, commands and
factory-resets tablets, and the console is only a browser talking to that same API. It would lock
the front door and leave the back one open.

Use a long unique password for the Headwind admin account regardless, and do not reuse the owner's.

### 4.8 Backups

🔴 **One thing, and the fleet is unrecoverable without it: the `headwind-db-eu` Postgres service.** It
holds every tablet, its configuration, its rules and its history.

✅ **A DAILY AND A WEEKLY SCHEDULE NOW EXIST, both set 2026-09-28 at the owner's instruction, and a first
backup is taken.** Read back from the API rather than assumed:

| | |
| --- | --- |
| daily | cron `34 14 * * *` = **17:34 Cairo**, retention **6 days** |
| weekly | cron `47 3 * * 6` = **Saturday 06:47 Cairo**, retention **27 days** |
| first backup | `first-backup-after-eu-cutover`, 2026-09-28 02:42 Cairo, `bb3baa15-…` |

Together those give a ~4-week window rather than 6 days, which is what matters for a fleet database whose
loss means re-enrolling every tablet by hand — a fault noticed in week two is inside the weekly retention
and outside the daily. `MONTHLY` is available and still off; it costs further stored copies and stays the
owner's call.

🔴 **The mutation is `volumeInstanceBackupScheduleUpdate(volumeInstanceId, kinds)` and `kinds` is the
WHOLE set, not an addition** — passing `["DAILY"]` when a weekly exists would remove the weekly. The enum
is `DAILY · WEEKLY · MONTHLY`; **retention is Railway's to set, not ours** (6 days for daily), and so is
the hour — there is no cron argument, Railway assigned 14:34 UTC. `volumeInstanceBackupCreate` takes one
on demand and returns a `WorkflowId`, so it needs a subfield selection and the backup appears in the list
a few seconds later.

**A new service still inherits nothing** — not the region, and not a backup schedule. This one had to be
asked for, three days after the service was created.

The dumps remain the offline copy: `F:\PHX backup\headwind-db\`, the last being
`headwind-db-2026092722361-CUTOVER.dump` (52/52 TABLE DATA, md5 `58bb23c2a8113351212684fc22cb9eb0`), and
that one is **proven to restore** — restored into a scratch database beside the live one on 2026-09-28
and read back as 52 tables / 1,297 rows / 456 device-log rows / 2 users, then dropped. 🔴 **`pg_restore -l`
proves a table of contents, not a database; restore before you rely on it.** Both `sfo` orphans are
scheduled to purge on 2026-09-30 (`postgres-volume-we4X` 00:09, `postgres-volume-0WKb` 02:38), so after
that date the dumps and Railway's own backups are the whole story.

🔴 **MEASURED 2026-09-26 on the old database, and it read the same way until the schedule above:** An earlier
revision of this section said Railway "takes its own backups of a Postgres service" and to check the
retention. That is wrong, and it is the most dangerous kind of wrong — it reads as reassurance.
Railway's own API is unambiguous: `volumeInstanceBackupScheduleList` for this volume returns `[]` and
`volumeInstanceBackupList` returns **0**. **Railway does not create a schedule for you.** Nothing
about Supabase's backup story covers this database either — it is a separate Postgres service from
payroll, deliberately.

A schedule is changed on **headwind-db-eu → Settings → Backups**, or with the mutation above. It bills
storage, so **which kinds are enabled stays the owner's decision** — the daily above is the one he asked
for; adding `WEEKLY` or `MONTHLY` costs more stored copies and is his call, not a tidy-up. **Still take
one by hand before any image-tag change**, because a daily at 17:34 can be up to 24 hours stale, and
understand that losing this volume means re-enrolling the fleet tablet by tablet.

🔴 **The relay key pair is no longer a thing that can be lost, and that is a real gain from §4.5.**
On the rented box, losing `rustdesk-data` meant re-pairing **every** tablet by hand. On the public
relay there is no key pair to hold, so there is nothing to lose. The day the company takes the relay
in-house, that risk comes back with it — it is written into
[`docker-compose.headwind.yml`](../../docker-compose.headwind.yml) where it belongs.

🔴 **Railway's backups are NOT Phoenix's backups, and this one has no PITR either.** It is a separate
Postgres service from the payroll database, deliberately — a device-management server talking to reps'
tablets all day does not belong beside payroll — so nothing about Supabase's backup story covers it.

🔴 **AND IT HAS NO PUBLIC ENDPOINT, SO NOTHING OUTSIDE RAILWAY CAN READ IT — INCLUDING A SESSION
TRYING TO VERIFY THE ADD-ON'S TABLE.** Measured 2026-09-26 and unchanged after the move:
`headwind-db-eu` carries `DATABASE_URL` pointed at its private domain and **no `DATABASE_PUBLIC_URL`** —
no TCP proxy is enabled on it, so from a laptop the host does not even resolve (`ENOTFOUND`). That is the
right posture for the database that holds the whole fleet and it should stay that way, but it means the
obvious way to check `phoenix_pending_actions` — connect and `select` — **is not available by default**,
and a session will spend a few minutes finding that out.

🔴 **When a migration genuinely needs psql, open a proxy and CLOSE IT AGAIN — it is a public endpoint on
the fleet database while it exists.** `railway tcp-proxy create --port 5432` prints a
`*.proxy.rlwy.net` host and port; delete it afterwards with
`railway tcp-proxy delete --service <svc> --yes <id>`, where **the id is a POSITIONAL argument** — without
it the command only prints its usage and removes nothing. The API's `tcpProxyCreate` answers
`Not Authorized` with the CLI's own token, so the CLI is the only way in. The 2026-09-28 cut-over used
exactly this, for about a minute at each end.

🔴 **`railway ssh` can run psql inside the container instead, but it JOINS argv**, so any SQL carrying
`||`, `&&` or `>` is mangled and comes back EMPTY with a null exit — which reads exactly like an auth
failure. A single-quoted whole command works; an argv array through `spawnSync` does not. It also resolves
the link from the **exact current directory**, so it must be run from the linked folder. **The evidence that the add-on's schema is live is the server's own startup
log:** `ensureSchema()` prints `Phoenix actions add-on: table ready.` after every deploy, readable with
`railway logs` on the service. 🔴 **Do not open a TCP proxy on this database to make a verification
easier** — it would put the fleet's database on the public internet to save one command.

---

## 5. Moving a tablet across — the whole cycle for one tablet

**The first two steps of the old list are done, and were done ONCE rather than per tablet.**
Configuration **`id=3` "Rep tablets"** exists (location on, kiosk off, permissions granted
automatically) and **RustDesk 1.4.9 is attached to it** with *Run after install* and *Run at boot* both
set — so every tablet that enrols on configuration 3 installs and starts RustDesk by itself. Per
tablet, the work is the eight steps below.

Do **PHX-TAB-0002 first, alone**, and only move the rest once every step has been seen working.

**Wiping it off ManageEngine first — a tablet coming from the old system.**

1. 🔴 **If a Google account is signed in on the tablet, remove it on the tablet first** — Settings →
   Passwords & accounts → the Google account → Remove. After a factory reset, **Factory Reset
   Protection asks for the last Google account the device had**, and a tablet nobody holds that password
   for is a brick until Google releases it. A device-owner tablet normally carries no Google account at
   all; check rather than assume.
2. In ManageEngine's console — `https://mdm.manageengine.com` — **Inventory** → the tablet → **Actions**
   → **Complete Wipe** (*not* Corporate Wipe, which only pulls the managed profile and leaves the old
   management in place). That is the factory reset, issued from the server, which is why the "no factory
   reset from Settings" restriction on the rep-tablet profile does not have to be lifted first. Then
   **Actions → Remove Device** on the same row, so the seat is freed and the tablet cannot re-enrol
   itself into the system being retired.

**Bringing it up on Headwind.**

3. On the welcome screen of the factory-fresh tablet, **tap the same blank spot until the QR scanner
   opens** — Headwind's own help says **seven taps**; most tablets open it on six. **Do not sign into a
   Google account and do not finish setup**: the QR path is only offered on an untouched device.
4. Join the company Wi-Fi, then **scan the tablet's own QR code**. One link per tablet, and the number
   in it is the name the tablet comes up with:

   ```
   https://mdm-console.satopharma.com/rest/public/qr/<the Rep tablets QR key>?size=400&deviceId=PHX-TAB-0003&create=1
   (on `mdm-console` since the host split — `mdm` answers 403 to `/rest/public/qr/*`, §8.3)
   ```

   🔴 **The key is a credential and is deliberately not written down here** — anyone holding it can
   enrol a device on configuration 3. Read it once from the console: **Devices → the QR icon on a row
   already on Rep tablets**, and the key is in the address bar. `create=1` is what lets the tablet
   **create its own row** on configuration 3, so nothing has to be pre-created; leave it off and the row
   must already exist. Change only the number at the end for each tablet.

   🔴 **Since 9 Nov 2026 each set of rules has its OWN enrolment code** — Rep tablets (3), Rep tablets —
   Anti Infective (4) and Rep tablets — Pedia (5) each hold one row in `headwind_enrollment_template`
   (migration `20261109030405`), and the tablet takes the rules its own code names. A tablet for a line
   rep is enrolled from that line's card, never from the shared Rep tablets code. Phoenix refuses a code
   whose server or download is not `https://`, that carries a tablet number of its own, or whose download
   does not answer 200.
5. The Headwind agent installs itself as **device owner**, names itself from the QR, takes configuration
   3 and grants its own permissions. **RustDesk then installs and launches itself**, and again at every
   boot. Nothing is pushed by hand.
6. Open RustDesk on the tablet once, read the **ID** it shows, and set an **unattended-access password**
   (RustDesk → ⋮ → Settings → Security → Unattended access). Grant the **"RustDesk Input"**
   accessibility service (§5.1) — without it a session can watch the tablet but not touch it.
7. Type that ID into Phoenix: `/devices/tablets` → open the tablet's row → **Remote screen ID** →
   *Record the ID of `PHX-TAB-0003`*. It is stored in Headwind's own first custom field, so there is no
   second list to keep in step, and the row above the panel updates itself once it saves. 🔴 **Do not go
   looking for that field in the Headwind console — it cannot be drawn there** (§5.2). Clearing the box
   clears the ID, which is what a re-enrolled tablet needs, because RustDesk gives it a new one.
8. In Phoenix — `https://phoenix-hr.satopharma.com/devices/tablets` — confirm: the tablet is in the
   **Headwind** section, it has **added itself to the custody register** under its number, and **View
   the screen** and **Take control** both work.

**Handing a tablet to a new joiner** is then step 8 and nothing else: the tablet is already managed, so
the only per-person act is the custody entry recording who holds it. A tablet coming back from a leaver
goes round the same loop from step 1 — wipe, re-enrol, re-assign — and keeps its number.

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

### 5.2 What the live server said when the cycle above was checked against it — 2026-09-26

Four things, all read from `mdm.satopharma.com` itself rather than from this file. Two were fixed in
the same change; two are the owner's to release.

🔴 **The fleet read the device search in a shape the server does not use, so Phoenix showed NO tablets
against a server holding two.** `POST /rest/private/devices/search` answers
`{"data":{"configurations":{…},"devices":{"items":[…],"totalItemsCount":2}}}` — the page is **nested
under `devices`** — and all three readers looked for `data.items`, then for `data.devices` as an array.
Both missed and each fell through to an empty list: an empty fleet, no installed apps on any tablet, and
"that tablet is not in the Headwind fleet any more" on every configuration move. **The bridge's own
tests were green throughout, because every fixture repeated the guess.** Fixed by one shared unwrapper,
`deviceRecordsFromSearch`, pinned in `tests/headwind-bridge.test.ts` with the live envelope.

🔴 **The enrolment QR hands the tablets `http://mdm.satopharma.com`, and Railway answers every http
request — GET *and* POST — with a `301` to https.** The base URL comes from the install-time
`PROTOCOL://BASE_DOMAIN` (`PROTOCOL=http` is deliberate on Railway, where TLS ends at the edge — §4.2).
A redirected GET is harmless; the standard Android HTTP client turns a POST across a `301` into a
**bodyless GET**, which is how a tablet's own reports — model, IMEI, app list, **location** — can go
missing while the tablet still looks perfectly enrolled.

🔴 **`baseUrl` is NOT writable, and `PUT /rest/private/configurations` says `OK` while changing
nothing.** Tried twice on 2026-09-26, both times `HTTP 200 status=OK`, both times the value came back
`http://…`: the server recomputes it on read, and the same goes for an application's absolute
`urlArm64` (RustDesk's link was PUT to https and came back http). **A PUT that reports success and
changes nothing is the trap here** — read the value back, never trust the `OK`. The stored value is out
of reach from the laptop as well, deliberately: the Headwind Postgres has **no public endpoint and must
not get one**, and `railway ssh` into the service is refused by this machine's permission classifier.

✅ **What IS set, and what it does: `newServerUrl = https://mdm.satopharma.com` on configuration 3**
(owner-released 2026-09-26, "set the headwind base url to https"). That field is the server's own
"I have moved" channel: a tablet enrols over http — every step of enrolment is a GET, so the redirect
is harmless — and at its first sync it is told the server's address is the https one, after which
**everything it sends, POSTs included, goes straight there with no redirect in the way**. It points at
the same server under the same name, so nothing migrates but the scheme. Verified after the write:
`newServerUrl` https, `baseUrl` still http (expected), and `gps`, `kioskMode`, `appPermissions`, the QR
key and the RustDesk link with both its run flags all unchanged. 🔴 **Read the first tablet's own
reports on the pilot** — model, IMEI and a position are the proof that the switch happened; if they are
missing, the agent ignored the field and the permanent fix is to write `base.url` as https in
`hmdm.properties` from `infra/headwind-phoenix-actions`, which rebuilds and restarts the fleet's server
and is therefore its own decision.

🔴 **The field the RustDesk ID belongs in cannot be shown in the console — so it is typed in Phoenix.**
`custom1` — which Phoenix reads and displays as *Remote screen ID* — only appears in Headwind's device
dialog when `settings.customPropertyName1` is set. It is `null` here, and the Community console's own
settings screens **read** that name without ever setting it, so the one number a screen session is aimed
at had nowhere a person could put it.

✅ **Built 2026-09-26: a *Remote screen ID* box on the tablet's own panel** (`/devices/tablets` → open a
row), writing `custom1` through `POST /api/devices/headwind/remote-id` — Super Admin only, same-origin,
with a required audit row naming the tablet, the old ID and the new one. It still lives in Headwind, so
there is no second list. Two things it does on purpose: an **empty box clears** the ID, because a
re-enrolled tablet gets a new one from RustDesk and a stale number aims sessions at a device that no
longer answers; and the write is **read back before success is reported**, because this server has a PUT
that answers `OK` and changes nothing (above). A spelling that is not an ID is refused with what to do
instead, rather than stored for a screen session to fail on later — and stripping RustDesk's own digit
grouping is done **only when what is left is all digits**, or a sentence typed into the box would
collapse into a plausible-looking custom ID and be saved.

✅ **The customer record's `deviceLimit = 3` does NOT cap the fleet.** It reads like a hard ceiling three
tablets in. Measured instead of assumed: three throwaway rows were created past it (five in total, all
accepted) and then deleted — the effective limit is the `deviceLimit = 0` on the settings record, which
means unlimited. **Nothing needs raising before the other ninety-nine tablets.**

One more, for the click path rather than the server: configuration 3 has **no main app**, and the
Configurations tab only offers its QR icon when a configuration has one. **The QR is reached from the
Devices tab** — the QR icon on a tablet's own row — or from the direct link in §5 step 4.

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

#### 🔴 "WITNESSED" MEANS SOMETHING THAT KNEW THE DEVICE NUMBER SAID SO — READ IT AS CORROBORATION

Those three confirmation paths sit under `/rest/plugins/…/public/`, which is Headwind's own convention
for agent traffic, and the stock agent sends **no credential** to them. It cannot be made to: adding
authentication there would mean shipping a modified agent, and using the free agent exactly as
published is the entire reason this add-on exists. So the endpoint is open, measured on both published
hostnames 2026-09-26:

```
POST https://mdm.satopharma.com/rest/plugins/devicereset/public/PHX-NOPE-0000   →  200 {"status":"OK"}
```

— with no token, no cookie and no such device.

**What that does and does not allow, both measured on both hostnames:**

| | |
|---|---|
| Can a stranger **cause** a lock, a wipe or a password reset? | **No.** Every path that creates a pending row is `/rest/private/*` and answers **403** with no JWT — the add-on's `phoenix-actions/private/*` included. |
| Can a stranger **confirm** one that is already pending? | Only one already **delivered** — see the gate below. |

✅ **Gated on delivery, 2026-09-26.** `PhoenixActionStore.confirm` now requires
`consumed_at is not null`, and `consumed_at` is written by nothing but the sync hook, while it puts the
instruction into a real response for that device. Before that clause a forged confirmation could close
a row that had **never been delivered** — queue a wipe, confirm it a second later, and the console
reported it done while the tablet sat in somebody's bag. Now the worst a stranger can do is call an
action done in the seconds before the tablet does it anyway. The endpoint itself cannot be
authenticated: that would mean shipping a modified agent, which is the one thing the add-on exists to
avoid.

Two more things came with it: the source address is recorded in `confirmed_from` — from
`getRemoteAddr()`, never the caller-set `X-Forwarded-For`, and a note beside the row rather than an
identity — and **a confirmation that closes no row is logged at `WARNING`**, which is the detection. A
real agent reaches that line only on a stale retry. The answer stays `200 OK` either way, because
refusing makes a real tablet retry forever.

So the honest reading is still that a confirmation is **corroboration, not proof**: it moves an action
from *claimed* to *very probably done*, and the thing that finishes the job is the tablet's own next
check-in — a wiped tablet stops checking in and comes back as a fresh enrolment. 🔴 **Never write a
tablet off as clean on the confirmation row alone**, which is the same mistake in a new place as
reading a queued push as a witnessed one.

🔴 **The column needs an `alter`, not a widened `create`.** The live table was created 2026-09-25, and
`create table if not exists` skips the statement whole rather than reconciling columns — so
`ensureSchema` issues `add column if not exists` as well, and `schema.sql` repeats it so the two cannot
drift. Without that, the new code runs against the old shape and every statement naming the column
fails inside the hook's own swallowed catch.

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

🔴 **The add-on is Java and is OUTSIDE every required CI check**, all of which are TypeScript. It is built
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

🔴 **An uploaded app does not survive a redeploy of the tablet server.** `/files/<name>` is served
from Tomcat's work folder, which Railway recreates empty on every `phoenix-headwind` deploy, so an APK
put there by this console or by Headwind's own does not come back, while the set of rules still points
at it. The tablet then fails "Bad server response" at every check-in and never installs the app.
Measured 2026-10-22: WhatsApp, WPS Office and Telegram had all been 404 since at least 11 October, so
the rep tablet had installed none of the three. `infra/headwind-phoenix-actions/phoenix-entrypoint.sh`
restores **three** apps on every start: RustDesk and the Phoenix launcher (exact files from immutable
releases, checked by exact size), and **WhatsApp** (the official current build from
`whatsapp.com/android/current/WhatsApp.apk`, checked by an 80 MiB floor and the zip magic, because that
source floats). WhatsApp only ever moves forward, so a tablet holding a newer build than the one in the
rules reads it as a downgrade and leaves it alone, and nothing loops. **WPS Office and Telegram are not
restored yet**: re-adding one in the console works only until the next redeploy, until its file is
mirrored to a public release and pinned in the entrypoint the way the launcher is.

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
| 15 | **Lock** | 🟡 Built, and the add-on is **live** — the server logs `Phoenix actions add-on: table ready.` on every start (§4.3). Unproven only in the last link: no tablet has yet been seen to obey an injected field |
| 16 | **Lost mode on / off**, with his words on the lock screen | 🟡 Built, and the add-on is **live** — the server logs `Phoenix actions add-on: table ready.` on every start (§4.3). Unproven only in the last link: no tablet has yet been seen to obey an injected field |
| 17 | **Factory reset** | 🟡 Built, and the add-on is **live** — the server logs `Phoenix actions add-on: table ready.` on every start (§4.3). Unproven only in the last link: no tablet has yet been seen to obey an injected field |
| 18 | **Reset the screen lock** | 🟡 Built, and the add-on is **live** — the server logs `Phoenix actions add-on: table ready.` on every start (§4.3). Unproven only in the last link: no tablet has yet been seen to obey an injected field |
| 19 | **Enrollment code** held and redrawn, never minted | 🟢 Built (§6.7) |
| 20 | **Extra console sign-ins**, free and uncapped | 🟢 Built (§6.8) |
| 21 | RustDesk per-tablet settings | 🟢 Documented (§6.9) — Android cannot be pre-seeded, so it is four taps per tablet |
| 22 | A chat toggle for RustDesk | 🔴 **No such key exists.** Chat is built in and has no switch — a toggle would be a dead button |
| 23 | **Shut down** | 🔴 **Impossible on stock Android, at any price.** Signature-level permission, manufacturer only. Reboot is not a substitute (§6.1) |

### What verifying the standing server found, and what was done about it — 2026-09-26

Publishing it and then actually reading it back turned up three things. All three are **fixed in code
in this PR**, not left as warnings, and each one is pinned by a test that was broken and watched firing:

| Found | What it would have cost | Fixed by |
|---|---|---|
| The agent's three confirmation paths are unauthenticated **by the agent's design**, and `confirm` closed *any* open row for a device number — so a stranger reading the number off a tablet's own screen could mark a freshly queued **factory reset** as done while the tablet sat in a bag | A custody console reporting a wiped tablet that was never wiped — the one reading this feature exists to make trustworthy | `confirm` now requires `consumed_at is not null`, which only the sync hook writes while injecting the instruction into a real response for a real device. A forged confirmation is narrowed to the seconds in which the tablet is carrying it out anyway. The caller's address is recorded from the connection (never the caller-set `X-Forwarded-For`), and a confirmation that closes nothing logs at `WARNING` — that log line is the detection |
| A stalled certificate renewal behind an orange cloud is invisible to every signal this repo has | A **526** on the console roughly sixty days later, with no deploy to blame | `.github/workflows/origin-certificate-check.yml`, daily, reading the origin certificate past the proxy (§4.7) |
| `HEADWIND_MDM_BASE_URL` on Railway's private network is the right setting and needs no Access token — but that network is IPv6-only and unproven from inside the container | A wrong-looking `fetch failed` with no address in it, read as a broken server | `callHeadwind` now answers a transport failure with a 502 naming the address, the network, why a laptop cannot reach it, and the public fallback (§4.6) |

🔴 **The one that is not a code fix, and must not be read as one:** authenticating the confirmation
endpoints is impossible from this side, because doing it would mean shipping a modified agent — the one
thing this add-on exists to avoid. **Read a confirmed row as corroboration, never as proof, and never
write a tablet off as clean on that row alone.**

**Still the owner's own steps, and only these.** 🔴 **Shorter than it was on 2026-09-25 — there is no
box to rent, no card to enter, no SSH key, no firewall, no `docker compose`, no `cloudflared` and no
relay:**

**Struck through as of 2026-09-26 — the server is standing and answering (§4.3):**

1. ~~Railway project: PostgreSQL service, plus a service from this repo with Root Directory
   `infra/headwind-phoenix-actions` and Watch Paths set~~ ✅ **done** (§4.1).
2. ~~Its variables — the nine in §4.2, `PROTOCOL=http` among them~~ ✅ **done**.
3. ~~The port, read from the first deploy's own logs~~ ✅ **8080**, and the server returns **200** on
   both `/` and `/rest/public/sync/configuration/{number}` (§4.3).
4. ~~Both hostnames in Railway, both CNAMEs in Cloudflare~~ ✅ **done**, both **grey** and both
   reported `DNS_RECORD_STATUS_PROPAGATED`; certificates requested.

**What is genuinely still his, in this order — and the order is the point:**

5. ~~**Sign in at the Railway-generated domain and change the admin password**~~ ✅ **the owner
   reported it changed, 2026-09-26.** No session verified it, and no session ever will: verifying
   would mean submitting `admin` / `admin` to the live form, which is entering a password to
   authenticate. 🔴 **The admin EMAIL is a separate field and was not part of that report** — it may
   still be the upstream author's address (§4.2), which is where a password-reset link would go.
6. ~~Put both hostnames back on **8080**~~ ✅ **done the same minute** — two `customDomainUpdate`
   calls, no DNS change, and both names answer **200** on `/` and on
   `/rest/public/sync/configuration/{number}` over a certificate `curl` verified without `-k` (§4.7).
7. Choose the **Zero Trust plan** (Free, $0 / seat, 50 seats) — an account subscription, so no
   session picks it — then build the Access application on `mdm-console.satopharma.com` and its
   service token (§4.7). 🔴 Never put Access on the tablets' hostname. **The orange cloud on
   `mdm-console` belongs to this step and not before it** — it buys nothing without a policy and it
   risks the certificate's renewal from the moment it is on (§4.7).
   ✅ **That renewal risk is now watched rather than only written down** —
   `.github/workflows/origin-certificate-check.yml`, daily, reads the ORIGIN certificate for all three
   Railway hostnames past Cloudflare and alerts on the owner's existing Telegram channel under 21 days
   (§4.7). So an orange cloud that stalls a renewal now costs a Telegram message, not a 526 sixty days
   later with nothing to blame.
8. **Two fields, on the Phoenix app's Railway service** — `HEADWIND_MDM_LOGIN` and
   `HEADWIND_MDM_PASSWORD` (§4.6). ✅ **`HEADWIND_MDM_BASE_URL` is already set** to
   `https://mdm.satopharma.com`, with `skipDeploys`, so production was not restarted for it; all three
   are required together, so the page stays dark until these two exist and the save that adds them is
   the deploy that lands everything. **Give Phoenix its own console account, not a person's** (§6.8 —
   extra logins are free and uncapped), so Headwind's own audit trail reads "Phoenix". 🔴 The password
   is typed **there**, never sent here: Railway's variable screen puts it straight into the secret
   store, a chat message puts it in a transcript forever. 🔴 **Nothing RustDesk** — both its variables
   stay empty, and empty is the working setting.
9. ~~Decide the **`headwind-db-eu` backup schedule** (§4.8).~~ ✅ **done** — he instructed it on
   2026-09-28: `DAILY` (17:34 Cairo, 6-day retention), then `WEEKLY` (Saturday 06:47 Cairo, 27-day
   retention), plus a first on-demand backup. `MONTHLY` is the only kind still off and stays his call.
10. ~~Approve the merge.~~ ✅ **done** — #4444 merged 2026-09-26 03:11 Cairo, #4450 (the delivery gate
    and the certificate watch) at 03:35, serving as revision `8b5208d11`.
11. Run the pilot on PHX-TAB-0002.

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
| **The server as it actually runs** — the Railway service's build settings | the `phoenix-headwind` block of `.railway/railway.ts` (the retired `railway.toml` until 2026-10-23) |
| The optional self-hosted box, kept for the day the company wants its own relay (§4.5) | `docker-compose.headwind.yml`, `.env.headwind.example` |
| 🔴 The add-on that carries lock, lost mode, factory reset and password reset — **Java, outside the six CI checks**, built by Railway from the Dockerfile | `infra/headwind-phoenix-actions/` |
| The alarm and on-screen message on the tablet itself | `mobile/plugins/with-phoenix-device-actions.js` |
| The enrollment template's table | `supabase/migrations/20260925193000_headwind_enrollment_template.sql` |
| Tests | `tests/headwind-bridge.test.ts` |

It was built as a **sibling module set** beside the ManageEngine bridge (deleted 2026-10-23) and
Google's AMAPI stack, mirroring ManageEngine file for file. That duplication is the house style on this page and is deliberate — do
not refactor the three into a shared provider abstraction.

Two seams are genuinely shared, because a tablet must not be describable two different ways depending
on which console noticed it first:

- `registerTablet(facts, "headwind", …)` — `src/lib/devices/tablet-auto-register.ts`
- `recordReportedImei({ …, source: "headwind" }, …)` — `src/lib/devices/service.ts`

---

## 8. The 22 Oct 2026 end-to-end audit, and the lockdown-and-features playbook

Read live against the tablet server's own APIs, its 4,005-row device log and Phoenix's `audit_logs`,
plus the upstream Headwind agent and server source. The owner asked, 22 Oct: can the rep reset the
tablet, can apps (Outlook/Yahoo mail) be put on it, and does every function really work — location,
control, lock. The plan is `~/.claude/plans/close-the-what-is-polished-dawn.md`.

### 8.1 What really works, and what does not

| Function | Really working? | Why |
|---|---|---|
| Sync / check-in | ✅ | Hourly until each tablet went offline (0002 on 12 Oct, 0007 on 19 Oct). |
| Remote factory reset (add-on) | ✅ once | 0002 on 26 Sep; it re-enrolled the same evening. |
| **Location / "Locate"** | 🟡 built (6.40), off until flipped | 0 location rows held, because upstream started the fix-refresh service only under `MainActivity` (stock home defeats it) and config 3 is `DONOTTRACK`. 6.40 starts it from the boot/sync path too (§8.6); it stays inert until config 3's `requestUpdates` is set to `network`. |
| **Instant commands** (lock, wipe, app-removal, reboot, locate-wake) | 🔴 never delivered | `pushOptions=mqttAlarm` = MQTT on TCP 31000, never opened on Railway (775 failures, push history 0). The agent's HTTP-poll fallback is dead code in MQTT mode. Only the hourly sync carries anything. |
| Add-on "lock" | ⚠️ overlay only | The agent's full-screen overlay, not a real `lockNow`; weak under the stock home. |
| **Password reset** | ✅ fixed on the Phoenix side | Was a silent no-op: `actions.ts` sent `passwordReset: true` with **no** `password`; the add-on's `text()` nulled it and `@JsonInclude(NON_NULL)` dropped the field, yet the row was marked consumed. Phoenix now sends a one-time six-digit PIN (§8.7). Still to prove on a real tablet. |
| App installs | 🟡 built, on at deploy | Telegram, WPS and WhatsApp were wiped every redeploy, so only RustDesk + launcher reached 0007. WhatsApp is re-fetched since #6232; Telegram (telegram.org) and WPS Office (WPS's own CDN) are re-fetched at every start by the launcher-6.40 PR, each from its publisher. Config 3 sets the three to install only once each `/files/` path answers 200. |
| Remote screen (RustDesk) | ⚠️ half | Installed on both; **0007 has no RustDesk ID** (`custom1` empty) so nobody can connect. Capture the id when 0007 is next online (§6.9). |
| **Rep resets from Settings** | 🟡 built (6.40) | The agent used to lift `no_factory_reset` at the start of every sync and re-lock only after the install loop, so one 404 app left reset OFF. 6.40 keeps the protective restrictions locked for the whole sync, and adds FRP (a recovery-menu wipe comes back locked to a Google account) — both built, verified at the pilot. See §8.8. |
| Company email on tablet | ⚠️ needs an app | `satopharma.com` is Turbify cPanel; any IMAP app works, but none is installed. The owner chose Microsoft Outlook (22 Oct), which reaches the tablets as a copied `.xapk` on the durable volume (§8.9). |
| **Custody register** | ✅ fixed in this PR | Was auto-registering by serial/IMEI; now a person confirms each tablet (§8.11). |
| **Console / upload path open on every name** | 🔴 | One Tomcat serves the console, the private API and the public write paths on `mdm`, `mdm-console` and the Railway host. `/rest/public/applications/upload` is gated only by `MD5(deviceNumber + hash.secret)` where `hash.secret` is the published default (no `SHARED_SECRET` set), and device numbers are guessable — so an app row can be written into `/files` and served to tablets. A second open upload, `/rest/videos`, sits outside `/rest/private` with no check at all. Both are refused by a Tomcat rule built 22 Oct, live on the next `phoenix-headwind` deploy. 2FA is available but off. See §8.3. |

### 8.2 🔴 THE GATE — apply NOTHING in §8.3–§8.10 until Railway is healthy, and verify the server-side changes on a real redeploy before the PR is merged

As of 22 Oct, Railway has an **open platform-wide deploy pause with a security advisory** (revoke
Railway-stored env vars, review logs; Railway is rotating its own bucket credentials). `phoenix-headwind`
last built 14 Oct and nothing can deploy. Everything below changes the live MDM server that real rep
tablets depend on, and a merge to `infra/headwind-phoenix-actions/` ships straight to it on the next
deploy (§4.3) — with **no safe way to rehearse** on this machine (no local Docker; the Dockerfile's
own history records a change declined for exactly this reason). So the server-side steps are written
here as a playbook to **apply-and-verify when Railway is healthy**, not shipped as code. The code that
has shipped is all Phoenix-side and needs no tablet-server deploy: the custody confirm (§8.11), the
screen-lock PIN (§8.7) and the configuration save that keeps the app links (§8.14). Do not merge any
later server-side change on a green CI alone — green CI is not a working tablet (§4.3).

### 8.3 Close the public upload writes (built; ships when Railway deploys `phoenix-headwind`)

**Two** endpoints accept a file upload with no sign-in. Both answered `OPTIONS` with `Allow: POST` on
`mdm.satopharma.com` on 22 Oct, and nothing on this fleet uses either:

- `POST /rest/public/applications/upload` (`PublicResource.java`) writes an APK into `/files` and
  inserts an `applications` row, gated only by the published-default hash. Its one client is the
  desktop "AppList" utility, which the owner does not use.
- `POST /rest/videos` (`VideosResource.java`) is mapped outside `/rest/private`, so the JWT filter
  (bound to `/rest/private/*` only) never runs on it, and the resource itself checks nothing. Found
  while listing every resource mapped outside `/rest/private` on 22 Oct. Nothing in Phoenix calls it.

Tablets download finished APKs from `/files/<name>` and sync from `/rest/public/sync/…`; neither rule
touches them.

**What ships (owner, 22 Oct: "close the tablet server's open upload path").** A Host-level Tomcat
`RewriteValve` refuses both with 403 on every hostname the server answers to.
`infra/headwind-phoenix-actions/rewrite.config` carries the two `RewriteRule … - [F,NC]` lines. The
Dockerfile copies it to `conf/Catalina/localhost/rewrite.config` and adds the valve to `server.xml`'s
one `<Host>`. It is Host level, not the app's own context, because the base entrypoint regenerates
`conf/Catalina/localhost/ROOT.xml` at every start, while `server.xml` is copied at build and never
rewritten.

🔴 **A bad rule fails the BUILD, never the start.** A line Tomcat cannot parse stops the whole Host
while Railway still calls the deploy green (the trap in the Dockerfile's logging note).
`RewriteCheck.java` runs Tomcat's own parser (`RewriteValve.parse` per line, then `RewriteRule.parse`)
against the image's own jars at build. A typo therefore leaves the running server as it is. The
`server.xml` edit refuses to guess: exactly one `</Host>`, and no RewriteValve already there.
`tests/headwind-bridge.test.ts` pins the exact two rules, the paths they refuse, the tablet and
Phoenix paths they must leave alone, and the Dockerfile wiring.

**Verify on the redeploy (Railway must be deploying again):**
- `curl -s -o /dev/null -w "%{http_code}" -X OPTIONS` on both paths → **403** on `mdm`,
  `mdm-console` and the Railway host;
- `/files/hmdm-phoenix-6.40.apk` → 200;
- the console still signs in;
- a tablet's next sync still lands (its `lastUpdate` moves).
Never test with a real upload.

**The host split (built 22 Oct, owner: "split the Headwind console onto mdm-console behind Access").**
The same `rewrite.config` now carries a third rule: on every hostname EXCEPT
`mdm-console.satopharma.com`, only the tablet agent's own paths answer, and everything else — the console,
`/rest/public/jwt/login` (the token endpoint that skips 2FA), `/rest/private/*`, the add-on's private
paths, `/rest/public/qr/*` — is 403. The allowlist was read from the agent's own source, not from this
page: `ServerService.java`, `PushNotificationWorker`, `PushLongPollingService` and
`GetServerConfigTask` at `h-mdm/hmdm-android` master, identical at our launcher fork's
`launcher-6.39-r1` (the fork changes only a build workflow). Twelve call shapes plus `/files/`:
`sync/configuration/{n}`, `sync/info`, `notifications/device/{n}`, **`notification/polling/{n}`
(singular — this page used to say "notifications/polling", which would have refused the push channel)**,
`devicelog/log/rules|list/{n}`, `deviceinfo/deviceinfo/public/{n}`,
`deviceinfo/deviceinfo-plugin-settings/device/{n}`, `devicelocations/public/update/{n}`, and
`devicereset/public/[reboot/|password/]{n}`. The live configuration hands tablets only `/files/*` URLs on
`mdm` (read 22 Oct), so nothing else is needed.

🔴 **Tomcat's rewrite rules match the WHOLE path, not a prefix** (`Matcher.matches()` in both RewriteRule
and RewriteCond). The first upload rules were written as prefixes, so `^/rest/videos` refused
`/rest/videos` and let `/rest/videos/` through; the test missed it because JavaScript's `test()` matches
a prefix. Both are now `(/.*)?$`, and the test models Tomcat's anchoring.

**The proof runs before anything ships.** `rewrite-cases.txt` lists the requests (allow/refuse, host,
path); `RewriteCheck.java` runs Tomcat's OWN engine over every one at image build and fails the build on a
single surprise, and `tests/headwind-bridge.test.ts` checks the same file with a model of the engine plus
a coverage check that every agent path is allowed on `mdm`. The new `headwind-image` workflow builds the
real image on every PR touching `infra/headwind-phoenix-actions/`, so this is the first change here whose
Java and rules were compiled and exercised before a merge rather than on the live service. It still
cannot prove the server starts or a real tablet syncs — that is §8.13.

🔴 **The host split cuts Phoenix off the console unless Phoenix has moved first.** Phoenix's
`HEADWIND_MDM_BASE_URL` is `https://mdm.satopharma.com` today (§4.6), and after this deploy that name
answers Phoenix's sign-in with 403. The order is §8.10, and its first step comes before the merge.

### 8.4 Durable `/files` — the Railway volume (the "small disk" the owner approved)

`/files` lives under `/usr/local/tomcat/work`, recreated bare on every redeploy — which is why console
uploads vanish and the entrypoint has to re-fetch RustDesk, the launcher, WhatsApp, Telegram and WPS Office. A Railway volume
mounted at the files dir makes a one-time console upload durable (and removes the need for an entrypoint
block per app). Create it via the Railway GraphQL `volumeCreate` on the `phoenix-headwind` service,
mount path `/usr/local/tomcat/work/files`, region `europe-west4-drams3a` (the service's region — a
volume is region-pinned; see `railway-services-are-born-in-sfo-and-volumes-are-region-pinned`). Verify:
redeploy and confirm a test file under `/files` survives.

### 8.5 Instant commands — switch config 3 `pushOptions` to `polling`

MQTT (31000) is never delivered. Headwind's `polling` mode long-polls `/rest/notification/polling/{n}`
over 443 and the agent then receives pushes within seconds instead of at the hourly sync. **Precondition
(the never-show-tracking golden rule, `rep-tablet-never-shows-tracking-golden-rule`):** confirm on a real
tablet that `polling` shows no persistent notification before cutting it over. Change it on the
configuration (config id 3) through the console or the Phoenix configurations API. Verify: send one
benign `APPLY_SETTINGS` (`configUpdated`) and watch the add-on push history advance past 0 and the device
sync within seconds.

### 8.6 Location under the stock home — BUILT in the launcher (6.40)

Check-in location needs `requestUpdates` ≠ `DONOTTRACK` **and** a running fix-refresh service. Upstream
starts `LocationService` only from the launcher's `MainActivity`, which the stock Lenovo home defeats, so
the server held 0 location rows. The 6.40 launcher starts it from the boot/enrol/periodic path too
(`Initializer.startServicesAndLoadConfig`, mirroring `MainActivity.startLocationService()`), so the fix
stays fresh under the stock home; `DeviceInfoProvider.getLocation` already rides the fix onto every sync,
and `locations.ts` switches the `deviceinfo` plugin on and reads `gpsLat`/`gpsLon`. The service goes
foreground before any early stop, so the background `startForegroundService` call cannot crash. A null
(DONOTTRACK) mode is still inert — so this does nothing until config 3's `requestUpdates` is set to a
real mode (`network` is enough and cheapest). Flip it only once the pilot confirms the clean status bar
hides the foreground-service notice (golden rule — the rep sees no tracking sign).

### 8.7 Password reset — a one-time PIN, not a cleared lock (shipped, Phoenix side)

The agent's `passwordReset` is not a switch: it is the NEW password, handed to
`dpm.resetPasswordWithToken`. The chain used to drop it — `actions.ts` sent `{ passwordReset: true }`
with no `password`, `PhoenixActionsResource.text()` turned the missing value into null, the decorator's
`@JsonInclude(NON_NULL)` left `passwordReset` out of the sync, and the agent did nothing while the sync
hook still `markConsumed`ed the row.

**What ships.** Clearing the lock would leave a field tablet open to whoever picks it up, so the reset
sets a fresh six-digit PIN instead. `temporaryScreenLockPin()` draws it from `crypto.randomInt` and
skips the guessable ones (one digit repeated, a straight run up or down); `headwindAddonBody` sends
`{ deviceNumber, password: <pin>, passwordReset: true }` and refuses a reset with no PIN rather than
send one to be ignored. The PIN reaches the person who pressed the button ONCE, in the reply; it is
never in Phoenix's audit row, and the add-on clears its own copy when the tablet confirms. No add-on
change was needed — a non-empty `password` already rides through to the agent.

**Still to prove on a real tablet:** `resetPasswordWithToken` needs the reset token the agent set to be
active, and on a tablet that already had a secure lock when the token was set, Android activates it
only after one unlock. Prove it on a new tablet before relying on it. Pinned by
`tests/headwind-bridge.test.ts` (the body shape and the PIN rules).

### 8.8 Reset hardening — the re-lock and FRP are BUILT in the launcher (6.40)

Config 3 `restrictions` carries `no_factory_reset,no_safe_boot,no_debugging_features,no_add_user` (set
22 Oct). **The failed-download-lifts-the-block bug is fixed in 6.40:** upstream released every configured
restriction at the start of each sync and re-locked only after the last app installed, so one app whose
download failed stopped the loop before `lockRestrictions()` and left factory reset open until the next
good sync. 6.40 keeps the four protective restrictions (none of which block an app install) locked for
the whole sync — `ConfigUpdater` releases only the install/uninstall restrictions via
`Utils.withoutProtectiveRestrictions`, so no exit path can leave factory reset open.

**Enterprise FRP is BUILT (6.40):** `Utils.applyFactoryResetProtection` runs on every sync in
`lockRestrictions`, driven by the launcher's own `frp_accounts` **application setting** in the tablet
rules — a comma-separated list of numeric **Google** account IDs (`off` removes the lock, empty leaves
the device alone), Android 11+ and device owner only. A tablet wiped from the recovery menu then asks,
at setup, for one of those Google accounts before it can be used. The account the owner chose is
**it.satopharma@gmail.com** (22 Oct) — it must be a real Google account, and FRP needs its **numeric**
account ID, not the address (§8.12). Honest limit: FRP is honoured by the OEM, so prove it on the Lenovo
TB328XU at the pilot before relying on it.

### 8.9 A native mail app on the tablet (the owner's choice, 22 Oct)

No Google account → no Play Store, so mail arrives as a file the tablet server serves. K-9 Mail was
offered and refused as too basic (22 Oct): he wants a modern mailbox. **He chose Microsoft Outlook**
(`com.microsoft.office.outlook`) over Spark and FairEmail, knowing its AI (Copilot) works only on a
Microsoft 365 mailbox — so the company's Turbify mailbox gets Outlook's modern client without Copilot.

Outlook publishes no direct APK (Play only), and it is never taken from a third-party APK mirror. The
route, in order:

1. **Copy it once from an Android phone that installed it from Play** — Play delivers it as split APKs:
   `adb shell pm path com.microsoft.office.outlook` lists them, `adb pull` each one (adb is Google's
   platform-tools; not on the laptop as of 22 Oct).
2. **Zip the splits into one `outlook-<version>.xapk`, every `.apk` at the zip's root** — the launcher
   installs a `.xapk` itself: `InstallUtils` hands any file ending `.xapk` to `XapkUtils`, which unpacks
   each root `.apk` entry into one install session.
3. **Upload it through the console onto the durable volume (§8.4)** — it cannot be re-fetched at start
   like Telegram or WPS, because there is no publisher URL; without the volume it would vanish on the
   next redeploy. So this step waits for Railway, like §8.4.
4. **Add it to config 3 as install**, once `/files/outlook-<version>.xapk` answers 200.

The rep adds the account in Outlook as IMAP: `imap.satopharma.com` 993 SSL, `smtp.satopharma.com` 465
SSL (both CNAME `cpanel356.turbify.biz`). Outlook syncs an IMAP account through Microsoft's cloud, so
Microsoft holds the mailbox login — the same trade every hosted mail client makes. No Play means no
self-update: a newer Outlook is a new copy and upload. `webmail.satopharma.com` in the browser stays the
zero-install fallback.

### 8.10 The `mdm-console` / Access cutover — in this order, and only this order

Each step leaves everything working; doing one early is what breaks something.

1. **Phoenix moves to the console's name (before the merge).** Set `HEADWIND_MDM_BASE_URL` to
   `https://mdm-console.satopharma.com` on Phoenix's production service (and on the Fly standby worker if
   it carries the Headwind variables). Safe today: both names serve everything until step 2. Tablets keep
   `mdm.satopharma.com` — no tablet-facing URL is built from Phoenix's base URL. Verify the Device
   Custody fleet view still reads.
2. **Merge the host-split PR; Railway rebuilds `phoenix-headwind`.** The Access gate is OFF (no
   `PHX_ACCESS_*` yet) and logs that at every start. Verify on the live hosts: on `mdm`, a tablet path
   answers (sync 200, `/files/<launcher>.apk` 200) and `/`, `/rest/public/jwt/login` and
   `/rest/private/devices/search` are 403; on `mdm-console` the console signs in and Phoenix works; both
   uploads 403 on every name; a tablet's `lastUpdate` moves at its next check-in.
3. **The owner creates the Access application** (§8.12): Zero Trust → Access → Applications → Add →
   Self-hosted, domain `mdm-console.satopharma.com`; an Allow policy for his own email; a second policy,
   action **Service Auth**, for a new service token named `phoenix-headwind`. He copies three values: the
   application's **Application Audience (AUD) Tag**, and the token's Client ID and Client Secret (the
   secret is shown once).
4. **Phoenix gets the service token**: `HEADWIND_MDM_ACCESS_CLIENT_ID` / `HEADWIND_MDM_ACCESS_CLIENT_SECRET`
   on Phoenix's service (and the standby worker). Harmless before step 5: with no Access in front, the
   two headers are simply ignored.
5. **`mdm-console` goes orange** in Cloudflare DNS (proxied). Access only acts on proxied traffic. This is
   the flip §4.7 warns can stall Railway's certificate renewal; `origin-certificate-check.yml` reads it
   daily and alarms on Telegram under 21 days. `mdm` stays grey for ever.
6. **The tablet server starts checking the pass**: set `PHX_ACCESS_TEAM_DOMAIN=curly-violet-4187.cloudflareaccess.com`
   and `PHX_ACCESS_AUD=<the AUD tag>` on `phoenix-headwind` (the variable change redeploys it). Verify: the
   console in a browser asks for the Cloudflare sign-in first; Phoenix's fleet view still reads; and a
   request made straight to Railway's edge with the console's name and no pass —
   `curl --resolve mdm-console.satopharma.com:443:<Railway edge IP> https://mdm-console.satopharma.com/rest/public/jwt/login`
   — answers 403 "This address needs a Cloudflare Access sign-in."

**Break-glass:** if Access ever locks the owner out, removing both `PHX_ACCESS_*` variables turns the
gate off at the next start, and the console answers on `mdm-console` behind its password as before. Setting
only ONE of them refuses every console request by design — the log says which half is missing.

### 8.11 Custody confirm — shipped in this PR (Phoenix code)

The fleet read no longer auto-creates custody rows (the owner's 22 Oct decision: a person confirms each
new tablet). An unregistered managed tablet is surfaced with an "Add to custody" control; confirming it
calls `POST /api/devices/headwind/register` (Super Admin, same-origin, audited) which registers that one
named tablet. Leave 0007 (Ganna) and 0002 as they are. This needs no deploy and is verified by its unit
test.

**The Google page too (follow-up, 22 Oct).** The "Rep tablets" page that lists Google's enrolled
tablets (`getRepTabletsState` in `rep-tablets-service.ts`) had the same habit: every read added an
unknown enrolled tablet to custody in the viewer's name. It now only counts them
(`pendingRegistration`), and the page says to add each with "Connect a tablet by USB", the one door
left on that page. Pinned by `tests/tablet-auto-register.test.ts`. The ManageEngine
auto-register went with its code on 2026-10-23.

### 8.12 The owner's clicks (I cannot do these — reported, never done for him)

- ~~Enable **2FA** on the console accounts~~ — **struck 2026-10-22: there is no such click in this
  build.** The console's two-factor form is hard-disabled upstream (`ng-if="false"`), so nothing can
  be enabled from the UI, and forcing it through the raw endpoints would lock him out with no
  recovery. The console's second factor is the Cloudflare Access application below. §4.7.
- ~~Set a long config-3 agent password~~ — DONE 23 Oct 2026, set by the owner in the console (15 characters, not the factory value). Claude never sets or prints it.
- Create the **Access application** on `mdm-console` and its **service token** for Phoenix, and copy the
  three values §8.10 step 3 names (the AUD tag, the token's Client ID and Client Secret).
- **For the factory-reset lock (§8.8):** create the Google account **it.satopharma@gmail.com** (the
  address he chose) and hand over its **numeric FRP account ID** — the long number tied to the account,
  not the address; FRP cannot use a bare email. Get it from the People API's own "Try this method" panel
  (developers.google.com/people/api/rest/v1/people/get — `resourceName` = `people/me`, `personFields` =
  `metadata`, Execute, sign in as that account): it answers `people/<digits>`. The bare
  `people.googleapis.com` endpoint needs an OAuth token, so opening it while signed in does not work.
  **Done 22 Oct** — the account exists and the id is on file in the laptop memory note, never in this repo.
  Once the ID is in hand, Phoenix writes it into config 3's launcher `frp_accounts` application setting —
  no rebuild. Until then the lock stays off and a recovery-menu wipe returns a clean tablet.

### 8.13 Verification checklist (run when Railway is healthy)

1. `/rest/public/applications/upload` and `/rest/videos` (and both with a trailing `/`) → 403 on all three hosts; `/files/<launcher>.apk` → 200; on `mdm` the console and `/rest/public/jwt/login` → 403; on `mdm-console` the console signs in; a tablet still syncs. Then §8.10 step 6's checks once the Access gate is on.
2. A console/Phoenix APK upload survives a redeploy (volume).
3. `polling`: an `APPLY_SETTINGS` lands within seconds; push history > 0; no tracking notice on the tablet.
4. "Reset the screen lock" sets the PIN Phoenix showed on a real tablet, and refuses cleanly when it cannot.
5. A new managed tablet stays out of custody until a Super Admin confirms it (shipped here; unit-tested now).
6. A home-screen change from Phoenix leaves every app link on config 3 as it was (§8.14).

### 8.14 🔴 A configuration save must send the app links — the by-id read never has them

Read from `hmdm-server` and on production, 22 Oct. `GET /rest/private/configurations/{id}`
(`getConfigurationByIdFull`) fills `applicationSettings`, `applicationUsageParameters` and `files`, but
`applications` always comes back `[]`; the links live behind
`GET /rest/private/configurations/applications/{id}` (79 rows on config 3, 5 of them on the rules).
`PUT /rest/private/configurations` deletes every app link and re-inserts only the ones it is sent, then
re-checks `mainAppId` against them. So Phoenix's old round-trip (`{ ...current, ...patch }`, used by
the home-screen look) would have taken every app — RustDesk, the launcher, the home-screen app — off
every tablet on those rules the first time anyone saved a colour. It never ran in production.

**What ships.** `configurationWriteBody(current, links, patch)` reads the links from their own endpoint
and sends the ones with `action !== 0` (1 install, 2 remove), the same body the console's own save sends
(`allApplications.filter(app => app.action != 0)`), and refuses the save if the link read is not a list.
Any hand-run change to a configuration follows the same rule. Pinned by `tests/headwind-bridge.test.ts`.

**Two agent facts the same read turned up.** The agent ignores `action` and reads only `remove`, which
the server sets to `action == 2`: a link sent with `action` 0 ("Do not install" in the console) would
still be downloaded and installed, which is why neither save ever sends one, and "remove" (2) on an app
the tablet never installed is simply skipped. And one app whose file answers 404 stalls the install queue, so
the agent never re-applies `no_factory_reset` (§8.8) — keep config 3 free of 404 apps.

### 8.15 🔴 Linking one app must send the existing link's id — an entry without one is a second link

Measured on production, 23 Oct. `POST /rest/private/applications/configurations` treats an entry with
no `id` as a NEW link row, even when the app is already on that configuration. Setting Telegram (app 84),
WPS Office (85) and WhatsApp (86) to install on "Rep tablets" (configuration 3) through
`linkHeadwindApp` therefore left each app on those rules twice: the old link (1002, 1003, 1004, action 2
remove) beside a new one (1012, 1013, 1014, action 1). It was repaired by hand the same day: a POST of
`{ id: <old link id>, action: 1, remove: false, showIcon: true }` updated each original, and a POST of
`{ id: <duplicate id>, action: 0 }` deleted each duplicate. On this endpoint `action` 0 with an `id`
deletes the link.

**What ships.** `writeHeadwindAppLink` reads `GET /rest/private/applications/configurations/{applicationId}`
first (`data: [{ id, configurationId, applicationId, action, showIcon, remove, … }]`), and
`applicationLinkEntries` builds the entries from it: the link already on that configuration is sent
with its `id` and updated in place; if the pair already carries several links, the lowest id is kept
and every other one is sent with `action: 0`, so it is deleted; only a pair with no link at all is sent
without an id. A link read that is not a list refuses the write. `remove: false` and `showIcon` stay on
every entry (Headwind throws a NullPointerException under an HTTP 200 without them). Both callers, the
configurations route (`case "app"`) and the APK upload, go through it. Pinned by
`tests/headwind-bridge.test.ts`.

### 8.16 🔴 Every install file lives on the tablet server's own disk — a dead link stops the whole run

Measured on production, 9 Nov 2026, from both tablets' device logs. The agent installs configuration
3's apps one by one and **stops the run at the first download that fails**: nothing after it is
installed, and the agent's own update (it comes last) never starts. On 23 Oct the separate download
host `phoenix-tablet-apps.fly.dev` was rebuilt to ship launcher 6.48, and the rebuild kept only the
launcher APKs — Outlook, LinkedIn, Facebook, Waze, ChatGPT and TapScanner (`.xapk`) answered 404 from
then on. Every hourly run on PHX-TAB-0007 stopped at Outlook, so it stayed on launcher 6.39 for 17
days: no location ever sent, no remote-screen ID. A factory-fresh tablet would stall the same way in
its first run, before the hardware report that "Add to custody" needs (memory note
`a-stalled-enrolment-run-never-sends-the-tablets-hardware-report`).

The fix, 9 Nov: the six apps and the 6.48 launcher were copied onto the Railway volume mounted at
`/usr/local/tomcat/work/files` (46 GB, survives every redeploy — WhatsApp, Telegram and WPS were
already there), each SHA-256-checked against the laptop copy in `F:\Phoenix Workforce\tablet-apps\apps`,
and the seven application-version rows were edited **in place** (`PUT /rest/private/applications/versions`,
id kept — never a configuration PUT, §8.14) to `https://mdm.satopharma.com/files/<name>`.

**Rules from here:** an app or launcher file for the rep tablets goes on that volume, never on the Fly
host. Before enrolling a tablet or linking a new app, HEAD every install URL in ids 3, 4 and 5 **without
following redirects** and expect 200 (§8.18 — a 301 is as dead as a 404 to a tablet).

### 8.17 One set of rules per line — each tablet gets its line's app (owner, 9 Nov 2026)

The owner's word: "based on the line push the line app". Headwind installs apps per configuration, never
per device, so each line has its own copy of "Rep tablets" (id 3) with that line's app linked:

| Id | Configuration | Line app | Tablets |
|---|---|---|---|
| 3 | Rep tablets | — (the base the copies came from) | none after the move |
| 4 | Rep tablets — Anti Infective | Sato Anti-Infective (`com.satopharma.antiinfective`) 1.0.18 | PHX-TAB-0008 (Ahmed Abd-Elnaim), PHX-TAB-0009 (Mohamed Hamed) |
| 5 | Rep tablets — Pedia | Pedia Line (`com.satopharma.pedia`) 1.3.4 | PHX-TAB-0007 (Gannatullah Amer) |

The copies were made with `PUT /rest/private/configurations/copy` (`{ id: 3, name, description }`;
upstream `ConfigurationResource.copyConfiguration` carries every setting via `Configuration.newCopy()`
plus the plain app links). Read back on production: zero setting differences against id 3, the same 11
app links, and a QR key of their own. Each line app went in through Phoenix's `uploadHeadwindApp`
(audited), byte-identical to the build the line's own site publishes.

🔴 **A change to the shared rules — a restriction, an app, the launcher row — must now be made on ids 3,
4 and 5**, or two lines silently miss it. A version row (`applicationversions`) is shared, so a repointed
download link reaches all three at once; a link or a setting is not. A new tablet is enrolled with **its
line's** QR, never id 3's. CNS gets the same treatment (id 6) the day a CNS rep holds a tablet.

**Phoenix holds one enrolment code per set of rules** (9 Nov 2026, migration
`20261109030405_headwind_enrollment_code_per_configuration`). The tablet page shows one card per rep set
of rules, headed by its name, each revealed and saved on its own and audited with that name. Before a
code is saved or shown, Phoenix refuses it when its server address or launcher download is not
`https://`, when it carries a non-empty `com.hmdm.DEVICE_ID`, when it names another set of rules, or
when the download link does not answer exactly 200 to a HEAD sent with `redirect: "manual"` (§8.18). The
older single saved code appears only on the card of the rules its own `com.hmdm.CONFIG` names.

**The upload fix that came with it.** `uploadHeadwindApp` registered an APK with only `filePath`, so the
insert hit `null value in column "name" of relation "applications"` and the server answered
`error.internal.server` under an HTTP 200 — every upload from Phoenix's tablet page failed this way. The
register body is now `applicationRegisterBody`, which copies the server's own `fileDetails` (package,
label, version, version code, architecture) the way the Headwind console does. Pinned in
`tests/headwind-bridge.test.ts`.

### 8.18 🔴 A tablet will not follow a redirect — every install link must be `https://` and answer 200 itself

Measured on production, 9 Nov 2026, in PHX-TAB-0007's device log, after §8.16 had fixed the six 404s:
`Failed to download app com.satopharma.pedia: Bad server response for http://mdm.satopharma.com/files/Sato-Pedia-1.3.4.apk: 301`.
Headwind writes an uploaded app's link from its own base address, which is plain `http` behind
Railway's TLS. That address answers 301 to `https`, and the agent counts the 301 as a failed download.
Both line apps from §8.17 were registered this way, so the update run on every line tablet stopped at
its line app — before the launcher, which is listed after it. That is why PHX-TAB-0007 was still on
launcher 6.39 (which sends no location) even after every other link answered 200: the earlier check
followed redirects and reported 200 for the 301 links.

**The fix, 9 Nov:** version rows 10089 (Sato Anti-Infective 1.0.18) and 10090 (Pedia Line 1.3.4) edited
in place to their `https://` twins, each read back answering 200 with no redirect. `uploadHeadwindApp`
now moves every version of a just-registered app onto `https://` (`tabletFollowableUrl`) before the app
is linked to any rules, so the next upload cannot reintroduce it. Pinned in `tests/headwind-bridge.test.ts`.

**The check, from here:** HEAD every install link in ids 3, 4 and 5 with redirects **not followed**
(`fetch(url, { method: "HEAD", redirect: "manual" })`) and expect 200 — a 301 or 302 is a dead link to
a tablet.

**Why location never appeared — the chain, as measured.** The launcher that sends location (6.45 and
later, live row 6.48) is the last thing in the update run. PHX-TAB-0007 never got past the first dead
link (the Fly 404s, then the line app's 301), so it ran 6.39 and never sent a position. PHX-TAB-0008
did reach 6.45 on 22 Oct and its own log shows network fixes near 27.189, 31.180 and "posted device
info with fresh location" every ten minutes from 13:42 to 15:52 Cairo — yet neither its stored report
nor the device-info history holds a position, and it has been switched off since 16:02 that day, so
why those posts left nothing is unproven until a tablet on 6.48 is online. The server side is not the
gap: `SyncResource.updateDeviceInfo` stores `DeviceInfo.location` (`lat`, `lon`, `ts`) and the
`deviceinfo` plugin is registered and not switched off server-wide (`/rest/plugin/main/public/registered`).

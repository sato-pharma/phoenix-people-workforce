# Phoenix actions add-on for Headwind MDM

**What it is.** A small Java plugin for the company's *own* Headwind MDM server. It makes four
actions work that the free server otherwise has no way to ask for: **lock**, **lost mode** (lock with
a message on the screen), **factory reset**, and **reset the screen lock**.

**Nothing on any tablet changes.** No new APK, no re-enrolment, no setting on the device.

---

## Why this exists

It is easy to read Headwind's Community-vs-Premium table and conclude the tablets cannot do these
things. That is not where the gap is.

The free **agent** — `hmdm-android` 6.39, commit `c9221a1f` — already implements all of it, and has
for years. Read from its own source:

| Field the agent reads out of its configuration | Where it acts | What it calls |
| --- | --- | --- |
| `lock` | `MainActivity.showLockScreen()` | a full-screen overlay nothing escapes |
| `lockMessage` | the same overlay | prints the device id, then our words |
| `factoryReset` | `ConfigUpdater.checkFactoryReset()` | `dpm.wipeData(0)`, `wipeDevice(0)` on Android 14+ |
| `passwordReset` | `ConfigUpdater.checkPasswordReset()` | `dpm.resetPasswordWithToken(...)` |
| `reboot` | `ConfigUpdater.checkRemoteReboot()` | `dpm.reboot(...)` |

The agent even reports each one back afterwards, to `/rest/plugins/devicereset/public/{number}`,
`/reboot/{number}` and `/password/{number}`.

What is missing is at the **other** end: the open-source server's `Configuration` and `SyncResponse`
carry none of those five fields, and the `devicereset` plugin that owns them is not in the
open-source repository. **The tablet is listening for an instruction the free server has no way to
write.**

Headwind publishes the door for exactly this case. `com.hmdm.rest.json.SyncResponseHook` is a public
interface on the Apache-2.0 core — *"the hooks may extend the response with additional properties."*
This plugin implements it.

---

## What it adds

1. **A table**, `phoenix_pending_actions` — one row per action waiting for a tablet.
2. **A sync hook** that injects the five fields into
   `GET/POST {project}/rest/public/sync/configuration/{number}` for a tablet with a pending row.
3. **A private REST surface** Phoenix calls with the JWT it already holds:
   `POST /rest/plugins/phoenix-actions/private/action` and `GET .../status`.
4. 🔴 **The three confirmation paths the agent already POSTs to** and the open-source server does not
   serve — so today they 404. Serving them turns **"sent" into "witnessed"**: a row is marked done
   only when the tablet says it did it. On a custody console that distinction is the entire point.

   🔴 **And those three are unauthenticated, because the agent posts them without a token.** That is
   the agent's design and it cannot be closed from this side — authenticating them would mean shipping
   a modified agent, which is the one thing this add-on exists to avoid. So the confirmation is
   **gated on delivery instead**: `confirm` requires `consumed_at is not null`, meaning the sync hook
   has already written that instruction into a real response for that device. A stranger who knows a
   device number can therefore only call an action done in the seconds before the tablet does it — not
   mark a freshly queued wipe as finished while the tablet sits in somebody's bag. A confirmation that
   closes no row is logged at `WARNING`, and the answer to the agent stays `200 OK` either way, because
   refusing makes a real tablet retry forever. **Read a confirmation as corroboration, not proof, and
   never write a tablet off as clean on that row alone.**

---

## 🔴 What is proven, and what is not

**Proven from source**, before any of this was written: the agent's five fields and the calls they
make; the confirmation paths it POSTs to; `SyncResponseHook` being a public interface on the core.

**NOT proven, because it cannot be from here:**

✅ **TWO OF THESE ARE CLOSED — by Railway's own build and its own startup log, never by inspection.**
They are kept here with their answers, because the *reasoning* for why they were the riskiest parts is
still correct and any change to this directory re-opens both.

- ~~**This Java has never been compiled.**~~ ✅ **It compiles**, and has since the sixth build
  (`04fbaff7f`). The required CI checks on the Phoenix repository are all still TypeScript and still do
  not see this directory at all — **the Railway build is the only thing that compiles it**, so a change
  here that breaks the build shows up as a failed deploy, never as a red check.
- ~~**The Guice/Jersey wiring is the part most likely to need a correction.**~~ ✅ **It is picked up.**
  Verbatim from the startup log of the deploy for merge commit `8b5208d11`, the one carrying the
  delivery gate:

  ```
  00:36:52.787 INFO [main] com.hmdm.plugins.phoenix.guice.module.PhoenixActionsModule.phoenixActionStore
      Phoenix actions add-on: table ready.
  ```

  That line proves the module registered and the store was constructed — and **on this build it also
  proves `ensureSchema()` ran the new `alter table … add column if not exists confirmed_from`**, which
  is the statement the live table needed because `create table if not exists` skips its own column list
  entirely. 🔴 **The reason it mattered stands: if the hook is ever NOT picked up, the symptom is
  silent** — the sync response simply does not carry the fields and a tablet does nothing. So that log
  line is what to look for after any change here, **before** suspecting a tablet.
- 🔴 **A 403 from outside proves nothing.** Unauthenticated, `/rest/plugins/phoenix-actions/private/status`
  and `/rest/private/devices/search` return the *same* Tomcat HTML 403 — authentication intercepts
  before routing. A **404** would be evidence of absence; only an authenticated call returning
  `{"ready":true}` is evidence of presence.
- ⚠️ **One SEVERE in that startup log is expected and is not a fault.** Tomcat's `https-openssl-nio-8443`
  connector fails with `FileNotFoundException: /usr/local/tomcat/ssl/hmdm.jks`, because `PROTOCOL=http`
  and Railway terminates TLS in front of the container — there is no keystore and there should not be.
  Tomcat continues and `Server startup in [11411] milliseconds` follows it. Do not "fix" it by
  generating a keystore.
- **No tablet has yet been seen to obey an injected field.** Until the pilot runs on PHX-TAB-0002,
  Phoenix reports these actions as *sent*, never as *done*. That is why part 4 above exists.

**Phoenix's own side of this is ordinary TypeScript and is covered by CI normally** —
`src/lib/devices/headwind/actions.ts` and its tests. If the add-on is absent, Phoenix asks its
`/status` endpoint, gets nothing, and refuses the four actions **in words that say what would make
them work**. It never reports an action as sent when nothing was.

---

## Build and install

From the Headwind box, with `HEADWIND_IMAGE_TAG` pinned to the same tag the running server uses:

```bash
docker compose build headwind && docker compose up -d headwind
```

Then confirm, from the box:

```bash
curl -s -H "Authorization: Bearer $JWT" https://mdm.<domain>/rest/plugins/phoenix-actions/private/status
```

`{"ready":true}` means Phoenix will offer the four actions. Anything else — including a 404 — means
it will not, and will say so on the page.

---

## Safety

- The private endpoints sit behind the same Cloudflare Access headers as the rest of the console.
- 🔴 **A factory reset is not undoable and takes the enrolment with it.** The row records who asked
  and when; Phoenix writes its own required audit row before the tablet ever hears about it.
- The table holds a temporary screen-lock password for a reset and **clears it the moment the tablet
  confirms**. It is never logged.

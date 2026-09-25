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

---

## 🔴 What is proven, and what is not

**Proven from source**, before any of this was written: the agent's five fields and the calls they
make; the confirmation paths it POSTs to; `SyncResponseHook` being a public interface on the core.

**NOT proven, because it cannot be from here:**

- **This Java has never been compiled.** The six required CI checks on the Phoenix repository are
  TypeScript — they do not see this directory at all. It is built by the box's own
  `docker compose build`, and the first build is where a compile error shows up.
- **The Guice/Jersey wiring is the part most likely to need a correction.** Headwind discovers
  plugins through its own module registration; if the hook is not picked up, the symptom is silent —
  the sync response simply does not carry the fields, and a tablet does nothing. **Check that first,
  not the tablet.**
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

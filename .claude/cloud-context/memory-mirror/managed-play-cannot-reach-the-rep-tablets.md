---
name: managed-play-cannot-reach-the-rep-tablets
description: "OWNER DECISION 2026-09-28: the managed Google Play upload is DROPPED — the enterprise has ZERO enrolled devices, the rep tablets are Headwind-enrolled, and Headwind installs APKs it hosts. The store .aab reaches nothing; the `mdm` APK profile is the fleet artifact."
metadata:
  node_type: memory
  type: project
  originSessionId: ad19fe4d-689f-439a-a7a2-fab162bd5049
  modified: 2026-09-28T20:23:37.958Z
---

🔴 **OWNER DECISION, 2026-09-28: stop uploading the store `.aab` to managed Google Play — it cannot
reach the fleet.** His words: *"drop the managed play upload since it cannot reach the fleet"*, after
the two channels were measured against production.

**The two delivery channels are not connected:**

| | reaches a tablet by |
| --- | --- |
| managed Google Play (the `.aab`) | Google's Play channel — the device must be enrolled in `enterprises/LC017auv4o`. Measured 2026-09-28: **0 devices enrolled**, and `com.satopharma.phoenixworkforce` answers **HTTP 404** on `applications.get`. |
| Headwind MDM (the `mdm` APK) | an APK Headwind hosts at a `/files/` URL and links to a configuration. PHX-TAB-0002 is here, device-owner, **no Google account by design** ("never sign into Google first" at enrolment). |

So a `production` build can be perfect and publish cleanly and still install on nothing. 🔴 **Never
read a green store build as fleet cover, and never re-propose the Play upload as the way to ship the
app to the reps** — it only becomes useful if the tablets are ever enrolled in the enterprise, which
is a different setup from the one running.

**The fleet artifact is `eas.json`'s `mdm` profile** — arm64-only APK on the `production` channel,
~52 MB against the bundle's ~117 MB. Since #4652 it is a choice on the Mobile build workflow's
dispatch input; before that the only one ever built was a hand-made one that went three days stale
while four store builds shipped past it. See [[the-mdm-apk-is-the-only-artifact-that-reaches-the-fleet]]
if that exists, and the launcher's own signing story in
[[headwind-rep-tablet-custom-launcher-build-required]].

**Live as of 2026-09-28 23:30 Cairo:** Phoenix Workforce 0.4.0 (versionCode 4) is Headwind application
**id 83**, hosted at `https://mdm.satopharma.com/files/phoenix-workforce-0.4.0-versionCode4-mdm.apk`
(serving 200, 54,240,646 bytes) and linked to configuration **3 "Rep tablets"** with `action=1`.

---
name: phoenix-camera-stays-its-own-app
description: "Owner decided 2026-11-20 that Phoenix Camera (offline visit/validation camera, repo phoenix-field-camera) stays a separate app; its features are never folded into the Phoenix CRM app."
metadata:
  node_type: memory
  type: project
  originSessionId: 93ef71f1-e0cb-4542-814d-c955400e553f
  modified: 2026-11-20T20:31:33.222Z
---

Phoenix Camera (repo `sato-pharma/phoenix-field-camera`, Kotlin, signed with its own key that Phoenix trusts) stays its OWN app. New offline features (location pending, the four doctor's-name photos, background sending, reminders) are built there, never in the Phoenix CRM app.

**Why:** owner, 20 Nov 2026 ~22:35 Cairo, "Keep camera separate". The CRM app is a shell over the web portal, so it needs the network, and the camera exists for the no-network case. Phoenix trusts the camera's signing key only. The reps installed it that day after his email and video.

**How to apply:** never propose merging the camera into the CRM app unless he raises it again himself. Each app has one job: the CRM app when there is network, the camera when there is none.

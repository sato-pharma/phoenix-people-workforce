---
name: phoenix-field-camera-is-public-since-2026-11-25
description: "sato-pharma/phoenix-field-camera (the rep camera app) was made PUBLIC on 2026-11-25 ~21:57 Cairo on the owner's word, so its Actions minutes are free like the main repo's; anything pushed there is world-readable"
metadata:
  node_type: memory
  type: project
  originSessionId: f53e96d5-efef-4cb0-87be-309a8be47e5d
  modified: 2026-11-25T19:57:17.317Z
---

The owner said "Convert the Phoenix camera into public" on 2026-11-25 (~21:55 Cairo), after the daily Actions cost alarm went blind on it while it was private (created 20 Nov, 120 minutes used, $0 billed).

**Why:** a private repository's minutes come out of the plan's included allowance against the organization's $0 "Stop usage" Actions budget; public standard-runner minutes are not billed. Same reason as the main repository ([[the-repo-is-public-since-2026-11-07]]).

**How to apply:** treat everything pushed to phoenix-field-camera as world-readable — the release keystore and its password stay ONLY in its repository secrets (PHOENIX_CAMERA_KEYSTORE_BASE64, PHOENIX_CAMERA_STORE_PASSWORD), never in a file. Before it went public: gitleaks over all 16 commits found nothing, no self-hosted runner attached (never attach one while public), and the photo seal key is generated inside each phone's hardware keystore, so the source holds no signing secret. Its build.yml runs on pull_request; a fork pull request gets no secrets, so its signing step simply fails.

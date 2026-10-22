---
name: the-future-talents-portal-is-offline-and-its-relay-secret-waits-for-its-next-deploy
description: "The Future Talents Portal (Railway project ftp-portal, service web, talents.satopharma.com) has had NO live deployment since 18 Sep 2026 — Railway's fallback 404 — and last claimed a WhatsApp video on 13 Sep; on 22 Oct its PHOENIX_VIDEO_RELAY_SECRET was rotated with --skip-deploys, so the new value applies on its next deploy."
metadata:
  node_type: memory
  type: project
  originSessionId: 03486b16-34ba-44b4-af4e-c44a32696de1
  modified: 2026-10-22T01:21:11.874Z
---

Measured 22 Oct 2026 ~04:20 Cairo while rotating the video hand-off secret after the Railway incident:

- `ftp-portal` / `web` / `production` (project `1af51e80-36d4-402d-b8d6-dcf7ddacd0e8`, service `3cd99ab0-842a-4f95-9d58-be97a73ce810`): every deployment REMOVED, the newest from 18 Sep 11:51 Cairo, and `serviceInstance.latestDeployment` is null. talents.satopharma.com is a CNAME to Railway and answers `x-railway-fallback: true` 404.
- `whatsapp_inbound_video`: 82 videos, 81 handed off, **last hand-off 13 Sep 22:42 Cairo**, and **one video waiting since 5 Oct 15:31**.

So nothing calls `/api/integrations/ftp-videos` today. The 22 Oct rotation moved both sides at once:
- Phoenix `FTP_VIDEO_HANDOFF_SECRET`: Railway website and worker, Fly standby and Fly worker.
- The portal's `PHOENIX_VIDEO_RELAY_SECRET`: stored with `--skip-deploys`, no deploy.

They match, and the portal picks the value up whenever it is next deployed.

**Why:** a session reading "the portal runs on Railway" would wait for Railway builds to rotate it, or redeploy the portal to "pick up" the value. Neither was needed.
**How to apply:** if the portal comes back, its first call should simply work. A 401 on `integrations/ftp-videos` then means a copy drifted: compare fingerprints, never values. Whether the portal *should* be offline is his call, never assumed.

Related: [[railway-deployment-list-omits-the-active-deployment]], [[railway-security-incident-2026-10-21-pauses-every-deploy]].

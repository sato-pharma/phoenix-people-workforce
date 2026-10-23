---
name: adding-a-railway-volume-removes-the-running-deployment-first
description: "Attaching a volume to a running Railway service (volumeCreate with serviceId) REMOVES the live deployment before the new one starts — on 22 Oct 2026 10:16:50 Cairo it took phoenix-headwind (the tablet MDM) down to 'Application not found' because the replacement sat QUEUED behind Railway's outage. Never attach a volume while deploys are queuing."
metadata:
  node_type: memory
  type: project
  originSessionId: c7f8c8cf-f16c-4d7a-a67a-a7c46bb236d5
  modified: 2026-10-22T07:19:18.801Z
---

**What happened (22 Oct 2026, Cairo):** on the owner's "add the files disk to the tablet server" (runbook
§8.4, approved earlier), `volumeCreate` made `phoenix-headwind-volume` (mount
`/usr/local/tomcat/work/files`, europe-west4-drams3a) at ~10:16. Railway at once created deployment
`9be38ee7` and set the serving one, `9839f8f6` (08:47), to **REMOVED at 10:16:50** — a service with a
volume gets no overlap, so the old container is stopped FIRST to free the mount. The replacement stayed
**QUEUED** because Railway's 22 Oct platform outage was holding deploy starts ("may stay queued for
longer than expected", status page 07:11 UTC). `mdm.satopharma.com` and `mdm-console` answered Railway's
edge 404 "Application not found" — every tablet sync and Phoenix's fleet view down until the queue moved.

**How long:** down from 10:16:50 to about 11:17 Cairo (~1 hour); the 11:17 start mounted the disk and tablets resumed (PHX-TAB-0008 checked in 16:02).

**Why it was missed:** the check before acting looked at the queue (step-6 deploy `3dbb756c` already
QUEUED since 10:07) and still treated the volume as "takes effect at the next start". A queued deploy
plus a volume attach = no server.

**How to apply:**
- Before `volumeCreate` / `railway volume add` on a LIVE service, read status.railway.com AND the
  service's deploy queue; attach only when a fresh deploy starts within minutes. The attach is a
  restart with downtime even on a healthy day (no overlap with a volume).
- A queued deploy's `meta.serviceManifest.deploy.volumeMounts` is snapshotted at creation — one queued
  before the attach lists `[]`; the attach queues its own deploy that carries the mount.
- Recovery is the queue: a rollback or redeploy only adds another QUEUED row. Proof the disk is used
  after the start: the volume's `currentSizeMB` climbs from 0 as the entrypoint re-fetches the APKs.

Related: [[a-railway-build-outage-leaves-no-deployment-row]], [[railway-services-are-born-in-sfo-and-volumes-are-region-pinned]],
[[headwind-uploaded-apks-vanish-on-redeploy-and-mqtt-push-is-dead]].

---
name: whatsapp-refuses-railway-so-the-apk-is-copied-onto-the-disk
description: "whatsapp.com answers Railway's servers with a ~49 KB HTML page instead of the APK, so phoenix-headwind's entrypoint can never fetch WhatsApp itself; on 23 Oct 2026 the official 153,404,958-byte build was downloaded on the laptop and piped onto the files disk with `railway ssh -i ~/.ssh/railway_phoenix_ed25519`, hash-checked. It survives restarts on the volume."
metadata:
  node_type: memory
  type: project
  originSessionId: c7f8c8cf-f16c-4d7a-a67a-a7c46bb236d5
  modified: 2026-10-23T02:11:07.240Z
---

**Measured 23 Oct 2026 (~05:00 Cairo):** inside the `phoenix-headwind` container, `wget https://www.whatsapp.com/android/current/WhatsApp.apk`
returns 49,168 bytes starting `<!` (a web page): WhatsApp blocks data-centre addresses. The 22 Oct start got
54,790 bytes the same way, failed the 80 MiB floor, and `/files/WhatsApp.apk` answered 404. From the laptop the
same URL serves the real APK (153,404,958 bytes, `application/vnd.android.package-archive`).

**What fixed it:** download on the laptop, then
`cat WhatsApp.apk | railway ssh -i ~/.ssh/railway_phoenix_ed25519 -s phoenix-headwind -e production -- sh -c '…cat > .part; sha256 check; mv'`
into `/usr/local/tomcat/work/files` (the `phoenix-headwind-volume` disk). Public `mdm.satopharma.com/files/WhatsApp.apk` → 200, same length.

**How to apply:**
- Piping stdin needs `-i` with that already-registered key; without it `railway ssh` scans `~/.ssh` and answers `no_ssh_key`.
- Never upload a big file through `mdm-console` (Cloudflare proxied): `/rest/private/web-ui-files` got **524** after
  Cloudflare's 100-second origin limit on an 80 MB part, and the free plan caps a request body at 100 MB.
- The entrypoint keeps a file already over its floor, so the disk copy stays across restarts. A WhatsApp update has to be
  copied the same way: the server will never refresh it on its own.

Related: [[adding-a-railway-volume-removes-the-running-deployment-first]].

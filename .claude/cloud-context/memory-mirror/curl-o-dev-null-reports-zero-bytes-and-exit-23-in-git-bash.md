---
name: curl-o-dev-null-reports-zero-bytes-and-exit-23-in-git-bash
description: "In the MSYS/Git Bash shell on this machine, `curl -o /dev/null -w '%{size_download}'` can intermittently fail to write the body and report 0 bytes with exit 23, so a perfectly healthy server reads as serving empty responses; write to a real file and measure with wc -c instead."
metadata:
  node_type: memory
  type: project
  originSessionId: ab5fd790-0dde-4d83-b770-150165ef14e7
  modified: 2026-10-20T00:35:00.000Z
---

🔴 **`curl -o /dev/null -w "%{size_download}"` LIES IN THIS SHELL.** In Git Bash/MSYS here it can
fail to write the response body — curl exits **23 ("Failed writing body")** and reports
`size_download` as **0** — while the server actually sent the whole thing. The status code is still
correct, so the response looks *successful but empty*.

**Why it is so convincing: it only misreads responses that HAVE a body.** A 302 or any empty reply
writes nothing, so it reports cleanly; every 200 with content reads as 0 bytes. The result is a
pattern that looks exactly like a broken origin — "correct status codes, empty bodies, and fast" —
and that is precisely the signature of a real class of proxy fault, so it survives a sanity check.

**What it cost (19-20 Oct 2026).** During the MeshCentral cutover to the phone
([[meshcentral-second-home-is-an-android-phone-under-termux]]) it read `/meshagents?id=4` as
**200 with 0 bytes** and `/agent.ashx` as **404 with 0 bytes**, both publicly and through
`adb forward`. That was taken as a broken server and the live DNS record was **rolled back to the
laptop on evidence that was pure measurement error**. Writing to a real file showed the same server
returning a **75,803-byte login page** and the full **3,453,840-byte `MZ`** installer. The cutover
then had to be re-applied.

🔴 **The rule: never judge a response body from `-o /dev/null`.** Write it to a file in the
scratchpad and measure with `wc -c`, check the signature with `head -c2`, and prove identity with
`sha256sum` against a known-good copy. Treat **exit 23 as "the measurement failed", never as "the
server returned nothing"** — and when a diagnosis says a body is empty, confirm it a second way
before acting on it. The matching entry of the same discipline is
[[verify-the-emitted-artifact-never-the-source]].

**Corollary for tunnels.** A cancelled upstream stream logged by `cloudflared`
(`stream N canceled by remote with error code 0`, `Request failed`) is what the *client* aborting a
download looks like from the origin side. When curl is failing to write, those errors are a
**symptom of the broken measurement, not of the tunnel** — do not debug the tunnel until the client
side is proven good.

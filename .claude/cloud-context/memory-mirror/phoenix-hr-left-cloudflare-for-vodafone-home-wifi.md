---
name: phoenix-hr-left-cloudflare-for-vodafone-home-wifi
description: "Since 2026-10-31 20:36 Cairo the production domain is NOT behind Cloudflare — CNAME phoenix-hr -> phoenix-people-workforce-production.up.railway.app (69.46.46.108), unproxied, TTL 60; Vodafone home broadband silently dropped the Cloudflare addresses"
metadata:
  node_type: memory
  type: project
  originSessionId: 7ec91e47-e3b3-43c3-af60-b6269a2f2a6e
  modified: 2026-10-31T18:37:43.471Z
---

On 2026-10-31 at 20:36 Cairo the owner chose (multiple-choice, "Move off Cloudflare") to take `phoenix-hr.satopharma.com` out of the Cloudflare proxy. The record is now `CNAME phoenix-hr -> phoenix-people-workforce-production.up.railway.app`, proxied=false, TTL 60. Before: `CNAME xok6ir4p.up.railway.app`, proxied, since 2026-10-27 12:25 Cairo.

**Why:** Nora Kamal Srour (Medical Rep, Menoufia 1) could not open Phoenix on her home wifi. Her line is Vodafone home broadband (AS24835 "Vodafone Data"). Cloudflare's own `/cdn-cgi/trace` on the Phoenix domain hung there (packets silently dropped, no error page), while the direct railway.app address opened and signed her in at once. `xok6ir4p.up.railway.app` resolves to 69.46.46.36, the Railway edge that dropped ~1 in 6 Egyptian connections (the reason Cloudflare went in on 26–27 Oct). The railway.app hostname resolves to 69.46.46.108, which serves the custom domain with a valid certificate (tested with `--resolve`).

**How to apply:**
- Never flip the proxy back on, or repoint at `xok6ir4p`, without the owner: either one cuts off Vodafone home users or brings back the drops.
- `docs/deployment.md` / `docs/environment.md` and the emergency-host `point` step still name `xok6ir4p` as the only normal target. `point` refuses a record holding anything else, so the failover needs updating before it can be used.
- Undo is one Cloudflare API PATCH on the zone `satopharma.com` record (token `CLOUDFLARE_API_TOKEN` in `.env.local`, DNS edit).
- The sign-in address collapse to 79.127.178.81/.82 (Railway cdg1 edge) began on 23 Oct, before Cloudflare. It was fixed separately in #6725 (merged 2026-10-31 20:37 Cairo): `clientAddress()` now reads Railway's `X-Real-IP`, which on the direct route is the visitor.

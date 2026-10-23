---
name: headwind-admin-api-is-behind-cloudflare-access-on-mdm-console
description: "the Headwind admin API is on mdm-console behind Cloudflare Access — a login returning HTTP 200 text/html (cf-ray) is the Access sign-in page, NOT a bad password; every admin call needs the CF-Access service-token headers"
metadata:
  node_type: memory
  type: reference
  originSessionId: d36b05eb-2113-46dd-a685-dfc52e3baf52
  modified: 2026-10-23T02:02:40.739Z
---

Since #6250 / the 22 Oct lockdown, `HEADWIND_MDM_BASE_URL` = `https://mdm-console.satopharma.com` and that console sits behind **Cloudflare Access** (orange cloud). A bare `fetch` to `/rest/public/jwt/login` comes back **HTTP 200, content-type `text/html`, with a `cf-ray` header** — Cloudflare's "Sign in · Cloudflare Access" page. It parses as no `id_token`, so it looks EXACTLY like a failed/rotated admin password, but it is not: the request never reached Headwind.

**Every admin API call** (the login AND all `/rest/private/*`) must carry the service-token headers `CF-Access-Client-Id` and `CF-Access-Client-Secret`, taken from env `HEADWIND_MDM_ACCESS_CLIENT_ID` / `HEADWIND_MDM_ACCESS_CLIENT_SECRET` — both present in the `phoenix-people-workforce` Railway env, so read them via `railway run --service phoenix-people-workforce node <script>`. The app's own client already does this: `src/lib/devices/headwind/auth.ts` (`headwindAccessHeaders`) and `client.ts`. Set BOTH or neither — with one alone Cloudflare answers every request with its sign-in page.

The public device **sync/enrolment** endpoint stays open (no Access) — only the admin console is gated. So a standalone Headwind admin script written before 22 Oct (e.g. earlier version-row repoint scripts) will fail login with "200 text/html" until the two CF-Access headers are added. See [[tablet-location-goes-periodic-after-6-45-reports]].

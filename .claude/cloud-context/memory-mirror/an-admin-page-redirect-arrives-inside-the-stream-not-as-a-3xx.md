---
name: an-admin-page-redirect-arrives-inside-the-stream-not-as-a-3xx
description: A page-level redirect() behind a loading.tsx boundary answers HTTP 200 and carries NEXT_REDIRECT in the body, so a role sweep that reads only the status line reports a denied page as OPEN
metadata:
  type: project
---

`app/(admin)/loading.tsx` and `app/(admin)/admin/loading.tsx` flush a loading boundary, so by the
time a page component throws `redirect()` the status line has already gone out as **200**. Next
delivers the redirect inside the stream instead — `NEXT_REDIRECT;replace;/admin/marketing-roi;307`
in the HTML — and the browser follows it. The portal has the same boundaries per route
(`.../coverage-report/loading.tsx`).

Measured 2026-10-09 on `localhost:3000`: the CEO on `/admin/marketing-requests/roi-tracking`, whose
page says `if (access.role === "CEO") redirect("/admin/marketing-roi")`, answers `status=200
redirect=` to curl while the body carries `NEXT_REDIRECT;replace;/admin/marketing-roi;307`. A real
CEO never sees that page.

**Why:** a page sweep that follows only HTTP 3xx therefore prints `OPENS` for exactly the roles the
page turns away — the opposite of the truth, in the report whose whole purpose is who can open what.
It is silent: no error, no warning, a plausible-looking table.

**How to apply:** in any page-level sweep treat BOTH an HTTP 3xx **and** an in-body
`/NEXT_REDIRECT;(?:replace|push);([^;\\"]+);(\d{3})/` as a redirect hop, and follow it. A 3xx still
happens where the bounce is thrown before the first flush (a layout, `/login`), so both paths are
live and neither alone is enough. Related: [[a-role-sweep-runs-without-a-dev-server]] — the API-level
sweep is unaffected, because a route handler has no loading boundary in front of it.

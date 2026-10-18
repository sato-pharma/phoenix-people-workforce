---
name: the-phx-preview-dev-server-cannot-compile-a-page-at-its-2048-mb-heap
description: "HISTORY — phx-preview was RETIRED 2026-10-17, see phx-preview-is-retired-phx-live-is-the-one-dev-server. phx-preview's box dev server is pinned to PHOENIX_DEV_HEAP_MB=2048 (preview-scope.sh), and compiling /(admin)/admin/page or /employee-portals/visit-report/page runs it out of memory on a cold start (measured 2026-10-17, 3 crashes) — API routes compile fine, so walk a role through dev-auth HEADERS with curl/fetch, and a rendered page needs phx-live or production."
metadata:
  node_type: memory
  type: reference
  originSessionId: 66a89f4f-2303-4993-98ac-46a08f51bbff
  modified: 2026-10-17T12:58:48.375Z
---

Measured 2026-10-17 walking the Visit report (PR 6021, merge `43a5639cb`) on `phx-preview main`. The log
(`/home/phx/preview.log` on the box) read `[dev-server] linux -> webpack | heap cap 2048 MB` and then
`FATAL ERROR: Ineffective mark-compacts near heap limit … JavaScript heap out of memory` while compiling
`/(admin)/admin/page` (reached through `/api/dev-auth`'s redirect) and again on
`/employee-portals/visit-report/page`. The 2,048 is hardcoded in `/home/phx/preview-scope.sh`
(`env PHOENIX_DEV_HEAP_MB=2048 … node scripts/dev-server.mjs`), inside a 4 GB scope; it is box
infrastructure, so raising it is the owner's call, never a session's.

**What the crash looks like from the laptop:** the in-app browser pane answers *"navigation … was denied or
failed"* — which reads as a permission refusal and is the dead server (the pane navigated fine to
`/api/healthz` once the server was healthy). Next also restarts its own server in place at 80% of the heap,
so a long run of calls drops a connection with `UND_ERR_SOCKET other side closed` — retry after about 8 s.

**How to apply:**
- Walk a role with request headers, not a page: `x-phoenix-role` + `x-phoenix-hr-id` (+ `origin: http://localhost:3000`
  on a POST/DELETE for the CSRF check) against `/api/phoenix-crm/...`; the box env has
  `PHOENIX_ENABLE_DEV_AUTH_HEADERS=true` and the staging project. `GET /api/dev-auth/candidates?role=...` lists real
  staging people; `GET /api/phoenix-crm/overview` as that person lists their seat ids.
- Staging holds almost no Phoenix CRM visits (2 of 91 seats had any, 5 visits in 90 days), so a data walk needs
  `discover` first and a weak-reading case cannot be found there at all.
- A rendered page needs `phx-live` (5 GB scope, PRODUCTION data, audit rows written) or the live site.

Related: [[the-hetzner-previews-run-on-staging-not-production]] · [[a-listener-on-port-3000-may-be-the-preview-tunnel]] · [[the-preview-box-runs-two-checkouts-so-never-pkill-by-name]]

---
name: a-page-redirect-answers-200-with-a-meta-refresh
description: "On a dev server a page-level `redirect()` inside a streamed render answers HTTP 200 with a meta-refresh in the body, not a 307 — so a role sweep that reads only the status code reports a denial as access granted. Read the refresh target, not the status."
metadata:
  node_type: memory
  type: project
  originSessionId: c6c5b9e1-3dc9-4ddb-bddb-2f58c01d2ce3
  modified: 2026-10-12T22:00:31.132Z
---

🔴 **A page that redirects can answer 200. Read the body's refresh target, never the status alone.**

Measured 13 Oct 2026, 01:3x Cairo, sweeping `/hr/admin/hr-command-center` on the preview box
(dev server, Next App Router). `HrCommandCenterPage` calls `redirect(resolveLandingPathForRole(...))`
for any role with no HR bundle. Three viewers came back **HTTP 200 with no `Location` header** —
Super Admin (B-10), CEO (AA) and the retired `HR Advisory` key — and a status-only sweep would have
recorded all three as *reaching the HR landing*. They did not: each body was a shell whose `<h1>` is
`Loading workspace`, carrying `<meta http-equiv="refresh" url=…>` and a `NEXT_REDIRECT` payload —
`/admin` for Super Admin and the retired key, `/admin/ceo-command-center` for the CEO.

The same page answers a REAL 307 with a `Location` when the redirect is thrown higher, in the
`(admin)` group layout: Employee and Medical Rep → `/employee-portals`, no headers → `/login`.
So one page emits both shapes depending on which component threw.

**How to apply.** A role sweep records three things per hit, never one: the status, the `Location`
header, and — on any 2xx — the body's `http-equiv="refresh"` target and whether a page-identifying
marker actually rendered (for the HR landing: the `Needs attention` button and the
`Notification centre` band). A 200 with a refresh target is a DENIAL. Same trap in reverse: a 200
with no marker is not proof of a blank page.

Related: [[verify-the-emitted-artifact-never-the-source]].

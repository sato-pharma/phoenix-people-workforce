---
name: a-refused-healthchecks-autoprovision-answers-404
description: "A dead-man's-switch ping whose check cannot be auto-provisioned is answered 404, not 403 — measured in production 2026-10-15 for phoenix-brick-move-drain; the management API's 403 is a different surface, so never diagnose the ceiling from the status alone."
metadata:
  node_type: memory
  type: project
  originSessionId: 004cb97c-1d80-43ac-96cc-d6faf7f4aa64
  modified: 2026-11-04T05:45:20.972Z
---

`pingDeadMansSwitch` → `hc-ping.com/<ping-key>/<slug>?create=1` for a slug the project has no
check for and cannot create answers **HTTP 404**. The **403 with an empty body** recorded in
`docs/observability.md` and in `dead-mans-switch.ts` is the **management** API's answer to
`POST /api/v3/checks/` — a different surface entirely. Both mean the same thing (no slot), so the
shipped comment names both, but a session reasoning from the documented 403 alone will look for a
status that never arrives on the ping path.

Measured in production at 14:19 Cairo on 2026-10-15, on the first fire after #5925 deployed:

```
event="deadmans_switch_ping_refused" job="phoenix-brick-move-drain" outcome="success" status="404"
```

Before #5925 `fetch`'s response was never read at all, so this was silent: the drain had pinged
every 20 minutes since 2026-10-13 with no check behind it and no trace anywhere. The 404 is now the
one-read proof that a declared job has no external watcher — grep `deadmans_switch_ping_refused` in
`railway logs` rather than diffing the declared slugs against `GET /api/v3/checks/` by hand.

🔴 Moved on his word 4 Nov 2026 07:43 Cairo: `private-calendar-gap-notice` gave its check to `phoenix-brick-move-drain`. `POST /api/v3/checks/` answered 403 with 39 checks held, for the new check and for restoring the deleted one, so a free slot does not make the API create. A `?create=1` ping answered 201 and a tune by `POST checks/<uuid>` answered 200. Before a move, know this: once the old check is deleted the only way back is a ping. The ping key is on Railway only (`railway run`).

See [[healthchecks-schedules-are-synced-from-the-doc-table]] and
[[a-wired-healthchecks-slug-does-not-mean-anything-calls-the-route]].

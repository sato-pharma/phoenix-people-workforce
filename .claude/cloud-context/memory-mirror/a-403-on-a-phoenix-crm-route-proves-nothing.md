---
name: a-403-on-a-phoenix-crm-route-proves-nothing
description: "An unauthenticated probe of /api/phoenix-crm/** answers 403 whether or not the route exists, so it can never prove a route deployed - use git merge-base against the live /api/healthz revision instead; the 401-vs-404 trick works only on /api/cron/**"
metadata:
  node_type: memory
  type: project
  originSessionId: e94a655d-2c8b-49f4-9c2c-ad15fddfe252
  modified: 2026-09-27T19:06:08.738Z
---

🔴 **An unauthenticated probe cannot tell you whether a Phoenix CRM route is deployed.** Measured
2026-09-27:

```
POST /api/phoenix-crm/time-anchor          -> 403
POST /api/phoenix-crm/photos/upload-slot   -> 403   (exists)
POST /api/phoenix-crm/no-such-route-xyz    -> 403   (does NOT exist)
```

The auth layer answers before routing, so **403 is the answer for everything** under that prefix —
a live route, a route that shipped an hour ago and a route that was never written are
indistinguishable. Reading a 403 as "deployed and gated" is a false positive, and it is a tempting
one because it is the same shape as a check that DOES work elsewhere.

**Where the trick is real — and it is narrower than it looks: `/api/cron/**`, ON `GET` ONLY.**
Re-measured 2026-09-28, because a POST probe sent me chasing a phantom:

```
GET   401  /api/cron/phoenix-crm-daily-digest     <- exists, gated by assertCronAuthorized
GET   404  /api/cron/no-such-cron-route-xyz       <- absent
POST  403  /api/cron/phoenix-crm-daily-digest     <- useless
POST  403  /api/cron/no-such-cron-route-xyz       <- useless, identical
POST  403  /api/cron/phoenix-notify-daily         <- a route live for months, same 403
```

🔴 **On POST the same-origin/CSRF layer answers BEFORE routing, so every path under the prefix reads
403 whether or not it exists** — exactly the trap this memory is about, one prefix over. `GET` reaches
`assertCronAuthorized` inside the handler, which is what makes 401-vs-404 meaningful. Probe cron
routes with **GET**, and never read a POST 403 as either presence or absence. Do not generalise even
the GET form past `/api/cron/**`.

**How to apply — prove a deploy by ancestry, never by probing:**
- read the live revision from `/api/healthz`, then
  `git merge-base --is-ancestor <merge sha> <live revision>`;
- or just run `node .claude/skills/ship/verify-shipped.mjs <pr>`, which does exactly that and
  distinguishes QUEUED from SHIPPED. A build behind another merge reads as queued, not as failed —
  see [[a-squash-merge-makes-a-stacked-branch-rebuild-not-merge]] for the neighbouring trap about
  stacked branches.
- A 200 from the route itself would prove it, but that needs a real session, and signing in as the
  owner to satisfy a smoke test is not a thing to do.

---
name: sheet-token-rotations-had-no-schedule-for-18-days
description: Both live-sheet feed tokens sat unrotated 2026-08-05 → 08-23 because nothing called the rotation routes; they now run Fridays 03:23 and 03:43 Cairo (cron-job.org 8313169 / 8313171) and ping /fail on rotated:false. A once-a-minute Apps Script 403 on the Direct Orders feed is a stale sheet copy on the link revoked 08-05, not a failed rotation
metadata: 
  node_type: memory
  type: project
  modified: 2026-09-15T21:04:54.146Z
  originSessionId: 86fdb9ce-282b-4969-bfad-1d71dfb75ca3
---

**The purest form of "the code is fine and the job is dead".** `/api/cron/direct-orders-rotate-sheet-token`
and `/api/cron/marketing-requests-rotate-sheet-token` were correct, deployed and fully configured —
and **nothing had ever called either one**. Both live feed tokens were minted **2026-08-05** and had
not rotated 18 days later. Every visible signal said healthy: webhook variable pairs set on Railway,
exactly one live `feed` share link each (so no no-op branch applied), and both sheets read tens of
thousands of times a week (25,156 and 24,820 reads, newest 2026-08-23 09:1x Cairo). The only two
`system:rotation` audit rows are both from 2026-08-05.

**Fixed by creating the SCHEDULE first, then wiring the watch** (PR #2322):

| cron-job.org job | Slug | When (Africa/Cairo) |
| --- | --- | --- |
| `8313169` | `phoenix-direct-orders-rotate-sheet-token` | Fridays 03:23 — `23 3 * * 5` |
| `8313171` | `phoenix-marketing-requests-rotate-sheet-token` | Fridays 03:43 — `43 3 * * 5` |

Weekly on the Egyptian weekend, 20 min apart so two Apps Script round-trips never share a 30 s
window. **The cadence is a judgement call, not a requirement** — daily is harmless.

**Both ping `pingDeadMansSwitch` DIRECTLY, not via `withDeadMansSwitch` — do not "simplify" this.**
The wrapper reads throw/no-throw, and every failure these routes can have returns **HTTP 200** with
`{ rotated: false, reason }`: variables unset, no live feed link (the report is dead), >1 live link
(ambiguous), or the sheet never reading back with the new token. A success always leaves exactly one
live link, so `rotated: true` is the steady state and there is **no benign `false`**. Wrapping them
puts a green check above a route that no-ops every Friday for a year.
`tests/sheet-token-rotation-liveness.test.ts` pins all of it, including the job ids — the only
handle on a schedule this repo cannot see.

The marketing token is the one **found publicly readable 2026-08-05** (`anon` could read
`marketing_request_report_share_links.token`, RLS off). Revoking the grant stopped the bleeding but
could not un-expose the token — which is exactly what the rotation that never ran was for.

**PROVEN WORKING 2026-08-23 14:00 Cairo** — both triggered by hand against production (owner
approved), using the exact `Authorization` header cron-job.org holds, so the 401 failure mode that
killed the Direct Orders sweeps is ruled out. Both returned `rotated: true` in **4.7 s / 3.7 s**,
far inside cron-job.org's 30 s cap. Verified in the DB, not from the 200: the new link is created
**before** the old is revoked (3–4 s apart), leaving exactly one live link each — the fail-safe
ordering the routes document, confirmed in practice. Tokens `59435347c7` (direct) / `e042600cb6`
(marketing), both minted 2026-08-05, are now revoked.
**Still NOT proven: that the Healthchecks ping lands.** `pingDeadMansSwitch` never throws and
swallows failures into a `logWarning`, so HTTP 200 says nothing about it; `HEALTHCHECKS_PING_KEY`
and `CRON_SECRET` ARE both set in Railway production (checked by name), so it is at least not inert.
Confirming a ping needs a Healthchecks **read** API key — the ping key cannot read — and that is not
in `.env.local`.

**The Brevo failover keepalive was ALSO triggered by hand 2026-08-23 (owner approved) and the key
is ALIVE** — HTTP 200, `status: "ok"`, an account returned, in 0.48 s. It sends NO email: it is
`GET https://api.brevo.com/v3/account`, which authenticates the key without dispatching mail or
burning a send credit (free 300/day tier), so it does NOT fall under the never-fire-test-emails
rule. Brevo expires a key after **90 consecutive days of inactivity regardless of its set expiry**,
and the failover is by design never exercised while Resend is healthy — so cron-job.org job
`8313297`, monthly on the 1st at 04:09 Cairo, gives ~3 pings per expiry window. That is a real
margin, not a marginal one. A `failed` ping THROWS on purpose (500 + switch fail); `skipped` means
no `BREVO_API_KEY` and stays green.

**A Google-Apps-Script 403 once a minute on the Direct Orders feed is NOT a failed rotation, and it
is ALREADY KNOWN — found four times** (the 2026-08-05 revocation note, #2374 on 08-24,
`docs/runbooks/direct-orders-feed-token-stale-duplicate-2026-09-05.md` via #3322, re-measured
09-15). It is a stale script copy still using the ORIGINAL bootstrap link (token prefix `pgn0W2`,
label "Owner live Google Sheet feed (all direct orders)"), revoked 2026-08-05 15:22 Cairo after 470
reads, and refused every minute since: roughly 59,000 calls by 09-15, on every day sampled in Railway
HTTP logs from 08-24. **Only a person signed in to the Google account holding the copy can stop it**
— delete that copy's `refreshDirectOrders` trigger. Do not re-investigate from Phoenix: it cannot see
the account. **The Apps Script `id:` in the user agent is per SCRIPT, not per Google account** — the
live Direct Orders, Marketing and CV-lifecycle sheets each carry a different one — and the source IPs
are Google's shared pool. **The 09-05 runbook is wrong twice.** A copy made on 5 August most likely
runs 5 August code, which on a non-200 only `console.error`s and returns: no STALE banner (that
arrived 08-24, and sheet code reaches a copy only by hand) and no Google failure email. And its fix,
re-pointing the copy's `FEED_TOKEN` at the live token, adds a second reader that the next Friday
rotation strands again. It also committed two full tokens, one of them (`1_qf4G`, sha-verified) live
at the time: in the private repo from 09-06 00:27 until the 09-11 03:23 rotation revoked it. The
copy most likely shows 5 August figures with tabs Cover / Direct Orders / By Status; the live sheet
has Executive Summary and Comparison.
**cron-job.org returned 0 history entries for job 8313169 on 09-15**, four days after a run the
database proves happened — never rely on it for a weekly job; the proof of `rotated: true` is the
`system:rotation` audit row with `confirmedBySheet: true`, present for 08-23, 08-28, 09-04 and 09-11.
Spotted the same day: the Direct Orders rotation insert omits `allow_files` (Marketing's carries
it), so every Direct Orders link since the 08-23 rotation is `false` and the live sheet's
evidence-photo column has been blank since then — flagged, not fixed.

Related: [[a-wired-healthchecks-slug-does-not-mean-anything-calls-the-route]],
[[a-cron-that-fails-nightly-can-do-so-forever-unwatched]],
[[cron-job-org-is-managed-by-a-rest-api-not-just-the-web-ui]].

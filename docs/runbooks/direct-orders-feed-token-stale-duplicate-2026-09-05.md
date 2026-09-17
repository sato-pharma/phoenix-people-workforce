# Direct-orders feed share link — a stale duplicate Sheet, found 2026-09-05

> **Corrected 2026-09-16.** The first version of this runbook (#3322) got two
> things wrong. The copy almost certainly shows **no** staleness banner: the code
> it has run since 5 August had none, and only a paste changes a copy's code. And
> its fix, putting the live token into the copy, was wrong: the copy's trigger has
> to be stopped instead (see **Fix**). That version also carried two full share
> tokens; both are revoked, and each is now cut to its first 6 characters.
> **Re-measured 2026-09-15** is new. All times are Cairo local.

Production is healthy. This is not an incident with the app — it is a dead
external consumer that has been silently failing for a month, found while
verifying production logs after an unrelated deploy.

## Symptom

Production HTTP logs show a recurring 403, once a minute, every minute,
indefinitely:

```
GET /api/share/direct-orders/pgn0W2…/feed  403
```

## Root cause — confirmed, not guessed

The token belongs to a share link labelled `"Owner live Google Sheet feed (all
direct orders)"` (`direct_order_report_share_links`, `created_by_hr_id = AA`).
It is not a stray test link — it was *the* original live-sheet token, and it
went through the automated rotation system
(`src/lib/direct-orders/sheet-token-rotation.ts`) exactly as designed:

| Token (first 6) | Created (Cairo) | Revoked (Cairo) |
| --- | --- | --- |
| `pgn0W2…` — the one 403ing | 2026-08-05 11:01 | **2026-08-05 15:22**, same day |
| `RE_e9v…` | 2026-08-05 15:15 | 2026-08-23 14:00 |
| `31ef-M…` | 2026-08-23 14:00 | 2026-08-28 03:23 |
| `J6YbW4…` | 2026-08-28 03:23 | 2026-09-04 03:23 |
| `1_qf4G…` | 2026-09-04 03:23 | 2026-09-11 03:23, by the Friday rotation (still live, verified `200`, on 2026-09-05) |

The Friday rotation carries on; the tokens after `1_qf4G…` are deliberately
not listed here.

Rotation only revokes the old token after **observing** the live sheet's own
Apps Script actually read with the new one (`tokenHasBeenUsed`, confirmed by a
bumped `access_count` — not by trusting the push's HTTP reply). That has
worked correctly four times in a row. The canonical live sheet is fine.

**Proof it's a second, separate Google Sheet, not the canonical one somehow
stuck on a cached value** — every Apps Script project carries its own ID in
its outbound `User-Agent`, and the two differ:

| | Apps Script ID | Status |
| --- | --- | --- |
| Polling the dead `pgn0W2…` token | `UAEmdDd-ww0d96vY8iUi2qkqtUWEC_Q4xMQ` | stuck, 403 every minute since 2026-08-05 15:22 |
| The canonical live sheet (current token) | `UAEmdDd81ZDwUgVVDQ3gBUYEGBFaJ8L-l9ZI` | working, verified `200` |

Google assigns a distinct script ID per Apps Script project, including one
bound to a spreadsheet copy made via *File > Make a copy*. Different IDs =
different deployments, conclusively.

**The copy does not run the repository's script.** Today's
`docs/direct-orders-live-sheet.gs` answers a non-200 with `markFeedStale(...)`,
a red STALE banner in row 2. That banner arrived with #2374 at 04:04 on
2026-08-24, and sheet code reaches a Google project only when someone pastes it
in, or when `scripts/push-apps-script.mjs` pushes it to the one project whose id
is configured, `DIRECT_ORDERS_APPS_SCRIPT_ID` — the live sheet's. A copy is a
separate project, so neither path reaches it. The copy has polled since before
15:22 on 2026-08-05, and every repository version of the script that carried
its token (#1754 at 12:09 through #1773 at 15:06 that day), like every version
after them until #2374, answered a non-200 only with
`console.error("Feed returned HTTP " + response.getResponseCode())` and a
`return`. No banner, and no Google failure email either: a run that logs and
returns ends as completed.

Rotation only pushes new tokens to **one** configured webhook URL
(`SHEET_REFRESH_WEBHOOK_URL`), so any independent copy of the sheet — with the
token in its own code or its own `FEED_TOKEN` Script Property — is invisible to
the rotation system and will never be updated automatically.

**Working theory, not proven:** someone made a personal copy of the live sheet
on or around 2026-08-05, before or right at the first rotation. That copy has
been showing data frozen at whatever it last fetched before 15:22 that day —
over a month stale — and nothing on it says so: no staleness banner, and its
own "Updated … (Cairo)" line simply stopped moving. That is the silent failure
#2374 fixed, on the live sheet alone.

## What Phoenix cannot answer

Who made the copy. The request carries a Google Apps Script ID (not a Google
account/email) and a source IP from Google's shared Apps-Script egress pool
(`34.116.28.67-69`, not attributable to a person). Phoenix's own database only
records who created the *token* (the owner, `AA`) — it has no visibility into
Google Drive, so it cannot see who ran "Make a copy" on the spreadsheet
itself. That answer, if it exists, is in that Sheet's own Google Drive
version history / Activity panel — outside anything this app or its logs can
see.

## Fix

**Stop the copy; never give it a token.** The first version of this runbook
said to set the copy's `FEED_TOKEN` Script Property to the live token. Do not:

- It hands a bearer token to a second reader, outside anything Phoenix
  controls, and one that cannot be cut off without cutting off the live sheet
  too.
- It would not hold. The Friday rotation (cron-job.org, Fridays 03:23) hands
  each new token to **one** webhook only, `SHEET_REFRESH_WEBHOOK_URL` — the live
  sheet — and revokes the old token once the live sheet has read with the new
  one. The copy would be refused again within a week.

Instead:

1. **Check the Triggers page in both Google accounts first.** The live
   direct-orders Apps Script project is owned by a different Google account
   from the one holding the Apps Script push grant, and is only shared with it
   (`docs/environment.md`, "Finding a sheet's script id, and proving it is the
   right one"). A trigger belongs to the account that created it, and only that
   account can delete it, so sign in to each account in turn and open
   **script.google.com → Triggers**.
2. Find the time-driven `refreshDirectOrders` trigger that is **not** the live
   project's. Their executions tell them apart: the copy's log
   `Feed returned HTTP 403` and still end as completed, because its code only
   logs and returns; the live sheet's succeed. The copy most likely also lacks
   the Executive Summary and Comparison tabs, which came after its token died
   (#1798 at 20:02 on 2026-08-05, #1821 at 00:14 on 2026-08-06).
3. Signed in to the account that holds the copy, delete that trigger, or delete
   the copy. If neither account lists it, the trigger belongs to some other
   Google account and has to be stopped from there.

Nothing in Phoenix needs changing: `pgn0W2…` stays revoked, and 403 is the
right answer to it. The once-a-minute 403 stops when the trigger does.

## Re-measured 2026-09-15

- **The copy is still refused, about once a minute:** roughly 59,000 refusals
  since 15:22 on 2026-08-05, seen on every day sampled in Railway HTTP logs
  from 2026-08-24 to 23:47 on 2026-09-15.
- **The live sheet is healthy:** exactly one live feed link, 6,848 reads, the
  last at 00:00 on 2026-09-16.
- **Rotation is confirming with the sheet:** the rotations on 2026-08-23,
  08-28, 09-04 and 09-11 each wrote the `confirmedBySheet` audit row.
- **Both tokens this runbook once carried are revoked**, so nothing needed
  rotating when they came out of it on 2026-09-16: `pgn0W2…` since 15:22 on
  2026-08-05, and `1_qf4G…` — still live when #3322 committed it — since the
  Friday rotation at 03:23:06 on 2026-09-11, checked by sha256 against the
  production row on 2026-09-16. Git history keeps both in full, which is
  harmless only because both are dead. `tests/docs-share-token-guard.test.ts`
  now fails any tracked file under `docs/` that carries a token-shaped string.

## Still open

1. **Which Sheet holds the dead token, and who owns it — unresolved.** Not
   findable from Phoenix. The Triggers pages in **Fix** are the quickest first
   look; after that, someone with access to the relevant Google Drive folder
   can check file version history around 2026-08-05.
2. The dead token itself was left as-is (already revoked, does no harm sitting
   in the table) — no cleanup action taken against
   `direct_order_report_share_links`.

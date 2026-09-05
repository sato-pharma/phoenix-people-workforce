# Direct-orders feed share link — a stale duplicate Sheet, found 2026-09-05

Production is healthy. This is not an incident with the app — it is a dead
external consumer that has been silently failing for a month, found while
verifying production logs after an unrelated deploy.

## Symptom

Production HTTP logs show a recurring 403, once a minute, every minute,
indefinitely:

```
GET /api/share/direct-orders/pgn0W2b6jES7op9t7bChvrdzI95xoZbuygXb35Gu--w/feed  403
```

## Root cause — confirmed, not guessed

The token belongs to a share link labelled `"Owner live Google Sheet feed (all
direct orders)"` (`direct_order_report_share_links`, `created_by_hr_id = AA`).
It is not a stray test link — it was *the* original live-sheet token, and it
went through the automated rotation system
(`src/lib/direct-orders/sheet-token-rotation.ts`) exactly as designed:

| Token (preview) | Created (UTC) | Revoked (UTC) |
| --- | --- | --- |
| `pgn0W2b6…` — the one 403ing | 2026-08-05 08:01 | **2026-08-05 12:22**, same day |
| `RE_e9vy8E…` | 2026-08-05 12:15 | 2026-08-23 11:00 |
| `31ef-M1fB…` | 2026-08-23 11:00 | 2026-08-28 00:23 |
| `J6YbW4EI…` | 2026-08-28 00:23 | 2026-09-04 00:23 |
| `1_qf4Gltg…` | 2026-09-04 00:23 | still live — verified `200` |

Rotation only revokes the old token after **observing** the live sheet's own
Apps Script actually read with the new one (`tokenHasBeenUsed`, confirmed by a
bumped `access_count` — not by trusting the push's HTTP reply). That has
worked correctly four times in a row. The canonical live sheet is fine.

**Proof it's a second, separate Google Sheet, not the canonical one somehow
stuck on a cached value** — every Apps Script project carries its own ID in
its outbound `User-Agent`, and the two differ:

| | Apps Script ID | Status |
| --- | --- | --- |
| Polling the dead `pgn0W2b6…` token | `UAEmdDd-ww0d96vY8iUi2qkqtUWEC_Q4xMQ` | stuck, 403 every minute since 2026-08-05 12:22 |
| The canonical live sheet (current token) | `UAEmdDd81ZDwUgVVDQ3gBUYEGBFaJ8L-l9ZI` | working, verified `200` |

Google assigns a distinct script ID per Apps Script project, including one
bound to a spreadsheet copy made via *File > Make a copy*. Different IDs =
different deployments, conclusively.

The script's own source explains the exact failure mode
(`docs/direct-orders-live-sheet.gs:493-498`): a non-200 response calls
`markFeedStale(...)`, which the sheet shows visibly — but "403 is the one that
hides: the link was revoked or has expired, so this will keep failing every
minute for ever until somebody re-points FEED_TOKEN at a live link." Rotation
only pushes new tokens to **one** configured webhook URL
(`SHEET_REFRESH_WEBHOOK_URL`), so any independent copy of the sheet — with its
own `FEED_TOKEN` Script Property — is invisible to the rotation system and
will never be updated automatically.

**Working theory, not proven:** someone made a personal copy of the owner's
live sheet on or around 2026-08-05, before or right at the first rotation.
That copy has been showing data frozen at whatever it last fetched before
12:22 UTC that day — over a month stale — with its own visible staleness
banner that nobody has apparently looked at.

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

Whoever finds the stale duplicate Sheet: open **Extensions > Apps Script >
Project Settings > Script Properties** and set `FEED_TOKEN` to the current
live token, or retire the duplicate if the canonical sheet already covers the
need. Current live token (verified `200` on 2026-09-05):

```
1_qf4Gltg9ZS1IvTRG-1tMOkdKKdi772o5o-al896UY
```

## Still open

1. **Which Sheet holds the dead token, and who owns it — unresolved.** Not
   findable from Phoenix; needs someone with access to the relevant Google
   Drive folder to check file version history around 2026-08-05.
2. The dead token itself was left as-is (already revoked, does no harm sitting
   in the table) — no cleanup action taken against
   `direct_order_report_share_links`.

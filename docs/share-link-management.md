# Share-link management screens

The three live Google Sheets (CV Lifecycle, Direct Orders, Marketing Requests) each read Phoenix through a bearer token in an unauthenticated route. This is the account behind the rules in `.claude/rules/platform.md`, "Live-sheet share links".

## The list never carries the whole token

Direct Orders and Marketing mapped `token: String(row.token)` into the row their `GET .../report/share-links` serialised until 13 Oct 2026, so every live bearer credential reached the browser of anyone holding export: devtools, the React tree, any error report that captured a network body. Hiding it in JSX would have left all of that untouched. The CV-lifecycle service was fixed first and is the shape the other two now follow.

- The row type has no `token` field; it carries `tokenPreview`, the first 8 characters, which is also what the audit rows store.
- The whole token leaves only in the mint response (`created.token` on the screen). A lost token is revoked and a new link minted.
- Pinned by `tests/share-link-lists-omit-token.test.ts` and section 3 of `tests/cv-lifecycle-share-links-screen.test.ts`.

## Stored as a hash, metered before the lookup (13 Nov 2026)

The Direct Orders report, Marketing Requests report, Territory preview and CV Lifecycle links keep only `token_hash` (the SHA-256 of the token, hex, unique) and `token_preview` (its first 8 characters). The interview calendar links work the same way.

- `src/lib/share-links/token-hash.ts` hashes a token, refuses one that could not have been minted (it is never looked up), and meters a public read per address and per link before the lookup. A refusal is 429 with `Retry-After`, or 503 when the limiter cannot be read; neither serves anything.
- The weekly rotations observe the sheet's first read by hash, delete an unconfirmed new link by hash, and revoke the old one by its row id.
- `20261113183501` added the columns and filled them from each row's own token, so every link already in a sheet kept opening. `20261113183503` cleared the plain tokens once the new code was serving. The CV Lifecycle links followed the same afternoon with their own pair, `20261113195226` (fill) and `20261113195228` (clear), and its feed route is metered at the same feed limits.
- Pinned by `tests/share-link-token-hash.test.ts`.

## The Marketing panel (13 Oct 2026)

Marketing's links were API-only, so nothing on any screen could say that a second live feed link had paused the weekly token rotation. `src/components/marketing-requests/report-share-links-panel.tsx` is mounted on both All Marketing Requests registers and carries the shared `LiveFeedAmbiguityBanner`.

- Gated on `expenses:export`, exactly as `src/lib/marketing-requests/report-share-links.ts` asserts on list, create and revoke.
- Sheets feed only. No route serves a Marketing `live` link (only `/api/share/marketing-requests/[token]/feed` and `/file` exist), so offering one would hand out a URL that opens nothing.
- The sheet's Apps Script (`docs/marketing-request-live-sheet.gs`) reads a `FEED_TOKEN` script property and builds the address itself, so the mint result shows the bare token once, with the `refreshMarketingRequests` step.
- `SHARE_LINK_FEEDS` (`src/lib/share-links/feeds.ts`) names the screen, so the dead-token alert's button opens it.
- Pinned by `tests/marketing-share-links-panel.test.ts` and `tests/live-feed-rotation-paused.test.ts`.

A new live sheet ships its banner in the same PR that adds its feed.

## Night pacing of the two sheet timers (31 Oct 2026)

The Direct Orders and Marketing Request sheets fetch their feed on a 1-minute Apps Script timer, and Phoenix also POSTs to each sheet's `doPost` the moment an order or request changes (`pingDirectOrderSheet`, `pingMarketingRequestSheet`). So the timer is only a safety net for a push that did not arrive.

Measured on production on the night of 30–31 Oct 2026, 23:00–07:00 Cairo: Phoenix made 81,560 requests to its database in 9 hours, about 9,000 an hour. The two sheet timers were about 2,100 an hour of that (23%). Direct Orders fetched at second :24–26 of every minute, at about 18 requests per fetch. Marketing fetched at :35–36, at about 17 per fetch. The Direct Orders link had 2,099 reads and the Marketing link 2,085 reads since the Friday rotation (30 Oct, 03:23 and 03:43 Cairo). Nobody reads either sheet at that hour.

- Between 23:00 and 08:00 Cairo, a **timer** tick fetches only when an hour has passed since the last fetch (`nightTimerTickSkips_`). Every fetch stamps script property `phoenixLastFeedFetchMs`, so a push at 02:10 counts as that hour's look.
- Only a time-driven trigger passes an event with `triggerUid`. A push, a token rotation (also a push), "Refresh now", `installTrigger`, `rebuildEverything` and a run from the editor pass nothing, so they always fetch.
- The rotation is the case that must never be paced. Phoenix revokes the old token only after it sees the sheet read with the new one (`tokenHasBeenUsed`).
- The trigger stays a 1-minute trigger with the same function name. The pacing lives inside the function, so the merge alone ships it (`apps-script-push.yml` writes HEAD, and the timer runs HEAD). No sheet needs `installTrigger` re-run.
- The daytime timer is unchanged. A failing feed still paints its STALE banner overnight, within the hour. The skip is not a failure and paints nothing; `tests/live-sheet-stale-banner.test.ts` allows exactly one such silent return per file, directly under the pacing check.
- Expected saving: about 2,000 requests an hour for nine hours, roughly 18,000 a day.
- The CV Lifecycle sheet is left alone. Its timer runs every 5 minutes, and it was not a measured night load.
- Pinned by `tests/live-sheet-night-pacing.test.ts`. That suite drives both real `.gs` files through a fake clock: 540 night ticks fetch 9 times, an hour of day ticks fetches 60 times, and the 22:59 / 23:00 / 07:59 / 08:00 edges are checked. It also checks that a push, a rotation, Refresh now and `installTrigger` each fetch at 03:00, 30 seconds after the last fetch.

## A sheet ping that times out was delivered (2 Nov 2026)

`doPost` answers only after it has read the feed and redrawn every tab, so `pingDirectOrderSheet` hangs up at 4 seconds while the script carries on to the end. The ping carries no business data: only the secret and a reason, telling the sheet to read the feed again. It is sent after the order's own writes, is not awaited, and is not retried. A lost ping costs at most a minute by day and an hour overnight, until the sheet's timer next fetches.

Measured on production on 2 Nov 2026, revision `229ff7f8f`, 03:23 to 12:10 Cairo:

- 44 rows in `direct_order_events` (15 collections, 15 sales months, 10 approvals, 4 submissions) and 44 `direct_order_sheet_ping_failed` warnings with the same split, every one a `TimeoutError`.
- From 11:18:19 to 11:30:00 Cairo, Google read the Direct Orders feed 42 times: 12 on the timer's 60-second rhythm and 30 off it. Those 30 reads line up one to one with the 30 order events in that stretch, each 1 to 4 seconds after its event.

So the warning fired on every ping that worked. A refusal is an HTTP 200 reading `denied` or `not configured`, and a crashed script answers a 200 error page. Nothing read the answer, so those logged nothing.

- A timeout now logs nothing.
- An answer other than `ok` logs `direct_order_sheet_ping_refused` or `marketing_sheet_ping_refused`, with `answer` set to `denied`, `not configured` or `unexpected`. The page itself is never logged.
- A non-2xx status or a network failure still logs `direct_order_sheet_ping_failed` or `marketing_sheet_ping_failed`. The 403 of 22 Oct 2026 is that case.
- The secret check comes before the feed read, so a refusal usually answers inside the 4 seconds. One that takes longer is missed, but a refusal is a lasting state, and the next ping reports it.
- Neither `.gs` file changed. An `/exec` address runs a saved version that only the owning Google account can move, so a change there would not reach the ping without his redeploy.
- Pinned by `tests/direct-orders-sheet-webhook.test.ts`, which runs both pings through the same cases.

`pingMarketingRequestSheet` had the same code and got the same fix. Measured on production over 20 deployments, 1 Nov 2026 19:50 to 2 Nov 2026 13:08 Cairo:

- 4 `marketing_sheet_ping_failed` warnings, all on revision `d3bc5edd3`, every one a `TimeoutError` with no status: 1 validation, 3 submissions.
- Google reads the Marketing feed on its timer near second 36 of each minute. Around these pings it also read at 22:41:16, 22:45:38, 22:49:13 and 22:53:14. Those are 1 to 5 seconds after the requests that sent the pings finished, at 22:41:15, 22:45:35, 22:49:11 and 22:53:09. The 22:45 minute shows two reads at second 38, the timer's and the ping's.
- The 22:45 warning was logged at 22:45:47, 12 seconds after its request finished rather than about 4. The ping is sent before the response goes back, so the read at 22:45:38 still follows it. Why the warning was late was not measured.
- How long the redraw takes was not measured. Neither refused warning has fired on production; only the test covers them.

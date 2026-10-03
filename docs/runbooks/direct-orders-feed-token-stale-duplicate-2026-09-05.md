# Direct-orders feed share link — a stale duplicate Sheet, found 2026-09-05

> **Corrected 2026-09-16.** The first version of this runbook (#3322) got two
> things wrong. The copy almost certainly shows **no** staleness banner: the code
> it has run since 5 August had none, and only a paste changes a copy's code. And
> its fix, putting the live token into the copy, was wrong: the copy's trigger has
> to be stopped instead (see **Fix**). That version also carried two full share
> tokens; both are revoked, and each is now cut to its first 6 characters.
> **Re-measured 2026-09-15** is new. All times are Cairo local.
>
> **Re-measured again 2026-10-03, and two things changed.** The owner asked
> outright which Google account owns the copy, so **What Phoenix cannot answer**
> is now a measured negative with three disproved leads rather than a note — and
> one claim in it is corrected: the egress IP does not merely fail to identify a
> person, it is shared with the LIVE sheet. And the silence itself is closed: a
> refused read is now counted on the link's own row and alerted on (#5221).

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

**Measured 2026-10-03, because the owner asked outright.** The answer is no,
and three things that look like evidence are not. Each was tested, not assumed:

1. **The User-Agent `id:` is not a script id.** The ghost's live header reads
   `Mozilla/5.0 (compatible; Google-Apps-Script; beanserver;
   +https://script.google.com; id: UAEmdDd-ww0d96vY8iUi2qkqtUWEC_Q4xMQ)` — **35
   characters**, and the live sheet's is 36. A real Apps Script project id is
   **57** (`docs/environment.md`, "Finding a sheet's script id"). So it reaches
   neither `projects.get`, the one Google call that returns `creator.email`, nor
   Drive. The id above is still conclusive that these are two *different*
   projects, which is all the table above ever claimed — it just cannot be
   resolved to an owner.
2. **The source IP is shared with the LIVE sheet, which corrects the note
   above.** In one 15-minute window both the ghost and the canonical sheet were
   served from `107.178.193.70` and `107.178.193.71`. The pool is also wider
   than `34.116.28.67-69`: `34.116.21.232` and `34.116.39.236` appeared in the
   same window. So the IP does not merely fail to name a person — it does not
   even separate the two sheets.
3. **The `UAEmdDd` prefix is not an account fingerprint**, which is the lead
   worth writing down because it looks like one. All five Apps Script projects
   that call Phoenix carry it — the two direct-orders ones, CV Lifecycle,
   Marketing Requests and the master map — including the three whose owner is
   known. It is a Google-wide constant.

And the credential that could ask Google is not reachable from the laptop
anyway: `GOOGLE_APPS_SCRIPT_REFRESH_TOKEN`, `GOOGLE_APPS_SCRIPT_CLIENT_*` and
all three `*_APPS_SCRIPT_ID`s are **write-only GitHub Actions secrets** (they
appear in `gh secret list`, none in `gh variable list`) and are unset in
`.env.local`.

**What does identify it — one positive test, in the copy's own source.** The
ghost runs pre-#1792 code with the dead token written into it, where the live
sheet keeps `FEED_TOKEN` in a Script Property and the file holds nothing. So
opening a candidate project's `Code.gs` and searching it for `pgn0W2` settles
the question outright. That token has been revoked since 2026-08-05, so
searching for it exposes nothing.

**And the Drive-history window is narrower than "around 2026-08-05".** The dead
token recorded **470** reads in its 260-minute life (11:01:34 → 15:22:04 on
2026-08-05) — about **1.8 a minute**, where a single one-minute trigger can only
produce one. So two pollers were on it that morning. Allowing the live sheet the
whole window leaves ~210 minutes for the copy, putting its first poll at roughly
**11:52**. Look at Drive Activity between **11:45 and 15:25** on 2026-08-05, not
across the day.

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

## Re-measured 2026-10-03

- **The ghost is still running, 58.7 days in.** In a 9-minute Railway HTTP
  window (08:27:24 → 08:36 on 2026-10-03) the dead `pgn0W2…` token was refused
  **8 times** and the live token answered **200 nine times**, at exactly one a
  minute each. At that rate the refusals since 15:22 on 2026-08-05 come to about
  **84,500**. Nothing about the diagnosis above has changed.
- **The live sheet is healthy.** One live feed link, `dOtz3E…`, minted by the
  Friday rotation at 03:23:01 on 2026-10-02, **1,719 reads**, the last at
  08:35:26 on 2026-10-03 — six seconds before it was read. Never revoked.
- **Rotation has now confirmed nine times in a row.** 2026-09-18 (`uOZdjd…`),
  09-25 (`U12Cm-…`) and 10-02 (`dOtz3E…`) each wrote the `confirmedBySheet`
  audit row, and each carried `allowFiles: true`, so the evidence photographs
  stayed reachable — the regression every rotation from 2026-08-23 once had.
- **The feed's own output is sound, checked rather than assumed.** It answered
  **200 in 0.82s**, 111 KB, **183 rows × 45 columns**, with **0** malformed
  rows under an RFC4180 parse. One Arabic bonus-override reason contains a line
  break; that is handled, because the Apps Script parses with Google's own
  `Utilities.parseCsv` rather than splitting on newlines.
- **And the figures are faithful.** The feed's by-status block and the database
  agree row for row: approved 117, rejected 37, returned 20, cancelled 9 = 183;
  3,104,118.52 EGP total, 1,823,329.02 approved, 20,539 units. Every one of the
  183 is in a terminal state — nothing is sitting unapproved.
- **One cosmetic drift, no action taken.** `docs/direct-orders-live-sheet.gs`
  still says "the same 39 columns" in its header while the feed now emits 45.
  The layout is rebuilt from the feed's own header, so the sheet is correct and
  only the prose is stale.

## The silence is closed — #5221, merged 2026-10-03 09:17

The reason this ran for 31 days before anyone noticed is that **a refused read
left no trace Phoenix could see.** The route answered 403 and returned; the only
record was Railway's HTTP log, which the app cannot read and which keeps barely
a quarter of an hour of lines for the current deployment. "Is anything being
refused?" was unanswerable from inside the system.

It is answerable now. All three share-token guards count the refusal on the
link's own row (`refused_count`, `last_refused_at`) before refusing — the
caller's answer is unchanged, and only a row that already exists is ever
written, so an unauthenticated caller cannot drive the write path.
`src/lib/share-links/dead-token-polling.ts` then judges them on
`job-heartbeat-sweep`'s existing 15-minute clock: revoked or lapsed, **≥10**
refusals, last refused **inside 24 hours**, feed links only. The owner gets one
Telegram/in-app/push message a Cairo day while it continues, and none once the
trigger stops.

**Confirmed against the live row, not the code.** The merge reached production
at 09:27:15 (live `revision` = the merge sha `ef3219f2c`, `main`'s CI
`success`), and at **09:27:03** — the ghost's first poll after the counting
shipped — `pgn0W2…` went to `refused_count = 1` with `last_refused_at` stamped,
while the live `dOtz3E…` stayed at `refused_count = 0` and its `access_count`
rose to 1,771. The dead token is counted, the working one is not, which is the
whole distinction the alert rests on.

So this runbook no longer needs re-measuring by hand. **If the ghost is still
polling, the alert says so.**

## Still open

1. **Which Sheet holds the dead token, and who owns it — not resolvable from
   Phoenix, and that is now measured rather than assumed** (see the three
   disproved leads under **What Phoenix cannot answer**). The Triggers pages in
   **Fix** are the quickest first look, and `Code.gs` carrying `pgn0W2` is the
   one positive test; failing both, Drive version history between **11:45 and
   15:25** on 2026-08-05.
2. The dead token itself was left as-is (already revoked, does no harm sitting
   in the table) — no cleanup action taken against
   `direct_order_report_share_links`. It is now also the thing the new alert
   fires on, so removing the row would silence the alert while the ghost kept
   polling. Leave it.

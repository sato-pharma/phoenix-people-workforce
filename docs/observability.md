# Observability

_Phoenix Workforce runs on **Railway** (moved off GCP Cloud Run 2026-08-01). Sentry was retired
2026-07-31 and came back 2026-10-16 as a production-only add-on (see "Sentry" below). What still works today: the `app_error_events` table (server errors via
`instrumentation.ts`'s `onRequestError` → `/api/errors/client`; client errors via
`reportClientError` → the same endpoint), structured JSON logging (`src/lib/observability/log.ts`,
readable with `railway logs`), the health probes, and the Healthchecks.io dead-man's-switch on the
cron routes._

## ⚠️ The alerting layer died with GCP and has not been replaced

Read this before concluding "nothing is wrong because nothing alerted."

GCP billing account `01BDEA-A20B4C-CC568F` was closed 2026-08-01; every API in project
`phoenix-workforce-498619` returns `BILLING_DISABLED`. Everything that was hosted **inside** that
project is therefore gone, including the pieces that used to page the owner:

| What | Status |
|---|---|
| Cloud Monitoring alert policies (5xx rate, p95 latency, uptime, scheduler failure, auth-failure spike, config drift) | **Dead** — see "Metrics & alerting" below |
| "Phoenix HR production ERROR log alert" (the Sentry replacement) | **Dead** — nothing emails the owner on a production ERROR any more |
| Cloud Logging retention, log-based metrics, and the log query language | **Dead** — use `railway logs` |
| The old `/admin/system-issues` "live infra logs" half | **Removed** (2026-09-30); the page itself retired into `/admin/system-audit` on 2026-10-23 |
| Healthchecks.io dead-man's-switch | **Alive** — third-party, outside GCP, `HEALTHCHECKS_PING_KEY` is set on the Railway service |
| `app_error_events` table + the `/admin/system-audit` Incidents tab | **Alive** — it is in Supabase, not GCP |

**Net effect: errors are still recorded, but nothing pages anyone.** Discovering a production
problem currently depends on someone looking at `/admin/system-audit`, `railway logs`, or a
Healthchecks notification for a cron that stopped pinging. Replacing the alerting layer is open
work, not a solved problem.

## Sentry (sentry.io) — production only

Back since 2026-10-16, as a second sink beside `app_error_events`, never instead of it. It started as errors only and the same day grew to everything Sentry can do (owner: "everything that could be on sentry"), each piece bounded in `sentry-policy.ts` and scrubbed before it leaves.

- **Where it runs is decided by the deployment name, not the build mode.** `src/lib/observability/sentry-policy.ts`: the server needs `APP_ENV=production` AND a valid `SENTRY_DSN`; the browser needs a valid `NEXT_PUBLIC_SENTRY_DSN` AND to be served from the production host. Staging, the Hetzner previews and a laptop are off by construction — a Phoenix build is `NODE_ENV=production` on all of them, so `isProductionRuntime()` is NOT the gate.
- **What it sends:**
  - **Errors:** server request errors (`onRequestError` → `captureRequestError`), uncaught exceptions and rejections in the Node process, and every browser failure `reportClientError` already sees.
  - **New errors to Telegram:** a Sentry internal integration posts alerts (issue alert rule, or a created issue) to `/api/webhooks/sentry`, signed with its client secret (`SENTRY_WEBHOOK_SECRET`). The route verifies the signature before it parses the body, sends a scrubbed title, place and level plus the Sentry link to the standing admin's connected Telegram chats, and ignores anything that is not an alert. Unset secret: every call is refused.
  - **What the first measurements changed (2026-10-16):** the sidebar badge poll waited on a full employee-directory reload about a third of the time (the 30 s poll equals the 30 s cache TTL), so the directory now serves its copy for up to 60 s past the TTL while a reload runs behind it; the in-app notification bell runs its two independent reads together. The messages call already costs only two round trips and was left alone.
  - **Page survey (ends by itself):** until midnight Cairo on 2026-10-19 (`SENTRY_PAGE_SURVEY_ENDS_AT_MS`) every PAGE request is traced, so each page that anyone opens has a timing; API calls stay at the fixed rate, and after that instant the sampler is back to 5% with no deploy. Read the result in Sentry's Traces explorer: group by transaction, p95 of duration.
  - **Traces:** 5% of requests and page loads (`SENTRY_TRACES_SAMPLE_RATE`), none for the health probe, the error reporter's own endpoint, `_next` assets or the favicon. A parent's decision wins. No trace header is added to any request (`tracePropagationTargets: []`).
  - **Profiles:** server and browser, only inside a sampled trace (`profileLifecycle: "trace"`). The browser profiler needs the `Document-Policy: js-profiling` header, which `next.config.ts` sends only on a build that carries a DSN. Server profiling is not yet confirmed in production.
  - **Session replay:** only the session of a user who hit an error (on-error rate 1, ordinary-session rate 0), with all text, all inputs and all media masked. It shows layout and clicks, never a figure.
  - **Logs:** the app's own `warn` and `error` console lines. A log line can still hold free text, so `scrubSentryLog` masks paths, HR ids and e-mail addresses and drops attributes named like a person, a credential or an amount.
  - **Cron check-ins:** every cron run already reports to Healthchecks and `job_heartbeats`; `pingDeadMansSwitch` now also sends a Sentry check-in. The check-in carries the monitor's schedule, built from the one register of scheduled jobs (`src/lib/observability/job-schedule.ts`, via `sentry-cron-monitor.ts`: the Africa/Cairo expression, the grace as the margin, a failure threshold of two). Sentry creates the monitor the first time that job reports, so nobody builds monitors by hand and a job added to the register is watched without a second edit. A job the register does not declare sends no config and creates nothing. The trial plan includes 300 cron monitors and the account has no payment method, so nothing is billed; after the trial ends the free plan includes one, and the rest go over quota.
  - **Releases and source maps:** see "Source maps" below.
  - **What it does not:** load-time module rewriting (`enableRuntimeChannelInjection: false`), a tunnel route, and the user-feedback button.
- **Every browser now loads the SDK.** `startSentryBrowser()` runs from the mounted `GlobalErrorReporter` once the page is idle, on the production host only, so tracing and the error-time replay buffer run from early in the session.
- **Nothing identifying leaves:** `scrubSentryEvent` (SDK 11 has no `sendDefaultPii` switch) drops the user, cookies, request bodies, query strings and session/role headers from every event. `scrubSentrySpan` turns identifying path segments (an HR id, a uuid, a number) into `:id`, strips queries, and drops user, header, query and SQL attributes from every span.
- **Source maps:** `next.config.ts` wraps the config with the Sentry build plugin only when `SENTRY_AUTH_TOKEN` is non-empty at build time. It uploads the maps to organisation `phoenix-crm`, project `phoenix-workforce` on `https://de.sentry.io`, names the release after the commit sha, marks it as a production deploy, and deletes the maps afterwards so none is served. It also asks Sentry to link the release's commits (`setCommits`, repository named explicitly, a missing integration tolerated): that starts working once someone installs Sentry's GitHub integration, which gives suspect commits and "resolved in the next release", and until then it does nothing. The Dockerfile declares the token as a build argument in the build stage only. A build without a token is unchanged. The token is created in Sentry (an organisation token with release and source-map permission) and stored as the GitHub secret `SENTRY_AUTH_TOKEN`, which the production secret sync already forwards to Railway.
- **What Sentry is told to ignore (the app's own error table still records all of it):** a locked module's refusal (`isModuleLockRefusal`, skipped in `instrumentation.ts`: the page shell already shows the lock notice, so the throw behind it is the lock working), and the browser's own network-failure wording (`isBrowserNoiseMessage`: "Load failed", "Failed to fetch", "Error in input stream", "network error", Firefox's NetworkError text and the cross-origin placeholder; matched exactly, and "Connection closed." stays visible because it was once a real Supabase failure). On 2026-10-17 these were six of the fourteen open issues.
- **Database spans keep their table name (2026-10-17):** `scrubSentryPath` leaves `/rest/v1/<table>`, `/rest/v1/rpc/<function>` and the `v1` after `auth`/`storage` alone; they are schema, not data, and the values ride in the query string, which is still dropped. Before, `v1` and any table name of 24+ characters became `:id`, so 100,120 spans a day read `/rest/:id/:id` and Sentry raised an "N+1 API Call" issue against a cron that reads thirty different tables. Sentry also shows some of these spans as "GET [Filtered]" on its own side; whether that share shrinks after this deploys is not yet measured.
- **Two log lines added for the next freeze and the next timeout burst (2026-10-17), instrumentation only, not a root cause:** the `event_loop_stall` warning now carries `sinceLastStallS`, `uptimeS`, heap and RSS (the 2026-10-17 freezes with no job running recurred every exactly 65:00 and no timer in the app owns that period); and a Supabase client timeout logs a `supabase_timeout` WARNING with the method, the scrubbed table path, `elapsedMs` and the process age (11 timeouts across four routes inside ten seconds at 12:00 Cairo could not be attributed afterwards). The error thrown is unchanged: name `AbortError`, message "Supabase request timed out.".
- **The email-policy N+1 (2026-10-17):** the real cause of "N+1 API Call" on GET /api/notifications/process (`PHOENIX-WORKFORCE-4`, the worker service). `resolveNotificationDelivery` needs one notification type's policy, the only read available was the whole `email_notification_policies` table, and the outbox drain resolves a delivery per email, so a run of ten read the same table ten times. `runScheduledNotificationProcessing` now opens `withEmailPolicySnapshot` (`src/lib/notifications/email-policy-snapshot.ts`), an AsyncLocalStorage scope: inside one run the table is read once and shared, for at most 10 seconds, so a policy switched off mid-run is still noticed. Outside a run nothing is held (the admin screens and `saveEmailNotificationPolicy` read fresh), a failed read is never remembered, and two runs never share a copy. A module-level cache was rejected because it would keep serving a policy an admin had just switched off. That fix alone did NOT stop the issue: it fired again on the release that carried it (2026-10-17, 14:35 Cairo), 30 repeated GETs in one run. The other half was the probation step: `processDueProbationReminderEvents` runs `ensureProbationReminderEvents` and `ensureOverdueProbationReminderEvents` for every employee on probation, and each re-read `app_auth_users` (the HR approvers, and the role lists for the Training and National Sales Managers), two to four identical selects per person. Sentry shows them as "GET [Filtered]" because it hides any URL that names "auth", which is why the table was not visible in the span. `createProbationRecipientLookups` (`src/lib/probation/service.ts`) now builds ONE set per run and shares it between the employees: the approvers the run already read at its start, and one role read. A failed role read or an empty approver list is never kept, so one blip cannot strip every later reminder of its recipients; callers outside the run read fresh. Pinned by `tests/email-policy-snapshot.test.ts` and `tests/probation-recipient-lookups.test.ts`. Sentry samples at 5%, so a quiet stretch after this deploys is weak evidence; a recurrence is strong evidence.
- **A Supabase outage is ONE issue, "Supabase unreachable" (2026-10-17):** the 12:30 Cairo restart filed four, two of them titled with a whole Cloudflare page ("supabase.co | 521: Web server is down", "525: SSL handshake failed"), because postgrest-js wraps the edge's HTML in a plain `{ message }` and every sink titled the issue with it. `classifySupabaseUnreachable` (`src/lib/error-monitor/supabase-unreachable.ts`, import-free so the edge and browser bundles can use it) recognises exactly that page by its `supabase.co | 5NN: <words>` title. `scrubSentryEvent` then gives the event the fingerprint `supabase-unreachable`, the type "Supabase unreachable", the value "Cloudflare 521: Web server is down" and a `supabase_edge_status` tag, on an exception, a message or a log entry; `scrubSentryLog` does the same to a console line; `logAppError` stores that one line in `app_error_events.message` instead of the markup; and the heartbeat answers 503 (never a sign-out) instead of rethrowing it as an unhandled 500. It renames and never drops, and only that page matches: "Failed to fetch", "Connection closed." and the client's own "Supabase request timed out." keep their own issues. **Not folded:** Next's digest-only "An error occurred in the Server Components render" event carries no message to read, so one of those still appears beside the named issue during an outage. The old 521/525 issues already in Sentry are marked resolved by hand; the proof is the next restart showing one issue. Pinned by `tests/supabase-unreachable.test.ts`.
- **Turn it on:** put the project DSN in `SENTRY_DSN` and `NEXT_PUBLIC_SENTRY_DSN` on the production Railway service (the browser one is a build argument, so it needs a redeploy). Turn it off by removing either.
- **Created in Sentry's screen (not by code):** the uptime monitor on the production URL.
- **Pinned by** `tests/sentry-production-only.test.ts`.

### Operating Sentry from a terminal

Two tools, two jobs. **Account setup is `scripts/sentry-setup.mjs`** (Sentry's REST API); **day-to-day triage is `sentry-cli`**. The CLI has no command that creates an alert rule or sets an organisation's data scrubbing, which is why the script exists.

- **The token** is a personal token (sentry.io → User settings → Personal Tokens) with the scopes `org:read org:write project:read project:write alerts:write event:admin`. It is read from the `SENTRY_AUTH_TOKEN` environment variable only — never a file, never printed, never committed. The `.env.sentry-build-plugin` file left over from the retired account is not used.
- **Set up the account once** (EU region, so the API host is `https://de.sentry.io`, which is the script's default). In PowerShell: `$env:SENTRY_AUTH_TOKEN = '<token>'; node scripts/sentry-setup.mjs` prints what it would change and writes nothing; add `--apply` to make the changes. It is safe to run again: it reads first and writes only what is missing: IP and data scrubbing on the organisation, and resolving the deliberate test issue. It also CHECKS that an enabled alert emails on every new issue and reports `NOT COVERED` (exit 3) if none does; it creates and deletes nothing. 🔴 **It does not create the alert because the account runs Sentry's new alert system** — the old `projects/<org>/<project>/rules/` address answers 404 there (measured 2026-10-16), alerts live under `organizations/<org>/workflows/`, and the account ships "Send a notification for high priority issues" (emails the issue owners on every new high-priority issue, which a captured exception is). `--probe` prints which addresses the account answers and its existing alerts.
- **Triage** with `sentry-cli` (installed globally with `npm install -g @sentry/cli`; add `--url https://de.sentry.io` on every call, or set `SENTRY_URL`, because the default is the US host): `sentry-cli --url https://de.sentry.io info` verifies the token, `sentry-cli --url https://de.sentry.io issues list -o <org> -p phoenix-workforce` lists open issues, and `issues resolve -i <id>` closes one.
- **After a deploy**, `node scripts/post-deploy-errors.mjs <pr> --wait` (the ship skill's phase 7b) reads Sentry's Discover events for the releases that carry the merge, using `SENTRY_READ_TOKEN`: a personal token kept as a Windows user variable on the laptop. On 2026-10-19 that token was refused on the issue list (`organizations/phoenix-crm/issues/` and the project form both answered 403) and answered on Discover (`organizations/phoenix-crm/events/`) and on releases, so the check asks Discover. `SENTRY_AUTH_TOKEN` is never a read token: the `.env.local` copy was still the retired account's (organisation `sato-pharma`), and the Railway one is the build plugin's. Without a read token the check still reads the app's own error table and says Sentry was not read. Pinned by `tests/post-deploy-errors.test.ts`.
- **Pinned by** `tests/sentry-account-setup.test.ts`, which runs the whole script against a local stand-in for Sentry.

## Error capture

- **Server errors:** `instrumentation.ts`'s `onRequestError` forwards to `/api/errors/client`
  (edge-safe, HTTP), which calls `logAppError()` → the **`app_error_events`** table
  (`src/lib/error-monitor/service.ts`). Fields include route, module, hr_id, message, stack,
  `release` (`COMMIT_SHA` → the platform's revision env var → `unknown`), environment.
- **Client errors:** `src/lib/error-monitor/report-client-error.ts` (`keepalive` POST) → the same
  endpoint, called from `app/global-error.tsx` (React root error boundary) and
  `src/components/layout/global-error-reporter.tsx` (`window.onerror` / `unhandledrejection`).
- **Retention:** `pruneOldAppErrorEvents()` runs in the daily cron (default 90 days, `PHOENIX_ERROR_EVENT_RETENTION_DAYS`).
- **Access:** the table is service-role only (RLS-enabled, no policies); the admin error dashboard reads it via the admin client with an application permission check.
- **Local dev never writes here (since 2026-07-30).** `shouldPersistErrorEvents()`
  (`src/lib/error-monitor/derived-status.ts`) makes `logAppError()` skip the insert and log to
  the console instead whenever `NODE_ENV !== "production"` — i.e. under `next dev` only. The
  Railway service builds with `NODE_ENV=production`. (The staging app builds that way too, but it
  writes to the staging Supabase project — so every non-dev row in *this* table is still
  production. Staging's own error rows live in `cifwmndunmlxjhyjugxa`.) Override with
  `PHOENIX_PERSIST_DEV_ERROR_EVENTS=true` when deliberately debugging ingestion.
  - *Why:* `.env.local` on the maintainer machines points at the **production** Supabase project
    (a deliberate, documented setup), so local iterate-and-reload churn was inserting straight
    into the production error table — **275 of its 903 rows** were `environment='development'`
    when this was found. They read exactly like an outage (bursts of `X is not defined` on
    whatever page was being built), and cost a production go/no-go audit a false alarm.
  - *Reading the table:* the historical dev rows are still there, so **every** read in
    `service.ts` filters `environment != 'development'` (see `DEVELOPMENT_ENVIRONMENT` there —
    add it to any new query). When triaging by hand, always filter on `environment='production'`;
    the quick tell on an unfiltered row is `release`, which is `sha-XXXXXXXX` for real
    production traffic and `unknown` for local dev.

### A structured ERROR's labels reach the row (2026-10-23)

`logStructured("ERROR", …, { labels })` also persists, through `persistErrorEvent` in
`src/lib/observability/log.ts`. Until 2026-10-23 that bridge carried exactly two things —
`labels.route ?? labels.job ?? labels.event` onto `route`, and an `Error`'s `.stack` — and dropped
every other label silently. Read off production (`ozucdzovmcqvepbozvqf`) that day, of **2,446**
`route_type='structured-log'` rows **0 carried an `hr_id`**, **0 carried a `role`**, and **1,677 had
no `stack` either**: the row was the event name and nothing else.

What that cost. `src/lib/needs-you/service.ts` logs a Needs You source timeout with
`{ event, source, hrId, role, scope }`. The stored row said `route='needs_you_source_timeout'` and
never **which** source timed out, for whom, in what scope — so the failing adapters had to be
reconstructed out of the delivered Telegram digests in `notification_events.metadata`, a table that
happens to keep the payload rather than one designed as the error record. Found while fixing
[#6301](https://github.com/Gawish-1997/phoenix-people-workforce/pull/6301).

**This was fixed from two ends at once, on the same day.** #6307 fixed the `stack` column —
`persistedStack` reads a non-`Error` through `describeThrown` (a Supabase rejection is a plain
`{ message, details, hint, code }`, so `error.stack` was undefined and the column landed empty) and
prefixes the call site's labels, which is where `source` and `scope` now live. This change fixed the
other end: the **columns**, plus two safety properties of that label prefix.

How it is carried now, with no migration:

- `hrId`/`hr_id`, `role`, `loginId`/`login_id` and `digest` go onto their **own columns**, decided in
  one place (`structuredLogErrorInput`). Both spellings are read because both are in use — measured
  across the call sites, `hrId` 89 times and `hr_id` 14, `loginId` 9 and `login_id` 1 — so accepting
  only camelCase would drop a seventh of them. A column beats free text here because
  /admin/error-monitor filters on `hr_id` and renders `role`.
- Everything else stays in `persistedStack`'s label prefix as `key=value`, **minus** those four:
  repeating a label that now has a column would only cost the cause characters that truncation takes
  off the end.
- **Every value goes through `redactSecretsFromRoute`**, which is documented to run over free text: a
  label carries a share-link token as readily as a path does, and the row is written while the token
  still works.
- **The label prefix is capped at 1,000** of the column's 4,000. The labels lead and `stack` is cut
  from the end, so without a ceiling a generously-labelled call site would evict the very cause the
  row was captured for — trading one lost diagnostic for another.
- `service` and `event` stay out, as #6307 decided: `service` is on every line, and `event` is
  already the row's `route`.

`logAppError`'s best-effort "never throws" contract is unchanged, and `redactSecretsFromRoute`'s own
behaviour is untouched — it is only called from one more place. Pinned by
`tests/structured-log-persists-the-cause.test.ts` (the cause and the ordering) and
`tests/structured-log-labels-reach-the-row.test.ts` (the columns, the no-repeat, the redaction and
the cap), whose sections were each confirmed by breaking the fix and watching that section's own
assertion fire.

## Whose code threw it — attribution on a client row

A minified client message says nothing about where the throw came from, and the Error Monitor
lists rows by message. Two attribution failures have each sent triage the wrong way, so both are
now answered at display time. Neither hides a row: the raw message is stored and shown verbatim,
and the sibling rule in `cross-origin-masked.ts` still holds — suppressing a diagnosable error
costs far more than keeping a noisy one.

**A third-party script's throw reads exactly like ours.** On 2026-09-09 ten rows on
`/employee-portals/submit-expense` read `undefined is not an object (evaluating
'this.rh.get(b).filter')` and `null is not an object (evaluating 'C0[c].indexOf')`, which is the
shape of an ordinary app bug on the page a rep files a trip claim from. Every frame of every one
sat inside `maps.googleapis.com/maps-api-v3/.../webgl.js` — Google's vector-map renderer failing
on iOS Safari. Nobody was blocked; both people submitted their claim 40 seconds and 6 minutes
later, for 482.70 and 815 EGP. `describeThirdPartyStack()`
(`src/lib/error-monitor/third-party-stack.ts`) now labels a row whose located frames are ALL
off-app, and `decodeErrorMessage()` leads the display with that origin.

- It claims only WHERE the frames are, never whose fault the throw is: our own bad argument can
  make a library throw entirely inside itself.
- A frame needs its `:line:col`. A React `#418` message carries `visit
  https://react.dev/errors/418` inside itself, so matching bare URLs would label every hydration
  error in the table as third-party — the exact inversion of the module. Pinned by
  `tests/error-monitor-third-party-attribution.test.ts`.
- One app frame anywhere returns null, and a server throw locates no frames at all (its frames
  are filesystem paths under `/app/node_modules`).
- `cross-origin-masked.ts` opens by stating this app loads no third-party scripts. That is no
  longer true — `src/lib/google-maps/browser.ts` injects the Maps API on every page with a map,
  and Maps serves CORS headers, so its failures arrive in full rather than masked.

**Hydration `#418` had one cause left standing, it was tested, and it was ruled out.** The error
concentrates in PEOPLE, not pages: one reader produced 63 events across 23 unrelated routes, and
sweeping the two worst routes' import graphs (154 and 155 files) found no app-code cause.
`app/layout.tsx` opted out of machine translation on 2026-09-08 (#3487, `translate="no"` plus the
`google: notranslate` meta) and its own comment named the falsification test.

**The opt-out was REMOVED on 2026-09-11 and must not be re-added without new evidence.** Measured
three days in: across the whole platform exactly one route still threw `#418` —
`/employee-portals/recruitment-candidates`, 12 events, every one from a single District Sales
Manager on Samsung Internet 20 (Chrome 106), whose translator honours neither signal. Every other
route, `/employee-portals/vacation-report` included, went silent. No event in that window carried
a `domRewriter=` marker, and the probe was live in all three releases that threw. So the attribute
was costing every Arabic-speaking reader the browser's translate offer and closing nothing. **The
remaining `#418` on that one page is still unexplained.**

So `report-client-error.ts` now records what rewrote the DOM, through the pure
`describeDomRewriters()` (`src/lib/error-monitor/dom-rewriter.ts`): the `translated-ltr` /
`translated-rtl` class Google Translate puts on `<html>`, Microsoft's `_msttexthash` attribute, a
count of `<font>` elements (the app emits none, and Google Translate wraps every rewritten text
node in one, which catches the browsers that leave no class behind), and an `<html lang>` that is
not the `en` the layout serves. A clean page produces an empty array and writes nothing, so an
ordinary row is unchanged. **Read `domRewriter=` in the client-context block before re-arguing
the cause of a `#418`.**

## Staging migration auto-apply

`.github/workflows/staging-migrate.yml` runs `pnpm run migrate:staging` on every push to
`main` that touches `supabase/migrations/**`, applying whatever staging is missing and
recording each one in staging's ledger under **the file's own version and name**. A
`workflow_dispatch` with `dry_run` lists without applying.

**Why it exists.** Until 2026-09-04 nothing applied migrations to staging — it was a hand step,
and hand steps get skipped. That day staging was missing 13 migrations merged between 29 August
and 2 September, the oldest 137 hours old, while the drift check below had been red for four
consecutive nights and had delivered four Telegram alerts about it. The gap was never invisible;
it was nobody's job. Since staging backs `ci.yml`'s login smoke and the staging mutation smokes,
a stale staging schema makes those tests answer about a database production does not share.

**It cannot reach production.** `scripts/apply-migrations-to-staging.ts` checks the target
project ref against a one-project allowlist *before opening a connection* and refuses anything
else by name — reading the ref from the host in a direct URL and from the username in a pooler
one. There is no override flag, and `tests/staging-migration-applier.test.ts` fails if one is
added. Production migrations remain a deliberate, owner-approved, one-at-a-time act (AGENTS.md §6).

**Two things it deliberately does differently from the drift check**, which shares its inventory
module (`scripts/lib/migration-inventory.ts`) so the two can never disagree about what "missing"
means:

- **It ignores the 48-hour grace window.** The check hides fresh migrations because a nightly
  report should not nag about an hour-old merge; the applier runs *on* that merge, so inheriting
  the window would make it skip the one file it exists to apply.
- **It skips the per-file `git log` commit-time lookup**, which only the grace window needs.
  That is one process per migration file — 410 today — and dropping it took a run from over
  three minutes to two seconds.

**Operational requirement:** a `PHOENIX_STAGING_DATABASE_URL` GitHub Actions secret, using the
**Session pooler** URI (a direct `db.<ref>.supabase.co` host is IPv6-only and a GitHub runner has
no IPv6). Without it the workflow applies nothing and emits a `::warning::` rather than failing
every merge — a green tick that did nothing is the silent-green shape this area keeps being bitten
by, so it says so out loud.

## Migration drift check

`.github/workflows/migration-drift-check.yml` runs `pnpm run check:migrations-applied` daily
against **both** staging and production, comparing every `supabase/migrations/*.sql` file to the
target project's `supabase_migrations.schema_migrations` (via the `phx_ci_migration_versions`
RPC). Each run prints the project ref it judged.

The production leg was added 2026-07-30. Until then the check ran against **staging only**, on
the reasoning that "if a migration never reached staging it never reached production either".
That proxy runs backwards: the documented workflow is staging-**first**, with production apply
gated on separate explicit approval (AGENTS.md), so the normal drift is applied-on-staging /
missing-on-production — exactly what a staging-only check reports as green. It had been passing
daily for over a week while production was missing
`20260725180000_analytics_dim_products_exclude_head_office.sql`.

**Operational requirement:** the production leg needs a `PRODUCTION_SUPABASE_SERVICE_ROLE_KEY`
GitHub Actions secret (production project ref `ozucdzovmcqvepbozvqf`). Without it the step is
skipped and the job emits a `::warning::` saying production was **not** checked — a skipped step
and a passing step look identical at a glance, which is the same silent-green failure this
workflow exists to prevent.

## Structured logging

`src/lib/observability/log.ts` emits single-line JSON with a top-level `severity` plus a
`logging.googleapis.com/labels` object. The label key is a GCP convention left in place so the
format is unchanged if GCP ever returns — on Railway it is simply part of the JSON line. Current
stable labels:

- `event=cron_unauthorized` — a cron/worker endpoint hit without a valid `CRON_SECRET`. Logged at
  `WARNING` except for the known-dead `Google-Cloud-Scheduler` user-agent (the GCP project retired
  2026-08-01 whose scheduler jobs still fire on their old secret), which logs at `INFO` so it stays
  greppable without reading as an incident. Any other caller — including a caller claiming that same
  user-agent string with a different IP — still warrants a look.
- `event=webhook_signature_invalid` / `webhook_misconfigured` — Resend webhook rejections.
- `event=cron_failed` / `background_job_failed` — job execution failures.
- `event=config_drift` — a notification-/cron-critical env var is unset where it must be present, emitted by `/api/readyz` (`src/lib/observability/config-drift.ts`). Non-fatal — readiness stays 200 — but alerted, see below. The gate differs per var, because the environment a var *must* exist in is a per-var question:
  - **Production only** (legitimately unset in dev/preview/staging): `EMAIL_NOTIFICATIONS_ENABLED`, `RESEND_API_KEY`, `NOTIFICATION_EMAIL_FROM`, `RESEND_WEBHOOK_SECRET`, `TELEGRAM_BOT_TOKEN`, `NOTIFICATION_WEBHOOK_SECRET`, and `MASTER_MAP_SYNC_TOKEN` (the Master Map Apps Script only ever calls production, so the token is deliberately absent on staging — a production-only gate keeps that from reading as drift).
  - **Every deployed environment** (production *and* staging, silent only in local `development`): `CRON_SECRET`. PR #2479 made the 18 cron/notification routes 401 on an unset `CRON_SECRET` on staging too — the drift alarm mirrors that route condition (`NODE_ENV !== "development"`) so it is not blind to a staging outage.

Read them with the Railway CLI (there is no log query language and no log-based metrics any more —
grep the stream):

```bash
railway logs --service phoenix-people-workforce | grep cron_unauthorized
```

`railway logs --http --json` gives the HTTP access log, which is how the real cron caller was
identified (read `clientUa` + `httpStatus` per `/api/cron/*` request).

## Health probes

- **`/api/healthz`** — liveness: returns 200 plus `revision`, the running commit SHA. **This is the
  authoritative answer to "what is actually live?"** — not the workflow list, not a merged PR. There
  is no longer a deploy smoke test or an uptime check calling it; you call it.
- **`/api/readyz`** — readiness: cheap Supabase head-ping + required-env presence; returns 503 when not ready. Returns only booleans / missing-env **names**, never values. Also surfaces non-fatal notification-config drift (see `event=config_drift` above) in a `warnings[]` field — drift never fails readiness, but it is logged and alerted (see below) since it means email/Telegram may be silently broken while everything else is healthy.

## A 5xx burst on the REST endpoint is the DATABASE INSTANCE restarting — how to read one

🔴 **A burst of Cloudflare 521 / 520 / 525 plus PostgREST 503 against the Supabase REST endpoint is
not an edge flap. The whole production database instance is being hard-restarted, and the edge codes
are what Cloudflare serves when the origin is gone.** Measured **three days running**: **10 Oct 2026
11:05:48**, **11 Oct 13:14:01** and **12 Oct 19:04:50 Cairo**, each unclean, each self-recovered
inside a minute, the Postgres binary byte-identical in all three (so no version upgrade).

🔴 **IT IS THE INSTANCE, NOT POSTGRES — AND SAYING "POSTGRES CRASHED" SENDS THE NEXT SESSION HUNTING
A CAUSE THAT IS NOT THERE.** Read 4 below is what separates the two, and on all three events it said
instance. Nothing inside the database caused any of them.

The five reads, in the order worth running:

1. **`select pg_postmaster_start_time()`** — one statement, live, and it settles the question. After
   the 12 Oct event it read `2026-10-12 19:04:50` Cairo.
2. **`cron.job_run_details`** — a restart lands as a job failure whose `return_message` is literally
   **`server restarted`**. That is how 10 Oct stayed provable days later (jobid 1, runid 289,
   started 11:05:00).
3. **`postgres_logs`** — `database system was interrupted; last known up at …`, then **`database
   system was not properly shut down; automatic recovery in progress`**, `redo starts at …`, then a
   run of `the database system is not accepting connections` (11 of them on 12 Oct). 🔴 **No
   `received fast shutdown`, no PANIC and no out-of-memory line means the postmaster was killed from
   outside the process** — not asked to stop, and not a query that blew up. A severity sweep of the
   whole day finds nothing else: ordinary application `ERROR`s, plus the `FATAL`s from the restart.
4. 🔴 **THE SIDECARS — THE DECISIVE READ, AND THE ONE `postgres_logs` CANNOT REPLACE.** Query
   `pgbouncer_logs` / `postgrest_logs` / `auth_logs` for `%process up:%`, `Starting PostgREST%` and
   `%Go runtime metrics%` in a 60-second window. **All three boot in the same second, and PgBouncer
   and PostgREST come up BEFORE the postmaster** — so PostgREST logs `connection to server at
   "localhost" … refused`, `PGRST000` and `PGRST002` and serves 503s until Postgres is ready, which
   is the 503 half of the burst in read 5. Measured (UTC) — 12 Oct: PgBouncer `16:04:48.86`,
   PostgREST `16:04:49.05`, postmaster `16:04:50.37` · 11 Oct: `10:14:00.58` / `10:14:00.66` /
   `10:14:01.84` · 10 Oct: `08:05:46.77` / `08:05:46.80` / `08:05:48.19`. 🔴 **An OOM-killed or
   PANICking postmaster leaves those three processes alive and reconnecting; it does not restart
   them.** All three together, before Postgres, means the container went down.
5. **`edge_logs`** — the only place the request-level damage is visible. 12 Oct 19:04:41–19:05:19:
   **38 × 521, 32 × 503, 7 × 520, 2 × 525 = 79 failed requests** over 13 / 10 / 3 distinct paths.
   The status key is **`log_attributes['response.status_code']`** (`status_code` alone is empty), and
   the 503s carry `response.headers.proxy_status = 'PostgREST; error=PGRST002'`.

🔴 **Two things that look like evidence and are not.** `app_error_events` held **17 rows in the whole
hour**, none of them a 5xx — never size this incident class from it. And `get_project` reads
`ACTIVE_HEALTHY` afterwards, because the project *is* healthy again; project status disproves nothing.

🔴 **COUNT THE RESTARTS FROM THE LOGS, NEVER FROM THE INCIDENTS THAT GOT REPORTED.** The 11 Oct event
sat unnoticed for two days — nobody was looking at that minute, and both the memory note and this
section said "twice" until someone asked for the whole picture. `query_logs` takes a **24-hour window
at most**, so a multi-day sweep is one query per day, with `starting PostgreSQL%` as the needle.

**The box it happens on.** `shared_buffers` 512 MB, `effective_cache_size` 1 GB, `work_mem` 32 MB,
`maintenance_work_mem` 128 MB, `max_worker_processes` 6 — a **2 GB** compute class carrying a
**3.19 GB** database. Connections at the time: 17 of 200. Neither connection count nor CPU is the
pressure.

🔴 **AND THE CAUSE IS NOT PROVABLE FROM INSIDE THE DATABASE — SAY SO RATHER THAN NAMING THE
LIKELIEST-SOUNDING SUSPECT.** Every in-house candidate for 12 Oct is exonerated by a measurement, not
by assumption: `cron.job_run_details` shows the three scheduled jobs at 3.4–9.8 s with the 19:05 run
starting *after* the restart; `edge_logs` requests/min were **falling** into it (2480, 2313, 2112,
936, 646, 1600, 2021, 652 across 15:56–16:03 UTC, then 59 with 58 × 5xx at 16:04); connections were
17 of 200; and there is no OOM, PANIC, `signal 9` or `crash of another server process` line anywhere
in the day. What is left is the host, where memory pressure on that 2 GB class is the only in-house
candidate the settings leave open — and **only Supabase's own host-side record can settle it**, which
is what the support ticket drafted on 13 Oct 2026 asks for, alongside the compute-size question.

**What already absorbs it.** PR 5736 keeps the session alive through the outage instead of signing
everyone out — 10 Oct's window produced 22 logins and **9 born-dead sessions**, 12 Oct's produced
5 logins and **0**, with one `session_verification_unavailable` row where the old code would have
cleared cookies and answered 401. PR 5737 retries 521/525 at 200/400/800 ms. 🔴 **That ~1.4 s budget
cannot ride a 38-second restart, and lengthening it is the wrong fix** — a retry long enough to
outlast a restart freezes every page for the length of the restart.

**A fourth one now alerts, within fifteen minutes.** Nothing reported the first three: `/api/healthz`
answered 200 throughout both (it does not touch the database), `app_error_events` held 17 rows in the
whole hour, and the GCP 5xx alert died with its billing on 2026-08-01 (the section below). Since
2026-10-13, `runDatabaseRestartCheck()` rides the 15-minute `job-heartbeat-sweep` clock as a third
independent watch — the same arrangement, and for the same reason, as the dead-share-token check
already on it, so **no new cron job and no cron-job.org entry were needed.**

- `public.note_database_restart()` (migration `20261013150001_database_restart_watch.sql`) reads
  `pg_postmaster_start_time()`, records it in `public.database_restarts` if it is new, and reports
  whether it moved. SECURITY DEFINER, `revoke execute … from public, anon, authenticated`, execute
  granted to `service_role` alone — so no browser role can call it and the table is unreachable.
- The insert is `on conflict do nothing`, so with two Railway replicas on the same clock exactly one
  of them reports the restart.
- 🔴 **The migration SEEDS the current start time**, so installing the watch does not fire it. A new
  start time with nothing on record is a `first-sighting` and never alerts — it only logs.
- **Idempotency is the start time, not the Cairo day.** Its two siblings on this clock bucket per day
  because they report standing faults; a restart is a discrete event, and two restarts in one day
  must be two messages. Do not "fix" that to a day bucket — two in three days is the whole pattern.
- In-app + Telegram + push on the `weekly_system_health_digest` audience. 🔴 **No email, deliberately:**
  this alarm can fire because the database holding the notification outbox is unreachable.
- Pinned by `tests/database-restart-watch.test.ts`, in the required `validate` job.



## 18 October 2026 — a slow database, the Talent Acquisition seat, and what changed

**What was reported.** The Talent Acquisition seat (Yomna Gamal, role `HR Resourcing`) could not load
recruitment data.

**What was found** (Africa/Cairo):

- **Nothing was wrong in the recruitment code.** Run afterwards, read-only, as her seat, the page's seven
  reads passed three times out of three in 2.5-3.1 s (1,491 candidates, 43 requisitions, 40
  applications), and her seat holds every Recruitment and Candidates permission the page asks for.
- **The database was the cause.** Production timed out between 10:30 and 11:55 and was hard-restarted at
  **11:54:34**. At **10:57** her Recruitment page failed four times with "Session verification is
  temporarily unavailable" — the login check, which runs before any page code is reached.
- **It was the fourth hard restart in six days:** 12 Oct 19:04, 14 Oct 11:34, 17 Oct 12:30 and 18 Oct
  11:54 (`public.database_restarts` holds all four), each preceded by 30-90 minutes of slowness, on the
  2 GB compute class described above.
- 🔴 **Not proven, and not to be written as if it were:** what killed the database, and whether the
  attendance replay below was the trigger or only coincided with it. Only Supabase's own Reports (CPU,
  memory and swap around those four times) can settle it. The compute size is a money decision: it is
  made on the Supabase screen (Settings, Compute and Disk), never in chat.

**Three things turned a slowdown into a dead end, and each now has a fix:**

1. **The Recruitment page was all-or-nothing.** Seven reads ran in one `Promise.all` inside one `try`;
   any one rejection blanked the page, wrote nothing to the log and showed "apply the recruitment
   migrations on staging" — advice for a fresh environment. The page now settles its eight reads one by
   one, names what did not load, logs ONE aggregated `recruitment` row, and never shows a failed pool as
   zero. Account: `docs/recruitment-page-round-trips.md`.
2. **The login check had no fallback.** `phx_auth_session_bundle` is called about twice a second with no
   cache, and when its one retry also failed the whole render threw. The last ACCEPTED bundle is now kept
   for ten minutes and used only after the live call and its retry both fail (owner's decision). Live is
   always tried first; the copy goes through every check a live bundle does, including the lifecycle gate
   against today's date; it is never stored again from a copy, so its age never resets; a served copy
   skips the idle-refresh write. It logs `session_verification_served_from_recent_copy` at warning level,
   so a Railway log search shows every time it was used. With no copy the outage still raises
   `SessionVerificationUnavailableError` as before.

   **What a copy can do — narrowed after the risk review of this change.** It authorises READS only: a
   page render, or an API request that is a GET or HEAD (`mayUseRecentSessionCopy` in `server.ts`). A
   server action is a POST to a page, so it never reaches that API rule; until 19 Oct 2026 it could run
   on a copy through `resolveAccessContextFromPage` (a code review found a vacation decision could be
   recorded under a role removed minutes earlier). The page resolver now refuses the copy to any request
   carrying the `next-action` header or a body (`pageRequestMayUseRecentCopy` in
   `session-bundle-cache.ts`), which also covers a form submitted before the page's JavaScript loaded. A
   POST, PUT, PATCH or DELETE during an outage answers "Session verification is temporarily unavailable"
   exactly as before, and the passkey registration and listing routes and the change-password route ask
   for `allowRecentCopy: false` outright — a passkey or a password set from a copy would outlive the ten
   minutes and give lasting access to a session that had been revoked. A logout, a forced logout and a
   dev-preview switch made in this process forget the copy at once (`forgetRememberedBundlesForSessions`),
   and a read that began BEFORE that moment, or before a newer live answer for the same session, cannot
   store itself afterwards (a per-session barrier on the read's start time), so a slow older answer cannot
   bring a revoked session back. The exposure the owner accepted is therefore: a role change or a
   deactivation made somewhere else can go unseen for up to ten minutes, and only while the live check is
   failing, and only to read.

   **A consequence worth knowing, not changed:** while the database is failing, a person with a copy
   waits the same ~30 s for the two bundle attempts and then their page runs ALL of its own reads against
   the failing database (the Recruitment page runs eight, each optional one capped at 8 s, and its Try
   again button repeats them). Before the copy the same person was stopped after the two bundle attempts.
   The copy trades that load-shedding for a working page; if an outage ever shows the extra reads hurting,
   the lever is to skip a page's optional reads when it was served from a copy.
3. **The attendance route made one call per punch.** On 18 Oct between 10:16 and 10:33 the on-prem agent
   replayed punches the table already held and the route answered with 10,461 single-row calls, fifty at a
   time. It now sends up to 250 punches per call to `public.phx_insert_attendance_raw_punches` (a 1,000
   punch request is four calls) and falls back to the single-row function, at concurrency 10, if a batch
   fails; a fallback is logged as `raw_punch_batch_fell_back`, because a missing function or one punch the
   database refuses would otherwise bring the old load back unseen. Account: `docs/attendance-agent.md`.

**The restart alert has a gap — found while checking the above, not fixed in the same change.**
`runDatabaseRestartCheck()` did NOT miss the 17 Oct restart: it recorded it in `database_restarts` six
seconds after the database came up (start 12:30:10, noticed 12:30:16). But the audit log holds an
`observability.database_restarted` row for 14 Oct (11:45, "delivered to 1 recipient") and for 18 Oct
(12:00), and NONE for 17 Oct. `note_database_restart()` writes the row before the alert is sent, so an
alert that fails once is never retried — the next run reads `unchanged`. The failure itself is not visible
(it goes to the process log only), so the cause is inferred from the order of operations and the six-second
timing, not observed. The repair is to re-attempt a recorded restart that has no audit row and is under an
hour old, on each sweep run; the notification's idempotency key (`database-restarted:<start>:<hr id>`)
already stops a second copy reaching anyone who received the first. It touches the alert path and its test,
so it was left for its own change.

**How to see that it worked after the deploy:** `/api/healthz` `revision` equals the merge commit;
`pg_stat_statements` shows calls to `phx_insert_attendance_raw_punches` and far fewer to
`phx_insert_attendance_raw_punch`; `app_error_events` carries a `recruitment` row only when a read really
failed; and a Railway log search for `session_verification_served_from_recent_copy` shows whether the login
fallback was ever used.

## Metrics & alerting — DEAD (nothing pages the owner)

All of the below lived in GCP Cloud Monitoring inside project `phoenix-workforce-498619`. That
project's billing closed 2026-08-01, so **every one of these alerts is dead** and none has been
rebuilt on Railway. Kept as the specification to rebuild against, not as a description of what runs:

| Alert (dead) | Was sourced from |
|---|---|
| Cloud Run 5xx rate | `run.googleapis.com/request_count` (response_code_class=5xx) |
| Cloud Run p95 latency | log-based metric `phoenix_hr_production_request_latencies` |
| Uptime failure | uptime check on `/api/healthz` |
| Cloud Scheduler job failure | log-based metric `phoenix_scheduler_failures` |
| App auth/cron/webhook failure spike | log-based metric `phoenix_app_auth_failures` |
| Notification-config drift | log-based metric `phoenix_config_drift` (`labels.event="config_drift"`) |
| Production error log ("Phoenix HR production ERROR log alert") | log-match on `severity>=ERROR`; this was the Sentry replacement |

The one alerting path that **does** still work is Healthchecks.io (next section) — it is
third-party, was never inside GCP, and answers exactly one question: did a cron job run at all.
It says nothing about 5xx rates, latency, or application errors.

Rebuilding this is open work. Whatever replaces it must live **outside** the hosting platform, for
the same reason the dead-man's-switch does: a monitor that runs inside the thing it monitors cannot
report that the thing is down.

## External dead-man's-switch (Healthchecks.io)

`src/lib/observability/dead-mans-switch.ts`, wired into the cron routes. **This is now the only
working alert in the system**, and the reason it survived the GCP shutdown is exactly why it was
built: it is hosted outside the platform it watches, so it can still fire when that platform is the
thing that is broken. The GCP monitoring that sat inside the same project it monitored is gone; this
is not.

The original gap it was built for: 3 scheduler jobs (including the notification outbox drain) sat
silently **PAUSED for ~2 days** after a 2026-07-23 emergency stop — the scheduler showed a state,
not an alert, and nothing external was watching for the absence of an expected ping.

The routes are now triggered by **cron-job.org**, not Cloud Scheduler (see
[deployment.md](deployment.md) § Cron Jobs). The dead-man's-switch is indifferent to who calls the
route — it pings on completion either way — so it kept working across the cutover.

**How it works:** each route calls `pingDeadMansSwitch(jobSlug, "success" | "fail", detail?)` (via
the `withDeadMansSwitch` wrapper, or directly for `notifications/daily`'s partial-sub-job-failure
case — see that file's own comment) after its real work completes. Healthchecks.io alerts when an
**expected ping doesn't arrive**, which is exactly the failure shape a paused/crashed/misconfigured
job produces. Uses Healthchecks' [Ping Key + slug API](https://healthchecks.io/docs/http_api/) —
one secret (`HEALTHCHECKS_PING_KEY`) covers every check, addressed by slug instead of a per-check
UUID, with [auto-provisioning](https://healthchecks.io/docs/autoprovisioning/) (`?create=1`) so
each check is created automatically on its job's first real ping. Fails silent by design: no key
configured, or non-production runtime, means the code never attempts a network call at all — see
`tests/dead-mans-switch.test.ts` for the exact contract (never throws, never masks the real job
outcome, no-ops outside production).

**One-time owner setup** (an AI session cannot create third-party accounts — see repository
policy):

1. Create a free account at [healthchecks.io](https://healthchecks.io/) (or use an existing one).
2. Open the default project (or create one) → **Settings** → copy the **Ping Key**.
3. Set `HEALTHCHECKS_PING_KEY` on the Railway service `phoenix-people-workforce` (production env
   var change — needs its own approval per repo policy). **Already done** — the switch is armed.
   Healthchecks slugs are not environment-namespaced, so if a second environment ever exists again,
   never set this key there: its ping would reset the exact check production relies on, masking a
   real outage behind a healthy-looking heartbeat. `withDeadMansSwitch`/`pingDeadMansSwitch`
   no-op outside production anyway (see `tests/dead-mans-switch.test.ts`).
4. Configure notification channels for the project (email is on by default; add Slack/Telegram/
   SMS/etc. under **Integrations** if wanted) — this is what actually pages you. Every channel
   configured here gets attached to every check by the sync script in step 6; there is no per-check
   opt-out, because a check that alerts nobody is silently useless and this is a single-owner
   project. Found 2026-08-27: `phoenix-db-health-snapshot` and `phoenix-direct-orders-probation`
   had sat with zero channels since creation — neither had ever gone red, so nothing surfaced it
   until someone checked by hand. `pnpm run healthchecks:sync --apply` now fixes and prevents this.
5. Deploy. Each job's check auto-appears in the dashboard the first time it pings after step 3 —
   nothing to pre-create.
6. **Tune each check's schedule and channels — run the script, do not do this by hand:**

   ```bash
   pnpm run healthchecks:sync            # dry run: print what would change
   pnpm run healthchecks:sync --apply    # push it
   ```

   Auto-provisioned defaults (Simple: 1-day period, 1-hour grace, **zero channels**) are wrong for
   every one of these jobs, so every check is born red-or-silent and stays that way until someone
   corrects it — and a dashboard that is always red, or always silent, is one nobody reads.
   [`scripts/healthchecks-sync.mjs`](../scripts/healthchecks-sync.mjs) reads the table below and
   makes Healthchecks match it: cron expression, `Africa/Cairo` timezone (Healthchecks defaults to
   UTC), grace, **and every channel configured in the project** (there is no per-check column for
   this — it always means "all of them", see step 4). It is idempotent, it reads back after writing
   rather than trusting the POST, and it changes nothing without `--apply`.

   It needs `HEALTHCHECKS_API_KEY` in `.env.local` — a Healthchecks **project API key**
   (Settings › API keys, full access), which is **not** `HEALTHCHECKS_PING_KEY`. A ping key can
   create a check but cannot set its schedule, which is exactly why every check has been sitting on
   defaults. The script never prints the key.

   Doing it in the web UI instead — switch **Schedule** to **Cron Expression**, paste the row, set
   **Time Zone**, set the grace — still works and is the fallback if the key is unavailable.

   One row is deliberately **Simple** rather than a cron expression: it is pinged on an interval,
   not at a wall-clock time.

   Several rows are marked **in-house only**. They are declared here and in `JOB_SCHEDULES` like every
   other job — the heartbeat register watches them and alerts in-app, Telegram and push when one
   stops reporting — and the marker tells `scripts/healthchecks-sync.mjs` not to **create** a check
   for them. The project has a ceiling, asking past it answers HTTP 403 with an empty body, and the
   owner has ruled out raising the plan (2026-09-08). Without the marker the sync reports a permanent
   `CREATE … FAILED` line for each of them although they are working perfectly, which is
   the "always red, so ignored" failure this whole page exists to prevent.

   🔴 **THE MARKER WITHHOLDS THE CREATE, NOT THE TUNING — AND IT USED TO WITHHOLD THE WHOLE WRITE,
   WHICH IS HOW 13 OF THE 40 LIVE CHECKS CAME TO BE WRONG.** These jobs ping with `?create=1`, so
   Healthchecks auto-provisioned a check for nearly every one of them anyway, each born on the
   Healthchecks **defaults** — a 1-day period and a 1-hour grace — and the old marker made the sync
   skip them, so nothing ever corrected that. Measured on the owner's audit, 15 Oct 2026, while the
   sync was reporting *"Everything already matches"*: `phoenix-retention-risk-pre-payroll` (monthly,
   day 25) had been **red for 20 days** against a job the register reported healthy,
   `private-calendar-gap-notice` and `phoenix-crm-fraud-scan` (both weekly) were red six days in
   seven, and `phoenix-crm-visit-rollup` (hourly) and `phoenix-interview-reminders` (every ten
   minutes) were judged once a **day** — 24× and 144× too loose to notice a stop. All 13 were tuned
   in place the same day (0 created, 13 updated, read-back verified). **So the rule is existence, not
   the marker:** a declared check that exists is tuned in place, because an update costs no slot, and
   the marker only stops the sync asking for a new one. Every run now lists both halves by name —
   `in place` and `withheld`.

   What a withheld row gives up is the outside observer for that one job — and "is Phoenix alive?" is
   already answered within minutes by `phoenix-inbound-intake` (2m),
   `phoenix-process-notifications` (5m) and `phoenix-ireports360-live-poll` (5m). **To give a withheld
   row its own check:** free a check in the Healthchecks project or raise the plan, delete
   `· **in-house only**` from its row, and re-run the sync with `--apply`.

   | Check slug | Cron expression | Suggested grace | What actually pings it |
   |---|---|---|---|
   | `phoenix-notify-daily` | `36 6 * * *` | 1h | cron-job.org job `8200909` |
   | `phoenix-production-planning-fx` | `7 6 * * *` | 2h | cron-job.org, armed on merge by `cron-autoarm.yml` · **in-house only** |
   | `phoenix-production-planning-reorder` | `11 6 * * *` | 2h | cron-job.org, armed on merge by `cron-autoarm.yml` · **in-house only** |
   | `phoenix-marketing-field-capture-nudge` | `50 6 * * *` | 1h | cron-job.org job `8348773` |
   | `phoenix-marketing-invoice-overdue-nudge` | `5 7 * * *` | 1h | cron-job.org job `8350529` |
   | `phoenix-distributor-upload-overdue-nudge` | `20 7 * * *` | 1h | cron-job.org job `8375333` |
   | `phoenix-mapping-guard-notify` | `5,20,35,50 * * * *` | 1h | cron-job.org job `8427700` |
   | `phoenix-interview-reminders` | `3,13,23,33,43,53 * * * *` | 1h | cron-job.org job `8478976` · **in-house only** |
   | `phoenix-recruitment-requisition-autopilot` | `27 * * * *` | 2h | cron-job.org, armed on merge by `cron-autoarm.yml` · **in-house only** |
   | `phoenix-recruitment-manager-cv-reminders` | `41 * * * *` | 2h | cron-job.org, armed on merge by `cron-autoarm.yml` · **in-house only** |
   | `phoenix-recruitment-archive-rejections` | `29 3 * * *` | 2h | cron-job.org, armed on merge by `cron-autoarm.yml` · **in-house only** |
   | `phoenix-recruitment-whatsapp-reask` | `1,31 * * * *` | 1h | cron-job.org, armed on merge by `cron-autoarm.yml` · **in-house only** |
   | `phoenix-crm-daily-digest` | `55 6 * * *` | 2h | cron-job.org job `8526396` · **in-house only** |
   | `phoenix-crm-integrity-sweep` | `35 3 * * *` | 3h | cron-job.org job `8525234` · **in-house only** |
   | `phoenix-crm-plan-reminder` | `57 12,17 * * *` | 2h | cron-job.org job `8562812` · **in-house only** |
   | `phoenix-crm-approval-nudge` | `57 9 * * *` | 2h | cron-job.org job `8563266` · **in-house only** |
   | `phoenix-crm-visit-rollup` | `49 * * * *` | 1h | cron-job.org job `8580289` · **in-house only** |
   | `phoenix-crm-fraud-scan` | `0 7 * * 4` | 2h | cron-job.org job `(set on first --apply)` · **in-house only** |
   | `private-calendar-gap-notice` | `9 8 * * 6` | 2h | cron-job.org job `8602203` · **in-house only** |
   | `phoenix-rep-ranks` | `17 4 * * *` | 3h | cron-job.org job `(set on first --apply)` · **in-house only** |
   | `phoenix-retention-risk-sweep` | `40 7 * * *` | 1h | cron-job.org job `8397172` · **in-house only** |
   | `phoenix-retention-risk-pre-payroll` | `45 7 25 * *` | 2h | cron-job.org job `8397174` · **in-house only** |
   | `phoenix-mailbox-offboarding-sweep` | `15 8 * * *` | 1h | cron-job.org job `8350624` |
   | `phoenix-process-notifications` | `*/5 * * * *` | 10m | cron-job.org job `8200914` |
   | `phoenix-background-jobs` | `0 3 * * 5` | 2h | cron-job.org job `8200915` |
   | `phoenix-inbound-intake` | `*/2 * * * *` | 10m | cron-job.org job `8200920` |
   | `phoenix-recruitment-email-intake` | `4-59/10 * * * *` | 20m | cron-job.org job `8200919` |
   | `phoenix-run-synthetic-journeys` | `17 5,8,11,14,17,20 * * *` | 2h | cron-job.org job `8220577` |
   | `phoenix-direct-orders-rotate-sheet-token` | `23 3 * * 5` | 2h | cron-job.org job `8313169` |
   | `phoenix-marketing-requests-rotate-sheet-token` | `43 3 * * 5` | 2h | cron-job.org job `8313171` |
   | `phoenix-cv-lifecycle-rotate-sheet-token` | `3 4 * * 5` | 2h | cron-job.org job `8387636` |
   | `phoenix-brevo-keepalive` | `9 4 1 * *` | 12h | cron-job.org job `8313297` |
   | `phoenix-direct-orders-expire-held` | `17 2 * * *` | 2h | cron-job.org job `8313165` |
   | `phoenix-direct-orders-probation` | `27 2 * * *` | 2h | cron-job.org job `8313177` |
   | `phoenix-db-health-snapshot` | `17 */6 * * *` | 2h | cron-job.org job `8242721` |
   | `phoenix-territory-restamp` | `20 3 * * *` | 2h | cron-job.org job `8350721` |
   | `phoenix-brick-move-drain` | `19,39,59 * * * *` | 1h | cron-job.org job `(set on first --apply)` · **in-house only** |
   | `phoenix-reconciliation-check` | `40 4 * * *` | 2h | cron-job.org job `8350984` |
   | `phoenix-system-audit-sweep` | `57 4 * * *` | 2h | cron-job.org, armed on merge by `cron-autoarm.yml` · **in-house only** |
   | `phoenix-crm-contact-lists` | `*/5 5 * * *` | 20m | cron-job.org job `8344730` |
   | `phoenix-expense-claims-refresh` | `51 * * * *` | 1h | cron-job.org job `8350207` |
   | `phoenix-recruitment-cv-digest` | `47 0,6,12,18 * * *` | 1h | cron-job.org job `8334658` |
   | `phoenix-ireports360-live-poll` | **Simple**, period `5m` | 30m | the in-process poller, every tick |
   | `phoenix-ireports360-sync` | `0 6-21/3 * * *` | 2h | the in-process poller, when due |
   | `phoenix-reconcile-visits` | `0 4 * * 0` | 12h | the in-process poller, when due |
   | `phoenix-job-heartbeat-sweep` | `*/15 * * * *` | 30m | cron-job.org job `8351275` |

   **This table is machine-read.** `scripts/healthchecks-sync.mjs` parses these rows — slug in
   backticks, then either a backticked cron expression or a **Simple** cell naming its period, then
   the grace as `10m` / `2h`. `tests/healthchecks-schedule-sync.test.ts` fails in CI if that stops
   parsing, if a row loses `Africa/Cairo`, or if either Direct Orders row drifts from its live
   cron-job.org clock.
   Reformat the table freely, but re-run `pnpm run test` — a parser that silently matches nothing
   turns the sync into a no-op that reports success.

   🔴 **A GRACE EQUAL TO THE INTERVAL MAKES ONE SKIPPED FIRE A PAGE — ON A MINUTE-LEVEL JOB THE
   GRACE IS AT LEAST TWO INTERVALS, AND NEVER TUNE ONE BACK DOWN TO LOOK TIGHTER.** Measured from
   the live flip history on 15 Oct 2026: of the 61 down-flips in the preceding 30 days, **39 came
   from three checks whose jobs never actually stopped** —
   `phoenix-recruitment-email-intake` (24 outages in its whole history, **12 of them lasting
   9.8–10.0 minutes** against a 10-minute grace, which is the signature of recovering on the very
   next scheduled fire), `phoenix-crm-contact-lists` (12 outages, **six at 5.2–5.8 minutes**, one
   five-minute slice of the twelve inside hour 5, and three at ~15.5) and
   `phoenix-ireports360-live-poll` (33 outages, **26 recovering within 4.3 minutes of going down**,
   i.e. a ~21-minute silence against a 20-minute threshold — the deploy restart of an in-process
   poller, not a stall). The first two moved to **20m** and the poller to **30m**, which would have
   silenced **31 of those 39 alerts and left 7, every one a genuine stall**. 🔴 **The fast liveness
   signal is `phoenix-inbound-intake` — 2-minute period, 10-minute grace — and it is deliberately
   NOT widened**; it is the one check that answers "is Phoenix alive?" within minutes, so widening
   it is what would actually cost coverage. A tight grace that cries wolf is worse than a wide one:
   the 13 checks above went 20 days unread for exactly that reason.

   **Tags and descriptions — the second machine-read table.** Measured on the owner's audit,
   15 Oct 2026: **0 of the 40 live checks carried a tag or a description.** So the dashboard was 40
   undifferentiated slugs, and an alert at 4am said a slug and a status and nothing about what had
   stopped or what it costs. `scripts/healthchecks-sync.mjs` reads the table below and pushes both,
   and it **refuses to run if a declared slug has no row here or a row names a slug that is not
   declared** — the two tables move together or not at all.

   The tag vocabulary is closed and CI-checked (`tests/healthchecks-schedule-sync.test.ts`): exactly
   one **module** tag — `hr` · `recruitment` · `sales` · `crm` · `marketing` · `direct-orders` ·
   `production-planning` · `platform` — plus `in-house-only`, which must agree with the marker on
   the schedule row above, and `silent-when-clean` where sending nothing is the job working.
   🔴 **There is deliberately no cadence tag:** the Healthchecks dashboard already prints each
   check's schedule beside it, and a hand-written `daily`/`hourly` would be one more thing to drift.
   What the dashboard cannot show is which module a slug belongs to — that is what these are for.

   🔴 **THE DESCRIPTION SAYS WHAT A RED MEANS, NOT WHAT THE JOB IS.** A description that only
   restates the slug is worth nothing to whoever is reading it at 4am; what they need is the
   consequence — who was not told, which figure is now stale, what is filling up — and, for the
   `silent-when-clean` rows, the fact that a quiet run is correct.

   | Check slug | Tags | What a red means |
   |---|---|---|
   | `phoenix-notify-daily` | `hr` | The 06:36 daily bundle — birthdays, contract renewals, holiday reminders, the vacation, marketing and outstation SLA digests, and the notification-retention cleanup. A red means none of those notices went out that morning. |
   | `phoenix-production-planning-fx` | `production-planning in-house-only` | The one dollar rate a day that keeps every dollar-typed material price deriving a current pound figure. A red means the planner is costing the buy list on a stale rate. |
   | `phoenix-production-planning-reorder` | `production-planning in-house-only` | The Ivyronc reorder and expiry alarm, naming the materials whose cover has fallen to about one run. A red means nothing warned him, and the imported material takes about six months to arrive. |
   | `phoenix-marketing-field-capture-nudge` | `marketing silent-when-clean` | Tells each rep which of his own validated marketing customers still have no field capture behind them, in-app, Telegram and push only. A red means that backlog went unnamed. |
   | `phoenix-marketing-invoice-overdue-nudge` | `marketing silent-when-clean` | Tells the requester and finance that an approved marketing request's invoice has passed its deadline. A red means a late invoice was raised with nobody. |
   | `phoenix-distributor-upload-overdue-nudge` | `sales silent-when-clean` | Tells the Super Admin and the SFE Manager which distributor files for the month just closed are later than they were last month. A red means a late file went unreported. |
   | `phoenix-mapping-guard-notify` | `sales` | The attribution freshness clock — it refreshes the stale attribution periods four times an hour. A red means the attribution figures are drifting behind the sales data underneath them. |
   | `phoenix-recruitment-requisition-autopilot` | `recruitment in-house-only silent-when-clean` | The hourly requisition autopilot: an open requisition for every empty seat, and every requisition whose seat is filled closed as Filled. It sends nothing by design, so a red means seats stopped opening or closing on their own and Talent Acquisition is working from a stale list. |
   | `phoenix-recruitment-manager-cv-reminders` | `recruitment in-house-only silent-when-clean` | The hourly reminder to each manager holding CV folders about CVs sent to them and not yet opened, 08:00-21:59 Cairo, in-app, Telegram and push, never email. A manager with nothing unopened is told nothing, so a red means an unopened CV stopped being chased. |
   | `phoenix-recruitment-archive-rejections` | `recruitment in-house-only silent-when-clean` | Moves every rejection older than 30 days out of the Recruitment workspace's tabs into its archive — never deleted, still searchable. It tells nobody, so a red means old rejections are piling back into the tabs Talent Acquisition works from. |
   | `phoenix-recruitment-whatsapp-reask` | `recruitment in-house-only silent-when-clean` | The in-window WhatsApp re-ask: while the switch on the Screening Questions screen is on, an applicant who went quiet mid-way through the questions is asked the question they stopped at, once, before WhatsApp's 24-hour window closes. It starts OFF and sends nothing while off, so a quiet run is correct; a red means quiet applicants stopped being asked again and their answers stay missing. |
   | `phoenix-interview-reminders` | `recruitment in-house-only silent-when-clean` | Reminds each person chosen to conduct an interview, the evening before and an hour before, in-app, email and Telegram. A red means an interviewer may be given no reminder at all. |
   | `phoenix-crm-daily-digest` | `crm in-house-only silent-when-clean` | Phoenix CRM's 06:55 digest to each district manager about the previous field day, in-app and Telegram. A clean manager is told nothing, so this check is the only proof it ran. |
   | `phoenix-crm-integrity-sweep` | `crm in-house-only` | Phoenix CRM's 03:35 photo-duplicate and integrity sweep. It notifies nobody by design and only writes evidence for the board, so a red here is the only way anyone learns it stopped. |
   | `phoenix-crm-plan-reminder` | `crm in-house-only silent-when-clean` | Phoenix CRM's 12:57 and 17:57 reminder that a rep's coming week is not sent, to him and to his district manager. It is silent outside the window the week is due in. |
   | `phoenix-crm-approval-nudge` | `crm in-house-only silent-when-clean` | Phoenix CRM's 09:57 nudge to whoever has a list request, an off-plan visit or a week edit waiting at his step for more than a day. A morning with nothing overdue sends nothing. |
   | `phoenix-crm-visit-rollup` | `crm in-house-only` | Phoenix CRM's hourly rollup of the routine planned visits submitted in the previous completed clock hour, one batched message per in-scope manager. A red means an hour of field work was never reported upward. |
   | `phoenix-crm-fraud-scan` | `crm in-house-only` | Phoenix CRM's Thursday 07:00 visit-fraud summary for the completed Saturday-to-Wednesday week, to the Super Admin and the SFE Managers. It judges nothing itself — it summarises flags the detectors already wrote. |
   | `private-calendar-gap-notice` | `hr in-house-only silent-when-clean` | The employee's own Saturday 08:09 notice that a day in their Private Calendar has nothing recorded on it, in-app and push. A red means a week of unexplained days went unasked. |
   | `phoenix-rep-ranks` | `crm in-house-only` | Phoenix Ranks' nightly 04:17 scoring run over Phoenix CRM's own territories, visits, lists and plans. A red means the ranks every manager reads are a day or more stale. |
   | `phoenix-retention-risk-sweep` | `hr in-house-only silent-when-clean` | The daily 07:40 sweep for five or more consecutive working days of recorded leave, and for a Medical Rep with five or more and no CRM entry at all. A red means HR was not warned before the money moves. |
   | `phoenix-retention-risk-pre-payroll` | `hr in-house-only` | The "take care, HR" notice on the 25th, listing every employee currently flagged, several working days before Part 1 pays. It fires once a month, so a red is a whole month with nobody warned. |
   | `phoenix-mailbox-offboarding-sweep` | `hr` | The daily 08:15 mailbox-offboarding sweep: it opens a revocation task for any leaver still holding a mailbox the exit workflow missed, and alerts on overdue, lapsed forwarding and the rest. A red means a leaver can still read company mail. |
   | `phoenix-process-notifications` | `platform` | Drains and retries the email and notification outbox every five minutes. A red means queued mail and notifications are sitting undelivered. |
   | `phoenix-background-jobs` | `platform` | Drains the durable background-job outbox — imports, exports and other async work — and recaps to the Super Admin. A red means queued imports and exports are not running. |
   | `phoenix-inbound-intake` | `recruitment` | Drains the inbound-CV intake queue every two minutes: WhatsApp media, re-fetched emails, AI extraction and candidate creation. A red means CVs are arriving and not becoming candidates. |
   | `phoenix-recruitment-email-intake` | `recruitment` | Polls the careers and HR mailboxes over IMAP every ten minutes, enqueues each new message for the intake worker, and health-checks the WhatsApp channel on the same tick. A red means applications are sitting unread in the mailbox. |
   | `phoenix-run-synthetic-journeys` | `platform` | Dispatches the synthetic end-to-end journeys six times a day. A red means nothing is exercising the critical paths from outside, so a broken page stays unnoticed until a person finds it. |
   | `phoenix-direct-orders-rotate-sheet-token` | `direct-orders` | Rotates the Direct Orders live-sheet share token every Friday 03:23. A red means the bearer token of an unauthenticated feed is still the one it was last week. |
   | `phoenix-marketing-requests-rotate-sheet-token` | `marketing` | Rotates the Marketing Requests live-sheet share token every Friday 03:43, twenty minutes behind its direct-orders counterpart so the two never overlap. A red means that feed's bearer token was not rotated. |
   | `phoenix-cv-lifecycle-rotate-sheet-token` | `recruitment` | Rotates the CV-lifecycle live-sheet share token every Friday 04:03. It also refuses rather than rotates when a second feed link is live, and that token sat unrotated for 3 days 22 hours in October 2026. |
   | `phoenix-brevo-keepalive` | `platform` | Resets Brevo's 90-day inactivity expiry on the email failover key, on the 1st of each month, and doubles as a liveness check on that failover. A red means the backup sender may be dying quietly. |
   | `phoenix-direct-orders-expire-held` | `direct-orders` | The held-order 14-day clock: it expires any direct order still held 14 days after it was parked and tells the requester. A red means the held lane is filling with orders nothing will drain. |
   | `phoenix-direct-orders-probation` | `direct-orders` | The 90-day probation sweep: it promotes every provisional pharmacy that has earned a footprint and reports the ones whose window closed in silence, to the owner and the CEO. A red means neither happened. |
   | `phoenix-db-health-snapshot` | `platform` | Takes the query-statistics snapshot every six hours. A red means there is no recent baseline to compare a slow page against. |
   | `phoenix-territory-restamp` | `sales` | The nightly 03:20 territory restamp that keeps each customer's territory current against the master data. A red means sales rows are being attributed on a stale territory. |
   | `phoenix-brick-move-drain` | `sales in-house-only` | Settles the net effect of brick moves three times an hour and alerts on what it could not settle. It is the one declared job with NO external check at all, so only the in-house register watches it. |
   | `phoenix-reconciliation-check` | `sales silent-when-clean` | The nightly 04:40 integrity checks. They store their report and write every breach into the System Audit ledger, which the 04:57 daily message carries; they send nothing of their own. A red means last night's checks were neither stored nor reported. |
   | `phoenix-system-audit-sweep` | `platform in-house-only silent-when-clean` | The nightly 04:57 System Audit sweep: every detector in turn, the verifier, then one in-app and Telegram message, sent only when an issue is new, newly shared or reopened, so a quiet morning is correct. A red means last night's findings were not collected and nobody was told. |
   | `phoenix-crm-contact-lists` | `crm` | Rebuilds the CRM doctor and pharmacy contact lists every five minutes through hour 5. It pings directly rather than through the wrapper, because this route answers 500 without throwing. |
   | `phoenix-expense-claims-refresh` | `hr` | Rebuilds the expense-claims read mirror from the legacy outstation tables every hour. Production reads are live on that mirror, so a red means the claims people are reading go stale. |
   | `phoenix-recruitment-cv-digest` | `recruitment silent-when-clean` | Emails each hiring manager who had candidates pushed to them in the last six hours a summary of what they received and from whom. Silent when no manager received any. |
   | `phoenix-ireports360-live-poll` | `crm` | The in-process poller's own tick, every five minutes. A brief red is usually the production process restarting on a deploy, which is why its grace is 30 minutes; a sustained red means the poller is dead and CRM has stopped pulling iReports360. |
   | `phoenix-ireports360-sync` | `crm` | The rolling iReports360 visits sync, every three hours between 06:00 and 21:00, run by the in-process poller. Its cron-job.org backstop is OFF by design while the poller runs. |
   | `phoenix-reconcile-visits` | `crm` | The weekly full-window iReports360 reconciliation, Sunday 04:00, run by the in-process poller. Its cron-job.org backstop is OFF by design while the poller runs. |
   | `phoenix-job-heartbeat-sweep` | `platform` | The sweeper for the in-house dead-man's switch: it judges every declared job against its schedule and pages a human when one stops reporting. A red here means the thing that watches everything else has stopped. |

   🔴 **STANDING A JOB DOWN AND BRINGING IT BACK NEEDS `watchingSince`, or the restore alarms about
   the gap.** A `job_heartbeats` row outlives its declaration: removing the slug stops it being
   judged but leaves the row, still stamped with the ORIGINAL `first_seen_at`. Put the slug back and
   the sweep judges it against the fires in between — mornings with no cron job behind them, which it
   can never have reported — so it reads STRANDED on the first sweep and pages every Super Admin every
   15 minutes about a job that is scheduled perfectly. `phoenix-crm-daily-digest` did exactly this:
   declared 2026-09-26, stood down the next evening before a single message was sent, restored at
   00:42 Cairo on 2026-09-28, and the alarm then ran from the 27th's 08:55 deadline until the row was
   re-armed by hand. **A restored declaration carries `watchingSince` — the restore instant — in the
   same edit** (`src/lib/observability/job-schedule.ts`), which floors the baseline once without ever
   becoming a rolling window that could hide a job that has genuinely never worked. An unparseable or
   future value is reported as `misdeclared` rather than obeyed. Pinned by
   `tests/job-heartbeat-register.test.ts`.

   🔴 **THE HEALTHCHECKS ACCOUNT HAS A CEILING AND IT HAS MOVED — MEASURE IT, NEVER QUOTE A NUMBER
   FROM THIS PAGE.** Measured 2026-08-30: `GET /api/v3/checks/` returned exactly **20** and a 21st
   answered **HTTP 403 with an empty body**, which is why there is a second, in-house backend and why
   the owner declined a paid plan that day (`$20/month` for 100 checks) and asked for a free path.
   🔴 **Measured again 2026-10-15: the same call returns 40** — the in-house-only jobs
   auto-provisioned their own checks through `?create=1` in between, so `phoenix-crm-contact-lists`,
   `phoenix-expense-claims-refresh`, `phoenix-recruitment-cv-digest` and
   `phoenix-job-heartbeat-sweep` all have an external check now and the sync reports them `ok`. The
   ceiling has NOT vanished, only moved: `phoenix-brick-move-drain` has pinged every 20 minutes since
   2026-10-13 and still has no check, so its auto-provision is being refused. **Do not read a number
   here as current, and do not delete a row to make the sync go green** — that only hides an
   unwatched job again. Since 2026-10-15 a refused ping logs `deadmans_switch_ping_refused`; before
   that the response was never read, which is exactly why the drain's silence had to be found by
   hand.

   ⚠️ **A ping to an uncreated slug is best-effort and silent, which is the trap here.**
   `pingDeadMansSwitch` never throws and swallows its own failure into a `logWarning`, so these
   routes will ping into nothing and carry on working normally. Nothing breaks; nothing is
   watched either. **Absence of a red check is not evidence of a healthy job when the check was
   never created** — that is precisely how these came to be unwatched in the first place.

### Start signals — "started, never finished"

A deploy replaces the production container, and a cron run in flight dies with it. To Healthchecks
that looked exactly like a job that never began: both are a missing ping. On 2026-10-16 the 06:36
`phoenix-notify-daily` run was cut off at 06:37:04 by a container swap (release `abe06c5` → `9d6fa47`,
two merges 19 seconds apart) and, almost certainly, the 03:35 `phoenix-crm-integrity-sweep` run was
cut off the same way — and the dashboard could say only "no ping".

`signalDeadMansSwitchStart(slug)` in `src/lib/observability/dead-mans-switch.ts` sends `/start` before
the run, and the run's own success or fail ping closes it. A check then reads **started, never
finished** after a restart, and Healthchecks records each run's duration, so a job creeping toward its
grace shows before it trips. It is **opt-in** (`withDeadMansSwitch(slug, run, { signalStart: true })`),
external half only (the in-house register records how a run ENDED), awaited so it can never land after
the ending ping, and inert outside production exactly like a ping. Wired today into
`phoenix-notify-daily`, `phoenix-crm-integrity-sweep` and `phoenix-ireports360-sync` (the cron route
and the in-process rolling sync; the weekly reconcile is deliberately not). Add it only to a job whose
check has a grace longer than a normal run — Healthchecks measures the grace from the start — and which
always ends in a success or a fail ping.

### A send a deploy killed must not leave a permanent drain alarm

`claimDelivery` writes an empty `pending` `notification_deliveries` row before a send and fills it in
when the send ends. A process killed between the two leaves a **bare claim**: due, no payload. The
Telegram and push retry drains used to step over such a row without counting an attempt, so
`assessDrainHealth` read "work was due and nothing was attempted" on every tick and
`phoenix-process-notifications` pinged `/fail` from 06:40 on 2026-10-16 (one Telegram row, B-119's
marketing overdue reminder, written 06:37:04).

Both drains now close a payload-less row as `skipped` once nothing has touched it for
`DELIVERY_CLAIM_GRACE_MS` (5 minutes, `src/lib/notifications/system.ts`), conditionally — still open and
still untouched since the cutoff, so a send that fills the row in meanwhile is never overwritten. The
drain-health probe ignores rows touched inside the same grace (`drain-health.ts`), so a killed send does
not spend the day's single drain alert before the drain closes it. The email outbox is a different
table and is unchanged. Pinned by `tests/orphaned-delivery-claims.test.ts`.

### Re-firing a stranded morning job

The same deploy killed `phoenix-notify-daily` at 06:37 on 2026-10-16. The sweep saw it from 07:36 and
told a human, but nothing started the job again, so the day's notifications stayed half-sent.
`src/lib/observability/job-refire.ts` is that act, and the sweep (`app/api/cron/job-heartbeat-sweep`)
calls it in the branch that already found a problem.

What it does, and each limit is deliberate:

- **Only a job named in `JOB_REFIRE_POLICIES`.** Today that is `phoenix-notify-daily` alone. A job joins
  the list only after its sub-jobs were read for what a second run on the same day does. For the daily
  route that was done on 2026-10-16: every delivery goes through `claimDelivery`, an insert that does
  nothing on a duplicate of the unique `notification_deliveries.idempotency_key`, and each of the 30
  sub-jobs passes an explicit key made of the recipient and a Cairo or UTC day (or a once-ever key), so a
  repeat completes a half-finished fan-out and sends nobody a second message.
- **Stranded only.** A job that ran and reported failure is left alone.
- **Once per Cairo day, claimed first.** The claim is the atomic `api_rate_limit_consume` bucket
  (`job-refire:<slug>:<day>`, limit 1), taken before anything starts. A claim that is lost means nothing
  is started; a claim that cannot be made also means nothing is started.
- **Only on the day the run was missed, and only before 12:00 Cairo** (`latestCairoMinutes`).
- **Production only, and only with `CRON_SECRET`.** The sweep starts the route on this server over
  loopback (`127.0.0.1:$PORT`, the server binds `0.0.0.0`) with the shared secret, inside `after()`, so
  the 60-second sweep does not wait for a job that takes minutes.

What a re-fire does **not** heal, from that audit: a claim left `pending` by the killed send (it is closed
by the orphan rule above, and that one message is lost, not resent); the Vacation SLA step writes two
repeat event rows per overdue request on every run (a write, not a message); the finance report could
resend in the narrow case where the first run died after sending and before its marker row; a few
recruitment alerts are keyed on a set of ids, so a changed set the same day is a second, different
message. The weekly steps are no-ops on any other day than their own.

Pinned by `tests/job-heartbeat-register.test.ts`: the decision (same day, cut-off, no policy), the claim
(once, fail closed, a failing trigger never throws) and the wiring (the stranded list only, after the
alert, through `after()`).

### The in-house register — `public.job_heartbeats`

`pingDeadMansSwitch` now writes to **two** backends on every call, and neither can block the other
(`Promise.allSettled`; both halves already swallow their own errors). No route changed to gain
this — the function is the single seam every one of the 41 declared jobs already went through.

| | Healthchecks.io | `public.job_heartbeats` |
|---|---|---|
| Where it lives | outside Phoenix | inside Phoenix |
| Capacity | **capped, and the cap moves — 20 full on 2026-08-30, 40 full on 2026-10-15; measure it** | unlimited |
| Survives Phoenix being down | **yes — this is its whole value** | no |
| Detects "ran and reported FAILURE" | on a dashboard only | **yes, and it alerts** |
| Alerts via | whatever the project has configured | in-app + Telegram, never email |

The sweeper is [`/api/cron/job-heartbeat-sweep`](../app/api/cron/job-heartbeat-sweep/route.ts),
every 15 minutes. It bootstraps a row for every declared slug, judges each against its schedule,
and on any problem writes an ERROR log, an audit row, and a notification to the
`weekly_system_health_digest` audience. **Deliberately no email, and do not "fix" that back** —
this alert can fire *because* the notification pipeline is what stopped, so an emailed alert would
depend on the channel it is reporting broken.

Three design points worth not re-deriving:

- **The previous scheduled fire is computed with `cron-parser`, never from an average interval.**
  Several schedules here are windowed — `*/5 5 * * *` fires twelve times inside one hour and is then
  silent for 23 hours *by design*, and `0 6-21/3 * * *` has a nine-hour overnight gap. Any
  interval-based staleness rule calls both of those stranded every single day, and a monitor that
  cries wolf daily is one nobody reads.
- **A job that has never reported is not stranded until a fire has passed since `first_seen_at`.**
  Otherwise declaring a new job pages someone the moment it deploys.
- **The sweep pings its own switch `success` even when it finds problems.** That check answers one
  question — "is the sweeper running?" — and turning it red for another job's fault is how a
  watchdog stops being trusted.

✅ **THE ONE HOLE IS CLOSED: the sweeper IS externally watched.** A sweeper that stops entirely
cannot report its own silence, and `phoenix-job-heartbeat-sweep` had no Healthchecks slot while the
account was full. It has one now — read live 2026-10-15: status `up`, 4,454 pings, `*/15 * * * *` on
Africa/Cairo with a 30-minute grace and both channels attached.

🔴 **THE HOLE THAT REPLACED IT: `phoenix-brick-move-drain` has no external check.** It is declared,
it is firing (the register recorded a success at 13:19 Cairo on 2026-10-15), and its `?create=1` is
being refused because the project is at its ceiling — so the drain is watched inside Phoenix only. A
monitoring layer that overstates its own coverage is worse than one that admits a gap, so this
paragraph exists instead of a green dashboard.

   🔴 **A check created through the management API is stored with an EMPTY slug unless one is sent
   explicitly** — and the app pings by slug (`hc-ping.com/<ping-key>/<slug>?create=1`), never by name.
   A slugless check therefore never receives the ping it is waiting for: it goes red on schedule while
   the job runs perfectly, and the next real ping quietly auto-provisions a **second** check beside
   it. The sync sends `slug` on every write for this reason. Found on the first live run, on
   2026-08-23, by the read-back the script performs after writing.

   The fourth column is the point of the table. A slug in the code proves only that the app *would*
   ping if something called it; it says nothing about whether anything does. Every row above was
   read back out of the live cron-job.org account on **2026-08-23** (17 jobs, 12 enabled) or traced
   to the code that pings it, and the two rows that did not survive that check are called out below.

   **Three of these are pinged by the app itself, not by any scheduler.** `src/lib/crm/live-poller.ts`
   runs inside the production process and absorbed the iReports360 cron work: it pings
   `phoenix-ireports360-live-poll` on **every tick** (20 s in the 08:00–12:30 Cairo compliance
   window, 30 s daytime, 120 s overnight — hence a Simple 5-minute period rather than a cron
   expression, with a grace wide enough to survive a deploy restart), and it pings
   `phoenix-ireports360-sync` / `phoenix-reconcile-visits` when their deep runs come due. Those two
   fire on an elapsed-time guard, not a wall clock — 3 h since the last success and no earlier than
   06:00 Cairo for the rolling sync, 5.5 days and Sunday from 04:00 for the wide reconcile — so the
   expressions above are the *envelope* they run inside, and the graces are wide on purpose. The
   old rows (`7 9,12,19 * * *` at 30 m, `24 4 * * 0` at 2 h) were copied from the dead GCP script
   and would now go red daily: a poller sync at 09:00 Cairo does not satisfy a check expecting one
   after 09:07.

   🔴 **`phoenix-ireports360-live-sync` is no longer in this table, and if that check exists in the
   dashboard it should be deleted.** `/api/cron/ireports360-visits-live-sync` is still wired to the
   switch, but its only caller — cron-job.org job `8200918` — is **disabled**, last fired
   2026-08-16, and nothing else pings that slug. It was made redundant by the in-process poller, so
   the check has been red since 2026-08-16 for no reason at all. This table used to instruct the
   owner to give it a 15-minute schedule, which would have kept it red forever.

   The two `phoenix-direct-orders-*` rows **moved into cron-job.org on 2026-08-23** — jobs `8313165`
   (02:17) and `8313177` (02:27), both Africa/Cairo, staggered so the two sweeps never overlap. They
   are therefore covered by the drift warning below like every other row: read the live schedule out
   of the account before tuning their grace.

   They ran from `.github/workflows/direct-orders-sweeps.yml` for one day before that. The move
   happened because scheduling from GitHub put `CRON_SECRET` in a second, independently rotated
   store: the 2026-08-14 Railway rotation was never mirrored into Actions, both clocks 401'd nightly
   for nine days, and nobody noticed — a red scheduled-workflow run proved not to reach anyone; a
   missing ping does. That workflow still exists with `workflow_dispatch` and **no `schedule:`**, as
   a manual fallback; re-adding a schedule there would double-fire both sweeps.

   Both expressions above are **Africa/Cairo local**, matching how cron-job.org is configured. Set
   these two Healthchecks checks to that timezone rather than UTC, or the expected-ping window sits
   two to three hours off the real one and shifts again at every Egyptian DST change.

   `phoenix-run-synthetic-journeys` was the first row here to be **measured rather than copied**.
   `/api/cron/run-synthetic-journeys` does
   not do the work itself — it asks GitHub to start `synthetic-journeys.yml` — so its cadence is
   visible in this repository's own Actions history: `gh run list --workflow=synthetic-journeys.yml`
   shows **177 `workflow_dispatch` events between 2026-08-15 and 2026-08-23, every one 4-12 seconds
   past the top of the hour, all 24 UTC hours represented, one single missed hour in eight days**.
   Railway's HTTP log names the caller (`@path:/api/cron/run-synthetic-journeys` → `clientUa`
   `cron-job.org`, GET, 200). That was hourly (`0 * * * *`, 1h grace) until 2026-10-14, when the owner cut it to every 3 hours,
   05:00-20:00 Cairo (6 runs/day) to stop paying for 24 smoke tests a day. The 2h grace tolerates one
   late fire inside a 3h gap; the old hourly grace deliberately tolerated exactly one
   missed hour — that has already happened once (2026-08-17 18:00 UTC) without anything being wrong,
   and a check that pages on a single blip is a check people learn to ignore.

   `synthetic-journeys.yml` has NO `schedule:` block any more (removed 2026-10-14; it used to fire
   ~3 extra runs a day at effectively random minutes, which is why the suite ran ~27 times a day and
   not the 6 its comments claimed). `tests/scheduled-alarms-never-withhold.test.ts` fails if one comes
   back. The `workflow_dispatch` events are this job's only clock.

   The two `*-rotate-sheet-token` rows are **not copied from anywhere either** — those jobs did not
   exist until 2026-08-23, when they were created to fix the second half of the same problem: those
   routes were not merely unwatched, *nothing was calling them at all*, and the live feed tokens
   they exist to rotate had sat unchanged since 2026-08-05. cron-job.org jobs `8313169` (Fridays
   03:23) and `8313171` (Fridays 03:43) are now the schedule, and the rows above simply restate
   them. A third joined them on 2026-09-05 — `8387636`, Fridays 04:03 — rotating the CV-lifecycle
   sheet's feed token, the one that reads candidates' names and phone numbers.
   Weekly, on the Egyptian weekend, twenty minutes apart so two 30 s requests can never
   overlap: rotation is cheap and safely repeatable, but each run is one more chance to disturb a
   live sheet the owner reads, so it happens when nobody is reading it. **That cadence is a
   judgement call, not a requirement** — moving either job to daily is harmless, and needs only the
   row above and the route's own comment changed to match.

   `phoenix-brevo-keepalive` is the odd one out: **monthly**, because the thing it defends against
   is a 90-day clock, not a daily one. Brevo expires an API key after 90 consecutive days of
   inactivity regardless of its stated expiry date, and `BREVO_API_KEY` is the email **failover** —
   by design it is never exercised while Resend is healthy, so left alone it dies quietly and the
   backup is gone at the exact moment it is needed. Monthly gives three pings per expiry window, so
   two consecutive failures still leave a month of margin. The route does a single authenticated
   `GET /v3/account` — no email, no send credit — and **throws** on a 401, so a revoked key pings
   fail immediately rather than waiting for a missing ping. The 12h grace only has to cover a
   deploy window.

   ⚠️ **The cron-job.org account, not this table, is the schedule.** Every expression here was
   verified against it on 2026-08-23, but nobody can see or change that account from this
   repository, so the table can drift again silently — and it has: these rows originally came from
   `scripts/setup-gcp-cron.sh`, which stopped being the source of truth when GCP died, and two of
   them were still describing jobs the in-process poller had taken over. Re-read the account before
   tuning a grace period, or the switch will alert on a job that is running perfectly well.

   **`phoenix-db-health-snapshot` had no row here until 2026-08-24, on purpose. Read why it now
   does before removing it again.** The route opted out because a missed snapshot is a gap in a
   graph, not an incident, and paging on it would teach the owner to ignore the pager. That
   answered *severity* and ignored *visibility*: opting out did not make the job alert quietly, it
   made a stopped job indistinguishable from a running one. On 2026-08-24 a half-finished
   `CRON_SECRET` rotation left six of the twelve enabled cron-job.org jobs presenting a superseded
   token; every one 401’d before reaching any ping, so they went silent rather than red, and the
   only reason it was caught is that the hourly synthetic-journeys check blew its grace window. On
   a 6-hourly clock with no check at all, this job would have stayed dark indefinitely and taken
   the slow-query history with it. Severity is now carried by the 2h grace, not by the silence.

   Note also that cron-job.org caps request timeout at 30 s, so a slow route logs `Failed
   (timeout)` there while the server finishes the work and pings Healthchecks successfully. The
   two systems will disagree, and Healthchecks is the one telling the truth about whether the work
   completed.

**Two `/api/cron/*` routes are NOT watched, and only one of them is deliberate.** A
dead-man's-switch check is a statement that a job is *expected* at a known cadence; auto-provisioning
defaults to a 1-day period with a 1-hour grace, so pointing one at a route nobody schedules produces
a permanently red check — which is worse than no check, because it teaches whoever reads the
dashboard that red is the normal colour. Checked against the live cron-job.org account 2026-08-23:

| Route | State |
|---|---|
| `/api/cron/marketing-assignment-backfill` | **Unwired on purpose, and its work is already watched elsewhere.** `backfillMissingMarketingAssignmentEmails()` runs as a sub-job of the daily notification run (PR #2211), so it is already covered by `phoenix-notify-daily`. This route exists only so the same sweep can be driven by hand in production without firing every other daily notification alongside it. Leave it alone. |

`/api/cron/reconciliation-check` left this table on 2026-08-30, and what had to happen first is the
part worth keeping. It had been wired to `phoenix-reconciliation-check` and called by nothing, so
its slug read as a watch that did not exist. Scheduling it was not, however, a matter of creating
the job: run against production as it stood, the harness reported two breaches, and one of them —
an active login carrying no `HR_ID` — was `admin-HR`, the break-glass Super Admin that has no
`employees` row **by standing rule** and must never be given one. Arming it in that state would
have paged a human every night about a condition ruled permanent, which is the fastest way to
manufacture a dashboard nobody reads. So the allowance landed first
(`src/lib/reconciliation/logins-without-employee-row.ts`, pinned by
`tests/reconciliation-harness.test.ts`) and the job was created **held** — `cronjob-sync.mjs
--hold`, disabled, firing nothing — so that its id could be written into the table above in the
same pull request that made it safe to run. The plain `--apply` afterwards is the arming step.
**The generalisation: a check is not ready to be scheduled the day it is written, but the day its
expected exceptions are expressed in code.** Until then, scheduling it is worse than leaving it off.

`/api/cron/brevo-keepalive` was in this table for a few hours on 2026-08-23 and left it the same way
the rotations did: it was wired to `phoenix-brevo-keepalive` and called by **nothing at all**, so
its check had never even been created — auto-provisioning needs a first ping, and a job that never
runs produces silence rather than red. That was not cosmetic. The route exists to reset Brevo's
90-day inactivity expiry on the email **failover** key, and an unused backup key that nobody pings
is exactly the key that is dead on the day the primary fails. It now runs monthly (cron-job.org job
`8313297`), which is three pings per expiry window.

The two `*-rotate-sheet-token` routes were in this table until 2026-08-23, and how they left it is
the lesson worth keeping. The evidence that they had no schedule was entirely indirect: both webhook
variable pairs were set on Railway, each report had exactly one live `feed` share link (so none of
the no-op branches applied), and both sheets were demonstrably alive —
`direct_order_report_share_links` showed 25,156 reads with the newest at 2026-08-23 09:19 Cairo, the
marketing equivalent 24,820 with the newest at 09:18. A rotation under those conditions succeeds and
leaves a trail. Yet both live tokens were minted **2026-08-05 and had never rotated**, and the only
two `system:rotation` audit rows are from that same day. Nothing was calling either route, and the
code written to rotate them looked perfectly healthy for eighteen days. They are wired now because
the **schedule** was created, not because the code changed. Before wiring any route here, prove
something calls it — and if nothing does, that is the bug, not the missing check.

**What it does NOT replace:** the Confidence Gate (holds a suspicious send before it goes out),
the held-notification alert (tells you when the gate held something), or fix #3's truthful
`cron_run_summary` logging (tells you which of the daily job's 22 sub-jobs failed). This only
answers one question — "did the job run at all?" — for the case none of those can cover: total
silence.

### p95 latency: obsolete

There used to be a log-based metric (`phoenix_hr_production_request_latencies`, applied via a script
now deleted) that excluded deploy-time smoke-test traffic from the p95 that paged the owner. It
existed because the since-deleted Cloud Run deploy workflow smoke-tested each new revision through a no-traffic
`sha-<8hex>` tag URL, and those cold-start hits polluted the raw Cloud Run latency metric.

**Both halves of that are gone**: there is no no-traffic tag deploy on Railway, and the alert it
protected is dead with GCP Monitoring. `scripts/scope-p95-latency-alert-to-production-revision.py`
was deleted on 2026-09-08 — it had been kept as a dead file, and Semgrep flagged two findings in it,
which is a poor reason to carry code that authenticates to a billing-closed project. Recover it from
git history if the reasoning is ever wanted; the account above is the part worth keeping.

## The System Audit sweep and its one daily message

`/api/cron/system-audit-sweep` (`src/lib/system-audit/sweep.ts`) runs at **04:57 Cairo**, seventeen
minutes after the 04:40 integrity checks, and writes into the System Audit ledger that
`/admin/system-audit` reads. It runs the detectors **one at a time** — errors people were shown,
iReports360 sync runs, failed and stranded jobs, record linkage, visits not carried through — then
the verifier, which alone sets FIXED — VERIFIED and reopens a fix that recurs.

- **It spares the database it audits.** A lease stops two sweeps overlapping; a database restart in
  the last 18 hours (read from `database_restarts`, never noted — noting it would swallow the restart
  alarm) makes the detectors sit the night out with their watermarks unmoved; a detector failing with
  a timeout, a cancelled statement, a dropped connection or a gateway 5xx stops the sweep and records
  every detector after it as aborted, not tried. 240 s in all, 90 s per detector.
- **One message a day, and only when something changed.** After the sweep, one in-app and Telegram
  notice (`system_audit_daily`, audience `weekly_system_health_digest`, never email or push) lists
  what is new, newly shared or reopened — counts by reason, ten issues by name, "and K more on the
  page". Nothing new sends nothing. The reconciliation check's own breach message was retired on
  2026-10-23; its breaches ride this one.
- **The ledger's starting point is one historical run.** `scripts/system-audit-historical.ts` runs
  every detector once over a past window (default the last 90 days, the error table's retention). It
  prints the Supabase host before anything else and refuses 09:00–17:00 Cairo and any flag it does not
  know. Without `--apply` it writes nothing to the database: three files (`MASTER_ERROR_AUDIT.csv`,
  `excluded-noise.csv`, `coverage.json`) land under `xlsx/system-audit-historical/`, with the errors
  read from a CSV snapshot given as `--app-errors`. With `--apply` it writes the ledger, applies the
  reviewed triage seed (`src/lib/system-audit/triage-seed.ts`, empty until a person has checked each
  entry against evidence), marks everything already found as told so the first daily message carries
  only what is new, and sets the watermarks the nightly sweep carries on from. The verifier is not
  part of it — a past window has no "after the fix" to measure.
- **In-house only.** No Healthchecks slot is left, so the heartbeat register is its only watcher; a
  red there means last night's findings were neither collected nor told.

## Synthetic journeys

`src/lib/synthetic-journeys/` is a Playwright smoke suite (`pnpm run synthetic:test`) that walks key
routes and records pass/fail to `synthetic_journey_runs`. It is **not yet scheduled** — to use it as
active monitoring it needs (a) a scheduled runner (a GitHub Actions cron is now the obvious host,
since Cloud Scheduler is dead) and (b) safe test credentials. Environment classification treats
`phoenix-hr.satopharma.com` as production.

Given that the alert layer is dead, scheduling this suite is the cheapest route back to an
automated "is production actually working?" signal — it runs on GitHub's infrastructure, outside
Railway, which satisfies the outside-the-platform requirement.

## Railway runtime signals

`railway logs` (add `--http --json` for the access log) and the Railway dashboard's built-in
service metrics — CPU, memory, network, restarts. There are no log-based metrics and no alert
policies; these are things you look at, not things that page you.

## The System Audit page (`/admin/system-audit`, Super Admin only)

On 2026-10-23 one page replaced four: System Issues (`/admin/system-issues`), Error Monitor
(`/admin/error-monitor`), Monitoring (`/admin/monitoring`) and Data Health
(`/admin/data-health`). Each old address now redirects to `/admin/system-audit`, and every alert
button that opened one of them opens it. Its tabs are Incidents (the folded `app_error_events` and
integrity findings), Integrity checks, Login security (locked accounts, forced resets, exact failed
sign-in counts, the 7-day security lens and the IP block list), Salary flags (every flag, never cut
at a row limit) and Role coverage, moved intact. A source that cannot be read says "Unavailable",
never zero. Retired with the old pages: the AI triage, the per-user attempt counts, the deploy
timeline, the weekly system health digest and the Monitoring CSV export.

Container-level failures (crash, OOM kill, cold-start failure) still never reach application code,
so they are not on the page — use `railway logs` for those, and Sentry's trace explorer for
availability and latency. The job-heartbeat sweep writes a WARNING line, not an
`app_error_events` row; a stranded job is read from `job_heartbeats`.

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
[#6301](https://github.com/it-gawish-hr/phoenix-people-workforce/pull/6301).

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


### What the employee sees during a restart — the sign-in check (26 October 2026)

While the database restarts, `resolveSessionState` cannot read the session and throws
`SessionVerificationUnavailableError` from the page render. A production build strips the message, so
until 26 Oct the browser saw only "Minified React error #441": the portal drew its crash card
("Employee portal unavailable") and the browser filed a crash row on every retry — 8 for one Medical
Representative in the 25 Oct 16:14 Cairo restart, across Employee 360 and Field CRM. Every #441 row on
Milestones and Field CRM in the two weeks before had the same shape.

The error now carries a fixed digest, `PHX_SESSION_VERIFICATION_UNAVAILABLE`
(`src/lib/auth/session-unavailable-digest.ts`). Next keeps a digest the error already has, so it is the
one part of the cause that reaches the browser. On it the route error card says "We could not confirm
your sign-in just now", tells the employee they are still signed in, and retries by itself after 3, 5,
10 and 20 seconds, then every 30 seconds for ten minutes. `reportClientError` files nothing for it: the
server row (`Session verification is temporarily unavailable.`) and the `session_verification_unavailable`
log line are the record. Any other #441 is still a crash and still reported.

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

## One live login check per burst (31 October 2026)

**The question.** The owner asked whether 673,000 Supabase requests a day was normal, and then to find and
cut what an open tab repeats. The tab's own clock, the session pulse (`src/lib/session-pulse-store.ts`), turned
out to be the smaller half.

**What was measured** — production, 31 Oct 2026, 14:51–15:00 Cairo, Railway's HTTP log for the web service
next to Supabase's API-gateway log for the same window:

| What | Count in the window |
| --- | --- |
| Supabase requests, all kinds | 4,789 |
| `phx_auth_session_bundle` (the login check) | 861, or 18% of them |
| Page requests to the app | 921: 71 real page loads, 370 prefetch renders (about 2 KB, 125 ms typical), 480 tiny prefetch requests that reach no database |
| Session pulse requests | 67, from 21 phones |

Opening a portal page makes the sidebar prefetch about fifteen pages, each down to its loading screen
(`next.config.ts`, "NEVER BUILD A WHOLE PAGE NOBODY TAPPED"). Every one of those prefetch renders runs the
portal layout, and the layout's first line is the login check. So one page opening was paying about fifteen
login checks for the same person within a second or two, and the pulse a few more.

**Cut 1 — one live read for read-only requests that arrive together.** `shareLiveBundleRead`
(`src/lib/auth/session-bundle-cache.ts`) lets a request that cannot change anything wait for the same
session's LIVE read when one is already in flight, instead of starting its own. This is not the outage copy
of 18 Oct and changes none of its rules:

- Only a live answer in flight is shared. Nothing is kept once the read settles; the next request after it
  runs a new one. A read is joined only while it is under one second old (`SESSION_BUNDLE_JOIN_MAX_AGE_MS`),
  so the oldest answer a request can receive began at most one second before it arrived.
- Only a read-only request shares: a GET or HEAD API call, or a page render that is not a server action —
  the same two tests that decide the copy. A write, the heartbeat (which refreshes the idle expiry off its
  read), the passkey routes and the change-password route always run their own read.
- Every check still runs per request — expiry, revocation, role, version, active and the lifecycle gate —
  against that request's own signed token, on its own deep copy of the rows.
- A logout or forced logout in this process ends the sharing at once: a request that arrives after it starts
  a fresh read. A rejection audit row is still written once per rejected request.

Measured on the same window, about a quarter to a third of all login checks started while the same person's
previous check was still running (247 of 902 within 120 ms, 289 within 200 ms). That is the estimate, not a
promise: it groups requests by phone and address, so the real share per session can only be the same or
smaller. Pinned by `tests/session-bundle-cache.test.ts` §13.

**Cut 2 — a heartbeat with nothing to carry waits for the bell.** Opening a page mounts the session guard,
which reports activity at once, and the notification bell a moment later. The pulse sent the guard's
heartbeat immediately with nothing in it, and the bell, arriving while that POST was in flight, sent its own
GET the moment the POST answered: two login checks, a rate-limit call and an idle refresh for one page
opening. In the window, 14 of the 67 pulse requests were that bare POST, followed 0.4–2.5 s later by the
bell's GET from the same phone. `HEARTBEAT_GATHER_MS` (3 s) now holds only a heartbeat that would travel
empty, so the bell's request becomes the heartbeat; a badge or the bell is never delayed, and the heartbeat
goes alone when the wait ends. A session's idle limit equals its absolute limit
(`sessionIdleTimeoutSecondsForRole` in `session-token.ts`), so three seconds on its keep-alive cannot end
one. Pinned by `tests/session-pulse.test.ts` §11.

**What was left alone, and why.** The prefetches stay as the owner set them on 1 and 23 Oct. The badges'
freshness was a decision, not a repeat, so it went to the owner — Cut 3 below is his answer.

**How to see that it worked after the deploy.** Count `phx_auth_session_bundle` in the API-gateway log for
one weekday hour after the deploy and compare it with the same hour before (8,915 between 13:00 and 14:00
Cairo on Saturday 31 Oct); and count `/api/auth/pulse` requests per phone in Railway's HTTP log — a bare
POST followed within three seconds by a GET from the same phone should be gone. Measured after the deploy
(31 Oct, 15:38–15:48 Cairo): 0.38 login checks per app request against 0.60 before, and 1 bare POST
followed by the bell in 105 pulse requests against 14 in 49.

### Cut 3 — the sidebar badges once a minute, and a lighter "Other Approvals" count (31 Oct 2026)

Measured on Wednesday 28 Oct (Cairo day): 689,708 Supabase requests, and about 2,743 sidebar badge reads
costing 50,000–57,000 of them, about 8%. One badge read is eleven domain reads: 35 requests for a Super
Admin, 22 for the CEO, 23 for Finance, 16–18 for a District Manager, 4 for a Medical Rep. One District
Manager's open tabs alone made 699 reads that day. The cause: the pulse asked for the badges on every 30 s
tick, and the server's per-viewer memory of them lasts 20 s, so every tick paid a full read. The owner
chose both of the following ("Both", 31 Oct).

- **Badges up to a minute old.** `BADGES_GAP_MS` (55 s) in `src/lib/session-pulse-store.ts`: a tick asks for
  the badges only when they are at least that old, like the bell's `NOTICES_GAP_MS`. Both arrive together
  when a page opens, so a quiet tab sends one request a minute instead of two. A tab shown again still
  refreshes them at once (`PULSE_RETURN_GAP_MS`), a badge mounted with nothing cached still asks, and a
  failed read leaves them due. The server's 20 s memory is unchanged. Pinned by
  `tests/session-pulse.test.ts` §6, §9 and §12.
- **A lighter "Other Approvals" count.** `countAwaitingMyActionItems` read the whole resignations dashboard
  (every column, the payroll leaver candidates, the historical leavers, a people lookup, the device
  register) and the whole contract-renewal dashboard (every active contract) to count the one or two
  requests waiting. It now reads `listVisibleResignationStatuses` and `listVisibleContractRenewalWorkflows`:
  the same scope as the dashboards, line for line, and only who is waiting in which status. The list and
  the count share the open-status rules (`isOpenResignation`, `isOpenOutstation`,
  `isActiveContractRenewal`). Pinned by `tests/badge-counts-viewer-cache.test.ts` and
  `tests/badge-poll-stays-light.test.ts`.

Measured before merging, read-only against production with the directory warm: for six viewers (Super
Admin, two District Managers, the CEO, the Finance Manager, the National Sales Manager) the old and the new
count were equal (1, 0, 0, 1, 1, 0) and equal to the inbox list; the count's requests fell from 7 to 2 and
its time from 0.74–1.37 s to 0.23–0.51 s. For seven viewers the resignation and renewal records each loader
can see were the same set (83 for the company readers, 0 for the rest).

**How to see that it worked after the deploy.** In the API-gateway log, count a Cairo weekday's
`employee_resignations` reads with `select=employee_hr_id,status,exit_status` (the new count, one per badge
read of a seat that can see others' requests) and its `payroll_resignation_candidates` reads (now only the
resignations page itself); compare the day's total with Wednesday 28 Oct's 689,708.

### Cut 4 — Phoenix CRM's people's names, shared for a minute (31 Oct 2026)

After the badges, the next-largest repeat on Wednesday 28 Oct was one `employees` read:
`select=hr_id,full_name,nickname&hr_id=in.(…)`, 17,895 requests that day, nearly every one of them from
`loadPeopleNames` (`src/lib/phoenix-crm/server/people.ts`) — recognisable by each HR id asked twice, upper
and lower case (`hrIdLookupKeys`). Every Phoenix CRM screen names the rep and the manager above him, and
each loader on the screen asked for the same names again. In the two busiest hours (10:00–12:00 Cairo)
it made 2,239 requests over 234 distinct sets of people, and 1,582 of them were the very same request
made within the minute before.

The read now goes through the shared read cache (`getOrLoadShared`, `src/lib/cache/shared-read.ts`), keyed
by the exact sorted set of people: a caller only ever receives the names it asked about, a copy is at most
a minute old, screens asking for the same people at once share one read, and a failed read throws and is
never kept. A name is display only — nothing approves, pays or picks a recipient from it. Production has
no employee stored twice under different capitalisation (checked 31 Oct), so "the first row wins" can
pick no other row than before. Pinned by `tests/shared-read-cache.test.ts` block 14.

Before relying on the door, it was checked against the same log: the brick-name read that already goes
through it repeated within a minute only 4 times in those two hours, against 1,582 here.

**How to see that it worked after the deploy.** Count a Cairo weekday's `employees` requests whose URL
carries `select=hr_id%2Cfull_name%2Cnickname&hr_id=in.` against Wednesday 28 Oct's 17,895; the share
repeated within a minute of the same request should fall from about 70% to near zero.

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
   `· **in-house only**` from its row, and re-run the sync with `--apply`. **To free a check, hand it
   over rather than delete it** (done 2 Nov 2026): pause it, rename its name and slug to the new job,
   then sync. A delete loses its history and leaves an open slot that any refused job's `?create=1`
   can take first. A rename without the pause holds a days-old last ping against the new schedule,
   which can raise a false alarm.

   | Check slug | Cron expression | Suggested grace | What actually pings it |
   |---|---|---|---|
   | `phoenix-notify-daily` | `36 6 * * *` | 1h | cron-job.org job `8200909` |
   | `phoenix-production-planning-fx` | `7 6 * * *` | 2h | cron-job.org, armed on merge by `cron-autoarm.yml` · **in-house only** |
   | `phoenix-production-planning-reorder` | `11 6 * * *` | 2h | cron-job.org, armed on merge by `cron-autoarm.yml` · **in-house only** |
   | `phoenix-marketing-field-capture-nudge` | `50 6 * * *` | 1h | cron-job.org job `8348773` |
   | `phoenix-marketing-list-check` | `37 * * * *` | 1h | cron-job.org job, armed only after the first `scripts/marketing-list-check.ts --apply` (the seeds would be skipped otherwise) |
   | `phoenix-marketing-invoice-overdue-nudge` | `5 7 * * *` | 1h | cron-job.org job `8350529` |
   | `phoenix-distributor-upload-overdue-nudge` | `20 7 * * *` | 1h | cron-job.org job `8375333` |
   | `phoenix-mapping-guard-notify` | `5,20,35,50 * * * *` | 1h | cron-job.org job `8427700` |
   | `phoenix-interview-reminders` | `3,13,23,33,43,53 * * * *` | 1h | cron-job.org job `8478976` · **in-house only** |
   | `phoenix-recruitment-requisition-autopilot` | `27 * * * *` | 2h | cron-job.org, armed on merge by `cron-autoarm.yml` · **in-house only** |
   | `phoenix-recruitment-manager-cv-reminders` | `41 * * * *` | 2h | cron-job.org, armed on merge by `cron-autoarm.yml` · **in-house only** |
   | `phoenix-recruitment-archive-rejections` | `29 3 * * *` | 2h | cron-job.org, armed on merge by `cron-autoarm.yml` · **in-house only** |
   | `phoenix-recruitment-whatsapp-reask` | `1,31 * * * *` | 1h | cron-job.org, armed on merge by `cron-autoarm.yml` |
   | `phoenix-approval-whatsapp-reminders` | `9,11,17,29,47 10 * * *` | 2h | cron-job.org, armed on merge by `cron-autoarm.yml` · **in-house only** |
   | `phoenix-marketing-pharmacy-code-sync` | `47 2 * * *` | 2h | cron-job.org, armed on merge by `cron-autoarm.yml` · **in-house only** |
   | `phoenix-code-backup-verify` | `57 10 * * *` | 2h | cron-job.org, armed on merge by `cron-autoarm.yml` · **in-house only** |
   | `phoenix-whatsapp-handset-reminder` | `37 10 * * *` | 2h | cron-job.org, armed on merge by `cron-autoarm.yml` · **in-house only** |
   | `phoenix-github-workflow-watch` | `21 * * * *` | 30m | cron-job.org, armed on merge by `cron-autoarm.yml` · **in-house only** |
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
   | `phoenix-crm-agent-crm-ids-reconcile` | `7 * * * *` | 2h | pg_cron job `crm-agent-crm-ids-reconcile`, inside the database · **in-house only** |
   | `phoenix-crm-person-by-hr-key-reconcile` | `*/15 * * * *` | 1h | pg_cron job `crm-person-by-hr-key-reconcile`, inside the database · **in-house only** |
   | `phoenix-crm-contact-truth-reconcile` | `*/15 * * * *` | 1h | pg_cron job `phoenix-crm-contact-truth-reconcile`, inside the database · **in-house only** |
   | `phoenix-crm-rep-entry-days-reconcile` | `*/5 * * * *` | 30m | pg_cron job `phoenix-crm-rep-entry-days-reconcile`, inside the database · **in-house only** |
   | `phoenix-data-retention` | `40 3 * * *` | 2h | pg_cron job `phoenix-data-retention` at 01:40 UTC (03:40 Cairo in winter, 04:40 in summer — declared at the earlier), production only · **in-house only** |
   | `phoenix-marketing-roi-refresh` | `20 * * * *` | 1h | pg_cron job `phoenix-marketing-roi-refresh`, inside the database · **in-house only** |
   | `phoenix-recovery-snapshot` | `5 * * * *` | 1h | pg_cron job `phoenix-recovery-snapshot`, inside the database · **in-house only** |
   | `phoenix-analyze-tables-without-statistics` | `20 4 * * *` | 2h | pg_cron job `phoenix-analyze-tables-without-statistics` at 02:20 UTC (04:20 Cairo in winter, 05:20 in summer — declared at the earlier), inside the database · **in-house only** |
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
   | `phoenix-marketing-list-check` | `marketing` | Re-checks every validated marketing customer against the reps' doctor lists, sending nothing. A red means the approval flags and the list-check board have stopped following the lists. |
   | `phoenix-marketing-field-capture-nudge` | `marketing silent-when-clean` | Tells each rep which of his own validated marketing customers still have no field capture behind them, in-app, Telegram and push only. A red means that backlog went unnamed. |
   | `phoenix-marketing-invoice-overdue-nudge` | `marketing silent-when-clean` | Tells the requester and finance that an approved marketing request's invoice has passed its deadline. A red means a late invoice was raised with nobody. |
   | `phoenix-distributor-upload-overdue-nudge` | `sales silent-when-clean` | Tells the Super Admin and the SFE Manager which distributor files for the month just closed are later than they were last month. A red means a late file went unreported. |
   | `phoenix-mapping-guard-notify` | `sales` | The attribution freshness clock — it refreshes the stale attribution periods four times an hour. A red means the attribution figures are drifting behind the sales data underneath them. |
   | `phoenix-recruitment-requisition-autopilot` | `recruitment in-house-only silent-when-clean` | The hourly requisition autopilot: an open requisition for every empty seat, and every requisition whose seat is filled closed as Filled. It sends nothing by design, so a red means seats stopped opening or closing on their own and Talent Acquisition is working from a stale list. |
   | `phoenix-recruitment-manager-cv-reminders` | `recruitment in-house-only silent-when-clean` | The hourly reminder to each manager holding CV folders about CVs sent to them and not yet opened, 08:00-21:59 Cairo, in-app, Telegram and push, never email. A manager with nothing unopened is told nothing, so a red means an unopened CV stopped being chased. |
   | `phoenix-recruitment-archive-rejections` | `recruitment in-house-only silent-when-clean` | Moves every rejection older than 30 days out of the Recruitment workspace's tabs into its archive — never deleted, still searchable. It tells nobody, so a red means old rejections are piling back into the tabs Talent Acquisition works from. |
   | `phoenix-recruitment-whatsapp-reask` | `recruitment silent-when-clean` | The in-window WhatsApp re-ask: while the switch on the Screening Questions screen is on, an applicant who went quiet mid-way through the questions is asked the question they stopped at, once, before WhatsApp's 24-hour window closes. It starts OFF and sends nothing while off, so a quiet run is correct; a red means quiet applicants stopped being asked again and their answers stay missing. |
   | `phoenix-marketing-pharmacy-code-sync` | `marketing in-house-only silent-when-clean` | The nightly Sales to Marketing pharmacy-code sync. Additive; a new vendor starts hidden and is named; it refuses to run if it would retire over 500 codes. A healthy night tells nobody, so this check and its detail are the only record. A red means Customer Validation is reading stale codes, or the Sales map lost rows. |
   | `phoenix-code-backup-verify` | `platform in-house-only silent-when-clean` | The nightly code backup checked from production: fails when the newest file on Drive is over 36 hours old, under 100 MB, under half the one before it, or Drive cannot be read. The job itself is `infra/code-backup/`. |
   | `phoenix-whatsapp-handset-reminder` | `recruitment in-house-only silent-when-clean` | The reminder to open WhatsApp Business on the HR handset before the 14-day limit, to the Super Admin only, in-app, Telegram and push. Under seven days with no send from the phone it says nothing, so a quiet run is correct; a red means the clock could not be read and nobody will be warned before the link drops. |
   | `phoenix-github-workflow-watch` | `platform in-house-only silent-when-clean` | Asks GitHub hourly when each scheduled check last succeeded, and alerts on its own when one is overdue. A red means the watch itself is blind: no token, a refusal, or GitHub silent for over three hours. |
   | `phoenix-interview-reminders` | `recruitment in-house-only silent-when-clean` | Reminds each person chosen to conduct an interview, the evening before and an hour before, in-app, email and Telegram. A red means an interviewer may be given no reminder at all. |
   | `phoenix-approval-whatsapp-reminders` | `hr in-house-only silent-when-clean` | The WhatsApp reminder to each approver holding something more than three days. It starts OFF behind a switch, a number and Meta's approval, and sends nothing while off, so a quiet run is correct; a red means the read failed or every send was refused. |
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
   | `phoenix-brick-move-drain` | `sales in-house-only` | Settles the net effect of brick moves three times an hour and alerts on what it could not settle. It has no external check, so only the in-house register watches it. |
   | `phoenix-reconciliation-check` | `sales silent-when-clean` | The nightly 04:40 integrity checks. They store their report and write every breach into the System Audit ledger, which the 04:57 daily message carries; they send nothing of their own. A red means last night's checks were neither stored nor reported. |
   | `phoenix-system-audit-sweep` | `platform in-house-only silent-when-clean` | The nightly 04:57 System Audit sweep: every detector in turn, the verifier, then one in-app and Telegram message, sent only when an issue is new, newly shared or reopened, so a quiet morning is correct. A red means last night's findings were not collected and nobody was told. |
   | `phoenix-crm-contact-lists` | `crm` | Rebuilds the CRM doctor and pharmacy contact lists every five minutes through hour 5. It pings directly rather than through the wrapper, because this route answers 500 without throwing. |
   | `phoenix-expense-claims-refresh` | `hr` | Rebuilds the expense-claims read mirror from the legacy outstation tables every hour. Production reads are live on that mirror, so a red means the claims people are reading go stale. |
   | `phoenix-recruitment-cv-digest` | `recruitment silent-when-clean` | Emails each hiring manager who had candidates pushed to them in the last six hours a summary of what they received and from whom. Silent when no manager received any. |
   | `phoenix-ireports360-live-poll` | `crm` | The in-process poller's own tick, every five minutes. A brief red is usually the production process restarting on a deploy, which is why its grace is 30 minutes; a sustained red means the poller is dead and CRM has stopped pulling iReports360. |
   | `phoenix-ireports360-sync` | `crm` | The rolling iReports360 visits sync, every three hours between 06:00 and 21:00, run by the in-process poller. Its cron-job.org backstop is OFF by design while the poller runs. |
   | `phoenix-reconcile-visits` | `crm` | The weekly full-window iReports360 reconciliation, Sunday 04:00, run by the in-process poller. Its cron-job.org backstop is OFF by design while the poller runs. |
   | `phoenix-crm-agent-crm-ids-reconcile` | `crm in-house-only` | The hourly pg_cron reconcile inside the database that keeps the departed-agent CRM id cache in step with the visits; nothing else refreshes it. A red means the cache has frozen, so a CRM id first used after it stopped is missing from the departed-agent exclusion that Double Visit Analytics, Field Workforce Compliance and the payroll no-activity detector read. |
   | `phoenix-crm-person-by-hr-key-reconcile` | `crm in-house-only` | The 15-minute pg_cron safety net behind the one-row-per-HR-id employee cache both CRM visit doors join to name a person; a trigger on employees does the real work. A red means a change that trigger missed would stay wrong in every CRM read that names who made a visit. |
   | `phoenix-crm-contact-truth-reconcile` | `crm in-house-only` | The 15-minute pg_cron safety net behind the Phoenix contact-truth cache all three CRM doors read for a doctor's name and speciality; a trigger on the customer table does the real work. A red means a change that trigger missed would stay wrong on every CRM screen. |
   | `phoenix-crm-rep-entry-days-reconcile` | `crm in-house-only` | The five-minute pg_cron reconcile behind the rep entry-days cache that decides whether Phoenix wins a field day. Employee and seat changes are not triggered, so this job is their only refresh; a red means those changes have stopped reaching the visit counts. |
   | `phoenix-data-retention` | `platform in-house-only` | The nightly pg_cron prune of audit log rows and raw attendance punches over 12 months and email delivery events over 6 months, the ages the owner set. Production only. A red means those three tables have stopped being trimmed and keep growing. |
   | `phoenix-marketing-roi-refresh` | `marketing in-house-only` | The hourly :20 pg_cron rebuild of the Marketing ROI fact tables the ROI dashboard reads. A run that finds another rebuild holding the lock reports skipped, which is normal; a red means the dashboard's figures have stopped moving. |
   | `phoenix-recovery-snapshot` | `platform in-house-only` | The hourly :05 pg_cron capture of the protected tables into the recovery undo log, which stands in for the point-in-time recovery production does not have. It reports a failure when any one table could not be captured. A red means the undo log has stopped being a recovery path. |
   | `phoenix-analyze-tables-without-statistics` | `platform in-house-only` | The nightly pg_cron ANALYZE of every table that holds data and has no column statistics, so the database never plans a query from its built-in guess of 350 rows. Most nights it analyzes nothing, which is correct. A red means a new or refilled table can sit with that guess until its own traffic reaches autovacuum. |
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

🔴 **READ LIVE ON 2 NOV 2026, THE GAP IS 14 JOBS, NOT ONE.** 54 jobs are declared and Healthchecks holds 40 checks, all up. Six jobs ping and are refused with a 404, which is what a refused `?create=1` answers: `phoenix-recruitment-requisition-autopilot`, `phoenix-recruitment-manager-cv-reminders`, `phoenix-recruitment-archive-rejections`, `phoenix-brick-move-drain`, `phoenix-system-audit-sweep` and, since the handover below, `phoenix-crm-fraud-scan`. Each one is marked `in-house only` above. Eight more run on `pg_cron` and never ping: the agent-CRM-ids, person-by-HR-key, contact-truth and rep-entry-days reconciles, data retention, the Marketing ROI refresh, the recovery snapshot and analyze-tables-without-statistics. So `deadmans_switch_ping_refused` with status 404 means a missing check, not a wrong address. The warning stays on purpose. The in-house sweep still watches all 54: at 12:00:03 Cairo that day it read 54 checked, 0 stranded, 0 failing.

**The same day, on his word, the fraud scan's check went to `phoenix-recruitment-whatsapp-reask`.** The count stays at 40 checks and 14 jobs without one. The re-ask's switch is still off, so for now its check proves only that the job fires, not that anyone was asked. The fraud scan pings once a week, so it adds one 404 refusal each Thursday, and the in-house sweep still watches it.

**On 3 Nov 2026 `phoenix-approval-whatsapp-reminders` joined in-house only, so 55 jobs are declared and 15 have no check.** Healthchecks still holds its 40, and this job's pings are refused the same way.

**One declared job reports from INSIDE the database (2026-10-23).** `phoenix-crm-agent-crm-ids-reconcile`
is the pg_cron job that alone keeps the departed-agent CRM id cache current; its command,
`crm_agent_crm_ids_reconcile_run()`, records success through `phx_record_job_heartbeat()` — the
SQL twin of `recordJobHeartbeat`, writing only its own outcome's timestamp — after each run. It
never calls Healthchecks, so it is in-house only by nature. 🔴 **A failing run is deliberately not
caught**: pg_cron runs the command in one transaction, so a caught failure would read `succeeded`
in `cron.job_run_details`; uncaught, it reads FAILED there and stranded here, both true. Account:
`docs/crm-agent-crm-ids-cache.md`, "Who watches the reconcile".

**And so do the other six, since the same evening (owner: "Watch all six").**
`20261023223000_pg_cron_jobs_report_heartbeats.sql` re-points every other pg_cron job at a `_run()`
wrapper of its unchanged function — the three CRM cache reconciles, `phoenix-data-retention`,
`phoenix-marketing-roi-refresh` and `phoenix-recovery-snapshot` — so all seven are declared and
judged. Three things in it are deliberate:

- **It uses `cron.alter_job`, never `cron.schedule`**, so it only changes the command of a job that
  already exists. Staging carries no `phoenix-data-retention` by the owner's decision, and
  `cron.schedule` would have created it there and started pruning. A job running an unexpected
  command is refused, not overwritten.
- **The recovery snapshot is the one wrapper that records `fail`.** `recovery.take_snapshots()`
  catches per table and returns the message in `error`, so pg_cron reads `succeeded` whatever
  happened; the wrapper reads that field instead of guessing.
- **`phoenix-data-retention` is declared `40 3 * * *`** — the winter Cairo reading of 01:40 UTC — so
  the summer run lands an hour inside its 2-hour grace. Declared at 04:40 it would read every winter
  run as an hour early and the job as stranded.

Pinned by `tests/pg-cron-heartbeats.test.ts`, which also asserts that every `cron.schedule` in any
migration names one of these seven jobs or `phoenix-analyze-tables-without-statistics` (the nightly
statistics sweep, `20261025230153`, pinned by `tests/phoenix-crm-team-starts-statistics.test.ts`) —
a new pg_cron job must be declared here too.

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

`tests/synthetic/journeys/` is a read-only Playwright smoke suite (`pnpm run synthetic:test`) that
signs in to production as a Super Admin and walks the key screens. `synthetic-journeys.yml` runs it
on GitHub's infrastructure, outside Railway, six times a day: cron-job.org's
`phoenix-run-synthetic-journeys` dispatches it every 3 hours at :17, 05:00-20:00 Cairo (the job
table above). Every run, pass or fail, is saved to `synthetic_journey_runs` /
`synthetic_journey_results` and shown on the Super Admin page `/admin/synthetic-journeys`.
Environment classification treats `phoenix-hr.satopharma.com` as production.

**The job stays green on a failed journey, on purpose** — a red suite on `main` HEAD would withhold
the deploy carrying the fix (`tests/synthetic-journeys-never-withholds.test.ts`). So the failure is
carried three ways: the dashboard row, an `::error::` annotation, and — since 2026-10-31, on the
owner's word — **a Telegram message to the owner** (`scripts/synthetic-telegram-alert.mjs`, secrets
`TELEGRAM_BOT_TOKEN` and `TELEGRAM_ALERT_CHAT_ID`). It fires once per failed run of `main` against
production — on a failed journey, or on a run that died before checking anything — names each failed
journey once in Cairo time, and goes out before the dashboard save so it never waits on the
database. A branch dispatch never pages him. To prove the alarm without breaking anything, dispatch
the workflow with `test_alert` ticked: it runs only a small `test alert` job — no login, no journeys,
no dashboard row — and sends one message headed TEST through the same bot, chat and script, the same
switch every other Telegram alarm here has. Before it existed, every run failed from 28 Oct 05:18 to
31 Oct 2026 (23 in a row, two Employee 360 journeys still asking for a heading level the 27 Oct
personnel-record layout had changed) and nobody knew for three and a half days. Pinned by
`tests/synthetic-telegram-alert.test.ts`.

The "Outstation Expenses export" journey is **always skipped, deliberately**: the export writes a
record, so it runs only with `SYNTHETIC_ALLOW_MUTATION=true`, which the workflow never sets. That is
why a fully passing run reads `warning` (amber) on the dashboard rather than `healthy`.

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
at a row limit), Role coverage, moved intact, and — since 1 Nov 2026 — Slowest pages: the week's page
timings from `page_timings` (one row per hour, page shape, kind, device class and metric; no person),
slowest first by the 90th percentile of the page looking ready, hard loads and taps in two tables, with
the low-end devices' figure beside the overall one. A source that cannot be read says "Unavailable",
never zero. Retired with the old pages: the AI triage, the per-user attempt counts, the deploy
timeline, the weekly system health digest and the Monitoring CSV export.

Container-level failures (crash, OOM kill, cold-start failure) still never reach application code,
so they are not on the page — use `railway logs` for those, and Sentry's trace explorer for
availability and latency. The job-heartbeat sweep writes a WARNING line, not an
`app_error_events` row; a stranded job is read from `job_heartbeats`.

## The crash screenshot — what the employee saw

Owner, 23 October 2026: *"the most important thing, I need a screenshot of the error appear to the
employee."* Asked what the capture may contain on a payslip page, he chose **capture everything,
mask nothing**. Both decisions are recorded as rules in `.claude/rules/platform.md`.

**A web page cannot photograph itself.** There is no browser API that hands a page its own pixels,
and the one that comes close (`getDisplayMedia`) puts a permission prompt in front of somebody whose
screen has just broken. So `src/lib/error-monitor/capture-screenshot.ts` RASTERISES the live DOM
through `html-to-image` and encodes it as WebP. Three things it cannot reproduce, by construction,
and none of them is a defect to chase: cross-origin images and fonts the page never got permission
to read back, the inside of an `<iframe>`, and a `<canvas>` another origin's pixels have tainted.

**It fires after the paint, not at the throw.** Two animation frames plus a short settle, so the
picture is the error boundary's fallback card — the screen the employee is actually sitting in front
of — rather than the half-torn tree behind it. At most two captures per page load, because one
orphaned streamed tree fires 16–23 errors at once and they are all one picture.

### Why the image has its own door

`/api/errors/client` is capped at 64 KB with every stored field truncated (the 23 Oct 2026 audit,
P5-03). **Those caps are not widened to carry a picture.** The image travels on
`/api/errors/client/screenshot` instead, under bounds of its own:

| Bound | Value |
| --- | --- |
| Body | 2 MB, checked on the `Content-Length` and again on the read |
| Rate | 10 a minute per address — a third of the text report's 30 |
| Format | WebP, sniffed from the container's own `RIFF`/`WEBP` magic bytes, never from the caller's header |
| Admission | A two-minute HMAC ticket (`screenshot-ticket.ts`), minted only in the response to a report that really wrote a row, naming that one row |
| Object | `YYYY/MM/DD/<app_error_events id>.webp`, partitioned by Cairo day, upserted so a retry replaces |

That door reads no cookie and resolves no identity — the employee whose page broke is often on the
login screen — so it is registered with `tokenApi` (`authMode: "public-token"`), **never**
`sessionApi`, whose coverage gate rightly demands a `resolveAccessContext` this route must not have.
The ticket is domain-separated from the session and share-card signers, so it cannot be replayed as
one of theirs, and with no `PHOENIX_AUTH_SECRET` nothing mints and nothing verifies: it fails closed.

### Reading one back

Nothing is masked, so the `error-screenshots` bucket is **private and stays private** (2 MB,
`image/webp` only; migration `20261023180801`). The System Audit drawer's "What the employee saw"
section asks `/api/admin/system-audit/screenshot/<eventId>` for a **five-minute signed URL**, minted
per view against the viewer's own Super Admin session and only when someone clicks to look. The
object path is read from the row rather than taken from the caller, so a URL can only ever be issued
for an object `app_error_events` really points at. No durable URL is rendered into the page. Minting
the URL is the view, so it writes a `system_audit_screenshot_view` audit row first — who looked, at
whose screen, and when it was taken (`docs/system-audit.md`, "What the person saw").

An occurrence shows the captures of its own `source_refs` (the `app_error_events` ids `collapse.ts`
collected, capped at 50), newest first, and the read is best-effort: a drawer that cannot show a
picture must still show the error.

Pinned by `tests/error-screenshot-intake.test.ts`.

## The audit trail stopped losing rows — the outbox (2026-10-23)

`writeAuditLog` and `writeRequiredAuditLog` both go through `insertAuditLog`, which opens its client
on `OUTBOX_FIRST_ATTEMPT_TIMEOUT_MS` — 3 seconds when this was written, **8 seconds since 26 Oct
2026** (see "The first attempt's budget is measured" below). A bounded first attempt is deliberate:
the audit trail must not sit in front of somebody's request. What was not deliberate is what
happened when it expired — a log line, and nothing else. **109 `audit_persistence_failed` errors on production in 21 days, 40 of them on 22
Oct alone.**

**The rows were genuinely lost, not merely slow.** Read off `ozucdzovmcqvepbozvqf`: the notification
logged at 16:19 Cairo on 23 Oct, entity `f67a82b2-fe70-4024-80b4-ca7e3f9a60dc`, has no `audit_logs`
row at all, while other notifications written in the same minute do. The cause in every sampled
case is `AbortError: Supabase request timed out`.

Owner's instruction that afternoon, choosing between the timeout fix and the re-entrancy fix:
*"Both, plus never lose a row."*

### How a row is kept now

1. **The fast attempt** — `OUTBOX_FIRST_ATTEMPT_TIMEOUT_MS`, on the request path (3s originally, 8s
   since 26 Oct 2026).
2. **One retry at 10 seconds**, which only ever runs after the fast attempt has already failed
   *inside* its budget. An attempt that spent the whole budget skips straight to step 3.
3. **Anything that fails both is parked in `audit_log_outbox`** (migration `20261023190001`) with
   the whole `AuditLogInput` as `payload`, and retried on a doubling back-off — 1, 2, 4, 8, 16, 32
   minutes, then hourly for ever. Nothing is ever abandoned: a row that cannot be written today is
   still the only record that something happened.

🔴 **A TIMED-OUT INSERT MAY STILL HAVE COMMITTED.** The abort is the *client* giving up, not Postgres
rolling back. So both the retry and the drain call `auditLogAlreadyLanded` first, which reads the row
back through `idx_audit_logs_actor_entity` (`actor_login_id, entity_type, entity_id`) narrowed on
`created_at`. Without that probe, "never lose a row" would have become "write some rows twice", and
`/admin/logs` would show one act happening two or three times. A probe that *fails* answers "no" on
purpose: a duplicate is readable and explicable, a missing row is not.

🔴 **NO NEW CRON, ON PURPOSE.** A scheduled drain would need a `scripts/cronjob-sync.mjs` entry, a
cron-job.org slot and a Healthchecks slot, and the project has none free. The queue is drained off
real audit traffic instead: every successful audit write fire-and-forgets a bounded drain of five
rows, throttled to once per 30 seconds per process. The system that fills the queue empties it, the
database is demonstrably answering at the moment the drain starts, it costs nothing at rest, and
there is no schedule to rot.

`writeRequiredAuditLog` **still throws** `AuditPersistenceError` after queueing. Its callers treat an
unwritten audit row as a failed act and decide for themselves what to do about it; the queue stops
the row being lost and deliberately does not quieten the alarm that says it was not written in time.

### The first attempt's budget is measured — 3s → 8s (26 October 2026)

The 3 seconds above was chosen as "short, because it runs on somebody's request". That was the right
instinct and the wrong number, and the writes it aborted were healthy ones.

**What the client's own round trip actually costs on this container.** From `process_health`'s
`timings.supabase.fetch` — the whole client round trip, not the query — on production, 26 Oct 2026:

| Minute (UTC) | Calls | p50 | p95 | max |
| --- | --- | --- | --- | --- |
| 09:31 | 2,060 | 1,396 ms | 2,988 ms | 8,061 ms |
| 09:32 | 2,266 | 1,998 ms | 3,494 ms | 5,762 ms |
| 09:33 | 2,143 | 1,760 ms | 3,512 ms | 5,680 ms |

A 3,000 ms budget sat **between that p50 and that p95**, so it was cutting off ordinary writes: 13
`supabase.fetch.timeout` in those three minutes, every `elapsedMs` reading 3,000–3,107 ms, **every
one of them a first attempt** — never the 10-second retry — and six of them inside a single
millisecond at 09:32:50.358.

🔴 **THE DATABASE WAS NEVER THE REASON.** `pg_stat_statements` on `ozucdzovmcqvepbozvqf` for the four
inserts sitting behind those aborts: `notification_deliveries` 2,754 calls at a mean of 2.449 ms
(max 21.0) and 2,616 at 0.544 ms, `audit_logs` 2,206 at 2.278 ms (max 118.8), `notification_events`
1,050 at 3.333 ms (max 20.1). **8,626 calls and nothing over 119 ms.** The whole three seconds was
transport. Pool queueing is ruled out too — `src/lib/observability/keep-alive.ts` leaves the undici
dispatcher deliberately unbounded.

**8 seconds** clears the measured p95 with better than twice the margin, covers the worst round trip
seen, and stays under both `OUTBOX_RETRY_TIMEOUT_MS` (10s) and `supabaseRequestTimeoutMs` (15s) in
`src/lib/supabase/server.ts`.

🔴 **AND THE RAISE IS CHEAPER ON THE REQUEST PATH, NOT DEARER.** A first attempt that *spent* its
whole budget — `firstAttemptSpentItsBudget(elapsedMs)`, with 250 ms of slack because the abort timer
fires late under event-loop pressure (`eventLoopDelayMs` max 920 / 811 / 1,725 ms in the same three
minutes) — is now queued **at once, with no probe and no retry on that request**. The old shape
allowed 3s + a 10s probe + a 10s retry + a 10s queue write ≈ 33s of one request for a single write;
the new shape is 8s + a 10s queue write ≈ 18s. The duplicate guard is not weakened, only moved: the
drain calls `alreadyLanded` before it lands anything. An attempt that fails *inside* its budget — a
PostgREST rejection, a gateway 5xx, a reset connection — still gets the probe and the patient retry,
which is the database-restart case this file was built for.

Pinned by `tests/audit-outbox.test.ts`, which stubs the clock to exercise the spent-budget branch and
refuses a budget below the measured p95.

### The flag that was eating everyone else's errors

The second half of the same fix. `persistErrorEvent` held a **module-wide** boolean, set for the
whole duration of one in-flight `logAppError` and cleared in a `.finally()`. It exists to stop a
loop — `logAppError` reports its own failures through `logError`, which comes straight back here —
but a module-wide flag closes the door on **every** error logged while **any** other error's insert
is in the air, not just the monitor's own.

The proof is in the numbers above: every one of those 109 failures logged the same event **twice**
(`writeAuditLog` called `logError` twice with near-identical arguments) and left **exactly one**
`app_error_events` row, 109 times out of 109. So the table's counts were a **floor**, not a count,
and the dropped line was silent in the only place anyone looks.

It is now blocked by name: `app_error_insert_failed` and `log_app_error_threw`, the only two events
`logAppError` raises about itself. That stops the recursion just as completely and drops nothing
else. The duplicate `logError` calls in `audit.ts` went with it — harmless while the flag swallowed
the second one, a duplicate **row** the moment it did not.

Pinned by `tests/audit-outbox.test.ts`, confirmed by breaking the fix twice and watching that
section's own assertion fire: restoring the module-wide flag, and moving the landing probe to after
the retry.

## What was actually failing: four database restarts (22 October 2026)

The audit outbox above was built from the symptom. The cause turned out not to be the audit
trail's own load at all.

`database_restarted` records the postmaster start time whenever it moves. On **22 October** it
moved four times:

| Cairo | Postmaster start (UTC) |
| --- | --- |
| 11:30 | 08:30:33 |
| 11:51 | 08:51:25 |
| 12:33 | 09:33:48 |
| 14:25 | 11:25:32 |

Before that, restarts were one a day (18th, 19th, 20th) and none on the 21st. Around each one sit
Cloudflare **520** and **521** responses at the edge, `AbortError: Supabase request timed out`
across `/api/auth/heartbeat`, Phoenix CRM, the portals and the session bundle, plus
`session_verification_unavailable`, a failed probation cron step, the employee-directory fallback
and WhatsApp message buffering. **The database was down, not slow.** All 40 of that day's audit
losses sit inside that window, which is 37% of the 109 in 21 days.

Production has been stable since: `pg_postmaster_start_time()` read **22 Oct 14:25 Cairo**, 27
hours' uptime and counting when this was written.

The lesson for anything written through a short client timeout: the failure mode to design for is
not a slow query, it is **the database being absent for minutes at a time**, several times in an
afternoon, with no warning and nothing to retry against until it returns.

## Protecting the notification writes (23 October 2026)

Owner's instruction once the restarts were understood: *"protect the notification writes with the
same outbox."*

So the mechanism moved to `src/lib/platform/write-outbox.ts` and the domains supply the three
things that differ — which table queues the work, how a payload is written for real, and whether it
had already landed. `src/lib/admin/audit-outbox.ts` and
`src/lib/notifications/notification-outbox.ts` are those halves.

### Why the delivery row is the dangerous one

A lost audit row is a missing record. A lost `notification_deliveries` row is **a second real email
or Telegram message to a real person**:

- `claimDelivery` writes a `pending` row before a send.
- `upsertDelivery` writes the outcome (`sent` / `failed`) afterwards — and it swallowed its own
  failure with a log line.
- The retry drain re-sends any delivery row still sitting open.

So an outage during the status write did not merely lose bookkeeping: it left the row open and
**armed a duplicate send for the next drain**. Both writes the queue carries are upserts on a
unique key (`event_key`, `idempotency_key`), so replaying one is harmless while losing one is not.

### The one write that is retried but NOT queued

`createNotificationEvent` gets the patient retry and no queue, deliberately. Its id is what the
delivery claim anchors to, so a caller that gets no id does not send. Parking it would write a
`status: 'sent'` notification row hours later asserting a send that never happened — the opposite
of what the outbox is for. The queue protects the write that records the **outcome**, where a
replay is harmless.

### Two tables, one mechanism

`audit_log_outbox` and `notification_write_outbox` are separate tables rather than one with a
`kind` column. Merging them would have meant dropping the audit queue — live in production an hour
earlier — while the serving build still wrote to it, which is a window with exactly the behaviour
these tables exist to remove.

### One predicate worth knowing about

`notificationTableMissing` is deliberately narrower than `schemaMissing` in `system.ts`, which also
returns true for **any** error text containing the table's own name — and a PostgREST error about a
table usually does. That is tolerable where it only decides whether to log. Here it decides whether
to **keep** the write, and a real outage error naming the table would otherwise be discarded as
"schema missing".

Pinned by `tests/audit-outbox.test.ts` (the mechanism, including a stub queue that proves the
landing probe stops the second write) and `tests/notification-outbox.test.ts` (the payload guards,
the predicate, and the write that must not be queued). Both sections were confirmed by breaking the
fix and watching that section's own headline assertion fire.

## The database host sampler (28 October 2026)

**What it answers.** Production's database server reset itself 14 times between 7 and 25 October.
Each was a whole-machine reset: no out-of-memory line, no slow-query warning, nothing in any log
Phoenix can read. Supabase's metrics endpoint (`/customer/v1/privileged/metrics`) is the only
place that shows the server's own memory, swap, CPU and disks — and it keeps **no history**. A
reading taken after a reset says nothing about the minutes before it. So, until now, the lead-up to
every reset was gone before anyone looked.

**What it does.** Once a minute the worker reads that endpoint and writes one `db_host` log line:

| Field | Meaning |
| --- | --- |
| `memAvailableMb` / `memTotalMb` | memory the server can still hand out, of its total (1,932 MB on the Small plan) |
| `swapUsedMb`, `swapInPagesPerMin`, `swapOutPagesPerMin` | how much is swapped out, and how hard it is swapping this minute |
| `majorFaultsPerMin` | page reads that had to wait for the disk |
| `cpuPercent`, `load`, `cpuCount` | CPU busy share over the last minute, the 1/5/15-minute load, the core count |
| `rootDiskFreeMb`, `dataDiskFreeMb` | the system disk and the database's data disk |
| `oomKills` | out-of-memory kills since the last minute |
| `postgresStartedAt`, `authStartedAt`, `postgresUp` | when the database and the sign-in service last started |
| `counterReset` | true when a counter went backwards — the server restarted between two readings |
| `stale` | true when Supabase served the same snapshot as last minute — no rate on that line |
| `intervalS` | how far apart the two snapshots behind the rates really are, by the server's own CPU clock |
| `readMs` | how long the read took |

The first line after a start has the rates as `null`, because a rate needs two readings.

**The rates run on the server's own clock, not on ours** (fixed the same night it shipped). Supabase
refreshes these figures about every 62 seconds, not on every request: on 28 October fresh snapshots
first appeared at 03:24:37, 03:25:40 and 03:26:42 Cairo. Read every 60 seconds, about one minute in 25
gets the same snapshot back. The next minute's counters then span two refreshes, and divided by our 60
seconds every rate came out about **double** — the third line after the first deploy did exactly that.
Each CPU adds one second per second across its modes, so the summed CPU seconds divided by
`cpuCount` is the true distance between two snapshots. A snapshot whose CPU seconds did not move is
the last one again: it is logged `stale: true` with no rates, and the reading before it stays the base
for the next minute. A stale line still counts toward the five-minute memory rule, because it repeats
the last real figure; at the measured refresh, five readings in a row cover at least four real snapshots.

**Reading it back:**

```
railway logs <deployment-id> -s phoenix-workforce-worker -e production -d --lines 5000 | grep db_host
```

A refused read writes `db_host_failed` with the HTTP status only; a timeout or a parse surprise
writes the same event with the error. Either costs that minute's line, never the process.

**The two alarms.** Both go to the technical-health audience (`weekly_system_health_digest` at
`/admin/notification-recipients`) by in-app, Telegram and push. **Never email**, for the same two
reasons as the database restart alarm: no feature may add an outbound email, and an alarm about the
database must not travel through an outbox that lives in that same database.

| Alarm | Fires when |
| --- | --- |
| `low_memory` | under 100 MB available for **5 readings in a row** — one bad minute is a spike, five is the server living there; a missing reading breaks the run |
| `low_root_disk` | the system disk under 500 MB free, on one reading |

Each fires **at most once per Cairo day**. The in-process rule says so, and the idempotency key
`database-host-<kind>:<day>:<hrId>` says so again, so a redeploy mid-day cannot send the same
standing fault twice. Each alarm also writes a `db_host_alarm` error line and an audit-log row.

**Where it runs.** One process only, decided by `dbHostSamplerRefusal` in
`src/lib/observability/db-host-metrics.ts`, which also says why when it does not start:

- `PHOENIX_DB_HOST_METRICS=off` (or `0`, `false`) on the service is the kill switch;
- it needs a production build **and** `APP_ENV=production`, so staging and `next dev` never sample;
- `PHOENIX_PROCESS_ROLE=web` is refused, so with the web/worker split it runs on the worker alone;
- it needs `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`.

At start-up `instrumentation.ts` logs `[db-host] sampling once a minute`, or `[db-host] not
started: <reason>`. Seeing the first on the worker and the second (`…web`) on the web service is
the post-deploy check.

**Safety.** It runs on the server only. The service-role key is read from the environment at the
moment of each call and goes in the request header alone — never stored, logged or put in a URL.
The User-Agent is named (`phoenix-db-host-sampler`), because the secret key refuses a browser agent
with a 401 (memory note `supabase-secret-key-refuses-a-browser-user-agent`). Nothing the endpoint
returns is personal, and the line keeps server figures and two start times only.

**Cost.** Measured on 28 October: one read is about 460 KB of text, sent gzip-compressed, and
answers in 0.4–1.8 s. A 10-second timeout and a no-overlap guard stop a slow minute from stacking
reads. It needs no migration, no new table and no paid resource.

**What it does not prove.** It records what the server did; it does not show that memory pressure
caused the resets. The next reset leaves its own lead-up in the log, and that is what answers it.

Pinned by `tests/db-host-metrics.test.ts`: the parser against a sample in Supabase's own format, the
rates on the CPU clock, the doubled minute and the stale repeat, a counter reset, both alarm rules and their once-a-day limit, the start-up gate, the URL and
the wiring (timeout, no overlap, named agent, no email, no static import). A live read through the
same parser on 28 October returned every field. The
five-minute rule and the strict "under 100 MB" line were each confirmed by breaking them and
watching their own assertion fire.

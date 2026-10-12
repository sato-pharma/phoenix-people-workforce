# Source-interface and release proposal

Status: review only; no service, SQL, OAuth or environment changes applied.

## Decision

Recommend a **separate, empty PostgreSQL reporting database in Europe**, plus a live,
owner-only authorization endpoint inside the trusted Phoenix source boundary.

| Choice | Benefit | Blocking cost/risk |
| --- | --- | --- |
| Restricted interfaces inside Phoenix's database | No projection transport, fresh underlying rows | Existing PUBLIC function execution and database TEMP grants cannot be denied for just one role. Passing the unchanged privilege guard would require shared permission changes. Raw SQL would also duplicate canonical closing and seat logic. Not recommended. |
| Isolated reporting database | No business tables, no source credentials, independent connections, grants and RLS; disposable projections | Requires a source publisher and live authorization bridge, separate hosting, and explicit freshness/completeness evidence. Recommended. |

The reader's effective-privilege audit is retained. Its SELECT allowlist replaces the old
identity projection with `snapshots`; identity is never stored in the reporting database.
No production PUBLIC revocation is proposed. All revocations in `install.sql` are scoped to
the named NEW database and its empty schema. The script refuses a different/nonempty database.

## Exact reporting SQL and ownership

`install.sql` defines the entire version-2 contract: no-login owner, publisher limited to
projection DML, reader limited to SELECT, no memberships, no definer functions, no sequences,
no database CREATE/TEMP or schema CREATE. Reader connection limit 2, publisher 1. FORCE RLS
requires both the pinned owner subject and transaction-local subject for every reader row.
Publisher RLS independently pins the owner. Publisher cannot change the owner/revision contract.
Reader TLS verifies the certificate; a custom CA is supported without disabling verification.
Install with an approved database administrator only in the newly provisioned isolated database.
Replace the two non-secret deployment placeholders after verifying the owner mapping; provision
role passwords outside Git. No installer is invoked by startup, Docker or CI against an external DB.

Primary keys supply the query indexes: `(subject,record_key)` for directory/vacancy/organization,
`(subject,period,record_key)` for sales, `(subject,dataset,period)` for manifests. `query-plans.json`
contains actual EXPLAIN ANALYZE/BUFFERS results from synthetic PostgreSQL as the reader with RLS.
These small-fixture plans prove query shape, not production latency. Release acceptance requires
2,000 directory/organization rows, realistic JSON widths, concurrent refresh and two readers,
with every query below 3 seconds and zero temp-file spill. Never add an index to Phoenix implicitly.

## Canonical source boundary

`source/phoenix-bindings.mjs` binds existing `getEmployeeDirectory`, `getOrganogramReport`,
`getScopedVacancyReport`, `resolvePortalClosingScope` and `loadPortalMonthlyClosing`. It is not
part of the reader image. `src/source-adapters.mts` whitelists their outputs. No sales or target
arithmetic is reconstructed: line money is the engine's company total, or grand total when no
separate direct-company total exists. Both requested month and canonical line must match exactly.
Publication proof is required before and after loading; missing/unpublished data raises unavailable.
All authorized sales lines must have the requested month; partial line coverage is not called a total.

Vacancies consume the scoped report, including occupied-seat reconciliation, replacements,
deduplication and offers handled by Phoenix. No offer/candidate fields cross the adapter.
Organization uses canonical parent edges and stable seat identities; HMAC IDs are owner scoped.
Duplicate titles are harmless. Duplicate parent aliases, missing parents and cycles fail closed,
including an ambiguous person occupying multiple seats. Such data requires a source-side seat-edge
resolution, not an MCP heuristic. Rotating the HMAC key deliberately changes all outward node IDs.

## Source proof, collection and publication (implemented on this branch, fixture-tested)

Status: the owner approved this architecture as the design direction on 2026-10-11. That approval does
not authorize provisioning or any production change, and nothing here has run against a real environment.

**Collection and publication are decoupled.** `src/publish-cycle.mts` collects and publishes each dataset
independently: workforce, vacancies, organization, and each sales month on its own. An unavailable
sales month cannot stop a valid workforce, vacancy or organization refresh. A dataset is published only
when its collector returns a sealed, proof-carrying projection; any refusal publishes nothing for that
dataset and leaves its previous snapshot untouched (the reader's 60-second bound then retires it).

**sourceProof is derived, never asserted.** There is no `complete: true` anywhere. The source host
(`src/lib/mcp-source/`, one implementation shared by the Phoenix source process and these tests) builds
a proof from two independent kinds of evidence, and `verifySourceProof` refuses with a named reason:

| Evidence | Refusal | What it catches |
| --- | --- | --- |
| Read log from `read-recorder.ts`: every PostgREST request made while the report ran, recorded beneath the loaders | `read_failed` | A failed read the loader swallowed (organogram employee master, teams, seat offers, `isClosingPublished`, stale-on-failure directory); judged by each request's LAST attempt so a retried success is fine |
| | `truncated` | An unpaged read that came back exactly at the server row cap, or short of a known total |
| | `no_reads` / `required_read_missing` | A cache answered: no read, or a dataset's required relation was never read |
| | `unwatched_read` | A loader began reading something no one watermarked: the dataset stops publishing |
| Change watermark read BEFORE and AFTER (`proposal/source-watermark.sql`) | `changed_during_read` | Any insert, delete or update to a watched source during the collection (retried once, then refused) |
| | `watermark_missing`, `invalid_time`, `no_change_stamp` | Absent sources, future stamps, no business change time |

`source-watermark.sql` is review-only and is not in `supabase/migrations/`. It exists because the schema
research found **no `updated_at`-maintaining trigger on any watched table** and the closing engine reads
through RPCs, views and rollups PostgREST cannot stamp. One STABLE function (one snapshot) returns, per
watched source, an exact row count, the app-written stamp (informational) and an md5 over every
`(primary key, xmin)` pair, so an UPDATE that touches no timestamp still changes the fingerprint.
`sourceUpdatedAt` is the newest change stamp; `sourceObservedAt` is when the sources were last verified
unchanged. A process-local change clock turns a digest change into a stamp; after a restart it reads
"now", which can only make a source look newer than it is.

**Snapshot identity survives unchanged refreshes.** `snapshotId` is a UUID derived from a SHA-256 of the
dataset, period and canonical rows (order-independent). An unchanged re-read keeps its identity while
`sourceObservedAt` advances; the publisher then updates only the manifest and does not rewrite rows. Any
changed value changes the identity and invalidates cursors. The publisher recomputes the identity from
the rows and refuses a mismatch, and refuses any projection that does not carry a proof its own
verifier produced. A walk over 2,000 organization rows (40 pages) completes at the configured 30-second
refresh and 30-calls-per-minute budget (tested); a real content change mid-walk invalidates the cursor.

**Withdrawal is immediate, and only on proof.** Each sales month first runs a narrow publication proof.
A clean read that finds no live publication row withdraws the month at once (rows and manifest removed
in one transaction). A failing publication read is "could not tell" and never withdraws.

## Live authorization bridge (implemented, route disabled by default)

`POST /api/mcp-source/authorize` (`app/api/mcp-source/authorize/route.ts`) is off unless
`PHOENIX_MCP_SOURCE_ENABLED` is exactly `true`; it requires its own bearer secret
(`PHOENIX_MCP_SOURCE_AUTHORIZATION_KEY`, 32+ characters, no development bypass and no fallback to
`CRON_SECRET`), accepts only the configured owner subject, echoes the nonce and sets `no-store`. On every
call `src/lib/mcp-source/live-authorization.ts` reads, uncached: the `app_auth_users` row linked to the
Auth user, the Auth user itself (existence, `banned_until`, `deleted_at`), the session version, the
employee lifecycle row (same `isEmploymentAccessRevoked` predicate as web sessions), the effective role
matrix straight from `role_permission_overrides` (`loadPermissionMatrixUncached`: no cache and no
last-known-good fallback) and every unreleased `user_module_locks` row. Unlike the web app, a missing
lock table or any read error is an error. A clean denial answers `identity: null`; anything that cannot
be decided answers 503 with no detail, which the reader treats as unavailable and never as "no denials".
Two touches to existing Phoenix files: `proxy.ts` lists the route in its shared-secret CSRF exemption and
`permissions.ts` gains the one uncached export; no existing behaviour changes.

`src/publisher.mts` performs an atomic rows+manifest replacement under the publisher role with
bounded data, advisory serialization and 3-second timeout. A publisher failure leaves the previous
snapshot untouched. Timestamps never advance after a failed or partial read: freshness exists only on a sealed projection. Publisher credentials
never enter the MCP process; Phoenix credentials never enter either reporting database or reader.

## Freshness and live authorization

`generatedAt` is response creation time. `sourceUpdatedAt` is the latest relevant business mutation
watermark; unchanged data can legitimately have an old value. `sourceObservedAt` is the time the
source successfully verified all underlying data, not the time a cache was downloaded. Every tool
rejects a projection observed over 60 seconds ago, future clock skew over 5 seconds, or a mutation
timestamp after observation. A refresh target of 30 seconds is proposed, subject to measured source
load; do not repeatedly recompute a costly closing without a trustworthy change watermark.
Publication withdrawal becomes unavailable within this same bounded 60-second window; authorization
revocation has no projection window. A changed snapshot invalidates a cursor and requires restart.
Each DB read uses repeatable-read/read-only so rows and manifest cannot straddle an atomic refresh.

The live endpoint is a fixed HTTPS POST, authenticated with a dedicated integration secret,
body `{subject,nonce}`, response `{nonce,identity}` or `{nonce,identity:null}`. No credentials or
identity in URLs. Responses must set `Cache-Control: no-store`; return only identitySchema fields.
The source must read account active/test status, session version, auth-user ban/deletion, employee
lifecycle, effective read denies and module locks on every call. Do not call Phoenix's cached or
fail-open lock loader. Errors must return failure, never empty permissions. A nonce prevents reuse
of a cached response. The reader validates subject and nonce and times out at 3 seconds.
Every tool checks live authorization before and after reading; OAuth issuance/refresh checks it too.

## Release proposal — status and the exact remaining requirements

Done on this branch (source only, synthetic fixtures, no environment touched): architecture approved as
design direction; decoupled per-dataset cycles; content-derived snapshot identity; owner-only live
authorization bridge; read-completeness proof and change-watermark contract; end-to-end
source → adapter → publisher → reporting database → MCP tests on isolated PostgreSQL clusters,
covering partial source failures, stale caches, publication withdrawal, acting roles, replacement
vacancies, Office/direct sales and a 2,000-row traversal.

Still required, each needing separate approval; none is started:

1. **Non-production Phoenix source rehearsal** (a staging copy that is not production data):
   a. Apply `source-watermark.sql` there; measure its cost per period against the real statement
      timeout, and run a mutation matrix proving each watched source changes the fingerprint for
      INSERT, UPDATE (no timestamp touched) and DELETE.
   b. Run `source/run-publisher.mjs` with the REAL loaders. Expect the first run to refuse with
      `unwatched_read`/`required_read_missing` for any read the registry does not yet name (the
      employee-directory lookups, `resolvePortalClosingScope`, closing RPC fan-out and the seat-offer
      chain were enumerated from source reading, not execution); complete `source-registry.ts` and the
      SQL from what it reports. Confirm the closing and directory modules bypass their caches, or that
      the proof refuses them.
   c. Compare all five outputs with the canonical reports for every acting role, replacement, direct
      and Office-allocation case on production-shaped copies, and rehearse freshness expiry, withdrawal,
      revocation, lock/ban/deletion and rollback.
   d. Install `install.sql` into a NEW empty database and re-run the 2,000-row traversal with realistic
      JSON widths, concurrent refresh and two readers; every query under 3 seconds, no temp spill.
2. **Owner OAuth and identity**: register the two OAuth clients in `IDENTITY.md` against a non-production
   identity provider; test the real provider sign-in with the owner's login; keep production OAuth off.
3. **Provisioning approvals (each separate)**: the new reporting database and its role passwords/TLS,
   the Railway reader service and its secrets, `PHOENIX_MCP_SOURCE_*` and publisher environment on the
   source host, and the production application of `source-watermark.sql`. None is requested yet.
4. **Production**: only after 1-3, a separate approval for exact production SQL on the NEW database and
   source function, the production OAuth registration, and an owner-only ChatGPT connection. Merging
   this draft and deploying the existing application are separate approvals again.

## Shutdown and rollback

Stop only the new MCP and publisher services; revoke their dedicated integration/OAuth credentials.
`rollback.sql` disables their reporting logins, terminates only those DB sessions, and removes only
the named projection tables/schema without CASCADE. It deliberately retains disabled roles until
the isolated database is retired. Never restore old OAuth state (it can undo revocation), never
restore a Phoenix business backup, and never change existing Phoenix services for this rollback.

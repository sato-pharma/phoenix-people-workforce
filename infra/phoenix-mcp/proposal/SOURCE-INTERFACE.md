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

**Remaining source dependency:** several existing reports cache or swallow IO failures. The source
host must implement `sourceProof.begin/finish/publication` with uncached, complete reads and a
consistent source change watermark. `finish` cannot simply return complete=true after a report
resolves. No production proof implementation or route is silently assumed. Synthetic tests execute
the real eligibility, vacancy occupancy and closing column policies; they do not yet execute the
entire source-host/report/IO chain or establish live parity for every acting/replacement/Office case.
Full source-host parity is a release gate and cannot be claimed from these tests.

`src/publisher.mts` performs an atomic rows+manifest replacement under the publisher role with
bounded data, advisory serialization and 3-second timeout. A publisher failure leaves the previous
snapshot untouched. Never advance timestamps after a failed/partial read. Publisher credentials
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

## Release proposal requiring approval

1. Approve the isolated reporting database architecture and the source host for a narrow live
   authorization bridge and completeness-aware publisher. This is the remaining architectural
   decision; it is not permission to weaken grants or change business rules.
2. In a separately approved non-production environment, implement that source proof/bridge, bind
   the existing report functions, compare all five outputs with canonical reports, and rehearse
   SQL installation, freshness expiry, publication withdrawal, revocation and rollback.
3. Register the two OAuth clients in `IDENTITY.md`; test the actual provider and owner's login.
4. Request separate approval for exact production SQL on the NEW database, new Railway service,
   secrets/OAuth registrations, and owner-only ChatGPT connection. Never merge this draft as part
   of those steps. The existing application's merge/deploy path is a separate approval.

## Shutdown and rollback

Stop only the new MCP and publisher services; revoke their dedicated integration/OAuth credentials.
`rollback.sql` disables their reporting logins, terminates only those DB sessions, and removes only
the named projection tables/schema without CASCADE. It deliberately retains disabled roles until
the isolated database is retired. Never restore old OAuth state (it can undo revocation), never
restore a Phoenix business backup, and never change existing Phoenix services for this rollback.

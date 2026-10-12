# Security review — release HOLD

The reader, adapters, publisher, source proof, live authorization bridge and synthetic end-to-end tests
are implemented. Nothing has been run against a real environment; no reporting service, source route
setting or OAuth configuration has been provisioned. This is not live-ready.

The current concrete proposal is [SOURCE-INTERFACE.md](proposal/SOURCE-INTERFACE.md).
Owner/provider verification and exact registrations are in [IDENTITY.md](proposal/IDENTITY.md).
Proposed isolated-database DDL and rollback are review-only files in that directory.

## Enforced boundaries

- Separate official-SDK Streamable HTTP service; exactly five read tools; no arbitrary SQL.
- Single pinned subject/login/role; live identity before and after every tool, and at token checks.
- Dedicated reader login, verified TLS, pool of two, no unbounded queue, 3-second query timeout.
- Effective-privilege audit refuses writes, ownership, memberships, application function execution,
  extra readable tables, database CREATE/TEMP and schema CREATE. No bypass for Supabase defaults.
- Reporting contract version 2. Identity is absent from projections; snapshots record source times.
- Business freshness limited to 60 seconds, transaction-consistent metadata, snapshot-bound cursors.
- Organization IDs use owner-scoped HMAC, never raw seat/employee IDs.
- Strict schemas, field whitelists, 50-row pages, 2,000-row source caps, 64 KB responses.
- PKCE S256, nonce, issuer/audience/signature/expiry checks, one-use codes, refresh replay revocation.
- No payroll, salary, bank, national ID, medical or attachment data in approved tool outputs.
- Audit events contain tool, hashed actor, outcome and duration; never returned data or tokens.
- No source administrative credentials or report IO in the reader bundle.

## Canonical semantics

Eligibility calls the existing Phoenix predicate and access filters. Vacancy adapters consume the
existing scoped vacancy report, preserving its seat reconciliation. Organizational adapters preserve
canonical edges and reject unresolved aliases/cycles. Sales require exact month and line, publication
before/after read, and the engine's sales AND target totals. No unpublished-to-zero or latest-month
fallback. Source-only bindings are not bundled into the reader.

## Remaining release gates

Implemented and fixture-tested on this branch: per-dataset decoupled publication, content-derived
snapshot identity, owner-only live authorization (uncached account, Auth status, session version,
lifecycle, effective read denial and module locks; every source error fails closed), and a derived
read-completeness proof with a before/after change watermark. See SOURCE-INTERFACE.md.

Still gated, each needing separate approval (exact list in SOURCE-INTERFACE.md):

1. A non-production Phoenix rehearsal: apply and measure `source-watermark.sql`, prove its mutation
   matrix, run the real loaders to complete the read registry, and compare all five outputs with
   canonical reports for acting, replacement, direct and Office cases.
2. Non-production OAuth/OIDC registration and the owner's real sign-in.
3. Provisioning, secrets, query-load measurement and container acceptance.
4. Only then, production SQL, production OAuth, and an owner-only ChatGPT connection. No merge is authorized.

## Residual risks

The publisher is trusted to supply truthful source timestamps and complete canonical data. The
isolated database limits its blast radius but cannot prove source truth. Reader authorization fails
closed if the live source is unavailable. Business publication withdrawal is bounded by the
60-second freshness limit; account revocation is live.

A globally rate-limited public HTTPS endpoint can still suffer denial of service. One replica and
persistent SQLite state are required; horizontal scaling needs shared revocation/rate state first.
Returned labels are untrusted data and must never be treated as instructions. The source host and
ChatGPT retain their own privacy/retention responsibilities. The owner should approve organizational
names and published business totals before connecting live data.

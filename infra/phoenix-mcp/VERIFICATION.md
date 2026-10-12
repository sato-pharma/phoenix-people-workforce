# Verification evidence

Latest focused local run: **31 tests, 31 passed, 0 failed, 0 skipped** (11 October 2026, Africa/Cairo),
plus the Phoenix suite's `tests/mcp-source.test.ts` (recorder, proof, live decision and route).
No live Phoenix environment is used by this suite. PostgreSQL clusters and signing keys are synthetic.

- All five tools call createReadStore against a newly initialized PostgreSQL database using the
  dedicated reader login and verified TLS. The exact proposed installation SQL is applied only there.
- Atomic publication uses the actual publisher implementation under its own restricted role.
- Tests cover owner/role rejection, RLS isolation, writes despite read-write settings, dangerous
  inherited privileges, stale/future metadata, changed-snapshot cursors, and live revocation.
- createIdentityProvider verifies real signed synthetic RS256 JWTs: bad signatures, issuer, audience,
  nonce, expiry, old issuance, authorized party, multi-audience ambiguity and JWKS key rotation.
- Existing tests cover PKCE, consent, replay, token expiry, refresh/account revocation, limits,
  sensitive-field stripping and official SDK HTTP interoperability.
- `tests/pipeline.test.mts` runs source → adapter → publisher → reporting database → MCP on two isolated
  PostgreSQL clusters. The source is a real database with production-shaped tables, the real watermark
  function, and a PostgREST-compatible server; the real recorder, proof verifier, registry, adapters and
  publisher run. Only Phoenix's report loaders are stand-ins that reproduce their habits (stale-on-failure
  cache, swallowed employee read, soft-failing lookup). It covers partial source failures, stale caches,
  truncation, unwatched/missing reads, mid-read changes (including an UPDATE touching no timestamp),
  publication withdrawal, acting roles, replacement vacancies, Office and direct sales, unchanged-refresh
  identity, and a 2,000-row traversal under the 30 s refresh and 30 calls/minute budget.
- Canonical fixture comparisons execute Phoenix's real eligibility, seat occupancy reconciliation
  and closing restricted-column policies. Source bindings call the real report entry points but
  the real loaders have not run against a Phoenix database; SOURCE-INTERFACE.md records that release gate.
- proposal/query-plans.json records actual synthetic EXPLAIN ANALYZE/BUFFERS as the RLS reader.
  Tiny fixture timings are not a production capacity claim.
- Cold typecheck and existing-app regression validation run in the draft PR CI, not on this laptop.
  The final response/PR body records exact head and CI run evidence.

No merge, deployment, production SQL, environment/OAuth mutation or ChatGPT connection was performed.

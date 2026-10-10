# Verification evidence

Latest focused local run: **22 tests, 22 passed, 0 failed, 0 skipped** (11 October 2026, Africa/Cairo).
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
- Canonical fixture comparisons execute Phoenix's real eligibility, seat occupancy reconciliation
  and closing restricted-column policies. Source bindings call the real report entry points but
  the complete live IO pipeline is not yet rehearsed; SOURCE-INTERFACE.md records that release gate.
- proposal/query-plans.json records actual synthetic EXPLAIN ANALYZE/BUFFERS as the RLS reader.
  Tiny fixture timings are not a production capacity claim.
- Cold typecheck and existing-app regression validation run in the draft PR CI, not on this laptop.
  The final response/PR body records exact head and CI run evidence.

No merge, deployment, production SQL, environment/OAuth mutation or ChatGPT connection was performed.

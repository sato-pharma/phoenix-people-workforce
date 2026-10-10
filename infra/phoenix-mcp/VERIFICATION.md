# Verification record

Verification uses synthetic data only. No production credentials are loaded by the test process.

Local final focused run: **18 tests, 18 passed, 0 failed, 0 skipped**. The native PostgreSQL
fixture and all protocol tests completed in approximately 39 seconds. Primary-checkout preservation
check: **22 original untracked files, 22 unchanged SHA-256 hashes, 0 missing or changed**.

- Official MCP SDK client initializes Streamable HTTP, lists exactly five read-only tools and calls
  the employee-count tool successfully. Missing bearer token returns 401, foreign Origin 403 and
  arbitrary administration paths 404.
- Browser-flow test traverses authorization, upstream identity stub, consent, code exchange and
  bearer verification over HTTP. Code reuse returns 400. PKCE, resource, exact redirect, consent
  cookie/Origin, token expiry, refresh replay, revocation and session-version change are exercised.
- Authorization tests reject another subject, login, role, disabled account, test persona, lifecycle
  revocation, live permission denial, module locks and a failed authorization source. A revocation
  occurring during a business read prevents results from being returned.
- Pagination, input schema, result projection, sensitive-column exclusion, canonical directory
  eligibility and the owner rate limit are tested with isolated fixtures.
- Real PostgreSQL fixture grants reject INSERT, UPDATE, DELETE, TRUNCATE and schema creation.
  A different session subject sees no rows. A deliberately introduced UPDATE grant triggers the
  privilege guard; READ ONLY still rejects the UPDATE. Restoring the grant restores the guard's
  success. A PUBLIC-executable application function is detected as an escalation route.
- Runtime dependency audit returned `total: 0` vulnerabilities during development.

The initial embedded PostgreSQL fixture could not revoke TEMP on its synthetic database catalog.
It was replaced with a fresh native PostgreSQL cluster, so the permission test now exercises actual
database-level grants. Native fixture clusters are stopped in finally blocks and never use an
existing database connection.

Final local count and CI verdict are recorded in the pull request. Full local Phoenix validation is
not run under repository rules; cold typechecking and existing regression checks run in CI.

Not verified: production grants/RLS, canonical live vacancy/organization/sales source parity,
real OIDC login/MFA, real ChatGPT installation, container deployment or Railway operation. These
are explicit release gates. A green fixture suite must not be described as a working live integration.

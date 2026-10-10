# Security review and source-contract approval proposal

## Current release decision: HOLD

The implemented MCP service can be reviewed and tested with fixtures. It cannot yet answer live
Phoenix questions. The interfaces below are a contract consumed by the driver, **not existing
production views, not implemented live projections, and not an applied migration**. This is an
explicit unfinished integration boundary. Enabling a production connection before implementing
and validating it is prohibited.

## Existing architecture and reusable services

| Area | Existing implementation | Integration decision |
| --- | --- | --- |
| Web application | Next.js/React, Railway, Supabase | Separate service; no new web routes |
| Identity | `app_auth_users`, sessions, employee lifecycle | Fresh owner mapping/session version; never accept role headers or a caller-supplied HR ID |
| RBAC | `src/lib/auth/permissions.ts` | Reuse pure matrix/context/scope functions; fresh denies and locks from restricted source |
| Employee eligibility | `src/lib/employees/employee-directory.ts` | Reuse `isActiveDirectoryEmployee`, including headcount classification |
| Vacancies | `getVacancyReport`, `getScopedVacancyReport` | Must preserve canonical seat deduplication, hierarchy safety, replacements and offer-state rules; exclude offer/candidate details |
| Organization | `getOrganogramReport`, `organogram-au-source.ts` | Must preserve acting-manager handling, parent rehoming, pseudo-node exclusion and Head Office rules |
| Sales | `loadPortalMonthlyClosing`, closing engine and publication gate | Both sales and targets must match authorized published Monthly Closing; preserve restricted-product and office exclusions |
| Existing MCP | Local mailbox stdio integration and database management client configuration | Neither is a suitable business-data boundary |

Existing loaders use broad administrative access and some cache/degraded fallbacks. They cannot
simply be imported as live MCP data loaders. A stale authorization cache is especially unacceptable.
Only pure policies are reused in this package. Do not call the employee-directory loader, the web
app's admin REST client, or arbitrary Supabase RPCs from the MCP service.

## Required restricted interface

Dedicated schema `phoenix_mcp`, owner-pinned records, audited field projections only:

| Interface | Required columns / payload |
| --- | --- |
| `contract` | Exactly one row: version integer 1, source_revision reviewed commit, owner_subject |
| `identity` | subject, payload matching identitySchema: live login, role, active state, session version, lifecycle, test-persona flag, read overrides and locks |
| `employees` | subject, unique record_key, payload matching employeeSchema; no salary or personal identifiers |
| `vacancies` | subject, unique record_key, payload matching vacancySchema from canonical open seats |
| `organization` | subject, unique record_key, payload matching organizationSchema from canonical report |
| `published_sales` | subject, period, unique record_key, payload matching salesSchema; authoritative published sales AND target |

Schema definitions live in `src/contracts.mts`; fixed queries live in `src/database.mts`. Keys must
sort consistently and uniquely. Index `(subject, record_key)` and `(subject, period, record_key)`
or prove equivalent base-table plans. These are keyset pages, not a repeatable snapshot across calls;
concurrent changes can affect pagination. Do not claim a historical frozen report from them.

The database must hard-pin the approved owner's subject in its policy/view, as well as check the
transaction-local identity. A session setting by itself is not an authentication boundary: a holder
of the database credential can change it. The fixture demonstrates that changing the setting cannot
read another subject. Views must have reviewed ownership and RLS behavior; do not assume the caller's
RLS applies through a definer view. Payload construction must name fields, never `to_jsonb(row)` or
`SELECT *` over Phoenix tables. The reader must own none of these objects.

The revision marker is a deployment compatibility check, not a cryptographic proof of correctness.
An operator must verify source definitions and grants separately. Live identity data must never be a
periodically refreshed snapshot; otherwise account revocation is delayed. Business projections must
have a defined freshness policy and fail when stale. That policy is not implemented yet because no
projection producer is implemented. MCP `asOf` currently means response time, not source freshness.

## Production obstacles requiring a concrete follow-up decision

1. **No suitable restricted login/interfaces exist.** The existing analytics role is not a ready
   login and exposes unrelated tables. The audit also found PUBLIC-executable application functions.
   PostgreSQL has no per-role DENY overriding PUBLIC. A new role alone is insufficient; this service
   correctly refuses that effective privilege set. Do not globally revoke PUBLIC grants in production
   to make the check pass: that could break Phoenix. First compare an isolated reporting database
   with a narrowly reviewed production grant redesign. Identity revocation must remain live either way.
2. **Canonical data adapters are unfinished.** Production-safe projections for vacancies, organization
   and sales require service-by-service reconciliation. A raw organizational SQL view or publication
   snapshot is not equivalent to the canonical report. Publication gates do not prove the snapshot
   includes current targets, store splits or office exclusions. No approximate sales query is shipped.
3. **Phoenix OIDC is not configured.** Repository Supabase OAuth settings were disabled during the
   audit. Hosted settings were not changed. The identity provider must return the exact UUID linked
   to the approved Phoenix account. An unrelated SSO subject cannot simply be relabeled. Current
   adapter requires same-origin discovery endpoints, S256 and `client_secret_post`; compatibility,
   MFA and prompt behavior require an approved non-production identity test.
4. **Owner binding must be verified.** No production owner UUID/login or secret is committed. Confirm
   the single real owner and exact role before assigning configuration. This release deliberately
   refuses all employee roles, even if they could read a limited web-app surface.

## Approval-gated next phase, in order

1. Approve the data-source isolation choice and an exact staging-only identity/source configuration.
   No blanket permission to mutate production is implied.
2. Implement the canonical live source adapters under the integration folder. Supply minimal grants,
   ownership, RLS and EXPLAIN evidence. Test canonical report parity using approved non-production
   fixtures, including acting roles, replacement vacancies, published/unpublished months, restricted
   products, office exclusions, targets and publication revocation.
3. Review exact proposed production SQL and OAuth registration separately. Rehearse them on a
   production-shaped isolated database. Prove no impact on existing roles/functions. Never change
   production tables or broad PUBLIC privileges as an incidental installation step.
4. Verify the role using a direct restricted login and deliberate INSERT/UPDATE/DELETE/TRUNCATE,
   schema/role escalation and definer-function attempts. Run query plans with realistic row counts.
5. Obtain separate approval for the new Railway service/configuration and production connection.
   Then execute the runbook. Approval to merge is a separate decision because main automatically ships.

## Remaining operational risks

- Public HTTPS metadata and login endpoints can be scanned. One global budget limits database load
  but permits denial of service against the single owner. Add edge controls during deployment review.
- Two connections and short query timeouts bound load; broad catalog audits occur per transaction.
  Their cost and index plans need measurement before production. No production load tests were run.
- The single SQLite volume means one replica and brief deployment downtime. Losing state signs the
  owner out. Restoring old state can resurrect revoked grants; never restore it during rollback.
- An owner access token grants the owner's approved fields for up to five minutes, subject to live
  rechecks. Protect the account and use upstream MFA. No employee sharing is supported.
- Returned business labels can contain prompt injection. MCP instructions treat results as data,
  tool inputs are bounded, and the service exposes no mutation or arbitrary network/SQL tool.
- Tool-result disclosure to ChatGPT is the intended operation. Review the owner's ChatGPT workspace
  data controls and retention before connecting any real employee names or commercial sales figures.
- Tests prove fixture boundaries, not production policies. CI checks are additional evidence, not
  permission to deploy. A final independent security review remains necessary before live enablement.

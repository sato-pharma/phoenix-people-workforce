# What a browser role can actually reach

Visibility in this app is **application-scoped, not RLS-scoped**: almost every code path uses the
service-role client and `assertPermission(ctx, resource, action)` is the real boundary. RLS is the
backstop for the one thing the application cannot control — the **`anon` key, which is public by
design** and is hardcoded in `ci.yml` on the explicit justification that it is "RLS-protected".

This page is about keeping that justification true.

## The state on production, measured 2026-09-29

| | |
| --- | --- |
| Tables in `public` | 429 |
| …that **`anon`** can SELECT | **0** |
| …that `authenticated` can SELECT | 69, every one behind RLS |
| Tables with RLS disabled | 6 — **none carries a browser grant** |
| Tables with RLS enabled and no policy (deny-all) | 140 |
| Views/matviews granted to a browser role | 11, **all `security_invoker = true`** |
| Relations granted to a browser role, total | 80 |

The owner's standing decision is that **RLS stays application-first**: the 140 deny-all tables get
no policies written for them. The work is to *prove* they are unreachable and to gate against a new
one being opened — not to write 140 policies on a live payroll system.

## 🔴 "RLS is enabled" is not the same as "a browser cannot read it"

`check-schema-shape.ts` has failed a table that is **granted while RLS is DISABLED**
(`exposed_without_rls`) since 2026-07-31, and on the numbers above that set is empty. Two shapes
leave RLS **enabled**, leave a policy in place, and leave every count in that script green while the
role reads every row:

### 1. A permissive `true` read policy

RLS on. A policy exists, so `rls_enabled_without_policy` is quiet. The policy's `USING` clause is
literally `true`, so it filters nothing.

**None is live, and the allowlist is EMPTY** (2026-10-26). The one there was,
**`public.deductions_categories`** (7 static rows of category names, read by no app code), was
allowlisted until the 2026-10-26 audit; `20261026120500` dropped its `using (true)` policy and
revoked its grants, so it is server-only and the detector fires again if the policy ever comes back.

**The allowlist is keyed `relation:role`**, so allowing a table for `authenticated` never silently
also allows it for `anon`. A `PUBLIC` policy reaches `anon` and is never covered by an
`authenticated` entry.

### 2. A granted view that is not `security_invoker`

A view runs as its **owner** by default. It therefore reads straight past the RLS of every table
beneath it, and the grant on the view becomes the only gate. A **materialized** view cannot be
`security_invoker` at all and has no RLS of its own, so a granted one is *always* a bypass.

Nine views in `public` are granted to **`anon`**, including `v_employee_portal_payslips`,
`v_employee_portal_salary_history` and `v_payroll_eligible_employees`. Probed with the live
production anon key on 2026-09-29:

```
anon GET /rest/v1/employee_linkage_health          -> 401  42501
anon GET /rest/v1/employee_linkage_health_summary  -> 401  42501
anon GET /rest/v1/source_of_sales_block_groups     -> 401  42501
anon GET /rest/v1/v_active_organogram              -> 401  42501
anon GET /rest/v1/v_employee_portal_payslips       -> 401  42501
anon GET /rest/v1/v_employee_portal_salary_history -> 401  42501
anon GET /rest/v1/v_employee_portal_sales          -> 401  42501
anon GET /rest/v1/v_hr_id_orphan_audit             -> 401  42501
anon GET /rest/v1/v_payroll_eligible_employees     -> 401  42501
anon GET /rest/v1/deductions_categories            -> 401  42501
```

Note the divergence: **the catalogue says `anon` has SELECT on those views; the wire says no.** That
is `security_invoker` sending the read back through anon's own (absent) grants on the underlying
tables.

🔴 **The grant is the loaded gun and `security_invoker` is the safety catch.** Losing it on one view
turns a payroll view into a public read, with no other change anywhere.

## The grants are gone as of 2026-09-30

They were worse than "SELECT". Read from `information_schema.role_table_grants`, **eight of the
nine granted `anon` the full set** - `DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE,
UPDATE` - including `v_employee_portal_payslips` and `v_payroll_eligible_employees`. Inert, for
the one reason above, and one dropped `security_invoker` away from not being.

All nine are revoked from `anon` in `20260929215727_phase4_schema_hygiene.sql`.
`authenticated` keeps its grants; only `anon` was touched; the portal runs server-side on the
service-role client and never used these. Re-probed with the live anon key afterwards: all nine
still **401**, and the app still serving.

The exact prior grants are recorded as replayable `GRANT` statements in that migration footer,
because a revoke is only reversible if someone wrote down what was there - and "SELECT" would
have been the wrong guess for eight of these nine.

**The check stays.** The revoke removes today's loaded gun; `granted_view_bypasses_rls` is what
stops the next one being loaded.

## Why the existing `security_invoker` checks could not catch it

`security_invoker` *is* checked in this repo — `scripts/security-rls-static.ts` and
`scripts/lib/migration-inventory.ts` both match the text `security_invoker = true`. **Both read
migration FILES.** Nothing had ever asked the live database.

That gap is not theoretical here: most of this schema arrived through `execute_sql` during live
fixes, with no file ever written — the same reason `check:sql-backups` could not see the pre-image
tables it was built for. A view created by hand, restored from a backup, or later altered with
`alter view … reset (security_invoker)` passes every one of those greps.

## The gate

`public.phx_ci_browser_reachability()` (service role only) reports, per relation in `public` that a
browser role is granted on: the grants, RLS state, policy count, `security_invoker`, and any role
holding a permissive `true` read policy. It returns only granted relations — about eighty rows — so
the allowlist stays something a human can read. **It reports; it decides nothing.**

The verdict lives in `scripts/check-schema-shape.ts`, so changing what is tolerated is a reviewable
diff:

| Code | Severity | Fires when |
| --- | --- | --- |
| `browser_readable_via_true_policy` | error | a permissive `true` read policy for anon / authenticated / PUBLIC, not in `TRUE_POLICY_ALLOWED` |
| `granted_view_bypasses_rls` | error | a granted view/matview without `security_invoker`, not in `GRANTED_VIEW_NOT_INVOKER_ALLOWED` |

Both ride `check:schema-shape` on the **existing** daily `migration-drift-check.yml` run, against
production and staging independently — **no new GitHub Actions minutes**, which matters because
Actions is the owner's largest bill. That workflow already posts to his Telegram on failure.

A target that predates the migration returns an RPC error; that is "check not deployed yet", not a
violation, and the gate stays silent — the same contract every other optional gate in that script
keeps.

### Fixing a hit, and what not to do

- **A new `true` policy** → narrow the policy, or revoke the grant. Add to `TRUE_POLICY_ALLOWED`
  only when the contents are genuinely public to that audience: a static lookup, never a person, an
  amount or a date.
- **A view that lost `security_invoker`** → add it back, or revoke the grant.
  `GRANTED_VIEW_NOT_INVOKER_ALLOWED` is deliberately **empty** and much harder to justify, because a
  non-invoker view does not merely expose its own rows — it exposes everything beneath it.
- **A granted matview** → revoke the grant. It cannot carry the option at all.

## How both detectors were proven

Neither was trusted because it was green:

- The `true`-policy detector was fired against **production** by emptying the allowlist; it named
  `deductions_categories:authenticated`. The allowlist has stayed empty since 2026-10-26, so
  that table now fires under the default list (pinned in the test below).
- The view detector was fired against a **real throwaway view** created on production —
  `create view public._invoker_selftest as select 1 as x`, granted to `anon, authenticated`,
  deliberately non-invoker. It selects a literal, so it exposed nothing. The check reported it,
  named `ANON`, and the view was dropped.
- In `tests/schema-shape-browser-reachability.test.ts`, deleting either detector fails the suite,
  and so does making the allowlist role-blind.

## Known, and not fixed here

The daily job this rides was **already red** on 2026-09-29 for unrelated reasons —
`missing_primary_key` and `snapshot_table_in_public` on four backup tables left in `public`. A new
detector landing in an already-red job is a detector less likely to be read; that cleanup is
tracked separately. This is the same failure mode as 2026-08-06, when the workflow correctly
reported a live leak for three days and nobody looked.

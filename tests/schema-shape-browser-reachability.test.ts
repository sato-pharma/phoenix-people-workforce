import assert from "node:assert/strict";

import {
  evaluateSchemaShape,
  type BrowserReachable,
  type SchemaShape,
} from "../scripts/check-schema-shape.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Two ways a browser role reads a table while RLS stays switched ON.
//
// `exposed_without_rls` — the check this repo has had since 2026-07-31 — fires only when RLS
// is DISABLED. Measured on production 2026-09-29 that set is empty and so are its neighbours:
// 429 tables, `anon` can SELECT **0** of them, and none of the 6 RLS-disabled tables carries a
// browser grant. On those numbers the locks look complete.
//
// They are not, because two shapes leave RLS enabled, leave a policy in place, and leave every
// count in that script green:
//
//   1. A PERMISSIVE `true` read policy. The policy exists, so `rls_enabled_without_policy` is
//      quiet; it filters nothing, so the role reads every row. One was live until 2026-10-26:
//      public.deductions_categories, readable by any logged-in user. It was allowlisted as a
//      static lookup; 20261026120500 removed the policy and the grant, and the allowlist is now
//      EMPTY, so the default reading below fires on it again.
//
//   2. A GRANTED VIEW THAT IS NOT `security_invoker`. It runs as its OWNER, so it reads past
//      the RLS of every table beneath it and the grant on the view is the only gate. Eleven
//      views in production `public` carry a browser grant — nine of them to ANON, including
//      `v_employee_portal_payslips` and `v_payroll_eligible_employees`. Probing all nine with
//      the live anon key on 2026-09-29 returned 401/42501, because `security_invoker` sends the
//      read back through anon's own (absent) grants underneath. **The grant is the loaded gun;
//      `security_invoker` is the safety catch.** Losing it on one view silently turns nine
//      payroll and org views into public reads.
//
// 🔴 `security_invoker` WAS already checked in this repo — and could not have caught that.
// scripts/security-rls-static.ts and scripts/lib/migration-inventory.ts match the TEXT
// `security_invoker = true` inside migration FILES. Nothing had ever asked the live database.
// A view created by hand through `execute_sql` — which is how most of this schema actually
// arrived — or one later altered with `reset (security_invoker)`, passes every one of them.
//
// Both detectors were fired against production before this test was written: the first by
// emptying the allowlist (its standing state since 2026-10-26), the second against a real throwaway view (`select 1 as x`, granted,
// non-invoker) which was then dropped.
// ─────────────────────────────────────────────────────────────────────────────

/** The real production reading, 2026-09-29: 80 granted relations, all views invoker. */
function healthyShape(): SchemaShape {
  return {
    tables_total: 429,
    tables_rls_enabled: 423,
    tables_force_rls: 0,
    policies_total: 433,
    primary_keys_total: 425,
    unique_total: 100,
    foreign_keys_total: 385,
    check_total: 50,
    indexes_total: 1606,
    triggers_total: 107,
    schema_usage: { anon: true, authenticated: true, service_role: true },
    tables_exposed_without_rls: [],
    tables_rls_disabled: [],
    tables_without_primary_key: [],
    tables_rls_enabled_without_policy: [],
    default_acl_leaks: [],
    private_schema_usage: { anon: false, authenticated: true, service_role: true },
    policies_using_private_schema: 64,
    stale_snapshot_schemas: [],
    snapshot_tables_in_public: [],
    browser_reachable: [
      // The nine anon-granted views, inert because they are all security_invoker.
      view("v_employee_portal_payslips", { anon: true, invoker: true }),
      view("v_payroll_eligible_employees", { anon: true, invoker: true }),
      view("v_employee_portal_sales", { anon: true, invoker: true }),
      // An ordinary authenticated-granted table behind a real policy.
      table("expense_claims", { auth: true, policies: 4 }),
    ],
  };
}

function view(
  relname: string,
  o: { anon?: boolean; invoker: boolean; matview?: boolean },
): BrowserReachable {
  return {
    relname,
    relkind: o.matview ? "matview" : "view",
    anon_select: o.anon ?? false,
    auth_select: true,
    rls_enabled: false,
    policy_count: 0,
    security_invoker: o.matview ? false : o.invoker,
    open_policy: null,
  };
}

function table(
  relname: string,
  o: { anon?: boolean; auth?: boolean; policies: number; openPolicy?: string },
): BrowserReachable {
  return {
    relname,
    relkind: "table",
    anon_select: o.anon ?? false,
    auth_select: o.auth ?? false,
    rls_enabled: true,
    policy_count: o.policies,
    security_invoker: null,
    open_policy: o.openPolicy ?? null,
  };
}

const codes = (s: SchemaShape) => evaluateSchemaShape(s).map((v) => v.code);
const find = (s: SchemaShape, code: string) => evaluateSchemaShape(s).find((v) => v.code === code);

export function runSchemaShapeBrowserReachabilityTests() {
  // ── production as it actually stands must be SILENT ──────────────────────
  // A detector that fires on a healthy database becomes furniture, and this one lands in a
  // daily job that pages the owner's Telegram.
  const healthy = codes(healthyShape());
  assert.ok(
    !healthy.includes("browser_readable_via_true_policy"),
    `a database with no open policy must not fire; got ${healthy.join(", ")}`,
  );
  assert.ok(
    !healthy.includes("granted_view_bypasses_rls"),
    `nine security_invoker views must not fire; got ${healthy.join(", ")}`,
  );

  // ── 1. a NEW `true` policy is an error ───────────────────────────────────
  const newOpenPolicy = healthyShape();
  newOpenPolicy.browser_reachable!.push(
    table("salary_records", { auth: true, policies: 1, openPolicy: "authenticated" }),
  );
  const openV = find(newOpenPolicy, "browser_readable_via_true_policy");
  assert.ok(openV, "a permissive `true` read policy on a new table must be an error");
  assert.equal(openV!.severity, "error");
  assert.match(openV!.message, /salary_records:authenticated/);

  // 🔴 THE ALLOWLIST IS EMPTY (audit 2026-10-26, point 12). The table it used to excuse must fire
  // again if its open policy ever comes back — with the default allowlist, no options passed.
  const deductionsBack = healthyShape();
  deductionsBack.browser_reachable!.push(
    table("deductions_categories", { auth: true, policies: 1, openPolicy: "authenticated" }),
  );
  const backV = find(deductionsBack, "browser_readable_via_true_policy");
  assert.ok(backV, "the open deductions_categories policy is no longer allowlisted and must fire");
  assert.match(backV!.message, /deductions_categories:authenticated/);

  // The allowlist's own behaviour, through an explicit list, so emptying the real one does not
  // leave the per-role keying untested.
  const allow = new Map([["static_lookup:authenticated", "test entry"]]);
  const openWith = (s: SchemaShape) =>
    evaluateSchemaShape(s, { truePolicyAllowed: allow }).find(
      (v) => v.code === "browser_readable_via_true_policy",
    );

  const allowedBeside = healthyShape();
  allowedBeside.browser_reachable!.push(
    table("static_lookup", { auth: true, policies: 1, openPolicy: "authenticated" }),
    table("salary_records", { auth: true, policies: 1, openPolicy: "authenticated" }),
  );
  const allowedV = openWith(allowedBeside);
  assert.ok(allowedV, "an entry that is NOT on the list must still fire beside one that is");
  assert.ok(
    !allowedV!.message.includes("static_lookup"),
    "an allowlisted entry must be filtered out, not merely out-counted",
  );

  const allowedAlone = healthyShape();
  allowedAlone.browser_reachable!.push(
    table("static_lookup", { auth: true, policies: 1, openPolicy: "authenticated" }),
  );
  assert.equal(openWith(allowedAlone), undefined, "an allowlisted pair on its own must not fire");

  // 🔴 Allowing a table for `authenticated` must NEVER also allow it for `anon`. The allowlist
  // is keyed per role for exactly this reason: anon is the PUBLIC key.
  const anonToo = healthyShape();
  anonToo.browser_reachable!.push(
    table("static_lookup", { auth: true, policies: 1, openPolicy: "anon,authenticated" }),
  );
  const anonV = openWith(anonToo);
  assert.ok(anonV, "the same table opening to anon must fire even though authenticated is allowed");
  assert.match(anonV!.message, /static_lookup:anon/);
  assert.match(anonV!.message, /reach ANON/, "an anon-reachable open policy must be called out as such");

  // A PUBLIC policy reaches anon, so it can never be covered by an `authenticated` entry.
  const publicPolicy = healthyShape();
  publicPolicy.browser_reachable!.push(
    table("static_lookup", { auth: true, policies: 1, openPolicy: "PUBLIC" }),
  );
  assert.ok(
    openWith(publicPolicy),
    "a PUBLIC `true` policy reaches anon and must not be satisfied by the authenticated entry",
  );

  // ── 2. a granted view that lost security_invoker is an error ─────────────
  const lostInvoker = healthyShape();
  lostInvoker.browser_reachable = lostInvoker.browser_reachable!.map((r) =>
    r.relname === "v_employee_portal_payslips" ? { ...r, security_invoker: false } : r,
  );
  const viewV = find(lostInvoker, "granted_view_bypasses_rls");
  assert.ok(viewV, "a browser-granted view without security_invoker must be an error");
  assert.equal(viewV!.severity, "error");
  assert.match(viewV!.message, /v_employee_portal_payslips/);
  assert.match(viewV!.message, /ANON/, "an anon-granted bypassing view must say so");

  // A MATERIALIZED view cannot carry security_invoker at all, so a granted one always bypasses.
  const matview = healthyShape();
  matview.browser_reachable!.push(view("mv_payroll_totals", { anon: false, invoker: false, matview: true }));
  const mvV = find(matview, "granted_view_bypasses_rls");
  assert.ok(mvV, "a granted matview is always an RLS bypass and must fire");
  assert.match(mvV!.message, /mv_payroll_totals \(matview\)/);

  // ── the not-deployed-yet contract ────────────────────────────────────────
  // This script runs against production AND staging independently. A target without the
  // migration must stay silent rather than invent a violation — the same contract every other
  // optional gate here keeps.
  const notDeployed = healthyShape();
  delete notDeployed.browser_reachable;
  const quiet = codes(notDeployed);
  assert.ok(
    !quiet.includes("browser_readable_via_true_policy") && !quiet.includes("granted_view_bypasses_rls"),
    "an undeployed target must be silent, not violated",
  );

  // An EMPTY array is different from undefined: deployed, and nothing granted. Also silent,
  // but it must not throw on the way there.
  const empty = healthyShape();
  empty.browser_reachable = [];
  assert.doesNotThrow(() => evaluateSchemaShape(empty));

  // ── negative controls ────────────────────────────────────────────────────
  // Without these, a detector that had quietly stopped looking would pass everything above.
  const invokerViewAlone = healthyShape();
  invokerViewAlone.browser_reachable = [view("v_only", { anon: true, invoker: true })];
  assert.ok(
    !codes(invokerViewAlone).includes("granted_view_bypasses_rls"),
    "the view detector must not fire on a correctly-invoker view — otherwise it is just counting grants",
  );

  const plainTable = healthyShape();
  plainTable.browser_reachable = [table("some_table", { auth: true, policies: 3 })];
  assert.ok(
    !codes(plainTable).includes("browser_readable_via_true_policy"),
    "a table behind real policies must not fire — a null open_policy is the healthy case",
  );
  assert.ok(
    !codes(plainTable).includes("granted_view_bypasses_rls"),
    "a TABLE has no security_invoker option; null must never be read as a bypass",
  );
}

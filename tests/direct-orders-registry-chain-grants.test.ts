import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { directOrderExpectedRoleChain } from "../src/lib/direct-orders/approval-flow.ts";

// ─────────────────────────────────────────────────────────────────────────────
// The direct-order approval chain and the workflow-registry row that governs it live in two
// different places — TypeScript and Postgres — and nothing used to compare them.
//
// That is exactly how the SFE outage happened. #1666 added an SFE Manager rung to the FRONT of
// every chain and updated both code-side gates, but the registry row (seeded 2026-07-18, when the
// chain still opened at District Manager) was never migrated. The coarse gate in
// service.ts -> assertDirectOrderWorkflowTransition therefore refused the SFE Manager on the rung
// that opens every request:
//
//     Forbidden: Workflow Registry does not allow SFE Manager to run direct_orders.return
//     from "pending_approval".
//
// Every direct order in production sat frozen on step 1 until 20260804093000 added the grant.
//
// This test pins the invariant that was missing: EVERY role the chain can put on a rung must be
// able to act on that rung in the registry. It reads the real migration files, so adding a rung
// role in TypeScript without a matching registry migration fails here rather than in production.
// ─────────────────────────────────────────────────────────────────────────────

const REQUESTER_ROLES = [
  "District Manager",
  "Regional Manager",
  "National Sales Manager",
  "Product Manager",
  "Group Product Manager",
] as const;

type RegistryAction = { key: string; allowedRoles: string[] };

/**
 * Rebuild the effective `direct_orders` registry actions by replaying the migrations in
 * filename order: the seed insert establishes the base lists, and each later "append a role"
 * migration adds to them. Parsing the real SQL (rather than restating the roles here) is the
 * whole point — a duplicated constant would drift the same way the registry itself did.
 */
function effectiveRegistryActions(): Map<string, string[]> {
  const migrationsDir = fileURLToPath(new URL("../supabase/migrations/", import.meta.url));
  const files = readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort();

  const actions = new Map<string, string[]>();

  for (const file of files) {
    const sql = readFileSync(`${migrationsDir}${file}`, "utf8");
    if (!sql.includes("workflow_registry_modules") || !sql.includes("direct_orders")) continue;

    // Seed shape: a literal '[ {...} ]'::jsonb array of action objects.
    for (const [, literal] of sql.matchAll(/'(\[[\s\S]*?\])'::jsonb/g)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(literal);
      } catch {
        continue; // statuses/other arrays that aren't valid standalone JSON — not our target
      }
      if (!Array.isArray(parsed)) continue;
      const rows = parsed as Array<Partial<RegistryAction>>;
      if (!rows.length || !rows.every((row) => typeof row?.key === "string" && Array.isArray(row?.allowedRoles))) {
        continue; // the statuses array has no allowedRoles — skip it
      }
      for (const row of rows) actions.set(row.key as string, [...(row.allowedRoles as string[])]);
    }

    // Patch shape: append a role to a named subset of actions
    // (see 20260804093000_fix_direct_orders_registry_sfe_rung.sql).
    const targeted = sql.match(/->>'key'\s+in\s*\(([^)]+)\)/);
    const appended = sql.match(/\|\|\s*'(\[[\s\S]*?\])'::jsonb/);
    if (targeted && appended) {
      const keys = [...targeted[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
      const roles = JSON.parse(appended[1]) as string[];
      for (const key of keys) {
        const current = actions.get(key);
        if (!current) continue;
        for (const role of roles) if (!current.includes(role)) current.push(role);
      }
    }
  }

  return actions;
}

export function runDirectOrdersRegistryChainGrantsTests() {
  const actions = effectiveRegistryActions();

  // Guard the parser itself: if this ever comes back empty the invariant below would pass
  // vacuously, which is worse than failing.
  assert.ok(actions.size >= 6, `expected the direct_orders registry actions to parse, got ${actions.size}`);
  for (const key of ["submit", "approve_intermediate", "approve_final", "reject", "return", "reverse"]) {
    assert.ok(actions.has(key), `registry action "${key}" must parse out of the migrations`);
  }

  const rolesFor = (key: string) => actions.get(key) ?? [];

  // ── The invariant: every rung role can actually act on its rung ──────────────
  for (const requester of REQUESTER_ROLES) {
    for (const pharmacyUnverified of [false, true]) {
      const chain = directOrderExpectedRoleChain(requester, { pharmacyUnverified });
      const finalRole = chain[chain.length - 1];

      chain.forEach((role, index) => {
        const isFinal = index === chain.length - 1;

        // Any approver may send a request back or refuse it, at any rung.
        assert.ok(
          rolesFor("return").includes(role),
          `${role} sits on ${requester}'s chain (pharmacyUnverified=${pharmacyUnverified}) but the registry does not allow direct_orders.return — that rung would be unactionable`,
        );
        assert.ok(
          rolesFor("reject").includes(role),
          `${role} sits on ${requester}'s chain (pharmacyUnverified=${pharmacyUnverified}) but the registry does not allow direct_orders.reject`,
        );

        if (isFinal) {
          assert.ok(
            rolesFor("approve_final").includes(role),
            `${role} closes ${requester}'s chain but the registry does not allow direct_orders.approve_final`,
          );
        } else {
          assert.ok(
            rolesFor("approve_intermediate").includes(role),
            `${role} sits on ${requester}'s chain (pharmacyUnverified=${pharmacyUnverified}) but the registry does not allow direct_orders.approve_intermediate — the chain would stall there`,
          );
        }
      });

      assert.equal(finalRole, "CEO", "every chain must still close at the CEO");
    }
  }

  // ── The SFE grant is scoped to decisions, never to finalizing or requesting ──
  // Widening it further would let SFE approve an order outright or raise its own.
  assert.ok(rolesFor("approve_intermediate").includes("SFE Manager"), "SFE must be able to advance the chain");
  assert.ok(rolesFor("return").includes("SFE Manager"), "SFE must be able to return a request for edit");
  assert.ok(rolesFor("reject").includes("SFE Manager"), "SFE must be able to reject a request");
  assert.ok(
    !rolesFor("approve_final").includes("SFE Manager"),
    "SFE must NOT finalize a direct order — the CEO rung always closes the chain",
  );
  assert.ok(
    !rolesFor("submit").includes("SFE Manager"),
    "SFE validates other people's orders and never raises its own",
  );
  assert.ok(
    !rolesFor("reverse").includes("SFE Manager"),
    "reversal is a requester-side action; SFE is not a requester",
  );
}

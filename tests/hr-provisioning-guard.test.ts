import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  provisionEmployeeAccountForRecruiting,
  type AccessActor,
  type AccessUserMutation,
} from "../src/lib/admin/access-control.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

/**
 * The seat that provisions a new hire's login.
 *
 * Creating the employee is `employees:create`, which lives in the people_records HR function and
 * reaches HR Operations alone — so HR Operations is the only role that can ever arrive at this
 * tool. HR Advisory holds employees at read+export and cannot add an employee at all.
 */
const PROVISIONING_SEAT = "HR Operations";

/**
 * Probe the role guard WITHOUT reaching the database.
 *
 * provisionEmployeeAccountForRecruiting checks, in order: (1) the actor's role, (2) that no sales
 * scope override was requested, (3) that a login id is present, and only then does it query
 * Supabase. Passing a salesScopeOverride therefore makes the call fail at step 2 the moment step 1
 * admits the actor — so the message that comes back tells us which guard fired, and no row is ever
 * read or written.
 *
 * This matters more than tidiness here: the suite runs with PRODUCTION credentials
 * (AGENTS.md §2.1), so a test that let this function reach Supabase could create a real login.
 */
async function roleGuardVerdict(role: string): Promise<"admitted" | "refused"> {
  const actor = { loginId: "TEST-ACTOR", role } as unknown as AccessActor;
  const mutation = {
    hrId: "TEST-0001",
    loginId: "TEST-0001",
    salesScopeOverride: { areas: ["TEST"] },
  } as unknown as AccessUserMutation;

  try {
    await provisionEmployeeAccountForRecruiting(mutation, actor);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("can use this tool")) return "refused";
    if (message.includes("sales scope override")) return "admitted";
    throw new Error(
      `Neither guard fired for role "${role}" — the function reached further than this test ` +
        `expects, which means it may have touched the database. Message: ${message}`,
    );
  }

  throw new Error(
    `provisionEmployeeAccountForRecruiting resolved for role "${role}" despite a sales scope ` +
      `override. The scope guard is gone, and this test can no longer probe the role guard safely.`,
  );
}

export async function runHrProvisioningGuardTests() {
  // ── The bug this file exists for ────────────────────────────────────────────
  // The guard once named "HR Advisory" while the sole caller routed "HR Operations" into it, so
  // it rejected the only role that can reach it. Every new joiner was created with no login, and
  // the failure surfaced days later when they first tried to sign in.
  assert.equal(
    await roleGuardVerdict(PROVISIONING_SEAT),
    "admitted",
    "HR Operations must pass the role guard — it is the only seat holding employees:create, so " +
      "refusing it means every hire is created with no login (the CN-0006 / PD-0007 incident)",
  );

  // ── The guard is still a guard ──────────────────────────────────────────────
  for (const role of ["HR Advisory", "Employee", "CEO", "Finance Manager", "Super Admin"]) {
    assert.equal(
      await roleGuardVerdict(role),
      "refused",
      `${role} must NOT reach this create-only tool — it deliberately bypasses ` +
        "assertSuperAdminUserAdminActor, so widening it widens an unaudited path",
    );
  }

  // ── The pair must name the same seat ────────────────────────────────────────
  // Read as source rather than behaviour: the caller's branch is unreachable without a database,
  // and it is the DISAGREEMENT between these two literals that caused the incident, not either
  // literal alone. Regex, never a byte window — a source pin sliced by offset false-fails as soon
  // as the file shifts.
  const guardSource = readFileSync(
    path.join(REPO_ROOT, "src", "lib", "admin", "access-control.ts"),
    "utf8",
  );
  const callerSource = readFileSync(
    path.join(REPO_ROOT, "src", "lib", "employees", "access-provisioning.ts"),
    "utf8",
  );

  const guardMatch = guardSource.match(
    /export async function provisionEmployeeAccountForRecruiting\([\s\S]{0,400}?actor\.role\s*!==\s*"([^"]+)"/,
  );
  assert.ok(
    guardMatch,
    "could not find the role guard inside provisionEmployeeAccountForRecruiting — if the guard " +
      "was restructured, re-pin it here rather than deleting this assertion",
  );

  const callerMatch = callerSource.match(
    /input\.actor\.role\s*===\s*"([^"]+)"\s*\)\s*\{\s*await provisionEmployeeAccountForRecruiting/,
  );
  assert.ok(
    callerMatch,
    "could not find the call site that routes a role into provisionEmployeeAccountForRecruiting " +
      "— if the routing moved, re-pin it here rather than deleting this assertion",
  );

  assert.equal(
    guardMatch![1],
    PROVISIONING_SEAT,
    `the guard admits "${guardMatch![1]}"; it must admit "${PROVISIONING_SEAT}"`,
  );
  assert.equal(
    callerMatch![1],
    guardMatch![1],
    `access-provisioning.ts routes "${callerMatch![1]}" into a guard that admits ` +
      `"${guardMatch![1]}". A guard that refuses the only role reaching it creates every new ` +
      "hire with no login, silently — that is exactly how this broke before",
  );

  // ── The sibling tool is NOT this one ────────────────────────────────────────
  // updateAccountActiveForRecruiting (the portal activation tool) really is HR Advisory's — she
  // holds account_activation. Both live in the same file and both read "...ForRecruiting", which
  // is precisely why one was renamed to match the other. Pin that they stay different.
  const siblingMatch = guardSource.match(
    /export async function updateAccountActiveForRecruiting\([\s\S]{0,400}?actor\.role\s*!==\s*"([^"]+)"/,
  );
  assert.ok(siblingMatch, "could not find the role guard inside updateAccountActiveForRecruiting");
  assert.equal(
    siblingMatch![1],
    "HR Advisory",
    "the account-activation tool belongs to HR Advisory (she holds account_activation); it must " +
      "not be renamed to match its same-named neighbour, which belongs to HR Operations",
  );
}

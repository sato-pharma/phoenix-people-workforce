import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  collectDirectReports as salesDirectReports,
  collectHierarchy as salesCollectHierarchy,
} from "../src/lib/sales/service.ts";
import {
  collectDirectReports as payrollDirectReports,
  collectHierarchy as payrollCollectHierarchy,
} from "../src/lib/payroll/service.ts";
import { normalizeHrId, normalizeHrIdForAccess } from "../src/lib/auth/permissions.ts";

/**
 * Regression coverage for the sales + payroll TEAM/HIERARCHY scope migration onto the
 * canonical seat-continuity resolver (mirrors PR #1145's outstation/expenses adoption).
 *
 * The retired naive `manager_hr_id` adjacency walk was correct only because a DB trigger
 * writes `manager_hr_id` + `pending_manager_replacement_for_hr_id` atomically. When a
 * manager seat is vacant/reassigned, the naive walk attaches reports to the WRONG seat
 * (or drops the vacant seat's reports entirely). These tests lock in the seat-continuity
 * behaviour for BOTH services' exported wrappers, and assert the wiring can't silently
 * revert to the naive join.
 */

// Only hrId / managerHrId / pendingManagerReplacementForHrId are read by the resolver,
// so a partial row is enough (matching tests/expense-access-scope.test.ts).
type Dir = Parameters<typeof salesCollectHierarchy>[0];
type ScopeFn = (directory: Dir, viewerCanonicalHrId: string) => Set<string>;

// Active org: RSM-1 → {DSM-1, DSM-2}; DSM-1 → {MR-1, MR-2}; DSM-2 → {MR-3}.
const activeOrg = {
  employees: [
    { hrId: "RSM-1", managerHrId: null, pendingManagerReplacementForHrId: null },
    { hrId: "DSM-1", managerHrId: "RSM-1", pendingManagerReplacementForHrId: null },
    { hrId: "DSM-2", managerHrId: "RSM-1", pendingManagerReplacementForHrId: null },
    { hrId: "MR-1", managerHrId: "DSM-1", pendingManagerReplacementForHrId: null },
    { hrId: "MR-2", managerHrId: "DSM-1", pendingManagerReplacementForHrId: null },
    { hrId: "MR-3", managerHrId: "DSM-2", pendingManagerReplacementForHrId: null },
  ],
} as unknown as Dir;

// After DSM-1 resigns: the resignation trigger reassigns MR-1/MR-2 UP to their DSM's
// manager (RSM-1) AND stamps each with the vacant-seat continuity marker pointing at
// the departed DSM-1 seat; DSM-1's own row is gone. Mirrors the atomic reassign+stamp.
const afterDsmResignation = {
  employees: [
    { hrId: "RSM-1", managerHrId: null, pendingManagerReplacementForHrId: null },
    { hrId: "DSM-2", managerHrId: "RSM-1", pendingManagerReplacementForHrId: null },
    { hrId: "MR-1", managerHrId: "RSM-1", pendingManagerReplacementForHrId: "DSM-1" },
    { hrId: "MR-2", managerHrId: "RSM-1", pendingManagerReplacementForHrId: "DSM-1" },
    { hrId: "MR-3", managerHrId: "DSM-2", pendingManagerReplacementForHrId: null },
  ],
} as unknown as Dir;

// Set membership uses the stored normalizeHrId form; the viewer argument is canonicalized
// the way the resolver canonicalizes edges (normalizeHrIdForAccess), matching the services.
function key(id: string) {
  return normalizeHrId(id) as string;
}
function canonical(id: string) {
  return normalizeHrIdForAccess(id) as string;
}

function assertSeatScopeBehaviour(label: string, collectDirect: ScopeFn, collectHier: ScopeFn) {
  // --- HIERARCHY: RSM sees the full downward chain, excludes self ---
  const rsmChain = collectHier(activeOrg, canonical("RSM-1"));
  assert.ok(rsmChain.has(key("DSM-1")) && rsmChain.has(key("DSM-2")), `${label}: RSM sees both DSMs`);
  assert.ok(rsmChain.has(key("MR-1")) && rsmChain.has(key("MR-2")), `${label}: RSM sees reps under DSM-1`);
  assert.ok(rsmChain.has(key("MR-3")), `${label}: RSM sees the rep under the sibling DSM`);
  assert.ok(!rsmChain.has(key("RSM-1")), `${label}: collectHierarchy excludes the root itself`);

  // --- HIERARCHY: DSM sees only its own two reps (its subtree, not siblings) ---
  const dsmChain = collectHier(activeOrg, canonical("DSM-1"));
  assert.deepEqual(
    [...dsmChain].sort(),
    [key("MR-1"), key("MR-2")].sort(),
    `${label}: DSM-1 sees exactly its two reps`,
  );

  // --- TEAM: direct reports are one level only, never the whole chain ---
  const dsmDirect = collectDirect(activeOrg, canonical("DSM-1"));
  assert.deepEqual(
    [...dsmDirect].sort(),
    [key("MR-1"), key("MR-2")].sort(),
    `${label}: DSM-1 direct reports are its two reps`,
  );
  const rsmDirect = collectDirect(activeOrg, canonical("RSM-1"));
  assert.deepEqual(
    [...rsmDirect].sort(),
    [key("DSM-1"), key("DSM-2")].sort(),
    `${label}: RSM direct reports are the two DSMs only (grandchildren excluded)`,
  );

  // --- CORRECT-ON-VACANCY: after DSM-1 resigns, the vacant DSM-1 seat STILL owns
  //     MR-1/MR-2 (via the continuity marker) even though their manager edge now
  //     points at RSM-1 and DSM-1's row is gone. A naive manager_hr_id walk would
  //     return EMPTY here — that was the bug this migration fixes. ---
  const vacantSeatTeam = collectDirect(afterDsmResignation, canonical("DSM-1"));
  assert.deepEqual(
    [...vacantSeatTeam].sort(),
    [key("MR-1"), key("MR-2")].sort(),
    `${label}: vacant DSM seat keeps its direct reports after the manager resigned`,
  );
  const vacantSeatChain = collectHier(afterDsmResignation, canonical("DSM-1"));
  assert.deepEqual(
    [...vacantSeatChain].sort(),
    [key("MR-1"), key("MR-2")].sort(),
    `${label}: vacant DSM seat keeps its downward chain after resignation`,
  );

  // --- RSM still sees the orphaned reps after the DSM resignation (climb via the
  //     reassigned manager edge), plus the untouched sibling district. ---
  const rsmAfter = collectHier(afterDsmResignation, canonical("RSM-1"));
  assert.ok(
    rsmAfter.has(key("MR-1")) && rsmAfter.has(key("MR-2")),
    `${label}: RSM still sees the orphaned reps after the DSM resigned`,
  );
  assert.ok(
    rsmAfter.has(key("DSM-2")) && rsmAfter.has(key("MR-3")),
    `${label}: RSM still sees the untouched sibling district`,
  );

  // --- No cross-branch leak: an unrelated DSM never inherits the orphaned reps. ---
  const unrelatedDirect = collectDirect(afterDsmResignation, canonical("DSM-2"));
  assert.ok(
    !unrelatedDirect.has(key("MR-1")) && !unrelatedDirect.has(key("MR-2")),
    `${label}: an unrelated DSM does not inherit the orphaned reps (TEAM)`,
  );
  const unrelatedChain = collectHier(afterDsmResignation, canonical("DSM-2"));
  assert.ok(
    !unrelatedChain.has(key("MR-1")) && !unrelatedChain.has(key("MR-2")),
    `${label}: an unrelated DSM does not inherit the orphaned reps (HIERARCHY)`,
  );

  // --- Empty viewer id yields an empty set (fail-closed). ---
  assert.equal(collectDirect(activeOrg, "").size, 0, `${label}: empty viewer id → empty TEAM set`);
  assert.equal(collectHier(activeOrg, "").size, 0, `${label}: empty viewer id → empty HIERARCHY set`);
}

export function runSalesPayrollHierarchyScopeTests() {
  // Both services carry their own copy of the seat-continuity wrappers; assert both.
  assertSeatScopeBehaviour("sales", salesDirectReports, salesCollectHierarchy);
  assertSeatScopeBehaviour("payroll", payrollDirectReports, payrollCollectHierarchy);

  // -- Wiring: sales + payroll scope resolution must route through the canonical
  //    seat-continuity helpers and must NOT reintroduce the naive manager-map join.
  const salesSource = readFileSync(new URL("../src/lib/sales/service.ts", import.meta.url), "utf8");
  assert.match(salesSource, /reportsToManagerSeat\(\{/, "sales TEAM scope must use the seat-continuity helper");
  assert.match(salesSource, /isWithinManagerHierarchy\(\{/, "sales HIERARCHY scope must use the seat-continuity helper");
  assert.doesNotMatch(salesSource, /function buildManagerMap/, "sales must retire the naive buildManagerMap join");

  const payrollSource = readFileSync(new URL("../src/lib/payroll/service.ts", import.meta.url), "utf8");
  assert.match(payrollSource, /reportsToManagerSeat\(\{/, "payroll TEAM scope must use the seat-continuity helper");
  assert.match(payrollSource, /isWithinManagerHierarchy\(\{/, "payroll HIERARCHY scope must use the seat-continuity helper");
  assert.doesNotMatch(payrollSource, /function buildManagerMap/, "payroll must retire the naive buildManagerMap join");
}

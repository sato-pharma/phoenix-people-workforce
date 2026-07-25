import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { collectDirectReports, collectHierarchy } from "../src/lib/outstation/expenses.ts";
import { normalizeHrId, normalizeHrIdForAccess } from "../src/lib/auth/permissions.ts";

// A fake org: NSM-1 → {GPM-1, OTHER-1}; GPM-1 → {PM-1}; PM-1 → {MR-1, MR-2}.
// hrId, managerHrId and pendingManagerReplacementForHrId are the only fields the
// seat-continuity resolver reads, so a partial row is enough.
const fakeDirectory = {
  employees: [
    { hrId: "NSM-1", managerHrId: null, pendingManagerReplacementForHrId: null },
    { hrId: "GPM-1", managerHrId: "NSM-1", pendingManagerReplacementForHrId: null },
    { hrId: "OTHER-1", managerHrId: "NSM-1", pendingManagerReplacementForHrId: null },
    { hrId: "PM-1", managerHrId: "GPM-1", pendingManagerReplacementForHrId: null },
    { hrId: "MR-1", managerHrId: "PM-1", pendingManagerReplacementForHrId: null },
    { hrId: "MR-2", managerHrId: "PM-1", pendingManagerReplacementForHrId: null },
  ],
} as unknown as Parameters<typeof collectHierarchy>[0];

// After PM-1 resigns: the resignation trigger reassigns her reps UP to her manager
// (GPM-1) AND stamps each with the vacant-seat continuity marker pointing at the
// departed PM-1 seat; PM-1's own row is gone. Mirrors the atomic reassign+stamp.
const afterPmResignation = {
  employees: [
    { hrId: "NSM-1", managerHrId: null, pendingManagerReplacementForHrId: null },
    { hrId: "GPM-1", managerHrId: "NSM-1", pendingManagerReplacementForHrId: null },
    { hrId: "OTHER-1", managerHrId: "NSM-1", pendingManagerReplacementForHrId: null },
    { hrId: "MR-1", managerHrId: "GPM-1", pendingManagerReplacementForHrId: "PM-1" },
    { hrId: "MR-2", managerHrId: "GPM-1", pendingManagerReplacementForHrId: "PM-1" },
  ],
} as unknown as Parameters<typeof collectHierarchy>[0];

// Set membership uses the stored normalizeHrId (canonicalHrIdKey) form.
function key(id: string) {
  return normalizeHrId(id) as string;
}

// The viewer argument is canonicalized the way the resolver canonicalizes edges
// (normalizeHrIdForAccess — symbol-stripped), matching resolveExpenseAccessFilter.
function canonical(id: string) {
  return normalizeHrIdForAccess(id) as string;
}

export async function runExpenseAccessScopeTests() {
  // --- GPM sees the full downward chain (PM + the PM's reports), excludes siblings ---
  const gpmDescendants = collectHierarchy(fakeDirectory, canonical("GPM-1"));
  assert.ok(gpmDescendants.has(key("PM-1")), "GPM must see the PM reporting to her");
  assert.ok(gpmDescendants.has(key("MR-1")), "GPM must see reps under her PM");
  assert.ok(gpmDescendants.has(key("MR-2")), "GPM must see reps under her PM");
  assert.ok(
    !gpmDescendants.has(key("OTHER-1")),
    "GPM must NOT see a sibling who reports to the same NSM",
  );
  assert.ok(
    !gpmDescendants.has(key("NSM-1")),
    "GPM must NOT see her own manager",
  );
  // collectHierarchy returns descendants only; the resolver adds self separately.
  assert.ok(!gpmDescendants.has(key("GPM-1")), "collectHierarchy excludes the root itself");

  // --- PM sees only her direct + indirect reports ---
  const pmDescendants = collectHierarchy(fakeDirectory, canonical("PM-1"));
  assert.deepEqual(
    [...pmDescendants].sort(),
    [key("MR-1"), key("MR-2")].sort(),
    "PM must see exactly her two reps",
  );

  // --- A manager with zero reports (an MR) gets an empty descendant set → self only ---
  const leafDescendants = collectHierarchy(fakeDirectory, canonical("MR-1"));
  assert.equal(leafDescendants.size, 0, "a rep with no reports sees no descendants (self only)");

  // --- TEAM (direct reports) returns exactly one level, never the whole chain ---
  const gpmDirect = collectDirectReports(fakeDirectory, canonical("GPM-1"));
  assert.deepEqual(
    [...gpmDirect].sort(),
    [key("PM-1")].sort(),
    "GPM's direct reports are exactly the PM (one level)",
  );
  assert.ok(
    !gpmDirect.has(key("MR-1")),
    "collectDirectReports must NOT include grandchildren (TEAM is one level, not the chain)",
  );
  const nsmDirect = collectDirectReports(fakeDirectory, canonical("NSM-1"));
  assert.deepEqual(
    [...nsmDirect].sort(),
    [key("GPM-1"), key("OTHER-1")].sort(),
    "NSM's direct reports are exactly its two children",
  );

  // --- Vacant-seat continuity: after PM-1 resigns, the vacant PM seat STILL owns its
  //     reassigned reports (via the continuity marker), even though PM-1's row is gone
  //     and the reps' manager edge now points at GPM-1. ---
  const vacantSeatReports = collectDirectReports(afterPmResignation, canonical("PM-1"));
  assert.deepEqual(
    [...vacantSeatReports].sort(),
    [key("MR-1"), key("MR-2")].sort(),
    "the vacant PM seat still owns its reassigned reports after the manager resigned",
  );
  const gpmAfter = collectHierarchy(afterPmResignation, canonical("GPM-1"));
  assert.ok(
    gpmAfter.has(key("MR-1")) && gpmAfter.has(key("MR-2")),
    "GPM's downward chain still includes the orphaned reps after the PM resigned",
  );

  // --- Source invariant: PM/GPM/TM are routed to HIERARCHY scope, matrix untouched -----
  const src = readFileSync("src/lib/outstation/expenses.ts", "utf8");
  assert.match(
    src,
    /PORTAL_HIERARCHY_EXPENSE_ROLES[\s\S]*"Product Manager"[\s\S]*"Group Product Manager"[\s\S]*"Training Manager"/,
    "PM/GPM/TM must be in the portal-hierarchy expense role set",
  );
  assert.match(
    src,
    /PORTAL_HIERARCHY_EXPENSE_ROLES\.has\(accessContext\.role\)\s*\?\s*"HIERARCHY"/,
    "portal-hierarchy roles must resolve to the HIERARCHY (self + descendants) scope",
  );
  assert.match(src, /export const PORTAL_HIERARCHY_EXPENSE_ROLES/, "the role set must be exported for reuse by expense-command.ts");

  // --- Head Office audit regression guard (2026-07-25): the Expense Command dashboard
  //     (a SEPARATE surface from the one above) must recognize the SAME hierarchy roles,
  //     not just resolveScope's binary company/self — otherwise a Training Manager /
  //     Marketing Manager / NSM / PM / GPM collapses to seeing only their own single row
  //     (dropping their team's rows and pins entirely, not merely misclassifying them). ---
  const expenseCommandSrc = readFileSync("src/lib/outstation/expense-command.ts", "utf8");
  assert.match(
    expenseCommandSrc,
    /import \{ listUnifiedOutstationExpenses, PORTAL_HIERARCHY_EXPENSE_ROLES \} from "@\/lib\/outstation\/expenses"/,
    "expense-command.ts must import the shared PORTAL_HIERARCHY_EXPENSE_ROLES set",
  );
  assert.match(
    expenseCommandSrc,
    /const hasWideVisibility = isAdmin \|\| PORTAL_HIERARCHY_EXPENSE_ROLES\.has\(access\.role\)/,
    "hasWideVisibility must recognize hierarchy roles in addition to isAdmin",
  );
  const wideVisibilityGates = expenseCommandSrc.match(/hasWideVisibility\s*\?/g) ?? [];
  assert.equal(
    wideVisibilityGates.length,
    3,
    "hasWideVisibility must gate all 3 collapse points: scopedRequests, visibleEnriched, exposedRows",
  );
  assert.doesNotMatch(
    expenseCommandSrc,
    /const scopedRequests = isAdmin/,
    "scopedRequests must no longer be gated by the narrower isAdmin alone",
  );
  assert.doesNotMatch(
    expenseCommandSrc,
    /const visibleEnriched = isAdmin/,
    "visibleEnriched must no longer be gated by the narrower isAdmin alone",
  );
  assert.doesNotMatch(
    expenseCommandSrc,
    /const exposedRows: ExpenseCommandRow\[\] = isAdmin/,
    "exposedRows must no longer be gated by the narrower isAdmin alone",
  );
}

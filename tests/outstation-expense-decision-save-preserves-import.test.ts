import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { resolveExpenseImportWrite } from "../src/lib/outstation/expenses.ts";

/**
 * The Expense Approvals decision-save cannot re-import a historical trip's figures (owner ruling,
 * 2026-09-21 — hardening the save route against a hand-built upload).
 *
 * The file-upload routes now refuse the Expense Approvals download (expense-import.ts, PRs #4192 /
 * #4199). But `POST /api/admin/outstation/expenses` is a JSON route: it takes already-parsed records
 * and upserts them on `trip_id`, and it never parsed a file to refuse. A hand-built request could
 * therefore carry the download's own shape — a historical trip's id with workload 0 and Other 0 —
 * and zero that trip's workload and drop its Other, exactly the damage the file refusal prevents.
 *
 * The decision-save is a DECISION, never an import: the approvals screen edits only Approve / the
 * deduction / the HR comment, and its Save posts every other column back exactly as it loaded them.
 * So on that route a trip that ALREADY exists keeps its STORED workload, Other and claimed total,
 * whatever the request body carries. `resolveExpenseImportWrite` is that rule, pure so it needs no
 * database. This pins it, and pins that the route turns it on.
 */

const stored = {
  amWorkload: 3,
  other: 50,
  pharmacyWorkload: 2,
  pmWorkload: 5,
  total: 450,
};

// A hand-built body aimed at trip T-1001: the download's zeroing shape.
const maliciousRecord = {
  amWorkload: 0,
  other: 0,
  pharmacyWorkload: 0,
  pmWorkload: 0,
  total: 500,
};

export function runOutstationExpenseDecisionSavePreservesImportTests() {
  // -- The attack: a decision-save over an existing trip keeps the STORED figures ---------------
  const guarded = resolveExpenseImportWrite({ preserve: true, record: maliciousRecord, stored });
  assert.deepEqual(
    guarded,
    stored,
    "a decision-save writes the trip's stored workload, Other and total — never the request body's",
  );
  assert.notEqual(guarded.amWorkload, 0, "the stored AM workload is not zeroed");
  assert.notEqual(guarded.pmWorkload, 0, "the stored PM workload is not zeroed");
  assert.notEqual(guarded.other, 0, "the stored Other is not dropped");

  // -- A genuine decision-save posts the SAME figures it loaded → unchanged, never falsely blocked -
  const unchanged = resolveExpenseImportWrite({
    preserve: true,
    record: { amWorkload: 3, other: 50, pharmacyWorkload: 2, pmWorkload: 5, total: 450 },
    stored,
  });
  assert.deepEqual(unchanged, stored, "a legit decision-save is not disturbed — its values already match stored");

  // -- A brand-new trip on the decision-save has nothing stored → written as sent ----------------
  const fresh = resolveExpenseImportWrite({ preserve: true, record: maliciousRecord, stored: null });
  assert.equal(fresh.amWorkload, 0, "a trip with nothing stored is written from the record — there is nothing to protect");
  assert.equal(fresh.total, 500);

  // -- The FILE import (preserve off) still sets workload and Other from the file -----------------
  // analyze / replace routes and the workflow push never preserve; setting these columns IS their job.
  const imported = resolveExpenseImportWrite({ preserve: false, record: maliciousRecord, stored });
  assert.equal(imported.amWorkload, 0, "a file import writes the file's workload, even over a stored row");
  assert.equal(imported.other, 0);
  assert.equal(imported.total, 500);

  // -- AM · PM · Pharmacies: a missing pharmacy figure is NULL, never 0 --------------------------
  const noPharmacy = resolveExpenseImportWrite({
    preserve: false,
    record: { amWorkload: 3, other: 10, pmWorkload: 5, total: 100 },
    stored: null,
  });
  assert.equal(noPharmacy.pharmacyWorkload, null, "an absent Pharmacy figure writes NULL (not counted separately), never 0");

  // -- Wiring: the decision-save route turns the guard on; the file routes do NOT -----------------
  const decisionRoute = readFileSync("app/api/admin/outstation/expenses/route.ts", "utf8");
  const post = decisionRoute.slice(decisionRoute.indexOf("export async function POST"));
  assert.match(
    post,
    /savePayrollExpenseApprovals\([\s\S]*?preserveImportedValues:\s*true/,
    "the decision-save route passes preserveImportedValues: true, so an existing trip's import figures are protected",
  );
  for (const route of [
    "app/api/admin/outstation/expenses/analyze/route.ts",
    "app/api/admin/outstation/expenses/reports/[id]/route.ts",
  ]) {
    assert.ok(
      !readFileSync(route, "utf8").includes("preserveImportedValues"),
      `${route}: the file import must NOT preserve — writing workload and Other from the file is its job`,
    );
  }
}

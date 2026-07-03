import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import type { AccessContext } from "@/lib/auth/permissions";
import {
  assertCustomerPharmacyMappingAccess,
  canAccessCustomerPharmacyMapping,
  INFERRED_HISTORY_MARKER,
} from "@/lib/customer-pharmacy-mapping/readiness.ts";
import { composeValidationNotes } from "@/lib/customer-pharmacy-mapping/actions.ts";

function access(overrides: Partial<AccessContext>): AccessContext {
  return {
    hrId: "M-1",
    loginId: "M-1",
    role: "Super Admin",
    scope: "system",
    source: "session",
    ...overrides,
  };
}

function testAccessGate() {
  assert.equal(canAccessCustomerPharmacyMapping(access({ role: "Super Admin", scope: "company" })), true);
  assert.equal(canAccessCustomerPharmacyMapping(access({ role: "CEO", scope: "company" })), true);

  for (const role of ["Employee", "Medical Rep", "District Manager", "Product Manager", "Group Product Manager", "SFE Manager"] as const) {
    assert.equal(
      canAccessCustomerPharmacyMapping(access({ role, scope: "team" })),
      false,
      `${role} must not be able to access Customer Pharmacy Mapping`,
    );
    assert.throws(
      () => assertCustomerPharmacyMappingAccess(access({ role, scope: "team" })),
      /Forbidden/,
      `${role} must be rejected by assertCustomerPharmacyMappingAccess`,
    );
  }

  // A "system" source/scope caller (e.g. an internal cron) is allowed regardless of role,
  // matching every other domain guard in this codebase.
  assert.equal(canAccessCustomerPharmacyMapping(access({ role: "Employee", source: "system" })), true);
  assert.equal(canAccessCustomerPharmacyMapping(access({ role: "Employee", scope: "system" })), true);

  assert.doesNotThrow(() => assertCustomerPharmacyMappingAccess(access({ role: "Super Admin" })));
  assert.doesNotThrow(() => assertCustomerPharmacyMappingAccess(access({ role: "CEO" })));
}

function testComposeValidationNotes() {
  assert.equal(composeValidationNotes(null, "Approved by M-1."), "Approved by M-1.");
  assert.equal(composeValidationNotes("", "Approved by M-1."), "Approved by M-1.");
  assert.equal(composeValidationNotes("   ", "Approved by M-1."), "Approved by M-1.");

  assert.equal(
    composeValidationNotes("Existing note.", "Approved: looks correct."),
    "Existing note.\nApproved: looks correct.",
  );

  // Re-applying the exact same addition must not duplicate it.
  const composed = composeValidationNotes("Existing note.\nApproved: looks correct.", "Approved: looks correct.");
  assert.equal(composed, "Existing note.\nApproved: looks correct.");

  // The inferred-history marker on an inferred link must survive composition untouched,
  // so the link keeps showing its inferred badge after a manual decision (requirement #3).
  const inferredExisting = `Inferred from historical marketing requests (${INFERRED_HISTORY_MARKER}).`;
  const afterApproval = composeValidationNotes(inferredExisting, "Approved: field-confirmed.");
  assert.match(afterApproval, new RegExp(INFERRED_HISTORY_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(afterApproval, `${inferredExisting}\nApproved: field-confirmed.`);

  const afterRejection = composeValidationNotes(inferredExisting, "Rejected: distributor code mismatch.");
  assert.match(afterRejection, new RegExp(INFERRED_HISTORY_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
}

function testActionsServiceSourceGuards() {
  const source = readFileSync("src/lib/customer-pharmacy-mapping/actions.ts", "utf8");

  // Both mutating entry points must gate on role/scope before touching the row (requirement:
  // "unauthorized roles cannot mutate").
  assert.match(
    source,
    /export async function approveCustomerPharmacyLink\([\s\S]{0,200}?\)[\s\S]{0,80}?\{\s*\n\s*assertCustomerPharmacyMappingAccess\(access\);/,
    "approveCustomerPharmacyLink must call assertCustomerPharmacyMappingAccess before any mutation",
  );
  assert.match(
    source,
    /export async function rejectCustomerPharmacyLink\([\s\S]{0,200}?\)[\s\S]{0,80}?\{\s*\n\s*assertCustomerPharmacyMappingAccess\(access\);/,
    "rejectCustomerPharmacyLink must call assertCustomerPharmacyMappingAccess before any mutation",
  );

  // Reject must require a non-empty reason (requirement: "rejecting requires a note").
  assert.match(
    source,
    /if \(!trimmedReason\) throw validationError\("A rejection reason is required\."\);/,
    "rejectCustomerPharmacyLink must reject an empty/whitespace-only reason",
  );

  // Both actions must pre-check the current status is "pending" before attempting the write
  // (requirement: "non-pending links cannot be changed").
  assert.match(
    source,
    /if \(existing\.validation_status !== "pending"\) \{\s*\n\s*throw conflictError\(\s*\n\s*`Only pending links can be approved\./,
    "approveCustomerPharmacyLink must pre-check the link is currently pending",
  );
  assert.match(
    source,
    /if \(existing\.validation_status !== "pending"\) \{\s*\n\s*throw conflictError\(\s*\n\s*`Only pending links can be rejected\./,
    "rejectCustomerPharmacyLink must pre-check the link is currently pending",
  );

  // The actual UPDATE must also be conditioned on validation_status = "pending" at the DB
  // level (not just pre-checked in application code) so a concurrent decision on the same
  // link cannot double-apply — this is the same TOCTOU-safe compare-and-swap pattern as
  // `decideExcuseRequestAsManager` in src/lib/excuses/service.ts.
  assert.match(
    source,
    /validation_status: "system_validated",\s*\n\s*\}\)\s*\n\s*\.eq\("id", linkId\)\s*\n\s*\.eq\("validation_status", "pending"\)/,
    "approve's UPDATE must be guarded by a DB-level validation_status compare-and-swap",
  );
  assert.match(
    source,
    /validation_status: "rejected",\s*\n\s*\}\)\s*\n\s*\.eq\("id", linkId\)\s*\n\s*\.eq\("validation_status", "pending"\)/,
    "reject's UPDATE must be guarded by a DB-level validation_status compare-and-swap",
  );

  // Losing that race must surface as a conflict, not a silent no-op or overwrite.
  const raceGuardOccurrences = source.match(
    /if \(!data\) throw conflictError\("This link was just changed by someone else\. Reload and try again\."\);/g,
  );
  assert.ok(raceGuardOccurrences && raceGuardOccurrences.length === 2, "both approve and reject must throw a conflict error when the compare-and-swap loses the race");

  // No delete, no bulk actions: every mutation targets exactly one linkId via .eq("id", linkId).
  assert.doesNotMatch(source, /\.delete\(/, "actions.ts must never delete a customer-pharmacy link");
  assert.doesNotMatch(source, /\.in\("id"/, "actions.ts must not support bulk (multi-id) mutation");
}

function testDecisionRouteSourceGuards() {
  const source = readFileSync("app/api/customer-pharmacy-mapping/[id]/decision/route.ts", "utf8");

  assert.match(
    source,
    /const csrfError = assertSameOriginMutation\(request\);\s*\n\s*if \(csrfError\) return csrfError;/,
    "decision route must enforce same-origin/CSRF protection",
  );

  // CSRF check must run before the access context is resolved and before any body parsing.
  const csrfIndex = source.indexOf("assertSameOriginMutation(request)");
  const accessIndex = source.indexOf("resolveAccessContext(request)");
  assert.ok(csrfIndex >= 0 && accessIndex >= 0 && csrfIndex < accessIndex, "CSRF check must run before resolveAccessContext");

  assert.match(source, /approveCustomerPharmacyLink\(access, \{/, "route must delegate approve to the domain action (which enforces the role gate)");
  assert.match(source, /rejectCustomerPharmacyLink\(access, \{/, "route must delegate reject to the domain action (which enforces the role gate)");
}

export async function runCustomerPharmacyMappingActionsTests() {
  testAccessGate();
  testComposeValidationNotes();
  testActionsServiceSourceGuards();
  testDecisionRouteSourceGuards();
}

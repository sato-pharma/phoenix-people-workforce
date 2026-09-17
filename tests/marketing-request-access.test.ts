import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { createAccessContext, type PhoenixRole } from "@/lib/auth/permissions";
import {
  canUseEmployeePortalMarketingRequests,
  canUseEmployeePortalMarketingRoiTracking,
  canUseEmployeePortalMarketingValidation,
} from "@/lib/employee-portal/navigation";
import {
  assertMarketingRequestCreationAccess,
  marketingCreatorRoles,
  marketingRequestCreatorRoles,
} from "@/lib/marketing-requests/service";

// Roles that must be able to VALIDATE customers from their employee-portal account. Pinning this
// set guards against a silent regression in any of the layers that gate Customer Validation.
const REQUIRED_VALIDATION_ROLES: readonly PhoenixRole[] = [
  "District Manager",
  "Medical Rep",
  "National Sales Manager",
  "Product Manager",
  "Group Product Manager",
];

// Roles that must be able to RAISE a marketing request — the same list MINUS the Medical Rep, who
// the owner took off that surface on 2026-09-18. The rep still captures the venue; their District
// Manager raises the spend against what they validated. These were ONE list until that day, which
// is exactly why they are now pinned apart: re-merging them silently reopens the drafts workspace
// and the Approval Inbox to every rep. The full ruling is in
// tests/medical-rep-marketing-scope.test.ts.
const REQUIRED_REQUEST_CREATOR_ROLES: readonly PhoenixRole[] = REQUIRED_VALIDATION_ROLES.filter(
  (role) => role !== "Medical Rep",
);

// Roles deliberately NOT authorized for marketing — proves the lock does not over-grant.
const NON_MARKETING_ROLES: readonly PhoenixRole[] = ["Training Manager", "Employee"];

function actionLine(source: string, marker: string): string {
  const line = source.split("\n").find((entry) => entry.includes(marker));
  assert.ok(line, `Expected a workflow-registry action line matching ${marker}`);
  return line as string;
}

function allowedRolesOf(actionObjectLine: string): string {
  const match = actionObjectLine.match(/"allowedRoles":\[([^\]]*)\]/);
  assert.ok(match, "Expected an allowedRoles array on the workflow action object");
  return (match as RegExpMatchArray)[1];
}

export function runMarketingRequestAccessTests() {
  const liveModulesMigration = readFileSync(
    "supabase/_migrations_archive/pre-baseline-2026-07-11/20260527091104_workflow_registry_live_modules.sql",
    "utf8",
  );

  // The marketing "create_draft" action is keyed identically to coaching's, so anchor on
  // its unique side effect. "create_validation_record" is unique on its own.
  const createDraftRoles = allowedRolesOf(actionLine(liveModulesMigration, "create marketing request draft"));
  const createValidationRoles = allowedRolesOf(actionLine(liveModulesMigration, '"key":"create_validation_record"'));

  for (const role of REQUIRED_VALIDATION_ROLES) {
    // Page guard: Customer Validation has had its own key since 2026-09-18 —
    // assertEmployeePortalMarketingPageAccess("validation"), not the shared "requests".
    assert.equal(
      canUseEmployeePortalMarketingValidation(role),
      true,
      `${role} must reach the Customer Validation page`,
    );

    // ROI Tracking view.
    assert.equal(
      canUseEmployeePortalMarketingRoiTracking(role),
      true,
      `${role} must reach Marketing ROI Tracking`,
    );

    // Service layer: assertMarketingAccess checks this set before any validate.
    assert.equal(
      marketingCreatorRoles.has(role),
      true,
      `${role} must be a marketing creator (service-layer gate)`,
    );

    // Workflow registry: validating a customer must be allowed for the role.
    assert.match(
      createValidationRoles,
      new RegExp(`"${role}"`),
      `${role} must be allowed to create a customer validation record (workflow registry)`,
    );
  }

  for (const role of REQUIRED_REQUEST_CREATOR_ROLES) {
    // Page guard for the drafts workspace and the Approval Inbox, which share this predicate.
    assert.equal(
      canUseEmployeePortalMarketingRequests(role),
      true,
      `${role} must reach the Marketing Requests page and the Approval Inbox`,
    );

    // Service layer: the gate every draft create and resubmit runs through.
    assert.equal(
      marketingRequestCreatorRoles.has(role),
      true,
      `${role} must be able to raise a marketing request (service-layer gate)`,
    );

    // Workflow registry: submitting a request (create_draft) must be allowed for the role.
    assert.match(
      createDraftRoles,
      new RegExp(`"${role}"`),
      `${role} must be allowed to create a marketing request draft (workflow registry)`,
    );
  }

  // ── The Medical Rep's half of the split, stated head-on (owner, 2026-09-18) ─────────────────
  // The workflow-registry row in that ARCHIVED migration still lists the rep on create_draft. It is
  // a historical artefact and is deliberately left alone: per CLAUDE.md the security boundary is
  // server-side access control, and a registry row is not one. The gate below is.
  assert.equal(
    canUseEmployeePortalMarketingRequests("Medical Rep"),
    false,
    "the Medical Rep lost the drafts workspace and the Approval Inbox — they capture, their manager raises",
  );
  assert.equal(
    marketingRequestCreatorRoles.has("Medical Rep"),
    false,
    "the Medical Rep must not be a marketing REQUEST creator",
  );
  assert.throws(
    () => assertMarketingRequestCreationAccess(createAccessContext({ hrId: "MR001", role: "Medical Rep" })),
    /cannot raise a marketing request/i,
    "posting a draft straight to the API must be refused for a Medical Rep",
  );

  for (const role of NON_MARKETING_ROLES) {
    assert.equal(
      canUseEmployeePortalMarketingRequests(role),
      false,
      `${role} must NOT reach the marketing pages`,
    );
    assert.equal(
      canUseEmployeePortalMarketingValidation(role),
      false,
      `${role} must NOT reach Customer Validation either`,
    );
    assert.equal(
      marketingCreatorRoles.has(role),
      false,
      `${role} must NOT be a marketing creator`,
    );
  }
}

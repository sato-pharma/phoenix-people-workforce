import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import type { PhoenixRole } from "@/lib/auth/permissions";
import {
  canUseEmployeePortalMarketingRequests,
  canUseEmployeePortalMarketingRoiTracking,
} from "@/lib/employee-portal/navigation";
import { marketingCreatorRoles } from "@/lib/marketing-requests/service";

// Roles that must be able to validate customers and submit marketing requests from
// their employee-portal account. Pinning this set guards against a silent regression
// in any of the layers that gate the Marketing Requests / Customer Validation module.
const REQUIRED_MARKETING_ROLES: readonly PhoenixRole[] = [
  "District Manager",
  "Medical Rep",
  "National Sales Manager",
  "Product Manager",
  "Group Product Manager",
];

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
    "supabase/migrations/20260527091104_workflow_registry_live_modules.sql",
    "utf8",
  );

  // The marketing "create_draft" action is keyed identically to coaching's, so anchor on
  // its unique side effect. "create_validation_record" is unique on its own.
  const createDraftRoles = allowedRolesOf(actionLine(liveModulesMigration, "create marketing request draft"));
  const createValidationRoles = allowedRolesOf(actionLine(liveModulesMigration, '"key":"create_validation_record"'));

  for (const role of REQUIRED_MARKETING_ROLES) {
    // Page guard: a single helper gates BOTH the Marketing Requests submission page and the
    // Customer Validation page (validation calls assertEmployeePortalMarketingPageAccess("requests")).
    assert.equal(
      canUseEmployeePortalMarketingRequests(role),
      true,
      `${role} must reach the Marketing Requests + Customer Validation pages`,
    );

    // ROI Tracking view.
    assert.equal(
      canUseEmployeePortalMarketingRoiTracking(role),
      true,
      `${role} must reach Marketing ROI Tracking`,
    );

    // Service layer: assertMarketingAccess checks this set before any create/validate.
    assert.equal(
      marketingCreatorRoles.has(role),
      true,
      `${role} must be a marketing creator (service-layer gate)`,
    );

    // Workflow registry: submitting a request (create_draft) and validating a customer
    // (create_validation_record) must both be allowed for the role.
    assert.match(
      createDraftRoles,
      new RegExp(`"${role}"`),
      `${role} must be allowed to create a marketing request draft (workflow registry)`,
    );
    assert.match(
      createValidationRoles,
      new RegExp(`"${role}"`),
      `${role} must be allowed to create a customer validation record (workflow registry)`,
    );
  }

  for (const role of NON_MARKETING_ROLES) {
    assert.equal(
      canUseEmployeePortalMarketingRequests(role),
      false,
      `${role} must NOT reach the marketing pages`,
    );
    assert.equal(
      marketingCreatorRoles.has(role),
      false,
      `${role} must NOT be a marketing creator`,
    );
  }
}

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { resolveMarketingCustomerValidationBadge } from "@/lib/marketing-requests/customer-validation-badge";

function source(relPath: string): string {
  return readFileSync(relPath, "utf8");
}

/**
 * The per-target-pharmacy "already validated · by whom · when" stamp on the marketing approver
 * window (owner ask, 2026-09-22: looking at a request whose two target pharmacies showed no photo,
 * "i need to see badges are those validated or no").
 *
 * The shipped badge covered the CUSTOMER only; a target pharmacy with no photo rendered as a bare
 * name, so an approver could not tell a validated venue from an unvalidated one. This pins the three
 * halves of the fix, none of which typecheck catches on their own:
 *
 *   • the LOADER carries the pharmacy's OWN validation state (validation_status / validated_by /
 *     validated_at / evidence capture time), distinct from the distributor-code reference status;
 *   • the SERVICE resolves the badge where the employee directory already lives, so a human
 *     validator is named and the system case never is;
 *   • the WINDOW renders "Validated" when there is a badge and an explicit "Not validated" when
 *     there is not — the whole point of the owner's ask.
 *
 * Plus one behavioural anchor: a pending pharmacy (his exact case) resolves to a null badge, which
 * is what drives the "Not validated" chip.
 */
export function runMarketingApproverPharmacyValidationBadgeTests() {
  // ── Loader carries each pharmacy's own validation state ─────────────────────────────────────
  const loaders = source("src/lib/marketing-requests/request-loaders.ts");
  for (const field of ["validationStatus", "validatedByHrId", "validatedAt", "evidenceCapturedAt"]) {
    assert.match(
      loaders,
      new RegExp(`\\b${field}:`),
      `MarketingDecisionPharmacy must carry ${field} so the approver can see venue validation`,
    );
  }
  assert.match(
    loaders,
    /validation_status: string \| null;\s*\n\s*validated_by_hr_id: string \| null;\s*\n\s*validated_at: string \| null;/,
    "the loader must SELECT the pharmacy validation columns (fetchRowsByIds is select(*), so the type is the read)",
  );
  assert.match(
    loaders,
    /evidenceCapturedAt: row\.pharmacy_id[\s\S]*?evidenceByPharmacyId\.get\(String\(row\.pharmacy_id\)\)\?\.capturedAt/,
    "evidenceCapturedAt is the evidence-photo capture time — the only honest 'when' for the system case",
  );
  assert.match(
    loaders,
    /validationStatus: \(cleanText\(pharmacy\?\.validation_status\)[\s\S]*?\) \?\? "pending"/,
    "an unreadable pharmacy row defaults to 'pending' — an unknown venue is never treated as validated",
  );

  // ── Service resolves the badge with the already-loaded directory, only for the approver path ──
  const service = source("src/lib/marketing-requests/service.ts");
  assert.match(
    service,
    /export type MarketingDecisionPharmacyWithValidation = MarketingDecisionPharmacy & \{\s*\n\s*validationBadge: ValidationBadge \| null;/,
    "the approver's target pharmacy carries a validationBadge; the plain loader type stays clean for the Case File",
  );
  assert.match(
    service,
    /targetPharmacies: MarketingDecisionPharmacyWithValidation\[\];/,
    "the decision summary exposes the badge-carrying pharmacy type",
  );
  assert.match(
    service,
    /validationBadge: resolveMarketingCustomerValidationBadge\(\{\s*\n\s*status: pharmacy\.validationStatus,/,
    "each target pharmacy badge is resolved by the shared marketing resolver (same status vocabulary as the customer)",
  );
  assert.match(
    service,
    /validatedByName: pharmacy\.validatedByHrId\s*\n\s*\? employeeNameByHrId\(employeeRows, pharmacy\.validatedByHrId\)/,
    "the human validator's name comes from the directory this summary already loaded — never fabricated",
  );
  assert.match(
    service,
    /targetPharmacies: targetPharmaciesWithValidation,/,
    "the summary returns the enriched pharmacies, not the raw loader output",
  );

  // ── The window shows validated-or-not on every pharmacy row ─────────────────────────────────
  const panel = source("src/components/marketing-requests/marketing-request-approver-detail.tsx");
  assert.match(
    panel,
    /pharmacy\.validationBadge \?[\s\S]*?Validated[\s\S]*?\) : \([\s\S]*?Not validated/,
    "each target pharmacy row renders 'Validated' when there is a badge and 'Not validated' when there is not",
  );
  assert.match(
    panel,
    /Validated by the system/,
    "the human/system split is honoured on the pharmacy row — the system case is never named a reviewer",
  );

  // ── Behavioural anchor: the owner's pending pharmacies resolve to no badge → 'Not validated' ──
  assert.equal(
    resolveMarketingCustomerValidationBadge({
      status: "pending",
      validatedByName: null,
      validatedAt: null,
      capturedAt: null,
    }),
    null,
    "a pending pharmacy has no badge, which is exactly what drives the 'Not validated' chip",
  );
  const human = resolveMarketingCustomerValidationBadge({
    status: "sfe_validated",
    validatedByName: "Rasha Sabry",
    validatedAt: "2026-09-21T14:03:00Z",
    capturedAt: null,
  });
  assert.ok(human && human.isHuman && human.byName === "Rasha Sabry", "a desk-validated pharmacy names its human validator");
  const system = resolveMarketingCustomerValidationBadge({
    status: "system_validated",
    validatedByName: "Someone",
    validatedAt: null,
    capturedAt: "2026-06-20T13:46:42Z",
  });
  assert.ok(system && !system.isHuman && system.byName === null, "a system-validated pharmacy is validated but names no reviewer");
}

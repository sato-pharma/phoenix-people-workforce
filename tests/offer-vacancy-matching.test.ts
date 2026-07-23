import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import { pickDepartmentSafeVacancy } from "../src/lib/offers/vacancy-matching.ts";

/**
 * WP-5 regression coverage: offer/import vacancy closure must be department-safe
 * (no cross-department close on a shared line) and must clear the replacement
 * marker when a vacancy is filled. The offers service is env-bound (Supabase
 * client), so the pure selection rule is unit-tested directly and the fill
 * payload + caller wiring are locked via source assertions.
 */
export function runOfferVacancyMatchingTests() {
  const SALES = 1;
  const MARKETING = 2;

  // -- Same line + different department: pick the hire's department, never the other.
  const sharedLineCandidates = [
    { id: 10, department_id: MARKETING },
    { id: 11, department_id: SALES },
  ];
  const salesPick = pickDepartmentSafeVacancy(sharedLineCandidates, SALES);
  assert.equal(salesPick?.id, 11, "Sales hire fills the Sales vacancy, not the Marketing one");
  const marketingPick = pickDepartmentSafeVacancy(sharedLineCandidates, MARKETING);
  assert.equal(marketingPick?.id, 10, "Marketing hire fills the Marketing vacancy");

  // -- Cross-department only: a Sales hire must NOT close a Marketing-only vacancy.
  assert.equal(
    pickDepartmentSafeVacancy([{ id: 20, department_id: MARKETING }], SALES),
    undefined,
    "Sales hire does not close a different-department (Marketing) vacancy",
  );

  // -- Correct single-department vacancy is selected.
  assert.equal(
    pickDepartmentSafeVacancy([{ id: 30, department_id: SALES }], SALES)?.id,
    30,
    "matching-department vacancy is selected",
  );

  // -- Legacy: a single departmentless vacancy is still closed (back-compat).
  assert.equal(
    pickDepartmentSafeVacancy([{ id: 40, department_id: null }], SALES)?.id,
    40,
    "single departmentless legacy vacancy is still closed",
  );
  // -- But ambiguous departmentless candidates are NOT closed (refuse to guess).
  assert.equal(
    pickDepartmentSafeVacancy([{ id: 41, department_id: null }, { id: 42, department_id: null }], SALES),
    undefined,
    "ambiguous departmentless vacancies are not closed",
  );

  // -- No department on the hire -> legacy first-match behavior preserved.
  assert.equal(
    pickDepartmentSafeVacancy([{ id: 50, department_id: SALES }, { id: 51, department_id: MARKETING }], null)?.id,
    50,
    "no hire department -> first candidate (legacy behavior)",
  );
  assert.equal(pickDepartmentSafeVacancy([], SALES), undefined, "no candidates -> nothing to close");

  // -- Wiring: the vacancies module threads department and clears replacement on fill.
  // (closeVacancyForOffer lives in offers/vacancies.ts, split out of offers/service.ts
  // so employee-directory.ts never pulls that file's dynamic offer-letter-pdf.ts import
  // into a client bundle — see vacancies.ts's header comment.)
  const offerSource = readFileSync(
    new URL("../src/lib/offers/vacancies.ts", import.meta.url),
    "utf8",
  );
  assert.match(offerSource, /department_id\?: number \| null;/, "closeVacancyForOffer input must accept department_id");
  assert.match(
    offerSource,
    /pickDepartmentSafeVacancy\(matches, input\.department_id\)/,
    "vacancy selection must use the department-safe picker",
  );
  assert.match(
    offerSource,
    /id,replacement_for_hr_id,department_id/,
    "vacancy match query must select department_id for disambiguation",
  );
  assert.match(offerSource, /filled_by_hr_id: filledByHrId/, "fill payload must set filled_by_hr_id");
  assert.match(offerSource, /status: "filled"/, "fill payload must set status=filled");
  assert.match(offerSource, /filled_at: filledByHrId \? new Date\(\)\.toISOString\(\) : null/, "fill payload must set filled_at");
  assert.match(
    offerSource,
    /replacement_for_hr_id: null,/,
    "fill payload must clear replacement_for_hr_id",
  );

  // -- Wiring: offer approval is now handled atomically in SQL and must use department-safe vacancy matching.
  const hardeningMigration = readFileSync(
    new URL("../supabase/_migrations_archive/pre-baseline-2026-07-11/20260531235753_offer_lifecycle_10_10_hardening.sql", import.meta.url),
    "utf8",
  );
  assert.match(hardeningMigration, /pv\.department_id = v_offer\.department_id/, "offer approval must match vacancy department");
  assert.match(hardeningMigration, /Ambiguous vacancy match/, "legacy ambiguous vacancy matches must be rejected");

  const directorySource = readFileSync(
    new URL("../src/lib/employees/employee-directory.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    directorySource,
    /department_id: payload\.department_id/,
    "employee creation must pass department_id to vacancy closure",
  );

  const importSource = readFileSync(
    new URL("../app/api/imports/employees/confirm/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(importSource, /department_id: departmentId/, "bulk import must pass department_id to vacancy closure");
  assert.match(importSource, /departmentIds: IdMap;/, "import vacancy closure must accept the department id map");
}

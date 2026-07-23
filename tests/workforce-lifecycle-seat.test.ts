import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import {
  calculateWorkforceStructureSummary,
  salesRecordMatchesSeatContinuity,
  shouldCloseVacancyForHire,
  workforceSeatKey,
  workforceSeatsMatch,
} from "../src/lib/workforce/seat-lifecycle.ts";

export function runWorkforceLifecycleSeatTests() {
  assert.equal(
    workforceSeatKey({
      areaId: 10,
      lineId: 2,
      managerHrId: "dsm-1",
      positionId: 30,
    }),
    "10:2:DSM-1:30",
  );

  assert.equal(
    shouldCloseVacancyForHire({
      areaId: 10,
      employmentStatus: "active",
      lineId: 2,
      managerHrId: "DSM-1",
      positionId: 30,
    }),
    true,
  );
  assert.equal(
    shouldCloseVacancyForHire({
      areaId: 10,
      employmentStatus: "terminated",
      lineId: 2,
      managerHrId: "DSM-1",
      positionId: 30,
    }),
    false,
  );

  assert.equal(
    workforceSeatsMatch(
      {
        areaName: "Nasr City",
        lineName: "Pedia",
        managerHrId: "DSM-1",
        positionTitle: "Medical Representative",
      },
      {
        areaName: "nasr city",
        lineName: "pedia",
        managerHrId: "dsm-1",
        positionTitle: "medical representative",
      },
    ),
    true,
  );

  assert.deepEqual(
    calculateWorkforceStructureSummary({ activeEmployees: 125, openVacancies: 28 }),
    {
      activeEmployees: 125,
      openVacancies: 28,
      totalStructure: 153,
      vacancyRate: 28 / 153,
    },
  );

  assert.equal(
    salesRecordMatchesSeatContinuity(
      {
        employeeHrId: "OLD-REP",
        line: "Pedia",
        managerHrId: "DSM-1",
        territory: "Nasr City",
      },
      {
        areaName: "Nasr City",
        currentHrId: "NEW-REP",
        lineName: "Pedia",
        managerHrId: "DSM-1",
        previousHrIds: ["OLD-REP"],
        positionTitle: "Medical Representative",
      },
    ),
    true,
  );

  assert.equal(
    salesRecordMatchesSeatContinuity(
      {
        employeeHrId: "REP-1",
        line: "Pedia",
        managerHrId: "OLD-DSM",
        territory: "Nasr City",
      },
      {
        areaName: "Nasr City",
        currentHrId: "NEW-DSM",
        lineName: "Pedia",
        previousHrIds: ["OLD-DSM"],
        positionTitle: "District Sales Manager",
      },
    ),
    true,
  );

  const employeeDirectorySource = readFileSync("src/lib/employees/employee-directory.ts", "utf8");
  assert.match(employeeDirectorySource, /closeVacancyForOffer/);
  assert.match(employeeDirectorySource, /reassignLiveManagerOwnership/);

  const bulkImportSource = readFileSync("app/api/imports/employees/confirm/route.ts", "utf8");
  assert.match(bulkImportSource, /closeVacanciesForImportedEmployees/);
  assert.match(bulkImportSource, /shouldCloseVacancyForHire/);
  assert.match(bulkImportSource, /closedVacancies/);

  const offerSource = readFileSync("src/lib/offers/service.ts", "utf8");
  assert.match(offerSource, /phx_approve_accepted_offer/);
  assert.doesNotMatch(offerSource, /await closeVacancyForOffer\(\{[\s\S]*vacancy_id: offer\.vacancy_id/);
  // closeVacancyForOffer lives in offers/vacancies.ts (split out of offers/service.ts so
  // employee-directory.ts never pulls service.ts's dynamic offer-letter-pdf.ts import into
  // a client bundle) — check the actual closer's manager-matching logic there.
  const vacanciesSource = readFileSync("src/lib/offers/vacancies.ts", "utf8");
  assert.match(vacanciesSource, /manager_name\?: string \| null/);
  assert.match(vacanciesSource, /normalizeManagerName\(vacancy\.manager_name\) === resolvedManagerName/);
  const offerHardeningMigration = readFileSync("supabase/_migrations_archive/pre-baseline-2026-07-11/20260531235753_offer_lifecycle_10_10_hardening.sql", "utf8");
  assert.match(offerHardeningMigration, /filled_by_hr_id = v_employee_hr_id/);
  assert.match(offerHardeningMigration, /replacement_for_hr_id = null/);

  const resignationsSource = readFileSync("src/lib/resignations/service.ts", "utf8");
  assert.match(resignationsSource, /phx_resign_employee_and_open_vacancy/);
  assert.match(resignationsSource, /replacement_for_hr_id: employee\.hrId/);

  const probationSource = readFileSync("src/lib/probation/service.ts", "utf8");
  assert.match(probationSource, /resignEmployeeAndOpenVacancy/);
  assert.match(probationSource, /employeeStatus: "terminated"/);

  const commandCenterSource = readFileSync("src/lib/admin/command-center.ts", "utf8");
  const dataHealthSource = readFileSync("src/lib/admin/service.ts", "utf8");
  assert.match(commandCenterSource, /calculateWorkforceStructureSummary/);
  assert.match(commandCenterSource, /getDataHealthStats/);
  assert.match(dataHealthSource, /getWorkforceMetrics/);

  const portalSource = readFileSync("src/lib/employee-portal/service.ts", "utf8");
  assert.match(portalSource, /fetchPortalSalesSeatContinuityRecords/);
  assert.match(portalSource, /salesRecordMatchesSeatContinuity/);
}

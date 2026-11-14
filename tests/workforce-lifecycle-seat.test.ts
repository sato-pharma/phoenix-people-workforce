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
  assert.match(employeeDirectorySource, /closeVacancyOnHire/);
  assert.match(employeeDirectorySource, /reassignLiveManagerOwnership/);

  const bulkImportSource = readFileSync("app/api/imports/employees/confirm/route.ts", "utf8");
  assert.match(bulkImportSource, /closeVacanciesForImportedEmployees/);
  assert.match(bulkImportSource, /shouldCloseVacancyForHire/);
  assert.match(bulkImportSource, /closedVacancies/);

  // closeVacancyOnHire lives in its own module (env-bound Supabase client, apart from
  // the recruitment/offers domain) — check the department/manager-matching logic there.
  const vacancyCloserSource = readFileSync("src/lib/employees/vacancy-closer.ts", "utf8");
  assert.match(vacancyCloserSource, /manager_name\?: string \| null/);
  assert.match(vacancyCloserSource, /normalizeManagerName\(vacancy\.manager_name\) === resolvedManagerName/);

  const resignationsSource = readFileSync("src/lib/resignations/service.ts", "utf8");
  assert.match(resignationsSource, /phx_resign_employee_and_open_vacancy/);
  assert.match(resignationsSource, /replacement_for_hr_id: employee\.hrId/);

  // REC-010 (14 Nov 2026): the legacy probation evaluation workflow left probation/service.ts; a
  // probation is decided on its case, in probation/intelligence/decision.ts.
  const probationSource = readFileSync("src/lib/probation/intelligence/decision.ts", "utf8");
  assert.match(probationSource, /resignEmployeeAndOpenVacancy/);
  assert.match(probationSource, /employeeStatus: "terminated"/);

  const commandCenterSource = readFileSync("src/lib/admin/command-center.ts", "utf8");
  const dataHealthSource = readFileSync("src/lib/admin/service.ts", "utf8");
  assert.match(commandCenterSource, /calculateWorkforceStructureSummary/);
  assert.match(commandCenterSource, /getDataHealthStats/);
  assert.match(dataHealthSource, /getWorkforceMetrics/);

  const portalSource = readFileSync("src/lib/employee-portal/service.ts", "utf8");
  // `select…`, not `fetch…`: since the portal moved onto SoS Monthly Closing it no longer issues a
  // second query for the inherited months — it filters rows already loaded for the window. The
  // predicate below is the invariant that matters and is unchanged; the prefix records that this
  // pass costs no extra round trip, so do not "restore" the fetch spelling.
  assert.match(portalSource, /selectPortalSalesSeatContinuityRecords/);
  assert.match(portalSource, /salesRecordMatchesSeatContinuity/);
}

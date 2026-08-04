import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import {
  buildCompanyWorkforceAggregateMetrics,
  countUnoccupiedWorkforceSeats,
} from "../src/lib/platform/metrics.ts";
import { isProbationDecisionOutstanding } from "../src/lib/probation/service.ts";
import type { ProbationDecision, ProbationRow } from "../src/lib/probation/types.ts";
import { suppressFilledVacancyRows } from "../src/lib/reports/organogram-safety.ts";
import type { OrganogramReportRow } from "../src/lib/reports/vacancies.ts";

type VacancySeat = {
  areaName?: string | null;
  jobTitle?: string | null;
  lineName?: string | null;
  managerHrId?: string | null;
  managerName?: string | null;
  positionTitle?: string | null;
  replacementForHrId?: string | null;
  vacancyCode?: string | null;
};

function repSeat(overrides: VacancySeat = {}): VacancySeat {
  return {
    areaName: "Nasr City",
    jobTitle: "Medical Representative",
    lineName: "Pedia",
    managerHrId: "DSM-1",
    managerName: "District One",
    positionTitle: "Medical Representative",
    vacancyCode: "VAC-1",
    ...overrides,
  };
}

function probationRow(decision: ProbationDecision | null | undefined): Pick<ProbationRow, "workflow"> {
  return { workflow: decision === undefined ? null : ({ decision } as ProbationRow["workflow"]) };
}

function organogramRow(overrides: Partial<OrganogramReportRow>): OrganogramReportRow {
  return {
    areaId: null,
    areaName: "Nasr City",
    departmentId: null,
    departmentName: null,
    displayName: "Person",
    fullName: "Person",
    hireDate: null,
    hrId: "E-1",
    jobTitle: "Medical Representative",
    lineId: null,
    lineName: "Pedia",
    managerHrId: "DSM-1",
    managerName: "District One",
    positionId: null,
    positionTitle: "Medical Representative",
    regionName: "Cairo",
    sourceRowNumber: null,
    status: "open",
    teamId: null,
    teamName: null,
    type: "vacancy",
    vacancyCode: "VAC-1",
    ...overrides,
  };
}

export function runCeoLandingSeatAndProbationCountsTests() {
  // ── Defect A: the CEO/admin vacancy tile counted position_vacancies ROWS ──────
  // Production had 45 open rows standing for 33 real seats: 7 rows sat on seats an
  // active employee already occupied, and the rest carried duplicate rows for one
  // seat that had emptied more than once.
  {
    const seats = countUnoccupiedWorkforceSeats({
      employees: [],
      vacancies: [
        repSeat({ vacancyCode: "VAC-1" }),
        repSeat({ vacancyCode: "VAC-2" }),
        repSeat({ vacancyCode: "VAC-3" }),
      ],
    });
    assert.equal(
      seats,
      1,
      "three open vacancy records for one area under one manager are one empty seat — position_vacancies stores an event per vacating, not a row per seat",
    );
  }

  {
    const seats = countUnoccupiedWorkforceSeats({
      employees: [repSeat({ vacancyCode: undefined })],
      vacancies: [repSeat()],
    });
    assert.equal(
      seats,
      0,
      "a seat an active employee occupies is filled regardless of the stale open row — the hire path only closes a vacancy it can positively match",
    );
  }

  {
    const seats = countUnoccupiedWorkforceSeats({
      employees: [repSeat({ areaName: "Maadi" })],
      vacancies: [repSeat({ areaName: "Nasr City" }), repSeat({ areaName: "Maadi", vacancyCode: "VAC-9" })],
    });
    assert.equal(
      seats,
      1,
      "occupancy must match on the SPECIFIC area — an employee in Maadi cannot fill the Nasr City seat, and cannot leave his own seat counted as vacant",
    );
  }

  {
    const seats = countUnoccupiedWorkforceSeats({
      employees: [],
      vacancies: [
        { jobTitle: "Regulatory Affairs", positionTitle: "Regulatory Affairs", vacancyCode: "VAC-OF0003" },
        { jobTitle: "Regulatory Affairs", positionTitle: "Regulatory Affairs", vacancyCode: "VAC-OF0003" },
      ],
    });
    assert.equal(
      seats,
      1,
      "a head-office vacancy has no sales seat key, so it must still count once by vacancy code rather than vanish from the total structure",
    );
  }

  {
    const seats = countUnoccupiedWorkforceSeats({
      employees: [],
      vacancies: [
        repSeat({
          jobTitle: "District Sales Manager",
          managerHrId: null,
          managerName: null,
          positionTitle: "District Sales Manager",
          vacancyCode: "VAC-ORPHAN",
        }),
      ],
    });
    assert.equal(
      seats,
      0,
      "a vacant manager seat reporting to nobody and replacing nobody is unplaceable import debris the organogram hides — counting it here would put the tile back above the chart",
    );
  }

  // The point of reusing organogram-safety's seat key: the tile and the chart must
  // agree by construction, not by two rules that happen to match today.
  {
    const rows: OrganogramReportRow[] = [
      organogramRow({ hrId: "MR-1", status: "active", type: "employee", vacancyCode: null }),
      organogramRow({ areaName: "Maadi", hrId: "VAC-2", vacancyCode: "VAC-2" }),
      organogramRow({ areaName: "Maadi", hrId: "VAC-3", vacancyCode: "VAC-3" }),
    ];
    const organogramSeats = suppressFilledVacancyRows(rows).filter((row) => row.type === "vacancy").length;
    const tileSeats = countUnoccupiedWorkforceSeats({
      employees: rows.filter((row) => row.type === "employee"),
      vacancies: rows.filter((row) => row.type === "vacancy"),
    });
    assert.equal(
      tileSeats,
      organogramSeats,
      "the workforce tile and the organogram must resolve the same input to the same seat count — a second dedup rule is how they drifted to 45 vs 33",
    );
  }

  // ── The aggregate the CEO hero and the admin Data Health card both read ───────
  {
    const workforce = buildCompanyWorkforceAggregateMetrics({
      employees: [
        {
          areaName: "Nasr City",
          employmentStatus: "active",
          fullName: "Alpha",
          hrId: "A-1",
          jobTitle: "Medical Representative",
          lineName: "Pedia",
          managerHrId: "DSM-1",
          managerName: "District One",
          positionTitle: "Medical Representative",
        },
      ],
      lookups: {
        workforceVacancies: [
          repSeat({ areaName: "Nasr City", vacancyCode: "VAC-1" }),
          repSeat({ areaName: "Maadi", vacancyCode: "VAC-2" }),
          repSeat({ areaName: "Maadi", vacancyCode: "VAC-3" }),
        ],
      },
    });
    assert.equal(
      workforce.openVacancies,
      1,
      "one occupied seat plus two duplicate records for a single empty seat is ONE vacancy, not three",
    );
    assert.equal(
      workforce.totalStructure,
      2,
      "total structure is active headcount plus real empty seats, so it inherits the row-count inflation unless openVacancies is deduped first",
    );
  }

  // ── Defect B: the CEO probation tile linked to a page it had no rows on ──────
  {
    assert.equal(
      isProbationDecisionOutstanding(probationRow(undefined)),
      true,
      "a probationer with no evaluation record still needs a decision — nobody has made one",
    );
    assert.equal(
      isProbationDecisionOutstanding(probationRow("pass")),
      false,
      "a passed probation is decided and must not be counted as awaiting the CEO",
    );
    assert.equal(
      isProbationDecisionOutstanding(probationRow("terminate")),
      false,
      "a terminated probation is decided and must not be counted as awaiting the CEO",
    );
    assert.equal(
      isProbationDecisionOutstanding(probationRow(null)),
      true,
      "an open evaluation with no decision recorded is exactly the outstanding case the tile exists for",
    );
  }

  {
    const ceoSource = readFileSync("src/lib/ceo/command-center.ts", "utf8");
    assert.match(
      ceoSource,
      /async function getCeoProbationCounts\(access: AccessContext\)[\s\S]*?getProbationRows\(access\)/,
      "the probation count must come from the service behind /probation — the page it links to — so the number and its destination cannot describe different people",
    );
    assert.doesNotMatch(
      ceoSource,
      /\.from\("probation_evaluations"\)/,
      "a raw probation_evaluations scan reads rows whose end date has passed, joins no employment_status and applies no medical-representative rule: every one of those people is absent from /probation",
    );
    assert.match(
      ceoSource,
      /isActiveLifecycleStatus\(row\.employment_status\)/,
      "getProbationRows applies NO employment-status filter — it is built from the directory's hire+90 window and the tracker's own status filter defaults to \"all\" — so without this the tile bills a resigned probationer (production: PD-0003, 10 days remaining) to the CEO as a decision he still owes",
    );
    assert.doesNotMatch(
      ceoSource,
      /key: "probationOverdue"/,
      "no surface lists a probationer past their 90-day window, so an overdue attention item is a link to a table that cannot contain it",
    );
  }

  {
    const adminSource = readFileSync("src/lib/admin/command-center.ts", "utf8");
    assert.match(
      adminSource,
      /countUnoccupiedWorkforceSeats\(\{/,
      "the admin Data Health card is the second call site of the same defect and must share the one seat-dedup helper",
    );
    assert.doesNotMatch(
      adminSource,
      /workforceVacancies\.length/,
      "counting the raw lookup array is the defect itself — it reported 45 where the Organogram reported 33",
    );
  }
}

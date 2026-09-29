import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  buildVacancyHireHref,
  buildVacancyHireQuery,
  buildVacancyHireSeat,
  readVacancyHireSeat,
  vacancyHireSeatKey,
} from "../src/lib/employees/vacancy-hire-link.ts";
import { employeePortalDevPreviewData } from "../src/lib/employee-portal/dev-preview-data.ts";

/**
 * Pressing a VACANT box on the organogram opened a popup that described the seat and offered
 * nothing to do about it. Whoever was hiring into that seat then walked to Employees and
 * retyped the line, the area, the position and the manager the box had just shown them. The
 * popup now carries those across, and this pins the round trip: what the chart row holds must
 * arrive in the form, unchanged, for a seat in every shape production actually produces.
 */
export async function runOrganogramVacancyHireLinkTests() {
  // A real sales vacancy shape: every id present, both titles present.
  const repSeat = {
    areaId: 1096,
    areaName: "Cairo 1",
    departmentId: 2,
    jobTitle: "Medical Rep",
    lineId: 3,
    lineName: "CNS",
    managerHrId: "CN-0002",
    positionId: 11,
    positionTitle: "Medical Representative",
    regionName: "Cairo",
  };

  const href = buildVacancyHireHref("/employees", repSeat);
  const roundTripped = readVacancyHireSeat((key) =>
    new URL(href, "https://phoenix-hr.satopharma.com").searchParams.get(key),
  );

  assert.ok(roundTripped, "the marker must survive the round trip, or the form never opens");
  // The headline assertion: the four fields nobody should have to retype.
  assert.deepEqual(
    {
      areaId: roundTripped.areaId,
      lineId: roundTripped.lineId,
      managerHrId: roundTripped.managerHrId,
      positionId: roundTripped.positionId,
    },
    { areaId: "1096", lineId: "3", managerHrId: "CN-0002", positionId: "11" },
    "line, area, position and manager must arrive at the form exactly as the seat held them",
  );
  assert.equal(roundTripped.departmentId, "2", "the department travels too");
  assert.equal(roundTripped.regionName, "Cairo", "and the region");
  assert.equal(
    roundTripped.jobTitle,
    "Medical Representative",
    "positionTitle wins over jobTitle — the same preference the chart itself uses",
  );
  assert.equal(
    roundTripped.seatLabel,
    "Medical Representative · Cairo 1 · CNS",
    "the form names the seat it was opened for",
  );

  // An unrelated visit to /employees must be left completely alone: no marker, no prefill.
  assert.equal(
    readVacancyHireSeat(() => null),
    null,
    "without the marker the form must not open pre-filled",
  );
  assert.equal(
    readVacancyHireSeat((key) => (key === "vacancyArea" ? "1096" : null)),
    null,
    "a stray param without the marker is not a seat — the marker is the only trigger",
  );

  // A Head Office seat carries no area and no region, and only a jobTitle. It must still
  // travel: half a prefill is still better than none, and the empties must not become "null".
  const headOfficeSeat = buildVacancyHireSeat({
    areaId: null,
    areaName: null,
    departmentId: 7,
    jobTitle: "Product Manager",
    lineId: null,
    lineName: null,
    managerHrId: null,
    positionId: 42,
    positionTitle: "",
    regionName: null,
  });
  assert.deepEqual(
    headOfficeSeat,
    {
      areaId: "",
      departmentId: "7",
      jobTitle: "Product Manager",
      lineId: "",
      managerHrId: "",
      positionId: "42",
      regionName: "",
      seatLabel: "Product Manager",
    },
    "a seat with no area, line or manager keeps what it does have and blanks the rest",
  );
  const headOfficeQuery = buildVacancyHireQuery({
    departmentId: 7,
    jobTitle: "Product Manager",
    positionId: 42,
  });
  assert.ok(
    !headOfficeQuery.includes("vacancyArea") && !headOfficeQuery.includes("vacancyLine"),
    "an absent field is left OUT of the URL, never sent as an empty or literal 'null'",
  );

  // Arabic and separators in a name survive encoding — the label is shown verbatim on the form.
  const arabicHref = buildVacancyHireHref("/employee-portals/employees", {
    areaId: 12,
    areaName: "الهرم - فيصل",
    lineId: 1,
    lineName: "Pedia",
    positionTitle: "Medical Representative",
  });
  assert.ok(
    arabicHref.startsWith("/employee-portals/employees?hireVacancy=1"),
    "the portal shell gets its own Employees route, and the marker leads the query",
  );
  const arabicSeat = readVacancyHireSeat((key) =>
    new URL(arabicHref, "https://phoenix-hr.satopharma.com").searchParams.get(key),
  );
  assert.equal(
    arabicSeat?.seatLabel,
    "Medical Representative · الهرم - فيصل · Pedia",
    "an Arabic area name survives the URL round trip unmangled",
  );

  // Two different seats must not be mistaken for each other — the key is what makes the
  // pre-fill apply once per arrival rather than reopening a form the user just closed.
  assert.notEqual(
    vacancyHireSeatKey(buildVacancyHireSeat(repSeat)),
    vacancyHireSeatKey(buildVacancyHireSeat({ ...repSeat, areaId: 1097 })),
    "two seats that differ only by area must produce different keys",
  );

  // The popup is the only door to this, and it must stay shut for a viewer who cannot hire —
  // POST /api/employees asserts employees:update, so offering it otherwise is a dead end.
  const modalSource = fs.readFileSync(
    path.join(
      process.cwd(),
      "src",
      "components",
      "organogram",
      "organogram-node-detail-modal.tsx",
    ),
    "utf8",
  );
  assert.ok(
    modalSource.includes("canAddEmployee ? ("),
    "the Add-employee button must stay behind the canAddEmployee gate",
  );

  for (const page of [
    path.join("app", "(admin)", "organogram", "page.tsx"),
    path.join("app", "employee-portals", "organogram", "page.tsx"),
    // The vacancies report is the OTHER place an open seat is listed, and it carries the
    // same one-press hire — both of its mounts must resolve the capability server-side too.
    path.join("app", "(admin)", "reports", "vacancies", "page.tsx"),
    path.join("src", "components", "workspace", "admin-shell-employee-pages.tsx"),
  ]) {
    const source = fs.readFileSync(path.join(process.cwd(), page), "utf8");
    assert.ok(
      source.includes('canAccess(access, "employees", "update")'),
      `${page} must resolve canAddEmployee server-side from the real capability, never client-side`,
    );
  }

  // A VacancyReportRow carries the same ids an organogram row does, which is what lets one
  // link builder serve both surfaces. If that ever drifts, the report's rows would start
  // producing an empty prefill silently — so assert the real shape round-trips.
  const reportRow = {
    areaId: 1102,
    areaName: "Alexandria 2",
    departmentId: 2,
    jobTitle: "Medical Rep",
    lineId: 5,
    lineName: "Pedia",
    managerHrId: "PD-0012",
    positionId: 11,
    positionTitle: "Medical Representative",
    regionName: "Alex-BHR",
  };
  const reportSeat = readVacancyHireSeat((key) =>
    new URL(
      buildVacancyHireHref("/employees", reportRow),
      "https://phoenix-hr.satopharma.com",
    ).searchParams.get(key),
  );
  assert.equal(reportSeat?.areaId, "1102", "a vacancies-report row must fill the area too");
  assert.equal(
    reportSeat?.managerHrId,
    "PD-0012",
    "and its manager — the field the report already prints beside the row",
  );

  // The report's own gate, and the rule that it must not widen the table: the action rides
  // inside the status cell, because that table already scrolls sideways at desktop width.
  const reportSource = fs.readFileSync(
    path.join(process.cwd(), "src", "components", "reports", "vacancies-report.tsx"),
    "utf8",
  );
  assert.ok(
    reportSource.includes('canAddEmployee && row.status === "open"'),
    "the report's hire action must be gated on both the capability and an OPEN row",
  );
  assert.equal(
    (reportSource.match(/<th className="px-4 py-3">/g) ?? []).length,
    9,
    "the hire action must NOT add a tenth column — the rule is fit by merging, never widening",
  );

  // The employee-portal vacancies page is a THIRD surface with its own service, and its row
  // used to carry names only. The ids are what the Add Employee form matches on, so a row
  // without them produces a link that fills nothing — silently, which is the whole risk.
  const portalService = fs.readFileSync(
    path.join(process.cwd(), "src", "lib", "employee-portal", "service.ts"),
    "utf8",
  );
  for (const field of ["areaId", "departmentId", "lineId", "positionId"]) {
    assert.ok(
      new RegExp(`export type EmployeePortalVacancyRow = \\{[^}]*\\b${field}\\b`, "s").test(
        portalService,
      ),
      `EmployeePortalVacancyRow must carry ${field} — without the ids the portal prefill is empty`,
    );
  }
  assert.ok(
    /\.select\(\s*(?:\/\/[^\n]*\n\s*)*"[^"]*\bdepartment_id\b[^"]*"/.test(portalService),
    "department_id must be SELECTED, or the mapped field is null however the row is typed",
  );

  const portalPage = fs.readFileSync(
    path.join(process.cwd(), "app", "employee-portals", "vacancies", "page.tsx"),
    "utf8",
  );
  assert.ok(
    portalPage.includes('canAccess(access, "employees", "update")'),
    "the portal page must resolve the capability server-side — it is read by managers who cannot hire",
  );
  assert.ok(
    portalPage.includes('canAddEmployee && vacancy.status === "open"'),
    "the portal hire action must be gated on both the capability and an OPEN vacancy",
  );
  assert.ok(
    portalPage.includes('buildVacancyHireHref("/employee-portals/employees"'),
    "a portal row must link to the PORTAL Employees route, never the admin one",
  );
  // That table is table-fixed with a colgroup summing to 100% and no horizontal scroller.
  assert.equal(
    (portalPage.match(/<col className="w-\[/g) ?? []).length,
    6,
    "the portal table must stay at six columns — a seventh breaks the colgroup and the screen",
  );

  // The dev-preview fixtures are the OTHER constructor of this row, and adding the ids to the
  // type without adding them here is exactly what turned `checks` red on the first attempt at
  // this change. Read the emitted objects rather than the source, so a fixture that compiles
  // but carries nothing still fails.
  const previewVacancies =
    employeePortalDevPreviewData.overview.vacancyDetails?.vacancies ?? [];
  assert.ok(
    previewVacancies.length > 0,
    "the dev preview must still carry vacancy rows, or this guard is checking nothing",
  );
  for (const vacancy of previewVacancies) {
    for (const field of ["areaId", "departmentId", "lineId", "positionId"] as const) {
      assert.equal(
        typeof vacancy[field],
        "number",
        `dev preview vacancy ${vacancy.vacancyCode} must carry a real ${field}`,
      );
    }
  }
}

import assert from "node:assert/strict";

import {
  EMPTY_ORGANOGRAM_AUDIENCE_FILTERS,
  ORGANOGRAM_EXPORT_COLUMNS,
  buildOrganogramAudienceOptions,
  buildOrganogramExportRows,
  collectOrganogramAudienceEmails,
  isOrganogramCompanyEmail,
  filterOrganogramAudience,
  formatOrganogramEmailList,
  organogramAudienceKey,
  resolveOrganogramAudienceSelection,
} from "../src/lib/reports/organogram-audience.ts";
import type { OrganogramRow } from "../src/lib/reports/organogram-view-model.ts";

/**
 * The organogram "Select & email" picker: who a viewer's filters and ticks resolve to,
 * which addresses come out of that, and — the part that must never regress — which
 * columns the sheet is allowed to carry.
 *
 * Owner instruction, 2026-08-22: the export is "work fields only", no personal data.
 * Both the sheet and the clipboard are BULK surfaces reaching everyone in the viewer's
 * scope at once, unlike the one-person node popup that gates Personal + Compensation
 * behind canViewOrganogramSensitiveFields. The denylist test below is what stops a
 * later session quietly adding a salary or national-ID column to "complete" the export.
 */

function row(overrides: Partial<OrganogramRow> & Pick<OrganogramRow, "hrId">): OrganogramRow {
  const name = overrides.fullName ?? overrides.hrId;
  return {
    areaId: null,
    areaName: null,
    contractRenewalDate: null,
    contractType: null,
    departmentId: null,
    departmentName: null,
    displayName: name,
    employeeDepartmentName: null,
    employeeJobTitle: null,
    employeeTeamName: null,
    employmentStatus: "active",
    fullName: name,
    hireDate: null,
    jobTitle: "Medical Representative",
    lineId: 1,
    lineName: "Anti infective",
    managerHrId: null,
    managerName: null,
    nameAr: null,
    positionId: null,
    positionTitle: "Medical Representative",
    regionName: "Upper Egypt",
    seatId: `SEAT-${overrides.hrId}`,
    sourceRowNumber: null,
    status: "active",
    teamId: null,
    teamName: null,
    type: "employee",
    vacancyCode: null,
    workEmail: null,
    ...overrides,
  };
}

const CEO = row({
  hrId: "CEO-1",
  fullName: "Chief Executive",
  jobTitle: "CEO",
  positionTitle: "CEO",
  lineName: null,
  regionName: null,
  areaName: null,
  workEmail: "ceo@satopharma.com",
});

const MINIA = row({
  hrId: "B-1",
  fullName: "Acting District Manager",
  areaName: "Minia 1",
  // The live acting-DM shape: the CHART title is the seat tier's, while the HR record
  // deliberately still says Medical Representative.
  jobTitle: "District Sales Manager",
  positionTitle: "District Sales Manager",
  employeeJobTitle: "Medical Representative",
  employeeDepartmentName: "Sales",
  employeeTeamName: "Upper Egypt",
  workEmail: "Acting.DM@satopharma.com",
});

const ASSIUT = row({
  hrId: "AI-0100",
  fullName: "Assiut Rep",
  areaName: "Assiut",
  workEmail: "assiut.rep@satopharma.com",
});

const GIZA = row({
  hrId: "AI-0200",
  fullName: "Giza Rep",
  areaName: "Giza 2",
  regionName: "Cairo & Giza",
  workEmail: "giza.rep@satopharma.com",
});

const PEDIA = row({
  hrId: "PD-0300",
  fullName: "Pedia Rep",
  areaName: "Tanta",
  lineName: "Pedia",
  regionName: "Delta",
  workEmail: "pedia.rep@satopharma.com",
});

const NO_EMAIL = row({
  hrId: "AI-0400",
  fullName: "Rep Without Email",
  areaName: "Assiut",
  workEmail: "   ",
});

const OPEN_SEAT = row({
  hrId: "SEAT-AIF-DM-UE-2",
  seatId: "SEAT-AIF-DM-UE-2",
  fullName: "Vacant",
  displayName: "Vacant",
  areaName: "Upper Egypt 2",
  jobTitle: "District Sales Manager",
  positionTitle: "District Sales Manager",
  employmentStatus: null,
  status: "open",
  type: "vacancy",
  workEmail: null,
});

const ROWS: OrganogramRow[] = [CEO, MINIA, ASSIUT, GIZA, PEDIA, NO_EMAIL, OPEN_SEAT];

export function runOrganogramAudienceTests() {
  /* ---------------- filtering ---------------- */

  // Open seats are out by default — nobody to email — and in when asked for.
  const everyone = filterOrganogramAudience(ROWS, EMPTY_ORGANOGRAM_AUDIENCE_FILTERS);
  assert.equal(everyone.length, 6, "open seats must be excluded by default");
  assert.equal(
    filterOrganogramAudience(ROWS, {
      ...EMPTY_ORGANOGRAM_AUDIENCE_FILTERS,
      includeOpenSeats: true,
    }).length,
    7,
    "includeOpenSeats must bring the vacant seat back",
  );

  // A row with NO value for the facet under filter is out, never swept in: filtering to
  // one line must not hand you the (line-less) CEO's address.
  const antiInfective = filterOrganogramAudience(ROWS, {
    ...EMPTY_ORGANOGRAM_AUDIENCE_FILTERS,
    lineNames: ["Anti infective"],
  });
  assert.deepEqual(
    antiInfective.map((entry) => entry.hrId).sort(),
    ["AI-0100", "AI-0200", "AI-0400", "B-1"],
    "line filter must exclude both the other line and the line-less CEO",
  );

  // Region + area compose, and the match is case/whitespace-insensitive.
  const upperEgypt = filterOrganogramAudience(ROWS, {
    ...EMPTY_ORGANOGRAM_AUDIENCE_FILTERS,
    regionNames: ["  upper egypt "],
  });
  assert.deepEqual(
    upperEgypt.map((entry) => entry.hrId).sort(),
    ["AI-0100", "AI-0400", "B-1"],
    "region filter must normalize case and spacing",
  );

  // Search reaches the work email, not just the name.
  const bySearch = filterOrganogramAudience(ROWS, {
    ...EMPTY_ORGANOGRAM_AUDIENCE_FILTERS,
    search: "giza.rep@",
  });
  assert.deepEqual(bySearch.map((entry) => entry.hrId), ["AI-0200"]);

  /* ---------------- cascading options ---------------- */

  const wideOptions = buildOrganogramAudienceOptions(ROWS, EMPTY_ORGANOGRAM_AUDIENCE_FILTERS);
  assert.deepEqual(wideOptions.lineNames, ["Anti infective", "Pedia"]);
  assert.ok(wideOptions.areaNames.includes("Tanta"), "every area is offered when nothing is picked");

  const scopedOptions = buildOrganogramAudienceOptions(ROWS, {
    ...EMPTY_ORGANOGRAM_AUDIENCE_FILTERS,
    lineNames: ["Anti infective"],
  });
  assert.ok(
    !scopedOptions.areaNames.includes("Tanta"),
    "picking a line must shrink the area list to that line's areas",
  );
  assert.deepEqual(
    scopedOptions.lineNames,
    ["Anti infective", "Pedia"],
    "a facet must keep offering its own alternatives so a pick can be swapped",
  );

  // A chip that another facet has since excluded must still be listed, or it could
  // never be un-picked.
  const strandedOptions = buildOrganogramAudienceOptions(ROWS, {
    ...EMPTY_ORGANOGRAM_AUDIENCE_FILTERS,
    lineNames: ["Pedia"],
    areaNames: ["Assiut"],
  });
  assert.ok(
    strandedOptions.areaNames.includes("Assiut"),
    "an already-picked value must stay in its own list even when it now matches nobody",
  );

  /* ---------------- selection ---------------- */

  // No ticks = "everyone I filtered to" — the one-press path.
  assert.deepEqual(
    resolveOrganogramAudienceSelection(antiInfective, new Set()).map((entry) => entry.hrId).sort(),
    ["AI-0100", "AI-0200", "AI-0400", "B-1"],
    "an empty tick set must mean every filtered row",
  );

  // Ticks win — and a tick left over from an earlier filter cannot leak a person back
  // in, because the tick set is intersected with the filtered rows.
  const ticks = new Set([organogramAudienceKey(ASSIUT), organogramAudienceKey(PEDIA)]);
  assert.deepEqual(
    resolveOrganogramAudienceSelection(antiInfective, ticks).map((entry) => entry.hrId),
    ["AI-0100"],
    "a stale tick outside the current filter must not resurface",
  );

  /* ---------------- emails ---------------- */

  const collected = collectOrganogramAudienceEmails([
    MINIA,
    ASSIUT,
    NO_EMAIL,
    OPEN_SEAT,
    // Same person, second seat, address differing only by case: one address out.
    { ...MINIA, seatId: "SEAT-AIF-REP-UE1", workEmail: "acting.dm@satopharma.com" },
  ]);
  assert.deepEqual(
    collected.emails,
    ["Acting.DM@satopharma.com", "assiut.rep@satopharma.com"],
    "addresses dedupe case-insensitively and keep the first spelling",
  );
  assert.deepEqual(
    collected.missing.map((person) => person.hrId),
    ["AI-0400"],
    "a whitespace-only work email counts as missing, never as an address",
  );
  assert.equal(collected.openSeats, 1, "open seats are reported, not silently dropped");

  // A personal address typed into work_email (2026-10-20: three new reps, one as "gamil.com")
  // must never reach the clipboard — it is listed as left out, like a missing address.
  const personal = collectOrganogramAudienceEmails([
    MINIA,
    { ...ASSIUT, hrId: "AI-0024", workEmail: "someone@gmail.com" },
    { ...ASSIUT, hrId: "PD-0016", workEmail: "someone@gamil.com" },
    { ...ASSIUT, hrId: "PD-0017", workEmail: "lookalike@notsatopharma.com" },
  ]);
  assert.deepEqual(personal.emails, ["Acting.DM@satopharma.com"], "only company addresses survive");
  assert.deepEqual(
    personal.missing.map((person) => person.hrId),
    ["AI-0024", "PD-0016", "PD-0017"],
    "a personal or look-alike domain is left out and named, never copied",
  );
  assert.equal(isOrganogramCompanyEmail("Jonia.Wageh@SatoPharma.com"), true);
  assert.equal(isOrganogramCompanyEmail("a@mail.satopharma.com"), true);
  assert.equal(isOrganogramCompanyEmail("a@gmail.com"), false);
  assert.equal(isOrganogramCompanyEmail("a@notsatopharma.com"), false);
  assert.equal(isOrganogramCompanyEmail("satopharma.com"), false);

  assert.equal(
    formatOrganogramEmailList(["a@x.test", "b@x.test"]),
    "a@x.test; b@x.test",
    "the clipboard separator is the semicolon every mail client accepts",
  );

  /* ---------------- export shape ---------------- */

  const columnKeys = ORGANOGRAM_EXPORT_COLUMNS.map((column) => column.key);
  assert.equal(new Set(columnKeys).size, columnKeys.length, "export column keys must be unique");

  // THE LOCK: no personal or compensation field may reach the sheet. Checked on the
  // column keys AND the labels, so neither a renamed key nor a relabelled column slips
  // one past. If this test fails, the fix is to remove the column — not to widen the list.
  //
  // "mobile" was on this list until 2026-08-23, when the owner asked for the number in the
  // export. It came off for that reason and no other — the number still never rides on the
  // row, which tests/organogram-whatsapp-gate.test.ts pins. Nothing else comes off without
  // the same kind of instruction.
  const FORBIDDEN = [
    "salary",
    "gross",
    "net",
    "basic",
    "wage",
    "bank",
    "tax",
    "insurance",
    "allowance",
    "national",
    "nid",
    "birth",
    "dob",
    "gender",
    "address",
    "residence",
    "education",
    "phone",
    "passport",
  ];
  for (const column of ORGANOGRAM_EXPORT_COLUMNS) {
    const haystack = `${column.key} ${column.label}`.toLowerCase();
    for (const banned of FORBIDDEN) {
      assert.ok(
        !haystack.includes(banned),
        `organogram export column "${column.label}" looks like personal or pay data ("${banned}") — the sheet is work fields only`,
      );
    }
  }

  // No numeric column, so the builder adds no SUM row: totalling HR IDs is nonsense.
  assert.ok(
    ORGANOGRAM_EXPORT_COLUMNS.every((column) => !column.numeric),
    "no organogram export column may be numeric",
  );

  const exported = buildOrganogramExportRows([MINIA, OPEN_SEAT]);
  assert.equal(exported.length, 2);

  // Every emitted cell must belong to a declared column — a stray key is silently
  // dropped by the workbook builder, which reads as "the data was empty".
  for (const exportedRow of exported) {
    for (const key of Object.keys(exportedRow)) {
      assert.ok(columnKeys.includes(key), `export row carries an undeclared column "${key}"`);
    }
  }

  // The acting DM: the chart's seat title AND her real HR title, side by side.
  assert.equal(exported[0].title, "District Sales Manager");
  assert.equal(exported[0].hrJobTitle, "Medical Representative");
  assert.equal(exported[0].workEmail, "Acting.DM@satopharma.com");
  assert.equal(exported[0].status, "Active");

  // Department and Team come from the export-only twins. The row's own departmentName /
  // teamName stay null on the seat path because the CHART keys on them — if this ever
  // reads from those instead, the organogram's own classification has been changed.
  assert.equal(exported[0].department, "Sales");
  assert.equal(exported[0].team, "Upper Egypt");
  assert.equal(MINIA.departmentName, null, "the chart-visible departmentName must stay null");
  assert.equal(MINIA.teamName, null, "the chart-visible teamName must stay null");

  // A vacant seat exports as a seat, never as a person with an empty name.
  assert.equal(exported[1].name, "Open Vacancy");
  assert.equal(exported[1].type, "Vacancy");
  assert.equal(exported[1].status, "Open Seat");
  assert.equal(exported[1].workEmail, "");
  assert.equal(exported[1].seatId, "SEAT-AIF-DM-UE-2");

  // The Mobile column is filled from the SERVER, at export time, never from the row —
  // which is why the call above leaves it empty and this one does not.
  assert.equal(
    exported[0].mobile,
    "",
    "without the server's numbers the mobile cell is empty, not absent — an absent key would be an undeclared column",
  );
  const withNumbers = buildOrganogramExportRows(
    [MINIA, OPEN_SEAT],
    new Map([[MINIA.hrId.toLowerCase(), "01001234567"]]),
  );
  assert.equal(withNumbers[0].mobile, "01001234567");
  assert.equal(withNumbers[1].mobile, "", "an open seat has nobody to call");
}

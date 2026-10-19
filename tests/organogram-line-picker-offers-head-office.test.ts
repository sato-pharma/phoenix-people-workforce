import assert from "node:assert/strict";

import {
  buildLinePickerOptions,
  buildOrganogramLanes,
  filterOrganogramRows,
  isOrganogramVisibleRow,
  type OrganogramRow,
} from "../src/lib/reports/organogram-view-model.ts";
import { canAccessCompanyOrganogram, canAccessHeadOffice } from "../src/lib/reports/organogram.ts";
import type { AccessContext } from "../src/lib/auth/permissions.ts";

/**
 * The portal Organogram line picker, and why Head Office kept not appearing.
 *
 * ## The bug this pins
 *
 * Two PRs granted HR Advisory the Head Office branch — #2408 built the branch (the AU
 * seat model has zero Head Office seats, so it had never existed for anyone) and put her in
 * `canAccessHeadOffice`, #2410 added navigation entries. She still saw only the four sales
 * lines, because neither PR touched the thing that actually decides what the chart draws.
 *
 * The employee portal builds its picker itself. Its option list ran
 * `if (isOfficeLine(row)) continue` unconditionally, so the Head Office rows arrived in her
 * browser — past the permission gate, past the company-mode strip — and were then dropped by
 * the last filter in the chain, one that knows nothing about entitlement. Nothing errored;
 * the branch simply had no button to open it. The admin surface never had this bug: its
 * `lineOptions` in organogram-report.tsx ADDS office rows rather than skipping them.
 *
 * ## What must stay true
 *
 * The exclusion was not wrong, only unconditional. Head Office rows reach a report by two
 * routes and only one of them may be selectable — see buildLinePickerOptions. So this test
 * asserts BOTH directions: the branch is offered to a viewer cleared for it, and is still
 * withheld from one who is not. A test that only checked the new direction would pass just
 * as well against a picker that offers Head Office to everybody.
 */

const ctx = (role: string, scope: AccessContext["scope"] = "company"): AccessContext =>
  ({ hrId: "T-1", role, scope }) as unknown as AccessContext;

function row(overrides: Partial<OrganogramRow> = {}): OrganogramRow {
  return {
    areaId: null,
    areaName: null,
    departmentId: null,
    departmentName: "Sales",
    displayName: "Person",
    fullName: "Person",
    hireDate: null,
    hrId: "X-1",
    jobTitle: "Medical Rep",
    lineId: 1,
    lineName: "Pedia",
    managerHrId: null,
    managerName: null,
    positionId: null,
    positionTitle: "Medical Rep",
    regionName: null,
    type: "employee",
    ...overrides,
  } as unknown as OrganogramRow;
}

const headOffice = (overrides: Partial<OrganogramRow> = {}) =>
  row({
    departmentName: "Finance",
    hrId: "HO-1",
    jobTitle: "Accountant",
    lineId: 4,
    lineName: "Head Office",
    managerHrId: "AA",
    positionTitle: "Accountant",
    ...overrides,
  });

export function runOrganogramLinePickerHeadOfficeTests() {
  const ceo = row({
    departmentName: "Head Office",
    hrId: "AA",
    jobTitle: "Chief Executive Officer",
    lineId: 4,
    lineName: "Head Office",
    managerHrId: null,
    positionTitle: "Chief Executive Officer",
  });

  const rows: OrganogramRow[] = [
    ceo,
    headOffice({ fullName: "Finance One", hrId: "HO-1" }),
    headOffice({ fullName: "Finance Two", hrId: "HO-2", managerHrId: "HO-1" }),
    row({ fullName: "Pedia Rep", hrId: "P-1", lineId: 1, lineName: "Pedia" }),
    row({ fullName: "CNS Rep", hrId: "C-1", lineId: 2, lineName: "CNS" }),
    row({ fullName: "AI Rep", hrId: "A-1", lineId: 3, lineName: "Anti Infective" }),
  ];

  // ── 1. Withheld by default — the Product Manager chain-context case ──────────────────
  // A line-scoped viewer's report carries Office ancestors only so the tree has a root.
  // Offering "Head Office" there would open a department they were never cleared for.
  const withheld = buildLinePickerOptions(rows);
  assert.deepEqual(
    withheld,
    ["Anti Infective", "CNS", "Pedia"],
    "Head Office must not be offered when the caller does not pass includeHeadOffice",
  );
  assert.equal(
    buildLinePickerOptions(rows, { includeHeadOffice: false }).includes("Head Office"),
    false,
    "an explicit false must behave exactly like the default",
  );

  // ── 2. Offered when the viewer is entitled — the bug ────────────────────────────────
  const offered = buildLinePickerOptions(rows, { includeHeadOffice: true });
  assert.equal(
    offered.includes("Head Office"),
    true,
    "a viewer who passes canAccessHeadOffice must be offered the branch",
  );
  assert.deepEqual(
    offered,
    ["Anti Infective", "CNS", "Head Office", "Pedia"],
    "the sales lines must be unaffected, and the list stays sorted",
  );

  // ── 3. Selecting it actually draws the branch ───────────────────────────────────────
  // An option that filters to nothing is the same defect wearing a button. filterOrganogramRows
  // special-cases an Office selection, so prove the branch survives the filter the chart runs.
  const visible = rows.filter((candidate) => isOrganogramVisibleRow(candidate));
  const drawn = filterOrganogramRows(visible, "Head Office", "");
  const drawnIds = drawn.map((candidate) => candidate.hrId).sort();
  assert.deepEqual(
    drawnIds,
    ["AA", "HO-1", "HO-2"],
    "selecting Head Office must draw the Head Office people, not an empty chart",
  );
  assert.equal(
    drawn.some((candidate) => candidate.hrId === "P-1"),
    false,
    "selecting Head Office must not drag a sales line in with it",
  );

  // ── 4. A sales selection is unchanged by the new option ─────────────────────────────
  const pedia = filterOrganogramRows(visible, "Pedia", "");
  assert.equal(
    pedia.some((candidate) => candidate.hrId === "P-1"),
    true,
    "the Pedia rep still appears on the Pedia chart",
  );
  assert.equal(
    pedia.some((candidate) => candidate.hrId === "HO-1"),
    false,
    "a Head Office person must never ride onto a sales line chart",
  );

  // ── 4b. The CEO as the SEAT MODEL emits him — the box that read "Executive Leadership" ──
  // The CEO fixture above is the legacy shape (line and department both "Head Office"), which is why
  // nothing here noticed him disappearing. Production's CEO seat row has NO line and NO department
  // (`departmentName` is null on every seat row; the CEO seat belongs to no line). Both pages filter
  // with isOrganogramVisibleRow BEFORE the chart runs, and none of its tests admitted that row — so
  // the spine's CEO box had no row behind it and showed no name, no data, and was not pressable.
  const seatCeo = row({
    departmentName: null,
    displayName: "Anwar Gaweesh",
    fullName: "Anwar Gaweesh",
    hrId: "AA",
    jobTitle: "CEO",
    lineId: null,
    lineName: null,
    managerHrId: null,
    positionTitle: "CEO",
  });
  assert.equal(
    isOrganogramVisibleRow(seatCeo),
    true,
    "the CEO's seat row (no line, no department) must pass the page's visibility filter",
  );
  const seatRows: OrganogramRow[] = [
    seatCeo,
    headOffice({ fullName: "Finance One", hrId: "HO-1" }),
    row({ fullName: "Pedia Rep", hrId: "P-1", lineId: 1, lineName: "Pedia" }),
  ];
  const seatVisible = seatRows.filter((candidate) => isOrganogramVisibleRow(candidate));
  for (const line of ["Head Office", "Pedia"]) {
    const lanes = buildOrganogramLanes(filterOrganogramRows(seatVisible, line, ""));
    assert.equal(
      lanes.chiefExecutive?.hrId,
      "AA",
      `the ${line} chart must have the CEO behind its top box, with his own row`,
    );
  }
  assert.equal(
    buildOrganogramLanes(filterOrganogramRows(seatVisible, "Head Office", "")).groups.some(
      (group) => group.name === "CEO Direct Reports",
    ),
    true,
    "the Head Office people who report to the CEO are grouped under him, not under \"Manager AA\"",
  );

  // ── 5. The entitlement the page reads to set the flag ───────────────────────────────
  // showHeadOfficeLine = isCompanyScoped && canAccessHeadOffice. Both halves matter: the
  // second alone would offer the branch to a line-scoped viewer holding chain context, and
  // the first alone would offer it to every company role including the ones it is stripped for.
  for (const role of [
    "Super Admin",
    "CEO",
    // The Talent Acquisition seat, in the place of the HR Business Partner retired 2026-10-08.
    "HR Resourcing",
    "Finance Manager",
    "Training Manager",
    "SFE Manager",
  ]) {
    assert.equal(canAccessCompanyOrganogram(ctx(role)), true, `${role} opens a company chart`);
    assert.equal(canAccessHeadOffice(ctx(role)), true, `${role} is cleared for Head Office`);
  }
  // The "still withheld from someone" half. Every NAMED role is cleared as of 2026-09-03, so this
  // is carried by a synthetic context rather than a role: scope `company` on a role the helper does
  // not name must still be refused, which is what fails if the entitlement is ever replaced by a
  // bare scope check. A test that only asserted the cleared roles above would pass just as well
  // against a picker that offers Head Office to everybody — the failure this file exists for.
  assert.equal(
    canAccessHeadOffice(ctx("National Sales Manager", "company")),
    false,
    "an unnamed role at scope `company` must NOT be offered Head Office",
  );
  assert.equal(
    canAccessCompanyOrganogram(ctx("National Sales Manager", "company")),
    false,
    "…and must not reach a company chart either, so it cannot be offered the picker at all",
  );
}

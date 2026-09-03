import assert from "node:assert/strict";

import {
  buildHeadOfficeOrganogramRows,
  HEAD_OFFICE_LINE_ID,
  HEAD_OFFICE_LINE_NAME,
  type HeadOfficeEmployeeRow,
} from "../src/lib/reports/organogram-head-office.ts";
import { scopeAuOrganogramRows } from "../src/lib/reports/organogram-au-source.ts";
import { canAccessHeadOffice, isHeadOfficeRow } from "../src/lib/reports/organogram.ts";
import type { AccessContext } from "../src/lib/auth/permissions.ts";

/**
 * The Head Office branch of the organogram.
 *
 * ## The bug this pins
 *
 * The organogram is drawn from the AU seat model, which describes the SALES force only —
 * CEO / NSM / RSM / DM / REP, every seat below the root on a sales line. Head Office has no
 * seats there. Measured on production 2026-08-25, `au_v_org_tree` held 1 CEO seat plus Anti
 * Infective, Pedia and CNS, and ZERO rows for line_id 4, so the 14 active Head Office
 * employees appeared on nobody's chart at all — not a Super Admin's, not the CEO's.
 *
 * `canAccessHeadOffice` and `isHeadOfficeRow` had been in place the whole time, filtering a
 * set that was always empty. That is why the hole was invisible: stripping nothing from
 * nothing raises no error, and the gate reads as healthy in every test that only asks who is
 * allowed rather than what they actually receive.
 *
 * ## The two invariants worth a test
 *
 * Both concern the LINE stamped on a Head Office row, and getting either wrong produces a
 * silent over-disclosure rather than a crash:
 *
 *   1. `isHeadOfficeRow` must recognise the row, or the company-mode strip in
 *      `getOrganogramReport` stops removing the branch for viewers without access.
 *   2. `scopeAuOrganogramRows` keeps every row whose `lineName` is null, treating it as
 *      line-less leadership. A Head Office row left line-less would therefore ride onto
 *      EVERY line-scoped chart — an NSM opening his Pedia view would find the CEO's finance
 *      department in it.
 */

const ctx = (role: string, scope: AccessContext["scope"] = "company"): AccessContext =>
  ({ hrId: "T-1", role, scope }) as unknown as AccessContext;

function employee(overrides: Partial<HeadOfficeEmployeeRow> = {}): HeadOfficeEmployeeRow {
  return {
    employment_status: "active",
    full_name: "Head Office Person",
    hr_id: "HO-X",
    job_title: "Office Coordinator",
    line_id: HEAD_OFFICE_LINE_ID,
    manager_hr_id: "AA",
    organogram_visible: true,
    ...overrides,
  };
}

const OPTIONS = { ceoNodeKey: "AA", occupiedHrIds: new Set<string>() };

export function runOrganogramHeadOfficeBranchTests() {
  // ── 1. The headline: the branch exists at all ────────────────────────────────────────
  // Break the fix (return [] from buildHeadOfficeOrganogramRows) and THIS is the assert
  // that fires — not an adjacent one.
  const ceoDirects = [
    employee({ full_name: "Ahmed El Maraghy", hr_id: "B-185", job_title: "Finance and Admin Manager" }),
    employee({ full_name: "Omar Anwar Gawish", hr_id: "B-10", job_title: "Hr Manager" }),
  ];
  const staff = [
    employee({ full_name: "Mahmoud Ibrahim", hr_id: "A-1", job_title: "Admin Assistant", manager_hr_id: "B-185" }),
    employee({ full_name: "Youmna Kotb", hr_id: "A-16", job_title: "HR Advisory", manager_hr_id: "B-10" }),
  ];
  const rows = buildHeadOfficeOrganogramRows([...ceoDirects, ...staff], OPTIONS);
  assert.equal(
    rows.length,
    4,
    "the Head Office branch must be emitted — the AU seat model has no Head Office seats, so if " +
      "this returns nothing the department is invisible on every chart in the product",
  );

  // ── 2. Invariant one: isHeadOfficeRow recognises every emitted row ───────────────────
  for (const row of rows) {
    assert.equal(row.lineId, HEAD_OFFICE_LINE_ID, `${row.hrId} must carry the Head Office line id`);
    assert.equal(row.lineName, HEAD_OFFICE_LINE_NAME, `${row.hrId} must carry the Head Office line name`);
    assert.equal(
      isHeadOfficeRow(row),
      true,
      `${row.hrId} must be recognised by isHeadOfficeRow, or the company-mode strip silently stops ` +
        "removing this branch for viewers without canAccessHeadOffice",
    );
  }

  // ── 3. Invariant two: the branch does NOT leak onto a line-scoped chart ──────────────
  // scopeAuOrganogramRows keeps any row whose lineName is null (CEO / line-less leadership),
  // so this is the assert that catches a Head Office row emitted without a line.
  const pediaOnly = scopeAuOrganogramRows(rows, { lineNames: ["Pedia"], mode: "line" });
  assert.equal(
    pediaOnly.length,
    0,
    "no Head Office row may survive a line-scoped view — an NSM's own line chart must never " +
      "sprout the CEO's departments",
  );
  // …and company mode still carries all of them, so the exclusion above is the line filter
  // doing its job and not the rows being malformed.
  assert.equal(scopeAuOrganogramRows(rows, { mode: "company" }).length, 4);

  // ── 4. Placement: the branch hangs off the CEO, and managers keep their own reports ──
  const byHrId = new Map(rows.map((row) => [row.hrId, row]));
  assert.equal(byHrId.get("B-185")?.managerHrId, "AA", "a CEO direct report must point at the CEO node");
  assert.equal(byHrId.get("B-10")?.managerHrId, "AA");
  assert.equal(byHrId.get("A-1")?.managerHrId, "B-185", "a manager's own staff must stay under that manager");
  assert.equal(byHrId.get("A-16")?.managerHrId, "B-10");
  assert.equal(
    byHrId.get("A-1")?.managerName,
    "Ahmed El Maraghy",
    "a manager INSIDE the branch is named; only the CEO's name is left to the seat model that owns his row",
  );
  assert.equal(byHrId.get("B-185")?.managerName, null);

  // ── 5. The CEO is never emitted twice ────────────────────────────────────────────────
  // He is Head Office staff himself (line_id 4) AND the seat model's root. Emitting him here
  // would put two rows on one node key — the duplicate-node failure the seat model's own
  // acting-DM collapse exists to prevent.
  const withCeo = buildHeadOfficeOrganogramRows(
    [employee({ full_name: "Anwar Gaweesh", hr_id: "AA", job_title: "Ceo", manager_hr_id: null }), ...ceoDirects],
    OPTIONS,
  );
  assert.equal(
    withCeo.some((row) => row.hrId === "AA"),
    false,
    "the CEO must not be re-emitted by the branch — the seat model already draws him as the root",
  );

  // Same guard for anyone who somehow holds an AU seat as well.
  const alsoSeated = buildHeadOfficeOrganogramRows(ceoDirects, {
    ceoNodeKey: "AA",
    occupiedHrIds: new Set(["b-185"]),
  });
  assert.equal(alsoSeated.some((row) => row.hrId === "B-185"), false, "a person already on an AU seat is not duplicated");

  // ── 6. Who is excluded: resigned, hidden, and other lines ────────────────────────────
  const mixed = buildHeadOfficeOrganogramRows(
    [
      employee({ hr_id: "KEEP-1" }),
      employee({ employment_status: "resigned", hr_id: "GONE-1" }),
      employee({ hr_id: "GONE-2", organogram_visible: false }),
      employee({ hr_id: "GONE-3", line_id: 2 }),
      employee({ employment_status: "historical_payroll_record", hr_id: "GONE-4" }),
      employee({ hr_id: "KEEP-2", employment_status: "on_leave" }),
    ],
    OPTIONS,
  );
  assert.deepEqual(
    mixed.map((row) => row.hrId).sort(),
    ["KEEP-1", "KEEP-2"],
    "only active/on-leave, organogram-visible, line_id 4 employees reach the chart",
  );

  // ── 7. A manager cycle must not hang the client's tree climb ─────────────────────────
  // The client builds the tree by climbing managerHrId. A cycle in employees.manager_hr_id
  // would loop forever, so the branch breaks it by re-homing to the CEO.
  const cyclic = buildHeadOfficeOrganogramRows(
    [
      employee({ hr_id: "C-1", manager_hr_id: "C-2" }),
      employee({ hr_id: "C-2", manager_hr_id: "C-1" }),
    ],
    OPTIONS,
  );
  const cyclicParents = new Map(cyclic.map((row) => [row.hrId, row.managerHrId]));
  assert.ok(
    cyclicParents.get("C-1") === "AA" || cyclicParents.get("C-2") === "AA",
    "a manager cycle must be broken by re-homing at least one end to the CEO, or the chart hangs",
  );

  // A manager outside the branch re-homes rather than orphaning: dropping the person would be
  // the exact failure this module exists to fix.
  const orphan = buildHeadOfficeOrganogramRows([employee({ hr_id: "O-1", manager_hr_id: "NOT-HERE" })], OPTIONS);
  assert.equal(orphan.length, 1);
  assert.equal(orphan[0]?.managerHrId, "AA");

  // ── 8. HR IDs are matched case-insensitively ─────────────────────────────────────────
  // This database stores HR IDs in mixed case — an `.eq` on the wrong casing already hid 28%
  // of reps' own direct orders once.
  const mixedCase = buildHeadOfficeOrganogramRows(
    [
      employee({ hr_id: "B-185" }),
      employee({ hr_id: "A-1", manager_hr_id: "b-185" }),
    ],
    { ceoNodeKey: "aa", occupiedHrIds: new Set() },
  );
  const mixedCaseByHrId = new Map(mixedCase.map((row) => [row.hrId, row]));
  assert.equal(
    mixedCaseByHrId.get("A-1")?.managerHrId,
    "B-185",
    "a lower-cased manager pointer must resolve, and must emit the manager's STORED casing so the " +
      "client's node lookup matches byte for byte",
  );

  // ── 9. No compensation or personal field ever rides on a chart row ───────────────────
  // Rows ship to every viewer's browser and land in a downloadable sheet, so a field here is a
  // bulk disclosure, not a one-person popup gated by canViewOrganogramSensitiveFields.
  const FORBIDDEN = [
    "salary", "basicSalary", "baseSalary", "grossSalary", "netSalary", "nationalId",
    "birthDate", "gender", "bankAccount", "residenceAddress", "mobileNumber", "taxes",
  ];
  for (const row of rows) {
    for (const field of FORBIDDEN) {
      assert.equal(
        field in (row as unknown as Record<string, unknown>),
        false,
        `${field} must never appear on an organogram row — it would be a standing bulk disclosure`,
      );
    }
  }

  // ── 10. The access gate the owner asked for ──────────────────────────────────────────
  // Owner instruction 2026-08-25: "in the admin account and talent acquisition show the head
  // office organogram." Both must hold, or the branch above is built and then stripped.
  assert.equal(canAccessHeadOffice(ctx("Super Admin")), true, "the admin account");
  assert.equal(canAccessHeadOffice(ctx("HR Advisory")), true, "…and HR Advisory");
  // Training Manager joined them 2026-09-03 (owner) — Head Office staff himself, so the branch
  // built above was being stripped from the one viewer who sits inside it.
  assert.equal(canAccessHeadOffice(ctx("Training Manager")), true, "…and Training Manager");
  // SFE Manager followed hours later the same day (owner: "same thing for sfe manager"). A-2 is
  // Head Office too — line_id 4, reporting to the CEO — so the branch built above was being
  // stripped from a second viewer who sits inside it.
  assert.equal(canAccessHeadOffice(ctx("SFE Manager")), true, "…and the SFE Manager");
  // Marketing Manager completed the sweep the same day ("marketing manager also"). A-9 is Head
  // Office too — line_id 4, reporting to the CEO — and is the LAST role that was being stripped.
  assert.equal(canAccessHeadOffice(ctx("Marketing Manager")), true, "…and the Marketing Manager");
  // The boundary itself still exists, and this is now the only thing proving it: an unnamed role
  // carrying scope `company` must still be refused. It is what fails if this helper is ever
  // collapsed to `access.scope === "company"`, now that no named role is left outside it.
  assert.equal(canAccessHeadOffice(ctx("National Sales Manager", "company")), false);
}

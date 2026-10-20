import assert from "node:assert/strict";

import {
  buildHeadOfficeOrganogramRows,
  HEAD_OFFICE_LINE_ID,
  HEAD_OFFICE_LINE_NAME,
  type HeadOfficeEmployeeRow,
  type HeadOfficeVacancyRow,
} from "../src/lib/reports/organogram-head-office.ts";
import { scopeAuOrganogramRows } from "../src/lib/reports/organogram-au-source.ts";
import { filterOrganogramRows } from "../src/lib/reports/organogram-view-model.ts";
import type { OrganogramReportRow } from "../src/lib/reports/vacancies.ts";

/**
 * Two things the Head Office branch could not draw, reported by the owner on 2026-08-28:
 * the marketing department's product managers, and any open Head Office seat.
 *
 * ## What was actually wrong
 *
 * Membership in the branch was `line_id = 4` and nothing else. Measured on production that
 * morning, exactly three active people held NO AU seat and were not line 4 —
 *
 *     Nahed Tarek Hattab (A-10)      Product Manager        line 1, reports to A-9
 *     Rasha Sabry Khalifa (A-8)      Group Product Manager  line 2, reports to A-9
 *     Ahmed Sharaf Eldeen (B-155)    Product Manager        line 2, reports to A-8
 *
 * — and all three were on no chart in the system. Not hidden by a permission: absent. The
 * Marketing Manager rendered with one report (the Training Manager) instead of four, and the
 * product-management arm did not exist.
 *
 * Their `line_id` is not the bug. It records which product line a marketer markets and feeds
 * sales attribution, targets and incentives, so "fixing" it to 4 would move real money to
 * repair a picture. Membership became the manager chain instead.
 *
 * Separately, HR rendered as a manager with nobody under him. Both HR seats were vacated on
 * 31 August and `position_vacancies` had auto-opened a row for each — the data was right, and
 * the chart drew employees only, so an open Head Office seat could not appear.
 *
 * ## Why the two live in one file
 *
 * They are the same question asked twice: what belongs on this branch? One answers it for
 * people, the other for empty seats. Each headline below is written so that reverting its own
 * half of the fix fires THAT assert and not an adjacent one.
 */

const HEAD_OFFICE = HEAD_OFFICE_LINE_ID;

function employee(overrides: Partial<HeadOfficeEmployeeRow> = {}): HeadOfficeEmployeeRow {
  return {
    employment_status: "active",
    full_name: "Person",
    hr_id: "X-1",
    job_title: "Officer",
    line_id: HEAD_OFFICE,
    manager_hr_id: "AA",
    organogram_visible: true,
    ...overrides,
  };
}

function vacancy(overrides: Partial<HeadOfficeVacancyRow> = {}): HeadOfficeVacancyRow {
  return {
    id: 1,
    job_title: "Open Role",
    line_id: HEAD_OFFICE,
    manager_hr_id: "AA",
    status: "open",
    ...overrides,
  };
}

const byHrId = (rows: OrganogramReportRow[], hrId: string): OrganogramReportRow | undefined =>
  rows.find((row) => String(row.hrId ?? "").toLowerCase() === hrId.toLowerCase());

/** The real shape: the marketing chain hanging off a Head Office Marketing Manager. */
const MARKETING = [
  employee({ full_name: "Hossam AboElftouh", hr_id: "A-9", job_title: "Marketing Manager", manager_hr_id: "AA" }),
  employee({ full_name: "Ahmed Elkawas", hr_id: "A-7", job_title: "Training Manager", manager_hr_id: "A-9" }),
  // The three that were invisible. Note the sales line_ids — that is the whole point.
  employee({ full_name: "Nahed Hattab", hr_id: "A-10", job_title: "Product Manager", line_id: 1, manager_hr_id: "A-9" }),
  employee({ full_name: "Rasha Khalifa", hr_id: "A-8", job_title: "Group Product Manager", line_id: 2, manager_hr_id: "A-9" }),
  employee({ full_name: "Ahmed Sharaf", hr_id: "B-155", job_title: "Product Manager", line_id: 2, manager_hr_id: "A-8" }),
];

export function runOrganogramHeadOfficeMarketingAndOpenSeatsTests() {
  // ── 1. HEADLINE A: a marketer on a sales line reaches the chart ──────────────────────
  // Revert membership to `line_id === HEAD_OFFICE_LINE_ID` alone and this is the assert that
  // fires. It is stated per person, so the failure names who went missing.
  const marketing = buildHeadOfficeOrganogramRows(MARKETING, {
    ceoNodeKey: "AA",
    occupiedHrIds: new Set<string>(),
  });
  for (const [hrId, who] of [
    ["A-10", "Nahed Hattab, Product Manager on the Anti Infective line"],
    ["A-8", "Rasha Khalifa, Group Product Manager on the Pedia line"],
    ["B-155", "Ahmed Sharaf, Product Manager on the Pedia line"],
  ] as const) {
    assert.ok(
      byHrId(marketing, hrId),
      `${who} reports into Head Office and holds no sales seat, so she must be drawn — this is the whole marketing arm being absent from every chart`,
    );
  }

  // ── 2. …under the RIGHT manager, and transitively ────────────────────────────────────
  // Ahmed Sharaf is two hops from Head Office: he reports to the Group Product Manager, who
  // reports to the Marketing Manager. A single non-repeating pass would find Rasha and stop,
  // leaving him off — so this asserts the chain is walked to a fixed point, not once.
  assert.equal(byHrId(marketing, "A-10")?.managerHrId, "A-9", "Nahed reports to the Marketing Manager");
  assert.equal(byHrId(marketing, "A-8")?.managerHrId, "A-9", "Rasha reports to the Marketing Manager");
  assert.equal(
    byHrId(marketing, "B-155")?.managerHrId,
    "A-8",
    "Ahmed Sharaf reports to Rasha, NOT re-homed to the CEO — a two-hop chain must resolve",
  );

  // ── 3. The AU seat is what keeps this from swallowing the sales force ────────────────
  // Every salesperson holds an `au.seats` row. Without that check, a rep reporting to a
  // District Manager who reports upward into Head Office would be dragged in, and the branch
  // would grow until it was the whole company.
  const withSales = buildHeadOfficeOrganogramRows(
    [
      ...MARKETING,
      employee({ full_name: "A District Manager", hr_id: "DM-1", job_title: "District Sales Manager", line_id: 1, manager_hr_id: "A-9" }),
      employee({ full_name: "A Medical Rep", hr_id: "REP-1", job_title: "Medical Representative", line_id: 1, manager_hr_id: "DM-1" }),
    ],
    { ceoNodeKey: "AA", occupiedHrIds: new Set<string>(["dm-1", "rep-1"]) },
  );
  assert.equal(byHrId(withSales, "DM-1"), undefined, "a seated District Manager is the seat model's row, never Head Office's");
  assert.equal(
    byHrId(withSales, "REP-1"),
    undefined,
    "a seated rep must not be pulled into Head Office through his manager — that is how the branch would swallow the sales force",
  );

  // ── 4. Reporting to the CEO is NOT a way in ──────────────────────────────────────────
  // The CEO is the root of the whole company. Admitting anyone who points at him would put
  // every National Sales Manager in Head Office. Only a manager already INSIDE the branch
  // counts. (Seatless here on purpose: the seat check must not be what saves us.)
  const nsmAtRoot = buildHeadOfficeOrganogramRows(
    [...MARKETING, employee({ full_name: "An NSM", hr_id: "NSM-9", job_title: "National Sales Manager", line_id: 3, manager_hr_id: "AA" })],
    { ceoNodeKey: "AA", occupiedHrIds: new Set<string>() },
  );
  assert.equal(
    byHrId(nsmAtRoot, "NSM-9"),
    undefined,
    "a sales manager reporting straight to the CEO is not Head Office — membership is the branch, not the root",
  );

  // ── 5. A marketer is stamped Head Office, so line mode never orphans her ─────────────
  // Tempting to stamp Nahed "Anti Infective" — it is her real line. But her manager is a Head
  // Office row: stamped with her line, she would survive onto an Anti Infective chart hanging off
  // a parent that had been removed. So `lineId`/`lineName` stay Head Office for the gates…
  const nahed = byHrId(marketing, "A-10")!;
  assert.equal(nahed.lineId, HEAD_OFFICE_LINE_ID, "stamped Head Office, not her product line");
  assert.equal(nahed.lineName, HEAD_OFFICE_LINE_NAME, "both fields — isHeadOfficeRow keys off either");
  assert.equal(nahed.ownLineName ?? null, null, "with no line resolver passed, no row claims an own line");
  assert.equal(
    scopeAuOrganogramRows(marketing, { mode: "line", lineName: "Anti Infective" }).length,
    0,
    "without an own line the marketing branch leaves a line chart together, never one row without its manager",
  );

  // ── 5b. …and a line chart still finds its own marketers (owner, 2026-10-20) ───────────
  // "every single role that is applicable to appear in a module — find it and show it": the Pedia
  // Product and Group Product Managers were on no Pedia chart, their own included. Each marketer
  // carries `ownLineName`; line mode keeps her AND the Head Office managers above her, so she is
  // still drawn under a manager who is on the chart. Revert scopeAuOrganogramRows to lineName
  // alone and the Pedia assert below fires.
  const LINE_NAMES = new Map<number, string>([
    [1, "Anti infective"],
    [2, "Pedia"],
    [3, "CNS"],
  ]);
  const withOwnLines = buildHeadOfficeOrganogramRows(MARKETING, {
    ceoNodeKey: "AA",
    occupiedHrIds: new Set<string>(),
    lineNameFor: (lineId) => LINE_NAMES.get(lineId) ?? null,
  });
  assert.equal(byHrId(withOwnLines, "A-8")?.ownLineName, "Pedia", "the Group Product Manager carries her own line");
  assert.equal(byHrId(withOwnLines, "A-8")?.lineName, HEAD_OFFICE_LINE_NAME, "…while still stamped Head Office");
  assert.equal(byHrId(withOwnLines, "A-9")?.ownLineName ?? null, null, "Head Office proper (line 4) carries no own line");
  const ceoRow = { ...byHrId(withOwnLines, "A-9")!, hrId: "AA", lineId: null, lineName: null, managerHrId: null, ownLineName: null };
  const chart = [ceoRow, ...withOwnLines];
  const ids = (rows: OrganogramReportRow[]) => rows.map((row) => row.hrId).sort();
  const pediaChart = scopeAuOrganogramRows(chart, { mode: "line", lineNames: ["Pedia"] });
  assert.deepEqual(
    ids(pediaChart),
    ["A-8", "A-9", "AA", "B-155"],
    "the Pedia chart holds its Group Product Manager and Product Manager, the Marketing Manager above them, and the CEO — and nothing else of Head Office",
  );
  for (const row of pediaChart) {
    if (!row.managerHrId) continue;
    assert.ok(
      pediaChart.some((candidate) => candidate.hrId === row.managerHrId),
      `${row.hrId} must hang off a manager who is on the chart — the placement rule the Head Office stamp exists for`,
    );
  }
  assert.deepEqual(
    ids(scopeAuOrganogramRows(chart, { mode: "line", lineName: "Anti Infective" })),
    ["A-10", "A-9", "AA"],
    "the Anti Infective chart holds its own Product Manager and her manager, never the Pedia marketers",
  );
  assert.equal(
    pediaChart.some((row) => row.hrId === "A-7"),
    false,
    "the Training Manager (line 4) is no marketer of any line and never rides onto a line chart",
  );
  // The portal and admin charts filter again by the picked line (organogram-view-model.ts) — the
  // marketers must survive that filter too, with their Head Office manager.
  const viewModelPedia = filterOrganogramRows(chart, "Pedia", "");
  for (const hrId of ["A-8", "B-155", "A-9"]) {
    assert.ok(
      viewModelPedia.some((row) => row.hrId === hrId),
      `${hrId} must survive the chart's own Pedia filter`,
    );
  }
  assert.equal(viewModelPedia.some((row) => row.hrId === "A-10"), false, "…and the Anti Infective PM does not");
  assert.equal(viewModelPedia.some((row) => row.hrId === "A-7"), false, "…nor the Training Manager");

  // ── 6. HEADLINE B: an open Head Office seat is drawn ─────────────────────────────────
  // Stop emitting vacancies and this fires. HR is the live case: both seats vacated
  // 31 August 2026, so the department rendered as a manager with nobody under him.
  const hr = buildHeadOfficeOrganogramRows(
    [
      employee({ full_name: "Omar Gawish", hr_id: "B-10", job_title: "Hr Manager", manager_hr_id: "AA" }),
    ],
    {
      ceoNodeKey: "AA",
      occupiedHrIds: new Set<string>(),
      vacancies: [
        vacancy({ id: 352, job_title: "HR Operations Coordinator", manager_hr_id: "B-10" }),
        vacancy({ id: 354, job_title: "HR Business Partner", manager_hr_id: "B-10" }),
      ],
    },
  );
  const hrSeats = hr.filter((row) => row.type === "vacancy");
  assert.equal(hrSeats.length, 2, "both open HR seats must be drawn under their manager");
  for (const seat of hrSeats) {
    assert.equal(seat.managerHrId, "B-10", "an open seat hangs off the manager who owns it");
    assert.equal(seat.status, "open", "status drives the chart's vacant treatment");
    assert.equal(seat.lineId, HEAD_OFFICE_LINE_ID, "line stamped, or the access gate stops recognising it");
    assert.equal(seat.lineName, HEAD_OFFICE_LINE_NAME);
  }
  // The title is the ONLY thing identifying an open Head Office seat — it has no area, no
  // occupant and no hire date, so a null here renders as an anonymous empty box.
  assert.deepEqual(
    hrSeats.map((seat) => seat.jobTitle).sort(),
    ["HR Business Partner", "HR Operations Coordinator"],
    "each open seat says which role it is",
  );

  // ── 7. A sales vacancy must NEVER be emitted here ────────────────────────────────────
  // It already arrives from its own unfilled `au.seats` row. Emitting it again would draw one
  // open seat as two — the duplicate-node failure the acting-DM collapse exists to prevent.
  const salesVacancy = buildHeadOfficeOrganogramRows([], {
    ceoNodeKey: "AA",
    occupiedHrIds: new Set<string>(),
    vacancies: [vacancy({ id: 900, job_title: "District Sales Manager", line_id: 1, manager_hr_id: "AA" })],
  });
  assert.equal(
    salesVacancy.filter((row) => row.type === "vacancy").length,
    0,
    "a line-1 vacancy belongs to the seat model; drawing it here too would double every open sales seat",
  );

  // ── 8. Only OPEN counts ──────────────────────────────────────────────────────────────
  const closed = buildHeadOfficeOrganogramRows([], {
    ceoNodeKey: "AA",
    occupiedHrIds: new Set<string>(),
    vacancies: [
      vacancy({ id: 901, status: "filled" }),
      vacancy({ id: 902, status: "cancelled" }),
    ],
  });
  assert.equal(
    closed.length,
    0,
    "a filled or cancelled vacancy is a historical record, not an open seat on the chart",
  );

  // ── 9. The public vacancy code never reaches a chart row ─────────────────────────────
  // `applyOrganogramMirrorSafety` sanitises vacancy codes out of shared reports, and the live
  // chart path deliberately does not run it. So the code must not be here in the first place —
  // including smuggled inside the node key, which nothing thinks to sanitise.
  for (const seat of hrSeats) {
    assert.equal(seat.vacancyCode, null, "no public vacancy code on a chart row");
    assert.match(
      String(seat.hrId),
      /^HO-VAC-\d+$/,
      "the node key is the row id, never the human-readable code",
    );
  }

  // ── 10. An unplaceable open seat re-homes rather than vanishing ──────────────────────
  // Same rule the people path uses. Dropping it would hide a real open role, which is the
  // failure this whole change exists to end.
  const orphanSeat = buildHeadOfficeOrganogramRows(
    [employee({ full_name: "Omar Gawish", hr_id: "B-10", manager_hr_id: "AA" })],
    {
      ceoNodeKey: "AA",
      occupiedHrIds: new Set<string>(),
      vacancies: [vacancy({ id: 903, job_title: "Somebody's Role", manager_hr_id: "NOT-A-PERSON" })],
    },
  );
  const rehomed = byHrId(orphanSeat, "HO-VAC-903");
  assert.ok(rehomed, "an open seat with an unresolvable manager is still drawn");
  assert.equal(rehomed!.managerHrId, "AA", "…re-homed to the CEO, exactly as an unplaceable person is");

  // ── 11. No personal or pay field rides on an open-seat row ──────────────────────────
  // Same standing rule as the people rows: these ship to every viewer's browser and into a
  // downloadable sheet. A vacancy has no occupant, so there is nothing legitimate to carry.
  const FORBIDDEN = [
    "salary", "basicSalary", "baseSalary", "grossSalary", "netSalary", "nationalId",
    "birthDate", "gender", "bankAccount", "residenceAddress", "mobileNumber", "taxes", "note",
  ];
  for (const seat of hrSeats) {
    for (const field of FORBIDDEN) {
      assert.equal(
        field in (seat as unknown as Record<string, unknown>),
        false,
        `${field} must never appear on an open-seat row`,
      );
    }
    assert.equal(seat.workEmail, null, "a vacant seat has no work email to leak");
    assert.equal(seat.hasWhatsApp, false, "and nobody to message");
  }
}

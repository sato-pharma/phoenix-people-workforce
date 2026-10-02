import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  BRICK_SALES_CAVEAT,
  buildBrickCoverageReport,
  NO_BRICK_LABEL,
  UNNAMED_BRICK_LABEL,
  type BrickCrmRow,
} from "../src/lib/phoenix-crm/brick-report.ts";
import { stripComments, stripSqlComments } from "./support/comment-strip.ts";

/**
 * Phoenix CRM — coverage against sales, per BRICK (C2 of the owner's plan).
 *
 * A manager could already see how many customers a rep covered, and on a different screen what an
 * area sold. What nobody could see is the two together at the grain a rep actually works. This board
 * answers: **of the bricks my line sells into, which ones does this rep's list even reach?**
 *
 * Four things here would be wrong in a way nobody would notice, which is why each has its own
 * assertion:
 *
 *   1. **The union, not the intersection.** A brick that appears ONLY on the sales side is the row
 *      the board exists for — money comes off it and nobody is on the list. Building the report from
 *      the CRM rows alone would drop exactly the rows worth reading and leave a screen that says
 *      everything is fine.
 *   2. **The caveat is fixed and server-supplied.** Brick sales never add up to the area's closing
 *      figure. If a screen may word that itself, the second screen words it softer and a manager
 *      reads a brick total as the area.
 *   3. **The El Qema mask runs on the way in, in the service.** It cannot be in SQL (it takes a
 *      viewer's role) and it cannot be in the pure module (that one is bundled for the phone), so
 *      there is exactly one place it can be and this test names it.
 *   4. **The pure module imports no server code.** It carries the caveat, so the temptation is to
 *      keep that constant beside the loader — which reaches the database and would drag a supabase
 *      client into a phone bundle behind it.
 */

const ROOT = new URL("../", import.meta.url);

function source(path: string): string {
  return stripComments(readFileSync(new URL(path, ROOT), "utf8"));
}

function crmRow(patch: Partial<BrickCrmRow> & Pick<BrickCrmRow, "seatId">): BrickCrmRow {
  return {
    brickId: "B-1",
    brickName: "Faisal",
    areaCode: "GZ3",
    areaName: "Giza 3",
    customers: 0,
    am: 0,
    pm: 0,
    visited: 0,
    amVisited: 0,
    pmVisited: 0,
    visits: 0,
    ...patch,
  };
}

const TERRITORY = { seatId: "SEAT-1", territoryName: "Faisal", areaCodes: ["GZ3"] };

export function runPhoenixCrmBrickCoverageReportTests(): void {
  // ── 1. A brick with sales and NOBODY on the list is a row, and it comes first ───────────────────
  //
  // This is the whole board. The CRM half knows nothing about "B-2" — no place was ever captured
  // there — so a report built from the CRM rows alone would be silent about the one brick a manager
  // needs to act on.
  {
    const report = buildBrickCoverageReport({
      territories: [TERRITORY],
      crmRows: [crmRow({ seatId: "SEAT-1", brickId: "B-1", customers: 4, am: 1, pm: 3, visited: 2, amVisited: 1, pmVisited: 1, visits: 6 })],
      sales: [
        { brickId: "B-1", areaCode: "GZ3", value: 1000 },
        { brickId: "B-2", areaCode: "GZ3", value: 9000 },
      ],
      brickNames: [
        { brickId: "B-1", brickName: "Faisal", areaCode: "GZ3" },
        { brickId: "B-2", brickName: "Haram", areaCode: "GZ3" },
      ],
      salesMonths: ["2026-08"],
    });

    assert.equal(report.rows.length, 2, "both sides are unioned — the sales-only brick is a row of its own");
    assert.equal(report.rows[0].brickId, "B-2", "the brick that sells with nobody on the list comes FIRST");
    assert.equal(report.rows[0].status, "sales-no-list");
    assert.equal(
      report.rows[0].brickName,
      "Haram",
      "and it is NAMED from the brick master — a manager must never be shown a brick id",
    );
    assert.equal(report.rows[1].status, "covered", "the brick with both is second");
    assert.equal(report.summary.salesNoList, 1);
    assert.equal(report.summary.brickSales, 10_000, "the summary sums the BRICK rows and is never called the area's sales");
  }

  // ── 2. A sales brick OUTSIDE the territory's areas is not dragged in ───────────────────────────
  //
  // The sales half is loaded per LINE, so it carries every brick of the line — other reps' included.
  // Without the area filter a district manager's board would accuse each of his reps of missing the
  // other reps' bricks.
  {
    const report = buildBrickCoverageReport({
      territories: [TERRITORY],
      crmRows: [],
      sales: [{ brickId: "B-9", areaCode: "CA5", value: 500 }],
      brickNames: [{ brickId: "B-9", brickName: "Down town", areaCode: "CA5" }],
      salesMonths: ["2026-08"],
    });
    assert.deepEqual(report.rows, [], "a brick of another area never lands on this territory's board");
  }

  // ── 3. A customer with no captured place is NAMED, not dropped ─────────────────────────────────
  //
  // Dropping him would make the territory read as smaller than it is. The row is what tells a manager
  // the rep has not been there at all.
  {
    const report = buildBrickCoverageReport({
      territories: [TERRITORY],
      crmRows: [crmRow({ seatId: "SEAT-1", brickId: null, brickName: null, areaCode: null, areaName: null, customers: 3, pm: 3 })],
      sales: [],
      brickNames: [],
      salesMonths: [],
    });
    assert.equal(report.rows.length, 1);
    assert.equal(report.rows[0].brickName, NO_BRICK_LABEL, "the placeless row says so in words");
    assert.equal(report.rows[0].status, "list-no-sales");
  }

  // ── 3b. A brick nobody names is labelled in words, never by its raw code ────────────────────────
  //
  // Phoenix CRM audit, 2026-10-02: the fallback was the brick id itself, so a code reached the
  // Reports bricks table. The id stays the row's key; the label is a sentence.
  {
    const report = buildBrickCoverageReport({
      territories: [TERRITORY],
      crmRows: [crmRow({ seatId: "SEAT-1", brickId: "B-77", brickName: "", customers: 1, pm: 1 })],
      sales: [{ brickId: "B-78", areaCode: "GZ3", value: 100 }],
      brickNames: [],
      salesMonths: ["2026-08"],
    });
    assert.equal(report.rows.length, 2);
    for (const row of report.rows) {
      assert.equal(row.brickName, UNNAMED_BRICK_LABEL, `brick ${row.brickId} with no name reads as words, not its code`);
    }
  }

  // ── 4. AM and PM stay apart, and nothing averages them ─────────────────────────────────────────
  {
    const report = buildBrickCoverageReport({
      territories: [TERRITORY],
      crmRows: [crmRow({ seatId: "SEAT-1", customers: 10, am: 2, pm: 8, visited: 5, amVisited: 1, pmVisited: 4, visits: 12 })],
      sales: [{ brickId: "B-1", areaCode: "GZ3", value: 100 }],
      brickNames: [{ brickId: "B-1", brickName: "Faisal", areaCode: "GZ3" }],
      salesMonths: ["2026-08"],
    });
    const row = report.rows[0];
    assert.equal(row.am, 2);
    assert.equal(row.pm, 8);
    assert.equal(row.amVisited, 1);
    assert.equal(row.pmVisited, 4);
    assert.equal(row.customers, 10, "`customers` is the row's SIZE, for sorting — never presented as a rate");
  }

  // ── 5. An idle brick is kept, and sorts last ───────────────────────────────────────────────────
  {
    const report = buildBrickCoverageReport({
      territories: [TERRITORY],
      crmRows: [
        crmRow({ seatId: "SEAT-1", brickId: "B-idle", brickName: "Quiet", customers: 0 }),
        crmRow({ seatId: "SEAT-1", brickId: "B-live", brickName: "Busy", customers: 2, pm: 2 }),
      ],
      sales: [],
      brickNames: [],
      salesMonths: [],
    });
    assert.equal(report.rows.at(-1)?.status, "idle", "a brick with neither sales nor a list is last, never first");
    assert.equal(report.rows.length, 2, "and it is still listed — it is the edge of what the line has touched");
  }

  // ── 6. The caveat is one fixed sentence, carried on the view ───────────────────────────────────
  {
    const report = buildBrickCoverageReport({ territories: [], crmRows: [], sales: [], brickNames: [], salesMonths: [] });
    assert.equal(report.caveat, BRICK_SALES_CAVEAT, "the view carries the caveat so no screen composes its own");
    assert.match(report.caveat, /do not add up to the area/i);
    for (const missing of ["wholesaler", "Office", "direct order"]) {
      assert.match(report.caveat, new RegExp(missing, "i"), `the caveat names ${missing} as one of the reasons`);
    }
    assert.deepEqual(report.rows, [], "no territories means no rows, and no invented ones");

    const screen = source("src/components/phoenix-crm/reports-tab.tsx");
    assert.ok(screen.includes("{report.caveat}"), "the screen prints the server's sentence rather than one of its own");
  }

  // ── 7. The El Qema mask runs in the SERVICE, on the way in ─────────────────────────────────────
  //
  // 🔴 A warehouse brick carrying El Qema's stock would announce a source that leaves no trace in a
  // closing detail for anyone but the Super Admin. The mask takes a viewer's ROLE, so it cannot be in
  // the SQL; the pure module is bundled for the phone, so it cannot be there either.
  {
    const service = source("src/lib/phoenix-crm/server/brick-report.ts");
    assert.ok(service.includes("withoutMaskedSourceRows"), "the service masks the closing rows");
    const masked = service.indexOf("withoutMaskedSourceRows");
    const summed = service.indexOf("buildBrickCoverageReport({ territories, crmRows, sales");
    assert.ok(masked !== -1 && summed !== -1 && masked < summed, "and it masks BEFORE anything is summed");
    assert.ok(service.includes("readsTeamReports"), "the same gate as the other manager sections");

    // Comments stripped: the migration's own header EXPLAINS why it does not read `phx_closing_brick`,
    // and a header that names the thing it refuses to do must not fail the check for doing it.
    const sql = stripSqlComments(
      readFileSync(new URL("supabase/migrations/20260927003000_phoenix_crm_report_brick_coverage.sql", ROOT), "utf8"),
    );
    assert.equal(
      /phx_closing_brick/.test(sql),
      false,
      "the SQL must NOT read the closing's brick grain — it would return El Qema's rows with no role to mask them by",
    );
    assert.ok(sql.includes("phoenix_crm_countable_visits"), "and the visit half reads the countable view, never the raw table");
    assert.ok(
      sql.includes("revoke execute on function public.phoenix_crm_report_brick_coverage(text[], date, date, boolean) from public, anon, authenticated;"),
      "the function is revoked from every browser role",
    );
    assert.ok(
      sql.includes("grant execute on function public.phoenix_crm_report_brick_coverage(text[], date, date, boolean) to service_role;"),
      "and granted to service_role only",
    );
  }

  // ── 8. The pure module stays pure ──────────────────────────────────────────────────────────────
  //
  // It owns the caveat, so the obvious place to put that constant is beside the loader in
  // `@/lib/sales/closing-brick-sales` — which reaches the database. That import would drag a supabase
  // client into the phone's bundle behind a rule module, which is what phoenix-crm-boundary forbids.
  {
    const pure = source("src/lib/phoenix-crm/brick-report.ts");
    for (const forbidden of [/@\/lib\/supabase/, /@\/lib\/sales\/closing-brick-sales/, /@\/lib\/phoenix-crm\/server\//]) {
      assert.equal(forbidden.test(pure), false, `the pure module must not import ${forbidden} — the phone bundles it`);
    }
    assert.ok(pure.includes("export const BRICK_SALES_CAVEAT"), "so the caveat lives here, where both sides can read it");
  }

  // ── 9. C2a moved the loaders without changing them ─────────────────────────────────────────────
  //
  // Employee 360's brick panel is the older caller and its own tests still pass unedited, which is the
  // proof the extraction was verbatim. This pins that it really is ONE copy now.
  {
    const shared = source("src/lib/sales/closing-brick-sales.ts");
    const panel = source("src/lib/employee-360/brick-coverage.ts");
    assert.ok(shared.includes("export async function loadAreaBrickMaster"), "the brick master loader lives in the shared module");
    assert.ok(shared.includes("export async function loadClosingBrickSales"), "and so does the closing brick loader");
    assert.equal(
      /async function loadAreaBrickMaster|async function loadClosingBrickSales/.test(panel),
      false,
      "Employee 360 no longer carries its own copy — a second copy is how the two screens start disagreeing",
    );
    assert.ok(panel.includes('from "@/lib/sales/closing-brick-sales"'), "it imports them instead");
    assert.ok(shared.includes("phx_closing_brick"), "the shared loader is still the one that reads the closing's brick grain");
  }

  // ── 10. The route serves it, under the same envelope as every other section ────────────────────
  {
    const route = source("app/api/phoenix-crm/reports/route.ts");
    assert.ok(route.includes('section === "bricks"'), "the reports route serves ?section=bricks");
    assert.ok(route.includes("loadBrickCoverageReport(viewer, filters)"), "through the service, which applies the gate and the mask");
  }

  console.log("phoenix-crm brick coverage report: OK");
}

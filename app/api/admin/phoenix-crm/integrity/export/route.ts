import ExcelJS from "exceljs";
import { NextResponse, type NextRequest } from "next/server";

import { writeAuditLog } from "@/lib/admin/audit";
import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import {
  INTEGRITY_DISTANCE_BAND_LABELS,
  INTEGRITY_STANDING_LABELS,
  integrityFiltersFromParams,
  matchesIntegrityFilters,
} from "@/lib/crm-integrity/integrity-board-filters";
import { integrityBoardRows, integrityRowDistanceWords } from "@/lib/crm-integrity/integrity-board-rows";
import { addPhoenixTableSheet, type ExportColumn, type ExportRow } from "@/lib/export/table-workbook";
// The owner reads every stamp in Cairo local, never raw UTC (house rule).
import { cairoDateTimeSortable } from "@/lib/format/cairo-datetime";
import { afterResponse } from "@/lib/http/after-response";
import { assertExportRateLimit } from "@/lib/http/assert-export-rate-limit";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { phoenixCrmFailure } from "@/lib/phoenix-crm/server/http";
import { loadIntegrityBoard } from "@/lib/phoenix-crm/server/integrity-board";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The location-integrity board as an XLSX — exactly what is on the screen, narrowed by exactly the
 * filters in the address bar (owner, 2026-10-13, his fifth item answered "all above").
 *
 * 🔴 IT READS `loadIntegrityBoard(viewer)` AND NEVER THE TABLE. Every narrowing the board applies
 * then applies here for free — the SFE Manager's detector allow-list, the `device_mocked` tiering,
 * `is_test = false` for anyone but the Super Admin — and no second read of
 * `phoenix_crm_location_integrity` lands in a file whose paged-read shapes are pinned at exactly two
 * occurrences each (`tests/crm-integrity-signboard-cases.test.ts`).
 *
 * 🔴 AND IT REFUSES WITH A 404, NOT A 403. `app/api/admin/activity/export/route.ts` is this route's
 * template and ends in an `isForbiddenError` branch answering 403 with the resource named; copying it
 * would tell whoever asked that a location-integrity board exists and that they are not allowed on
 * it. `phoenixCrmFailure` passes the service's own `notFoundError` through untouched, which is the
 * same refusal the board page and the settle routes give.
 *
 * 🔴 NO HR ID IN ANY CELL — names throughout, including who settled a case, which is why the rows are
 * built from the loader's resolved `settlement.byName` rather than its `byHrId`.
 */
const CASE_COLUMNS: ExportColumn[] = [
  { key: "visitDay", label: "Day", width: 12 },
  { key: "filedDay", label: "Filed on", width: 12 },
  { key: "rep", label: "Who", width: 26 },
  { key: "line", label: "Line", width: 16 },
  { key: "area", label: "Area", width: 18 },
  { key: "region", label: "Region", width: 18 },
  { key: "customer", label: "Customer", width: 28 },
  { key: "list", label: "List", width: 10 },
  { key: "speciality", label: "Speciality", width: 20 },
  { key: "about", label: "About", width: 18 },
  { key: "detector", label: "Check", width: 26 },
  { key: "strength", label: "Strength", width: 18 },
  { key: "standing", label: "Standing", width: 22 },
  { key: "finding", label: "What it says", width: 60 },
  { key: "story", label: "The whole story", width: 90 },
  { key: "readings", label: "Readings kept", width: 48 },
  { key: "apart", label: "Metres apart", numeric: true, excludeFromTotal: true, width: 14 },
  { key: "apartWords", label: "How far apart", width: 24 },
  { key: "fromPlace", label: "Metres from the place", numeric: true, excludeFromTotal: true, width: 20 },
  { key: "brick", label: "Brick", width: 18 },
  { key: "brickKm", label: "Km from the brick", numeric: true, excludeFromTotal: true, width: 18 },
  { key: "photo", label: "Photograph", width: 16 },
  { key: "settledBy", label: "Settled by", width: 24 },
  { key: "settledAt", label: "Settled on", width: 20 },
  { key: "settledNote", label: "The reason given", width: 60 },
];

const BY_REP_COLUMNS: ExportColumn[] = [
  { key: "rep", label: "Who", width: 26 },
  { key: "line", label: "Line", width: 16 },
  { key: "area", label: "Area", width: 18 },
  { key: "region", label: "Region", width: 18 },
  { key: "cases", label: "Cases", numeric: true, width: 10 },
  { key: "strong", label: "Strong on their own", numeric: true, width: 20 },
  { key: "open", label: "Nobody has decided", numeric: true, width: 20 },
  { key: "settled", label: "Settled", numeric: true, width: 12 },
  { key: "withdrawn", label: "The evidence gave way", numeric: true, width: 22 },
];

const DASH = "-";

function words(value: string | null | undefined): string {
  const trimmed = String(value ?? "").trim();
  return trimmed || DASH;
}

export async function GET(request: NextRequest) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "read");
    // The rate limit needs only who is asking, never the organogram, so the two are asked together
    // rather than one after the other (Phoenix CRM performance audit, 2026-10-16) — and both still
    // answer before the board is loaded, the heavy read the limit exists to protect. The viewer's own
    // refusal is reported first when both refuse, exactly as when it was asked first.
    const [viewerRead, limitRead] = await Promise.allSettled([
      resolvePhoenixCrmViewer(access),
      assertExportRateLimit({ actor: access.loginId ?? access.hrId, request, scope: "export:admin:crm-integrity" }),
    ]);
    if (viewerRead.status === "rejected") throw viewerRead.reason;
    if (limitRead.status === "rejected") throw limitRead.reason;
    const viewer = viewerRead.value;

    // The board, with every audience narrowing inside it — then the SAME mapping and the SAME matcher
    // the screen uses, over the filters the screen wrote into the address. That is the whole reason
    // `integrity-board-rows.ts` is a module and not part of the view.
    const board = await loadIntegrityBoard(viewer);
    const filters = integrityFiltersFromParams(new URL(request.url).searchParams);
    const rows = integrityBoardRows(board).filter((row) => matchesIntegrityFilters(row.filterable, filters));

    const caseRows: ExportRow[] = rows.map((row) => {
      const entry = row.entry;
      return {
        visitDay: words(row.filterable.visitDay),
        filedDay: words(row.filterable.filedDay),
        rep: words(entry.repName),
        line: words(entry.repLine),
        area: words(entry.repArea),
        region: words(entry.repRegion),
        customer: words(entry.customerName),
        list: words(entry.customerList),
        speciality: words(entry.customerSpeciality),
        about: words(entry.subjectLabel),
        detector: words(row.filterable.sourceLabel),
        strength: entry.strong ? "Strong on its own" : "Corroborating only",
        standing: INTEGRITY_STANDING_LABELS[row.standing],
        finding: words(row.story.headline),
        // The story's own paragraphs, joined — one cell a reader can widen, never a truncated one.
        story: words(row.story.story.join(" ")),
        readings:
          entry.readings.length === 0
            ? DASH
            : entry.readings
                .map((reading) => `${reading.label}: ${reading.lat.toFixed(5)}, ${reading.lon.toFixed(5)}`)
                .join(" · "),
        apart: row.filterable.spreadMeters === null ? DASH : Math.round(row.filterable.spreadMeters),
        apartWords: integrityRowDistanceWords(row, INTEGRITY_DISTANCE_BAND_LABELS),
        fromPlace: entry.placeDistanceMeters === null ? DASH : Math.round(entry.placeDistanceMeters),
        brick: words(entry.brickName),
        brickKm: entry.brickDistanceKm === null ? DASH : Number(entry.brickDistanceKm.toFixed(2)),
        photo: entry.photoPath === null ? "None kept" : "Kept",
        // The NAME, never the HR id — the owner's standing rule, and the loader already resolved it.
        settledBy: words(entry.settlement?.byName),
        settledAt: entry.settlement === null ? DASH : cairoDateTimeSortable(entry.settlement.at),
        settledNote: words(entry.settlement?.note),
      };
    });

    // By rep, counted from the FILTERED rows rather than the board's own roll-up: a sheet beside a
    // narrowed Cases sheet that counted the whole board would be read as the narrowed total.
    const perRep = new Map<string, ExportRow>();
    for (const row of rows) {
      const key = row.entry.repName;
      const held = perRep.get(key) ?? {
        rep: words(key),
        line: words(row.entry.repLine),
        area: words(row.entry.repArea),
        region: words(row.entry.repRegion),
        cases: 0,
        strong: 0,
        open: 0,
        settled: 0,
        withdrawn: 0,
      };
      held.cases = Number(held.cases) + 1;
      if (row.entry.strong) held.strong = Number(held.strong) + 1;
      held[row.standing] = Number(held[row.standing]) + 1;
      perRep.set(key, held);
    }
    const repRows = [...perRep.values()].sort((left, right) => Number(right.cases) - Number(left.cases));

    const stamp = cairoDateTimeSortable(new Date().toISOString());
    const workbook = new ExcelJS.Workbook();
    workbook.creator = "Phoenix Workforce";
    workbook.created = new Date();
    addPhoenixTableSheet(workbook, {
      title: "Location integrity",
      subtitle: `${caseRows.length} ${caseRows.length === 1 ? "case" : "cases"} · exported ${stamp} Cairo`,
      sheetName: "Cases",
      columns: CASE_COLUMNS,
      rows: caseRows,
    });
    addPhoenixTableSheet(workbook, {
      title: "Location integrity — by rep",
      subtitle: `${repRows.length} ${repRows.length === 1 ? "rep" : "reps"} · exported ${stamp} Cairo`,
      sheetName: "By rep",
      columns: BY_REP_COLUMNS,
      rows: repRows,
    });
    const buffer = await workbook.xlsx.writeBuffer();

    // On the record once the file has gone. `writeAuditLog` is best-effort — it logs its own failure
    // and never throws — so the download never depended on it and need not wait for its insert.
    await afterResponse("phoenix-crm-integrity-export-audit", () =>
      writeAuditLog({
        actorLoginId: access.loginId ?? null,
        entityType: "phoenix_crm_integrity_export",
        entityId: null,
        summary: `Exported the location-integrity board (${caseRows.length} cases, ${repRows.length} reps)`,
      }),
    );

    // The Cairo day in the filename, never the UTC one: downloaded at 01:30 Cairo the UTC stamp names
    // yesterday, and a folder of these would read as a day out.
    const filename = `location-integrity-${stamp.slice(0, 10)}.xlsx`;
    return new NextResponse(buffer as ArrayBuffer, {
      status: 200,
      headers: {
        "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "content-disposition": `attachment; filename="${filename}"`,
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not export this board.");
  }
}

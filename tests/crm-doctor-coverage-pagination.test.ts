import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// ─────────────────────────────────────────────────────────────────────────────
// The Doctor Coverage drill-down must never render its whole doctor set.
//
// Measured against production on 2026-08-21, both routes answered HTTP 200 with a payload
// no phone should ever be asked to download:
//
//   /admin/doctor-coverage             18.8 MB
//   /employee-portals/doctor-coverage  18.6 MB
//
//   rendered markup    16.5 MB   88%    7,175 <article> + 7,127 <tr> + 49,875 <td>
//   serialised props    2.3 MB   12%
//
// The markup is the whole story, and the reason is PortalResponsiveDataList: it renders every
// item it is handed TWICE — once as a mobile card, once as a desktop table row — and hides one
// half in CSS. So each of ~7,000 doctors cost two full renders, and a Medical Rep on mobile data
// paid for the desktop half they can never see. (The employee-portals route is not admin-only;
// AGENTS.md §4 is explicit that reps open this board on a phone.)
//
// The board's other two repeated renders were already bounded and stay that way: the call list is
// capped in the domain service at DOCTOR_COVERAGE_CALL_LIST_SIZE with `callListTotal` reporting
// the true count, and the rep table holds one row per rep (~100). The doctor drill-down was the
// only unbounded one.
//
// Windowing here is DISPLAY-ONLY. Search, sort, the status filter and the xlsx export all still
// operate over the full `rows` prop; only what gets drawn is limited. That distinction is the
// point of the export assertion at the bottom — a "fix" that also truncated the sheet would be a
// silent data loss, which this repo forbids outright: count and flag, never quietly drop.
// ─────────────────────────────────────────────────────────────────────────────

const TABLES_FILE = fileURLToPath(
  new URL("../src/components/crm/doctor-coverage-tables.tsx", import.meta.url),
);
const SERVICE_FILE = fileURLToPath(
  new URL("../src/lib/crm/sfe-doctor-coverage.ts", import.meta.url),
);

/**
 * Comments are stripped before matching, so the explanatory note sitting above the component —
 * which names `table.rows` while describing what the code used to do — can neither satisfy nor
 * fail an assertion. Same reasoning as crm-mobile-table-cards.test.ts.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/**
 * Narrow to DoctorCoverageDoctorTable. The rep table is defined ABOVE it in the same file and is
 * deliberately unpaginated — scanning the whole file would fail on its perfectly correct
 * `table.rows.map(...)`.
 */
function doctorTableBody(source: string): string {
  const start = source.indexOf("export function DoctorCoverageDoctorTable");
  assert.notEqual(
    start,
    -1,
    "DoctorCoverageDoctorTable is gone from doctor-coverage-tables.tsx. If it moved, re-point " +
      "this test — do not delete it; it is the only thing standing between this board and a " +
      "19 MB mobile payload.",
  );
  return source.slice(start);
}

export function runDoctorCoveragePaginationTests() {
  const source = stripComments(readFileSync(TABLES_FILE, "utf8"));
  const body = doctorTableBody(source);

  // A page size that drifted into the thousands would satisfy every structural check below while
  // quietly restoring the original payload, so the number itself is pinned to a sane ceiling.
  const declared = /const DOCTOR_PAGE_SIZE = (\d+);/.exec(source);
  assert.ok(declared, "DOCTOR_PAGE_SIZE is missing from doctor-coverage-tables.tsx.");
  const pageSize = Number(declared[1]);
  assert.ok(
    pageSize > 0 && pageSize <= 100,
    `DOCTOR_PAGE_SIZE is ${pageSize}. A page must stay small enough that doubled card+row markup ` +
      "cannot re-inflate the payload; 25 is the house default across the portal workspaces.",
  );

  // Both halves must draw the window. Missing EITHER one leaves ~7,000 rows in the response,
  // because the primitive renders the same `items` into the card list and the table.
  assert.match(
    body,
    /items=\{pagedRows\}/,
    "The card half still receives the unwindowed list. PortalResponsiveDataList renders every " +
      "item it is given into BOTH halves — this is exactly what shipped 16.5 MB of markup.",
  );
  assert.match(
    body,
    /\{pagedRows\.map\(/,
    "The desktop <tbody> still maps the unwindowed list, so the hidden half remains ~7,000 rows.",
  );
  assert.doesNotMatch(
    body,
    /\{table\.rows\.map\(|items=\{table\.rows\}/,
    "A render path still walks the full row set instead of the current page.",
  );

  // The window is a slice, and the page self-clamps. Without the clamp, narrowing a filter while
  // sitting on a deep page strands the view past the end of the list showing nothing.
  assert.match(body, /pagedRows[\s\S]{0,200}?\.slice\(/, "pagedRows is not a slice of the row set.");
  assert.match(
    body,
    /Math\.min\(page,\s*totalPages\)/,
    "The page is not clamped to totalPages — shrinking the filtered set would strand the view " +
      "on an out-of-range page.",
  );

  // Without controls the rows past page 1 are unreachable rather than merely undrawn, which
  // would turn a payload fix into a data-access regression.
  assert.match(
    body,
    /<PortalPagination\b/,
    "No pagination control is rendered, so every doctor past the first page is unreachable.",
  );

  // The export is the audit artifact. This assertion is what separates "windowed for display"
  // from "silently truncated".
  assert.match(
    body,
    /exportRows = rows\.map\(/,
    "The xlsx export no longer spans the full `rows` prop. Windowing must never reach the sheet.",
  );

  // The board's other repeated render. It is capped server-side; if that cap were removed the
  // call list would re-inflate the same way, and `callListTotal` is what keeps the cap honest.
  const service = stripComments(readFileSync(SERVICE_FILE, "utf8"));
  const cap = /DOCTOR_COVERAGE_CALL_LIST_SIZE = (\d+);/.exec(service);
  assert.ok(
    cap,
    "DOCTOR_COVERAGE_CALL_LIST_SIZE is gone from sfe-doctor-coverage.ts — the call list renders " +
      "twice like the drill-down and would grow without bound.",
  );
  assert.ok(
    Number(cap[1]) > 0 && Number(cap[1]) <= 200,
    `The call list cap is ${cap[1]}, large enough to matter once doubled by the card+table render.`,
  );
  assert.match(
    service,
    /callListTotal:/,
    "callListTotal is gone. The cap must always report the true count — a capped list that hides " +
      "how much it dropped is a silent drop.",
  );
}

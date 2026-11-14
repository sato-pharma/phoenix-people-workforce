import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { duplicateUploadMessage } from "../src/lib/sales/import-duplicate-guard.ts";
import { stripSqlComments } from "./support/comment-strip.ts";

// Two defects from the deferred-scope audit (run wf_2196360f-a88), shipped together.
//
// #5  Top Customers omitted Office entirely — 3,930,227.33 EGP for 2026-07, the LARGEST distributor
//     by value, ahead of PS (2,569,253.50) and IS (1,637,421.58). Every other distributor
//     reconciles to the cent, so nothing looked wrong.
// #3  IS-S loaded the identical workbook as both 2026-04 and 2026-05 — same file name, 1,141 rows,
//     349,266.46 EGP each — so one month is counted twice and the other was never loaded.
//
// Pinned by substring, never by byte window (AGENTS.md §2.1).

const MIGRATION = fileURLToPath(
  new URL("../supabase/migrations/20260905163000_top_customers_shows_office_as_one_row.sql", import.meta.url),
);
const DISTRIBUTOR_SAVE = fileURLToPath(new URL("../src/lib/sales/monthly-distributor-import.ts", import.meta.url));
const NORMALIZER_SAVE = fileURLToPath(new URL("../src/lib/sales/normalizer/service.ts", import.meta.url));
const GUARD = fileURLToPath(new URL("../src/lib/sales/import-duplicate-guard.ts", import.meta.url));

function executableSql(path: string) {
  return stripSqlComments(readFileSync(path, "utf8"));
}

function testOfficeIsUnionedAsExactlyOneRow() {
  const sql = executableSql(MIGRATION);

  assert.ok(sql.includes("office as ("), "the migration must add an `office` CTE");
  assert.ok(sql.includes("union all"), "the Office row must be UNIONed onto the coded customers");
  assert.ok(
    sql.includes("'OFFICE'::text as client_code"),
    "Office must carry a synthetic client_code so the panel can key it like any other row",
  );

  // It must come from the FACT rollup. The customer-directory rollup holds no Office rows at all —
  // measured: zero Office rows and zero null-client_code rows for 2026-07 — so sourcing it there
  // would silently produce nothing, which is the bug this replaces.
  assert.ok(
    sql.includes("from public.source_of_sales_fact_rollup f"),
    "Office must be read from the fact rollup, the only table that carries it",
  );
  assert.ok(
    sql.includes("upper(btrim(coalesce(f.distributor_code, ''))) = 'OFFICE'"),
    "the Office CTE must select only Office rows",
  );

  // Exactly one row: an aggregate with no GROUP BY over a single filtered distributor.
  const officeBlock = sql.slice(sql.indexOf("office as ("), sql.indexOf("select a.client_code"));
  assert.ok(!/\bgroup\s+by\b/i.test(officeBlock), "the Office CTE must not GROUP BY — it emits ONE row");
  assert.ok(officeBlock.includes("sum(f.total_qty)"), "the Office row must aggregate units");

  // No geography: 3,591 underlying rows span many areas and one row cannot claim one of them.
  // Whitespace-collapsed, because the migration aligns these columns and a spacing-sensitive pin
  // would false-fail on reformatting rather than on the behaviour it is supposed to protect.
  const officeFlat = officeBlock.replace(/\s+/g, " ");
  for (const column of ["null::text as region_code", "null::text as area_code", "null::text as brick_id"]) {
    assert.ok(officeFlat.includes(column), `the Office row must emit ${column} rather than invent a geography`);
  }

  // The reveal fix from 20260905143000 must survive in BOTH halves of the function.
  assert.equal(
    sql.split("cardinality(p_exclude_codes) = 0").length - 1,
    2,
    "both the coded half and the Office half must honour p_exclude_codes",
  );
  assert.ok(
    !sql.includes("not in ('LA003', 'LA004', 'SS001')"),
    "the unconditional restricted-product predicate must not come back",
  );
}

function testOfficeDoesNotTouchTheAllocationRule() {
  // The Office allocation golden rule (src/lib/sales/office-allocation.ts) spreads Office units
  // across areas by each area's share of the line's non-Office VALUE. A single unallocated row must
  // never be confused with that, so the migration must not reference the allocation machinery.
  const sql = executableSql(MIGRATION);
  assert.ok(!/office_allocation|allocate/i.test(sql), "the Office row must not invoke any allocation logic");
}

function testEverySaveStepRefusesADuplicateWorkbook() {
  // The refusal first ran in the Monthly Import commit route, before the workbook was parsed, where
  // only the file name is known — and a name alone refuses real months. It now runs inside the two
  // save steps every monthly upload screen reaches, where the figures are known too. What counts as
  // the same file is pinned in tests/duplicate-upload-name-and-figures.test.ts.
  for (const [path, signature] of [
    [DISTRIBUTOR_SAVE, "export async function persistDistributorSalesUpload("],
    [NORMALIZER_SAVE, "export async function persistNormalizedBatch("],
  ] as const) {
    const source = readFileSync(path, "utf8");
    const start = source.indexOf(signature);
    assert.ok(start >= 0, `${signature} must exist`);
    // Since REC-008 (14 Nov 2026) the refusal runs in the one door both save steps call.
    const call = source.indexOf("applyImportStoreRules(", start);
    const insert = source.indexOf('.from("source_of_sales_import_batches")', start);
    assert.ok(
      call > start && call < insert,
      `${signature} must refuse a workbook already committed under another period before it writes the batch`,
    );
  }
  const rules = readFileSync(fileURLToPath(new URL("../src/lib/sales/import-store-rules.ts", import.meta.url)), "utf8");
  const door = rules.slice(rules.indexOf("export async function applyImportStoreRules<"));
  assert.ok(door.indexOf("await (seams.assertNotADuplicate ?? assertNotADuplicateUpload)({") > 0, "the one door refuses a workbook already committed under another period");
}

function testGuardFailsClosedAndExplainsItself() {
  const guard = readFileSync(GUARD, "utf8");
  // A guard that cannot read the table must not silently pass.
  assert.ok(guard.includes("duplicate_check_failed"), "a failed lookup must surface, not return null");
  assert.ok(guard.includes('.neq("status", "blocked")'), "blocked batches never became sales and must be ignored");

  const message = duplicateUploadMessage(
    { fileName: "Monthly_Sales.xlsx", id: "b1", period: "2026-04", totalRows: 1141, totalValue: 349266.46 },
    "2026-05",
  );
  assert.match(message, /2026-04/, "the message must name the period it was already imported as");
  assert.match(message, /1,141/, "the message must quote the row count so the user can recognise the file");
  assert.match(message, /349,266\.46/, "the message must quote the value");
  assert.match(message, /count the same sales twice/, "the message must say what the damage would be");
}

export function runSosOfficeRowAndDuplicateUploadTests() {
  testOfficeIsUnionedAsExactlyOneRow();
  testOfficeDoesNotTouchTheAllocationRule();
  testEverySaveStepRefusesADuplicateWorkbook();
  testGuardFailsClosedAndExplainsItself();
}

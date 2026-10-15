/**
 * Import the customer/distributor master into marketing_pharmacy_code_references.
 *
 * WHY THIS EXISTS
 * The reference table is what decides whether a marketing request's target pharmacy code can ever
 * attribute a sale. It held ~20,100 rows while the real master has 49,713, so 122 perfectly valid
 * codes were being reported "not found" — the codes were never wrong, the reference data was
 * simply stale. Measured against this file, 107 of those 122 resolve.
 *
 * SAFETY
 * - UPSERT ONLY. Nothing is ever deleted. A row already present is left alone, so re-running is
 *   harmless and a bad run cannot destroy reference data that currently matches.
 * - Distributors are mapped EXPLICITLY. A file distributor with no unambiguous database match is
 *   skipped and reported, never guessed — attribution matches on distributor, so guessing
 *   "EPDA-BULK" means "epda" would silently attach pharmacies to the wrong company.
 * - Dry run is the DEFAULT. Pass --apply to write.
 *
 * Usage:
 *   pnpm exec node --experimental-strip-types scripts/import-pharmacy-code-references.ts <file.xlsx>
 *   pnpm exec node --experimental-strip-types scripts/import-pharmacy-code-references.ts <file.xlsx> --apply
 */

import { createClient } from "@supabase/supabase-js";
import ExcelJS from "exceljs";

import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";

// A flag this script does not know is refused, never ignored (scripts/lib/refuse-arguments.mjs).
refuseUnknownFlags({
  name: "import-pharmacy-code-references",
  entry: import.meta.url,
  known: ["--apply"],
});

const SOURCE_LABEL = "Phoenix_All_Customers_Distributors.xlsx";

/**
 * File distributor name -> marketing_distributors.normalized_name.
 *
 * Only unambiguous pairs. The deliberately ABSENT ones — Ibn Sina-Sato, EPDA-Pharmacies,
 * EPDA-BULK, EGD Branch, EGD Hospital and the four Tender variants — have no clear counterpart
 * and need a human decision before their ~5,500 rows are imported under any distributor.
 */
const DISTRIBUTOR_MAP: Record<string, string> = {
  "egd": "egd",
  "epda": "epda",
  "ibn sina": "ibn sina",
  "mec": "mec",
  "overseas": "overseas",
  "ramco": "ramco",
  "sofico": "sofico",
};

const normalizeCode = (value: unknown) => String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
const lower = (value: unknown) => String(value ?? "").trim().toLowerCase();

async function main() {
  const filePath = process.argv[2];
  const apply = process.argv.includes("--apply");
  if (!filePath) throw new Error("Usage: import-pharmacy-code-references.ts <file.xlsx> [--apply]");

  // The app env uses NEXT_PUBLIC_SUPABASE_URL; the staging RLS env files use bare SUPABASE_URL.
  // Accepting both is what lets the SAME script be dry-run against staging before production,
  // instead of one being verified and the other run blind.
  const url = process.env.PHOENIX_STAGING_SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
  const key =
    process.env.PHOENIX_STAGING_SUPABASE_SERVICE_ROLE_KEY ??
    process.env.SUPABASE_SERVICE_ROLE_KEY ??
    process.env.SUPABASE_SERVICE_ROLE;
  if (!url || !key) {
    throw new Error("Supabase URL and service-role key are required (NEXT_PUBLIC_SUPABASE_URL/SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY/SUPABASE_SERVICE_ROLE).");
  }
  const supabase = createClient(url, key, { auth: { persistSession: false } });

  console.log(`target project: ${url}`);
  console.log(apply ? "MODE: APPLY (will write)" : "MODE: DRY RUN (no writes)");

  // 1) Distributor lookup.
  const { data: distRows, error: distError } = await supabase
    .from("marketing_distributors")
    .select("id, display_name, normalized_name");
  if (distError) throw distError;
  const distIdByNorm = new Map<string, number>();
  for (const row of (distRows ?? []) as Array<{ id: number; normalized_name: string | null }>) {
    const key = lower(row.normalized_name);
    if (key) distIdByNorm.set(key, Number(row.id));
  }

  // 2) Read the workbook.
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error("workbook has no sheets");

  type Row = { code: string; name: string; distributor: string; sourceRow: number };
  const parsed: Row[] = [];
  const skippedByDistributor = new Map<string, number>();
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return; // header
    const code = String(row.getCell(1).value ?? "").trim();
    const name = String(row.getCell(2).value ?? "").trim();
    const distributor = String(row.getCell(3).value ?? "").trim();
    if (!code || !distributor) return;
    const mapped = DISTRIBUTOR_MAP[lower(distributor)];
    if (!mapped || !distIdByNorm.has(mapped)) {
      skippedByDistributor.set(distributor, (skippedByDistributor.get(distributor) ?? 0) + 1);
      return;
    }
    parsed.push({ code, distributor: mapped, name, sourceRow: rowNumber });
  });

  console.log(`\nparsed rows (mapped distributors) : ${parsed.length}`);
  if (skippedByDistributor.size > 0) {
    console.log("skipped — distributor not mapped:");
    for (const [name, count] of [...skippedByDistributor.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${name}: ${count}`);
    }
  }

  // 3) What already exists, so the run is a true upsert and the dry run reports real deltas.
  // Read EVERY existing pair, and prove the read was complete.
  //
  // A short read here would be silently destructive: unseen rows look absent, get inserted again,
  // and a duplicated (distributor, code) pair makes buildPharmacyCodeReferenceResult return
  // `ambiguous` instead of `matched` — so a partial read BREAKS codes that currently work. Paging
  // until a short page is not proof of completeness, so the exact count is fetched up front and
  // asserted against; the run aborts rather than risk it.
  //
  // Note the distinction, because it caused a misdiagnosis during the first production run:
  // `expected`/`read` count ROWS, while `existing` holds DISTINCT (distributor, code) pairs. When
  // the table already contains duplicates the Set is legitimately smaller than the row count.
  // That gap is a pre-existing data problem, NOT a short read — do not "fix" it by loosening this
  // assertion. Production held 494 such duplicate rows before this importer ever ran.
  const { count: exactCount, error: countError } = await supabase
    .from("marketing_pharmacy_code_references")
    .select("id", { count: "exact", head: true });
  if (countError) throw countError;
  const expected = exactCount ?? 0;

  const existing = new Set<string>();
  const PAGE = 1000;
  let read = 0;
  for (let from = 0; from < expected; from += PAGE) {
    const { data, error } = await supabase
      .from("marketing_pharmacy_code_references")
      .select("distributor_id, normalized_pharmacy_code")
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    const page = (data ?? []) as Array<{ distributor_id: number; normalized_pharmacy_code: string | null }>;
    read += page.length;
    for (const row of page) existing.add(`${row.distributor_id}::${normalizeCode(row.normalized_pharmacy_code)}`);
    if (page.length === 0) break;
  }
  if (read !== expected) {
    throw new Error(
      `Refusing to continue: read ${read} existing reference rows but the table reports ${expected}. ` +
        `Inserting now would duplicate the ${expected - read} unread pairs and turn matched codes into ambiguous.`,
    );
  }
  console.log(`existing reference rows           : ${expected} (read ${read}, verified)`);

  // Surface pre-existing duplicates rather than absorbing them silently. A duplicated pair makes
  // the matcher report `ambiguous` for a code that should be `matched`, so this is a live defect
  // in the data, not cosmetic — production carried 494 of them undetected until this ran.
  const duplicateRows = expected - existing.size;
  if (duplicateRows > 0) {
    console.log(
      `WARNING: ${duplicateRows} duplicate reference row(s) already exist (${existing.size} distinct pairs).\n` +
        `         Duplicates make the matcher return 'ambiguous' instead of 'matched'. This import does not\n` +
        `         create or remove them — clean them separately, keeping the lowest id per pair.`,
    );
  }

  // 4) Build the insert set, de-duplicated within the file itself.
  const seen = new Set<string>();
  const toInsert: Array<Record<string, unknown>> = [];
  for (const row of parsed) {
    const distributorId = distIdByNorm.get(row.distributor);
    if (!distributorId) continue;
    const key = `${distributorId}::${normalizeCode(row.code)}`;
    if (existing.has(key) || seen.has(key)) continue;
    seen.add(key);
    // normalized_pharmacy_code is a GENERATED column — the database derives it from
    // raw_pharmacy_code and rejects any attempt to supply it. It is still used above for the
    // existence check, which only READS it.
    toInsert.push({
      distributor_id: distributorId,
      normalized_distributor_name: row.distributor,
      raw_distributor_name: row.distributor,
      raw_pharmacy_code: row.code,
      source_file: SOURCE_LABEL,
      source_row: row.sourceRow,
    });
  }

  console.log(`NEW rows that would be inserted   : ${toInsert.length}`);
  console.log(`already present (left untouched)  : ${parsed.length - toInsert.length}`);

  if (!apply) {
    console.log("\nDry run complete — nothing written. Re-run with --apply to write.");
    return;
  }

  let written = 0;
  for (let i = 0; i < toInsert.length; i += 500) {
    const batch = toInsert.slice(i, i + 500);
    const { error } = await supabase.from("marketing_pharmacy_code_references").insert(batch);
    if (error) throw error;
    written += batch.length;
    if (written % 5000 === 0 || written === toInsert.length) console.log(`  written ${written}/${toInsert.length}`);
  }
  console.log(`\nDone. Inserted ${written} reference rows.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

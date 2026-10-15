// READ-ONLY dry-run of learnFromCleanedFile: reports exactly which raw->Phoenix mappings a cleaned
// distributor sheet WOULD teach (product aliases, territory aliases, customer->brick map), validated
// against the live masters. Writes NOTHING. Mirrors the mining logic in
// src/lib/sales/normalizer/service.ts::learnFromCleanedFile.
//
//   node --experimental-strip-types --experimental-specifier-resolution=node \
//        --experimental-loader ./tests/alias-loader.mjs \
//        scripts/learn-from-cleaned-dry-run.ts [CODE] ["path.xlsx"]

import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";

import ExcelJS from "exceljs";

import { loadSalesReferenceData } from "@/lib/sales/monthly-distributor-import";
import { resolveDistributorProfile } from "@/lib/sales/normalizer/distributor-profile-store";
import { normalizeCodeKey } from "@/lib/sales/normalizer/resolvers";

import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";

// A flag this script does not know is refused, never ignored (scripts/lib/refuse-arguments.mjs).
refuseUnknownFlags({
  name: "learn-from-cleaned-dry-run",
  entry: import.meta.url,
  known: [],
});

function loadEnvLocal() {
  const path = resolve(process.cwd(), ".env.local");
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("="); if (eq === -1) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(k in process.env)) process.env[k] = v;
  }
}
loadEnvLocal();

const PHOENIX_PRODUCT_COLUMNS = ["Product ID"];
const PHOENIX_BRICK_COLUMNS = ["Brick ID", "Brick ID2"];

async function main() {
  const code = (process.argv[2] || "SF").toUpperCase();
  const filePath = process.argv[3] || "C:/Users/satoh/OneDrive/Desktop/Phoenix Sales Upload/sofico-April.xlsx";
  if (!existsSync(filePath)) { console.error(`File not found: ${filePath}`); process.exit(1); }

  const profile = await resolveDistributorProfile(code);
  if (!profile) { console.error(`No profile for ${code}`); process.exit(1); }
  const refs = await loadSalesReferenceData({ includeCustomerBricks: false });
  const productCodes = new Set(refs.products.map((p) => normalizeCodeKey(p.productCode)));
  const brickIds = new Set((refs.bricks ?? []).map((b) => normalizeCodeKey(b.brickId)));

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(readFileSync(filePath) as unknown as ArrayBuffer);
  const sheet = wb.worksheets[0]!;

  let headerRow = 1;
  for (let r = 1; r <= Math.min(sheet.rowCount, 10); r++) { let n = 0; sheet.getRow(r).eachCell({ includeEmpty: false }, () => { n++; }); if (n >= 3) { headerRow = r; break; } }
  const col = new Map<string, number>();
  sheet.getRow(headerRow).eachCell({ includeEmpty: false }, (cell, i) => { const k = String(cell.text ?? "").trim().toLowerCase(); if (k && !col.has(k)) col.set(k, i); });
  const colOf = (names: string[]) => { for (const n of names) { const i = col.get(n.trim().toLowerCase()); if (i) return i; } return 0; };
  const text = (row: ExcelJS.Row, i: number) => (i ? String(row.getCell(i)?.text ?? "").trim() : "");

  const productIdCol = colOf(PHOENIX_PRODUCT_COLUMNS);
  const brickIdCol = colOf(PHOENIX_BRICK_COLUMNS);
  const rawProductCols = profile.productColumns.map((n) => colOf([n])).filter(Boolean);
  const primaryTerritory = profile.territoryColumns?.[0] ? colOf([profile.territoryColumns[0]]) : 0;
  const customerCol = profile.customerCodeColumns?.[0] ? colOf([profile.customerCodeColumns[0]]) : 0;

  const nameOfCol = (i: number) => { for (const [k, v] of col) if (v === i) return k; return `col${i}`; };
  console.log(`\nLEARN-FROM-CLEANED DRY RUN (read-only) — ${profile.distributorCode} ${profile.distributorName}`);
  console.log(`File: ${basename(filePath)}`);
  console.log(`Masters: ${productCodes.size} products, ${brickIds.size} bricks`);
  console.log(`Teach columns -> raw product: [${profile.productColumns.join(", ")}]; primary territory: ${primaryTerritory ? nameOfCol(primaryTerritory) : "(none)"}; customer: ${customerCol ? nameOfCol(customerCol) : "(none)"}`);
  console.log(`Phoenix columns -> Product ID col#${productIdCol || "MISSING"}, Brick ID col#${brickIdCol || "MISSING"}`);

  const seen = new Set<string>();
  const prodValid = new Set<string>(), prodInvalidCodes = new Set<string>();
  const terrValid = new Set<string>(), custValid = new Set<string>();
  const badProductCodes = new Set<string>(), badBrickIds = new Set<string>();
  let scanned = 0, rowsWithValidPid = 0, rowsWithValidBid = 0;

  for (let r = headerRow + 1; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    let any = false; row.eachCell({ includeEmpty: false }, () => { any = true; });
    if (!any) continue;
    scanned++;
    const pid = normalizeCodeKey(text(row, productIdCol));
    if (pid) {
      if (productCodes.has(pid)) {
        rowsWithValidPid++;
        for (const ci of rawProductCols) { const raw = text(row, ci); const key = `p:${raw.toLowerCase()}`; if (raw && !seen.has(key)) { seen.add(key); prodValid.add(`${raw} => ${pid}`); } }
      } else { badProductCodes.add(pid); prodInvalidCodes.add(pid); }
    }
    const bid = normalizeCodeKey(text(row, brickIdCol));
    if (bid) {
      if (brickIds.has(bid)) {
        rowsWithValidBid++;
        if (primaryTerritory) { const raw = text(row, primaryTerritory); const key = `t:${raw.toLowerCase()}`; if (raw && !seen.has(key)) { seen.add(key); terrValid.add(`${raw} => ${bid}`); } }
        if (customerCol) { const raw = text(row, customerCol); const key = `c:${raw.toLowerCase()}`; if (raw && !seen.has(key)) { seen.add(key); custValid.add(`${raw} => ${bid}`); } }
      } else { badBrickIds.add(bid); }
    }
  }

  console.log(`\nRows scanned: ${scanned}`);
  console.log(`Rows whose Product ID is a real Phoenix code : ${rowsWithValidPid}/${scanned}`);
  console.log(`Rows whose Brick ID  is a real Phoenix brick : ${rowsWithValidBid}/${scanned}`);
  console.log(`\nWOULD SAVE (distinct, insert-if-absent):`);
  console.log(`  Product aliases  : ${prodValid.size}`);
  console.log(`  Territory aliases: ${terrValid.size}   (from ${primaryTerritory ? nameOfCol(primaryTerritory) : "n/a"})`);
  console.log(`  Customer->brick  : ${custValid.size}`);
  console.log(`  TOTAL mappings   : ${prodValid.size + terrValid.size + custValid.size}`);

  if (badProductCodes.size) console.log(`\n⚠ Product IDs in file NOT in master (skipped): ${badProductCodes.size} -> ${[...badProductCodes].slice(0, 20).join(", ")}`);
  if (badBrickIds.size) console.log(`⚠ Brick IDs in file NOT in master (skipped): ${badBrickIds.size} -> ${[...badBrickIds].slice(0, 20).join(", ")}`);

  console.log(`\nSample product aliases:`);
  for (const p of [...prodValid].slice(0, 12)) console.log(`   ${p}`);
  console.log(`Sample customer->brick:`);
  for (const c of [...custValid].slice(0, 6)) console.log(`   ${c}`);
}

main().catch((e) => { console.error("dry-run failed:", e instanceof Error ? e.message : e); process.exit(1); });

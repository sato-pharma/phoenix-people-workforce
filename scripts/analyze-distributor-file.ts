// Reusable, read-only "analyze a distributor sales file" runner.
//
// It drives the EXACT same code the Upload Sales / Normalizer-preview screen runs
// (resolveDistributorProfile -> loadCrosswalks -> normalizeRawWorkbook -> summarizePreview),
// against the live masters in the Supabase project configured in .env.local. Nothing is written
// to the database — this only reads masters/crosswalks and reports what the system would code.
//
// Usage:
//   node --experimental-strip-types --experimental-specifier-resolution=node \
//        --experimental-loader ./tests/alias-loader.mjs \
//        scripts/analyze-distributor-file.ts [DISTRIBUTOR_CODE] ["path\to\file.xlsx"]
//
// Defaults: SF + the Sofico April file on the Desktop upload folder.

import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";

import { resolveDistributorProfile } from "@/lib/sales/normalizer/distributor-profile-store";
import {
  buildCodedWorkbook,
  normalizeUploadedFile,
  recognitionErrorMessage,
  summarizePreview,
} from "@/lib/sales/normalizer/service";

import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";

// A flag this script does not know is refused, never ignored (scripts/lib/refuse-arguments.mjs).
refuseUnknownFlags({
  name: "analyze-distributor-file",
  entry: import.meta.url,
  known: [],
});

// ── env: load .env.local exactly like scripts/validate-source-of-sales.mjs ──
function loadEnvLocal() {
  const path = resolve(process.cwd(), ".env.local");
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(k in process.env)) process.env[k] = v;
  }
}
loadEnvLocal();

const num = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 2 });
const pct = (a: number, b: number) => (b > 0 ? `${((a / b) * 100).toFixed(1)}%` : "0%");
const bar = (s: string) => "─".repeat(s.length);

async function main() {
  const distributorCode = (process.argv[2] || "SF").toUpperCase();
  const filePath =
    process.argv[3] || "C:/Users/satoh/OneDrive/Desktop/Phoenix Sales Upload/sofico-April.xlsx";

  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error("Missing Supabase env (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local).");
    process.exit(1);
  }
  if (!existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  const fileName = basename(filePath);
  const bytes = readFileSync(filePath);
  const file = new File([new Uint8Array(bytes)], fileName);

  const profile = await resolveDistributorProfile(distributorCode);
  if (!profile) {
    console.error(`No normalizer profile for distributor "${distributorCode}".`);
    process.exit(1);
  }

  const title = `PHOENIX SOURCE-OF-SALES — FILE ANALYSIS`;
  console.log(`\n${title}\n${bar(title)}`);
  console.log(`File         : ${fileName}`);
  console.log(`Distributor  : ${profile.distributorCode} — ${profile.distributorName}`);
  console.log(`Supabase     : ${process.env.SUPABASE_PROJECT_REF ?? process.env.NEXT_PUBLIC_SUPABASE_URL}`);

  // ── Template mapping: which profile columns the system found in this file ──
  const headerSet = new Set<string>();
  {
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(bytes as unknown as ArrayBuffer);
    const ws = wb.worksheets[0];
    ws?.getRow(1).eachCell({ includeEmpty: false }, (cell) => {
      const t = String((cell.value as { text?: string })?.text ?? cell.value ?? "").trim().toLowerCase();
      if (t) headerSet.add(t);
    });
  }
  const mapLine = (label: string, cols: string[] | undefined) => {
    const found = (cols ?? []).filter((c) => headerSet.has(c.trim().toLowerCase()));
    const missing = (cols ?? []).filter((c) => !headerSet.has(c.trim().toLowerCase()));
    const mark = found.length ? "OK " : "-- ";
    const miss = missing.length ? `   (not in file: ${missing.join(", ")})` : "";
    console.log(`  ${mark}${label.padEnd(13)}: ${found.join(", ") || "(none matched)"}${miss}`);
  };
  console.log(`\nTEMPLATE MAPPING (profile column -> file header)`);
  mapLine("product", profile.productColumns);
  mapLine("qty", profile.qtyColumns);
  mapLine("bonus", profile.bonusColumns);
  mapLine("value", profile.valueColumns);
  mapLine("date", profile.dateColumns);
  mapLine("customer code", profile.customerCodeColumns);
  mapLine("customer name", profile.customerNameColumns);
  mapLine("territory", profile.territoryColumns);
  mapLine("discount", profile.discountColumns);

  // ── Run the real engine against the live masters/crosswalks ──
  const normalized = await normalizeUploadedFile(distributorCode, file);
  if (normalized.status !== "ok") {
    // The recognizer already writes the sentence for every way a file can be refused - a missing
    // column group, a coded sheet, or a template naming no distributor the system knows.
    console.error(`
ERROR: ${recognitionErrorMessage(normalized)}`);
    process.exit(1);
  }
  const { result, period, distributorName, products } = normalized;
  const preview = summarizePreview(distributorCode, distributorName, result, products);
  const s = result.summary;

  // exception reason breakdown
  let exProduct = 0, exBrick = 0, exBoth = 0;
  for (const e of result.exceptions) {
    if (e.reason === "both") exBoth++;
    else if (e.reason === "product") exProduct++;
    else exBrick++;
  }

  // recomputed totals on the dominant-period rows (what an import would actually persist)
  const periodRows = result.coded.filter((r) => r.invoiceDate === period);
  const sum = (rows: typeof result.coded, f: (r: (typeof result.coded)[number]) => number) =>
    rows.reduce((a, r) => a + (Number.isFinite(f(r)) ? f(r) : 0), 0);

  console.log(`\nPERIOD`);
  console.log(`  Dominant period : ${period ?? "(none detected)"}`);
  if (preview.periods.length) {
    console.log(`  All periods     : ${preview.periods.map((p) => `${p.period} (${p.rows} rows)`).join(", ")}`);
  }

  console.log(`\nROW OUTCOME`);
  console.log(`  Rows scanned        : ${num(s.totalRows)}`);
  console.log(`  Fully coded (ready) : ${num(s.fullyCoded)}  (${pct(s.fullyCoded, s.totalRows)})`);
  console.log(`  Needs mapping       : ${num(result.exceptions.length)}  (${pct(result.exceptions.length, s.totalRows)})`);
  console.log(`     - missing product : ${num(exProduct)}`);
  console.log(`     - missing brick   : ${num(exBrick)}`);
  console.log(`     - missing both    : ${num(exBoth)}`);
  console.log(`  Ignored (not sold)  : ${num(s.ignored)}`);
  console.log(`  Product resolved    : ${num(s.productResolved)} rows`);
  console.log(`  Brick resolved      : ${num(s.brickResolved)} rows`);

  console.log(`\nRECOMPUTED TOTALS  (qty x factory_price — bonus and sheet value both ignored)`);
  console.log(`  Coded — all periods   : ${num(sum(result.coded, (r) => r.qty))} units, ${num(sum(result.coded, (r) => r.bonusQty))} bonus, EGP ${num(sum(result.coded, (r) => r.value))}`);
  console.log(`  Coded — ${(period ?? "n/a").padEnd(13)}: ${num(sum(periodRows, (r) => r.qty))} units, ${num(sum(periodRows, (r) => r.bonusQty))} bonus, EGP ${num(sum(periodRows, (r) => r.value))}`);

  const top = (label: string, list: typeof preview.unknownProducts, withSuggest: boolean) => {
    if (!list.length) { console.log(`\n${label}: none ✅`); return; }
    console.log(`\n${label} (top ${Math.min(15, list.length)} of ${list.length})`);
    for (const u of list.slice(0, 15)) {
      const name = u.rawName ? ` "${u.rawName}"` : "";
      const sug = withSuggest && u.suggestionCode ? `  -> suggest ${u.suggestionCode} (${u.suggestionLabel ?? ""})` : "";
      console.log(`  x${String(u.count).padStart(3)}  ${u.raw}${name}${sug}`);
    }
  };
  top("UNKNOWN PRODUCTS", preview.unknownProducts, true);
  top("UNKNOWN TERRITORIES", preview.unknownTerritories, false);
  top("UNKNOWN CUSTOMERS (need brick map)", preview.unknownCustomers, false);

  const ready = result.exceptions.length === 0;
  console.log(`\nVERDICT`);
  if (ready) {
    console.log(`  ✅ READY TO IMPORT — every row coded to a product + brick.`);
  } else {
    console.log(`  ⚠ NEEDS MAPPING FIRST — ${num(result.exceptions.length)} rows cannot code yet.`);
    console.log(`     Map ${preview.unknownProducts.length} product(s), ${preview.unknownTerritories.length} territory(ies), ${preview.unknownCustomers.length} customer(s),`);
    console.log(`     then re-run — the rest (${pct(s.fullyCoded, s.totalRows)}) is already importable.`);
  }

  // ── Artifacts ──
  const outDir = resolve(process.cwd(), "outputs");
  mkdirSync(outDir, { recursive: true });
  const stem = fileName.replace(/\.[^.]+$/, "");
  const jsonPath = resolve(outDir, `${stem}-analysis.json`);
  writeFileSync(jsonPath, JSON.stringify(preview, null, 2), "utf8");
  const codedBuf = await buildCodedWorkbook(result);
  const xlsxPath = resolve(outDir, `${stem}-coded.xlsx`);
  writeFileSync(xlsxPath, Buffer.from(codedBuf as ArrayBuffer));

  console.log(`\nARTIFACTS`);
  console.log(`  ${jsonPath}`);
  console.log(`  ${xlsxPath}  (Coded sheet + "Needs mapping" sheet)\n`);
}

main().catch((e) => {
  console.error("\nAnalysis failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});

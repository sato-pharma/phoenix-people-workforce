// READ-ONLY probe of the REAL Upload-Sales recognition path (no DB write).
// Calls validateDistributorSalesWorkbookBuffer exactly like the upload route does, so it reports
// which coded template recognizes the file, the batch status, and the recomputed totals.
//
//   node --experimental-strip-types --experimental-specifier-resolution=node \
//        --experimental-loader ./tests/alias-loader.mjs \
//        scripts/verify-sofico-upload.ts [CODE] ["path.xlsx"]

import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";

import {
  loadSalesReferenceData,
  validateDistributorSalesWorkbookBuffer,
} from "@/lib/sales/monthly-distributor-import";

import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";

// A flag this script does not know is refused, never ignored (scripts/lib/refuse-arguments.mjs).
refuseUnknownFlags({
  name: "verify-sofico-upload",
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

async function main() {
  const code = (process.argv[2] || "SF").toUpperCase();
  const filePath = process.argv[3] || "C:/Users/satoh/OneDrive/Desktop/Phoenix Sales Upload/sofico-April.xlsx";
  if (!existsSync(filePath)) { console.error(`File not found: ${filePath}`); process.exit(1); }

  const fileName = basename(filePath);
  const buffer = readFileSync(filePath);
  console.log(`\nUPLOAD RECOGNITION PROBE — distributor ${code}, file ${fileName}`);

  let references;
  try {
    references = await loadSalesReferenceData();
  } catch (e) {
    console.error("Could not load references:", e instanceof Error ? e.message : e);
    process.exit(1);
  }

  try {
    const r = await validateDistributorSalesWorkbookBuffer({ buffer, distributorCode: code, fileName, references });
    console.log(`\n✅ RECOGNIZED`);
    console.log(`  Template     : ${r.templateName} (key=${r.templateKey})`);
    console.log(`  Sheet        : ${r.sheetName}`);
    console.log(`  Status       : ${r.status}`);
    console.log(`  Period       : ${r.period ?? "(mixed/none)"}`);
    console.log(`  Rows         : ${r.rowCount}  (importable ${r.importableRows}, failed ${r.failedRows}, warnings ${r.warningRows})`);
    console.log(`  Totals       : qty ${r.totals?.totalQty}, bonus ${r.totals?.totalBonusQty}, value EGP ${Number(r.totals?.totalValue ?? 0).toLocaleString("en-US", { maximumFractionDigits: 2 })}`);
    console.log(`  By product   : ${r.byProduct?.length ?? 0} products, by brick ${r.byBrick?.length ?? 0}, by region ${r.byRegion?.length ?? 0}`);
    const warnFields = new Map<string, number>();
    for (const i of r.issues ?? []) warnFields.set(i.field, (warnFields.get(i.field) ?? 0) + 1);
    console.log(`  Warning kinds: ${[...warnFields.entries()].map(([f, n]) => `${f} x${n}`).join(", ")}`);
    if (r.blockingReasons?.length) console.log(`  Blocking     : ${r.blockingReasons.join("; ")}`);
    if (r.advisories?.length) console.log(`  Advisories   : ${r.advisories.join("; ")}`);
    if (r.issues?.length) {
      console.log(`  Issues (first 8 of ${r.issues.length}):`);
      for (const i of r.issues.slice(0, 8)) console.log(`     - ${JSON.stringify(i)}`);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const codeStr = (e as { code?: string })?.code ?? "";
    console.log(`\n❌ NOT RECOGNIZED by the coded path${codeStr ? ` (${codeStr})` : ""}`);
    console.log(`  ${msg}`);
  }
}

main().catch((e) => { console.error("probe failed:", e instanceof Error ? e.message : e); process.exit(1); });

// Pre-import gate: which item names in a month's distributor files have NO product mapping?
//
// WHY THIS EXISTS. `check:sos-product-mapping` asks the same question of the DATABASE — after the
// month is stored, which is after the damage. Between 2026-06-25 and 2026-08-09 every Pharma
// Overseas row resolved by ITEM CODE because none of its names were registered, and two of those
// codes were wrong: 1,298 packs of Rispadex syrup were reported as Conviban 100 mg and 762 packs of
// Tebofortin drops as the 40 mg tablet, every month, for seven months. Nothing failed and no total
// moved — a misfiled unit is still a unit — so no gate could catch it after the fact.
//
// This runs BEFORE the upload, against the files themselves, and answers the only question that
// matters at that moment: for every distinct item name in this folder, does an alias exist for THAT
// distributor, and if not, what will the importer silently fall back to?
//
// It reproduces the importer's own resolution order exactly (resolveProduct: name first, then code,
// per distributor) so a name this script calls unmapped is a name the importer will also fail to
// place. Anything less faithful would be a second opinion rather than a check.
//
// Read-only: reads the files and the crosswalks, writes nothing.
//
//   pnpm run check:sos-source-files "C:\path\to\sato 7-2026"
//
// Exit code is 0 even with findings — this reports so a human can decide, it does not block. A
// distributor legitimately sends products outside the line, and refusing the upload for those would
// train everyone to bypass the gate.

import { readdir } from "node:fs/promises";
import path from "node:path";

import ExcelJS from "exceljs";

import { loadCrosswalks } from "@/lib/sales/normalizer/crosswalks";
import { detectDistributor, type DetectionProfile } from "@/lib/sales/normalizer/detect-distributor";
import { normalizeAliasKey, resolveProduct } from "@/lib/sales/normalizer/resolvers";
import { RAW_DISTRIBUTOR_PROFILES } from "@/lib/sales/normalizer/profiles";
import type { Crosswalks, DistributorProfile } from "@/lib/sales/normalizer/types";

import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";

// A flag this script does not know is refused, never ignored (scripts/lib/refuse-arguments.mjs).
refuseUnknownFlags({
  name: "check-sos-source-files",
  entry: import.meta.url,
  known: [],
});

type Finding = {
  distributorCode: string;
  fallback: string;
  file: string;
  itemCode: string;
  itemName: string;
  rows: number;
  units: number;
};

/** Header row is not always row 1 — distributors ship title banners. Take the first row that
 *  matches at least two of the profile's declared headers, same as the importer's own scan. */
export function findHeaderRow(rows: string[][], headerAliases: ReadonlySet<string>): number {
  for (let index = 0; index < Math.min(rows.length, 15); index += 1) {
    const hits = rows[index].filter((cell) => headerAliases.has(normalizeAliasKey(cell))).length;
    if (hits >= 2) return index;
  }
  return 0;
}

/** Column index for the first header alias present, else -1. */
export function columnFor(header: string[], candidates: readonly string[] | undefined): number {
  if (!candidates?.length) return -1;
  const wanted = new Set(candidates.map((value) => normalizeAliasKey(value)));
  for (let index = 0; index < header.length; index += 1) {
    if (wanted.has(normalizeAliasKey(header[index]))) return index;
  }
  return -1;
}

function num(value: unknown): number {
  const parsed = Number(String(value ?? "").replace(/[^\d.\-]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Scan one workbook and return every item whose NAME has no alias for this distributor.
 *
 * `fallback` is the whole point: it names the product the importer will use instead. An item with
 * no name alias but a correct code alias is harmless; one that falls through to the wrong product,
 * or to nothing, is the bug this script exists to surface — so the two are reported differently
 * rather than lumped together as "unmapped".
 */
export function scanRows(
  rows: string[][],
  headerIndex: number,
  nameColumn: number,
  codeColumn: number,
  qtyColumn: number,
  distributorCode: string,
  maps: Crosswalks,
): Finding[] {
  const byItem = new Map<string, { code: string; name: string; rows: number; units: number }>();
  for (let index = headerIndex + 1; index < rows.length; index += 1) {
    const row = rows[index];
    const name = nameColumn >= 0 ? String(row[nameColumn] ?? "").trim() : "";
    const code = codeColumn >= 0 ? String(row[codeColumn] ?? "").trim() : "";
    if (!name && !code) continue;
    const key = `${normalizeAliasKey(name)}|${code}`;
    const entry = byItem.get(key) ?? { code, name, rows: 0, units: 0 };
    entry.rows += 1;
    entry.units += qtyColumn >= 0 ? num(row[qtyColumn]) : 0;
    byItem.set(key, entry);
  }

  const findings: Finding[] = [];
  for (const item of byItem.values()) {
    // Does the NAME alone resolve? That is the importer's first pass.
    const byName = item.name ? resolveProduct([item.name], maps, distributorCode) : null;
    if (byName) continue;
    // It does not. What will the importer actually use — the code fallback, or nothing?
    const resolved = resolveProduct([item.name, item.code], maps, distributorCode);
    findings.push({
      distributorCode,
      fallback: resolved
        ? `falls back to item code -> ${resolved}`
        : "NOTHING — this row will not be imported",
      file: "",
      itemCode: item.code,
      itemName: item.name,
      rows: item.rows,
      units: item.units,
    });
  }
  return findings;
}

function toDetectionProfile(profile: DistributorProfile): DetectionProfile {
  const groups = [profile.productNameColumns, profile.productCodeColumns, profile.qtyColumns]
    .filter((group): group is string[] => Boolean(group?.length));
  return {
    distributorCode: profile.distributorCode,
    distributorName: profile.distributorCode,
    optionalGroups: [],
    requiredGroups: groups,
  };
}

async function main() {
  const folder = process.argv[2];
  if (!folder) {
    console.error('Usage: pnpm run check:sos-source-files "<folder of distributor files>"');
    process.exitCode = 1;
    return;
  }

  const maps = await loadCrosswalks();
  const profiles = RAW_DISTRIBUTOR_PROFILES;
  console.log(`[sos-source-files] ${profiles.length} distributor profiles, folder: ${folder}\n`);

  const entries = (await readdir(folder)).filter((name) => /\.xlsx?$/i.test(name) && !name.startsWith("~$"));
  const detectionProfiles = profiles.map(toDetectionProfile);
  const allFindings: Finding[] = [];

  for (const fileName of entries.sort()) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(path.join(folder, fileName));
    const sheet = workbook.worksheets[0];
    if (!sheet) continue;

    const rows: string[][] = [];
    sheet.eachRow((row) => {
      const values: string[] = [];
      row.eachCell({ includeEmpty: true }, (cell, col) => {
        values[col - 1] = cell.text ?? "";
      });
      rows.push(values);
    });
    if (rows.length < 2) continue;

    const aliasPool = new Set(
      profiles.flatMap((profile) => [
        ...(profile.productNameColumns ?? []),
        ...(profile.productCodeColumns ?? []),
        ...(profile.qtyColumns ?? []),
      ]).map((value) => normalizeAliasKey(value)),
    );
    const headerIndex = findHeaderRow(rows, aliasPool);
    const header = rows[headerIndex] ?? [];
    const detection = detectDistributor(header, detectionProfiles);
    const code = detection.best?.distributorCode ?? "";
    if (!code) {
      console.log(`  ${fileName.padEnd(42)} distributor NOT DETECTED — skipped`);
      continue;
    }
    const profile = profiles.find((entry) => entry.distributorCode === code);
    if (!profile) continue;

    const findings = scanRows(
      rows,
      headerIndex,
      columnFor(header, profile.productNameColumns),
      columnFor(header, profile.productCodeColumns),
      columnFor(header, profile.qtyColumns),
      code,
      maps,
    ).map((finding) => ({ ...finding, file: fileName }));

    console.log(`  ${fileName.padEnd(42)} ${code.padEnd(8)} ${findings.length} unmapped item name(s)`);
    allFindings.push(...findings);
  }

  if (allFindings.length === 0) {
    console.log("\n[sos-source-files] every item name in this folder is mapped for its distributor.");
    return;
  }

  console.log(`\n[sos-source-files] ${allFindings.length} item name(s) with NO alias for their distributor:\n`);
  allFindings.sort((a, b) => Math.abs(b.units) - Math.abs(a.units));
  for (const finding of allFindings) {
    console.log(
      `  ${finding.distributorCode.padEnd(8)} ${String(Math.round(finding.units)).padStart(8)} units  ` +
        `${finding.itemName.slice(0, 44).padEnd(44)} code=${finding.itemCode.padEnd(10)} ${finding.fallback}`,
    );
  }
  const dropped = allFindings.filter((finding) => finding.fallback.startsWith("NOTHING"));
  if (dropped.length) {
    console.log(
      `\n  ${dropped.length} of these resolve to NOTHING and will be dropped entirely ` +
        `(${Math.round(dropped.reduce((sum, f) => sum + f.units, 0))} units).`,
    );
  }
  console.log(
    "\n  A code fallback is not safety: item 7520 fell back to Conviban 100 for seven months and it" +
      "\n  was Rispadex syrup. Check each fallback against the distributor's own item list before importing.",
  );
}

if (process.argv[1] && /check-sos-source-files\.ts$/.test(process.argv[1])) {
  main().catch((error) => {
    console.error("[sos-source-files] FAILED:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

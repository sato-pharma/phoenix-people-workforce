#!/usr/bin/env node
// Ask the owner which of our areas a hand-typed area belongs to — and read his answers back.
//
//   node scripts/cv-area-questions.mjs                 build the question workbook
//   node scripts/cv-area-questions.mjs --unplaceable   only the CVs sitting with NO region at all
//   node scripts/cv-area-questions.mjs --apply <file>  read the answered workbook and file them
//   node scripts/cv-area-questions.mjs --apply <file> --dry-run   show the writes, make none
//
// RUN IT THROUGH THE ALIAS LOADER — it imports the live placement modules rather than copying them.
// The registered entry does that for you: `pnpm run cv-drive:questions`.
//
// WHY A WORKBOOK AND NOT A LIST IN CHAT. Standing owner rule: a "which of these does each of these
// belong to" question is asked as an XLSX with dropdowns — one row per item, the context that makes
// the call easy, a locked list of valid answers, and a free-text Note column. Never as prose.
//
// WHY --apply EXISTS. A sheet the owner fills in and hands back is only half the job; the other half
// is somebody typing the answers into the database, and that somebody should not be him. `--apply`
// reads column F, checks each answer is a real area, writes `folder_key`, and clears the mirror path
// so the next `cv-drive:refile` moves the CV into its proper area folder.
//
// NO IMAGES, NO OUTLINE GROUPS, and ONE sheet-level validation per contiguous block rather than per
// cell — the three things that make Excel "repair" an ExcelJS workbook on open. Per-cell validation
// coalesces into overlapping `sqref` ranges, which is its own repair prompt.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import ExcelJS from "exceljs";

// Imported, never copied. The region labels, the area→region grouping and the free-text reader all
// live in the modules the app itself calls; a local copy of any of them drifts the first time
// somebody improves the original — which is exactly how backfill-cvs-to-drive.mjs went stale.
import { egyptRegionFromFreeText } from "@/lib/recruitment/candidate-region-freetext";
import { driveFolderPathFor, regionFolderFromTypedArea } from "@/lib/recruitment/drive-cv-folders";

import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";

// A flag this script does not know is refused, never ignored (scripts/lib/refuse-arguments.mjs).
refuseUnknownFlags({
  name: "cv-area-questions",
  entry: import.meta.url,
  known: ["--apply", "--dry-run", "--unplaceable"],
  hints: [
    "--apply <file> files the answers; add --dry-run to show the writes and make none",
  ],
});

// ── env ──────────────────────────────────────────────────────────────────────────────────────────
// Loaded by hand rather than via a dependency: this has to run from a bare worktree, where
// `pnpm exec` is banned (it purges the node_modules junction) and dotenv may not resolve.
function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const rawLine of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    const quoted =
      (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"));
    if (quoted) value = value.slice(1, -1);
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadEnvFile(path.resolve(".env.local"));
loadEnvFile(path.resolve(".env"));

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (they are in .env.local).");
  process.exit(1);
}

const args = process.argv.slice(2);
const UNPLACEABLE_ONLY = args.includes("--unplaceable");
const DRY_RUN = args.includes("--dry-run");
const APPLY_AT = args.indexOf("--apply");
const APPLY_FILE = APPLY_AT >= 0 ? args[APPLY_AT + 1] : null;
if (APPLY_AT >= 0 && !APPLY_FILE) {
  console.error("--apply needs the path to the answered workbook.");
  process.exit(1);
}

async function rest(pathAndQuery, init = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${pathAndQuery}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

const HEADER_ROW = 4;
const ANSWER_COLUMN = 6;
const ID_COLUMN = 8;
const OUT_DIR = path.resolve("xlsx");
const OUT_FILE = path.join(OUT_DIR, "cv-area-questions.xlsx");

/** The 49 live areas, grouped by region — the only valid answers. */
async function loadAreas() {
  const areas = await rest(
    "au_v_canonical_areas?select=area_name,code_region_code&is_active=is.true&order=area_name.asc",
  );
  const byRegion = new Map();
  const canonical = new Map();
  // The same shape `driveFolderPathFor` takes, so this script asks the app where a CV sits rather
  // than assembling a path of its own that can drift out of step with it.
  const areaRegions = {};
  for (const area of areas) {
    if (!area.area_name) continue;
    canonical.set(area.area_name.toLowerCase(), area.area_name);
    if (!area.code_region_code) continue;
    areaRegions[area.area_name] = area.code_region_code;
    if (!byRegion.has(area.code_region_code)) byRegion.set(area.code_region_code, []);
    byRegion.get(area.code_region_code).push(area.area_name);
  }
  return { areas, areaRegions, byRegion, canonical };
}

/**
 * Every medical-rep CV filed under an area that is not one of ours.
 *
 * The "Filed now" column is what the SYSTEM already worked out, read from `driveFolderPathFor`
 * itself rather than rebuilt here — a hand-typed governorate nests under its region, and under its
 * governorate parent where the company splits that governorate in two. So most of these are already
 * in a sensible place and the only open question is which HALF. The ones with no region at all are
 * the urgent rows: they sort to the top and print in red, and `--unplaceable` narrows the sheet to
 * just those.
 */
async function outstandingQuestions({ areaRegions, byRegion, canonical }) {
  const candidates = await rest(
    "ats_candidates?select=id,full_name,folder_key,governorate,address,preferred_region_code," +
      "preferred_area_name,created_at&folder_kind=eq.medical_rep&folder_key=not.is.null&order=folder_key.asc",
  );
  const rows = [];
  for (const candidate of candidates) {
    const typed = String(candidate.folder_key ?? "").trim();
    if (!typed || canonical.has(typed.toLowerCase())) continue;

    // Where the mirror puts it today, and which region's areas the dropdown should offer.
    const placedRegionLabel = regionFolderFromTypedArea(typed);
    const placedPath = driveFolderPathFor({ key: typed, kind: "medical_rep", label: typed }, areaRegions);
    const stated = candidate.preferred_region_code;
    const region =
      (stated && byRegion.has(stated) ? stated : null) ??
      egyptRegionFromFreeText(typed) ??
      egyptRegionFromFreeText(candidate.governorate) ??
      egyptRegionFromFreeText(candidate.address);

    if (UNPLACEABLE_ONLY && placedRegionLabel) continue;
    rows.push({ ...candidate, placedPath, placedRegionLabel, region, typed });
  }
  // Unplaceable first — those are the CVs nobody can find by browsing the tree.
  rows.sort(
    (a, b) =>
      Number(Boolean(a.placedRegionLabel)) - Number(Boolean(b.placedRegionLabel)) ||
      String(a.region).localeCompare(String(b.region)) ||
      String(a.full_name).localeCompare(String(b.full_name)),
  );
  return rows;
}

function buildWorkbook(rows, { areas, byRegion }) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Phoenix Workforce";
  const sheet = workbook.addWorksheet("Which area", { views: [{ state: "frozen", ySplit: HEADER_ROW }] });

  const columns = [
    { header: "Applicant", key: "name", width: 34 },
    { header: "They typed", key: "typed", width: 22 },
    { header: "Governorate on the CV", key: "governorate", width: 20 },
    { header: "Address on the CV", key: "address", width: 34 },
    { header: "Filed now", key: "filed", width: 32 },
    { header: "→ Which of our areas?", key: "answer", width: 22 },
    { header: "Note", key: "note", width: 30 },
    { header: "id", key: "id", width: 38 },
  ];
  sheet.columns = columns.map((column) => ({ key: column.key, width: column.width }));

  sheet.mergeCells(1, 1, 1, columns.length);
  sheet.getCell("A1").value = "CVs filed under an area that is not one of ours";
  sheet.getCell("A1").font = { bold: true, color: { argb: "FFFFFFFF" }, size: 15 };
  sheet.getCell("A1").fill = { fgColor: { argb: "FF0F172A" }, pattern: "solid", type: "pattern" };
  sheet.getCell("A1").alignment = { vertical: "middle" };
  sheet.getRow(1).height = 30;

  sheet.mergeCells(2, 1, 2, columns.length);
  sheet.getCell("A2").value =
    "Each applicant typed their area by hand in WhatsApp and typed something that is not one of our 49 areas. " +
    "Column E shows where the CV sits today. Pick the right area in column F — the list is limited to the areas " +
    "in that region — or write what you want in the Note column, then send the file back. A row left blank is skipped.";
  sheet.getCell("A2").alignment = { vertical: "top", wrapText: true };
  sheet.getRow(2).height = 34;

  sheet.getRow(HEADER_ROW).values = columns.map((column) => column.header);
  sheet.getRow(HEADER_ROW).eachCell((cell) => {
    cell.fill = { fgColor: { argb: "FF0F172A" }, pattern: "solid", type: "pattern" };
    cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
    cell.alignment = { horizontal: "left", vertical: "middle", wrapText: true };
  });
  sheet.getRow(HEADER_ROW).height = 26;

  rows.forEach((entry, index) => {
    const row = sheet.getRow(HEADER_ROW + 1 + index);
    row.values = [
      entry.full_name ?? "—",
      entry.typed,
      entry.governorate ?? "—",
      entry.address ?? "—",
      entry.placedRegionLabel ? entry.placedPath.join(" / ") : "Loose — no region above it",
      null,
      null,
      entry.id,
    ];
    row.alignment = { vertical: "middle", wrapText: true };
    row.getCell(ANSWER_COLUMN).fill = { fgColor: { argb: "FFFFF7ED" }, pattern: "solid", type: "pattern" };
    row.getCell(ANSWER_COLUMN).border = { bottom: { color: { argb: "FFF97316" }, style: "thin" } };
    if (!entry.placedRegionLabel) row.getCell(5).font = { bold: true, color: { argb: "FFB91C1C" } };
    row.height = 24;
  });

  // ONE validation per contiguous region block. Per-cell assignment makes ExcelJS coalesce the rows
  // into OVERLAPPING sqref ranges, and Excel then offers to repair the file on open.
  const everyArea = areas.map((area) => area.area_name);
  let blockStart = 0;
  for (let index = 1; index <= rows.length; index += 1) {
    if (index < rows.length && rows[index].region === rows[blockStart].region) continue;
    const options = byRegion.get(rows[blockStart].region) ?? everyArea;
    sheet.dataValidations.add(`F${HEADER_ROW + 1 + blockStart}:F${HEADER_ROW + index}`, {
      allowBlank: true,
      error: "Choose an area from the list, or write what you want in the Note column instead.",
      errorTitle: "Pick one of our areas",
      formulae: [`"${options.join(",")}"`],
      showErrorMessage: true,
      type: "list",
    });
    blockStart = index;
  }

  // The id column is the join key for --apply and nothing a person needs to read.
  sheet.getColumn(ID_COLUMN).hidden = true;
  return workbook;
}

/** A cell's text, whichever of ExcelJS's several shapes it came back as. */
function cellText(cell) {
  const raw = cell.value;
  if (raw === null || raw === undefined) return "";
  if (typeof raw === "object") return String(raw.text ?? raw.result ?? raw.richText?.map((r) => r.text).join("") ?? "");
  return String(raw);
}

/**
 * Read the answered workbook back and file each candidate.
 *
 * Refuses anything that is not one of our areas rather than writing a typo into the database — a
 * wrong area folder is worse than a shallow one, the same rule the mirror itself follows. Clearing
 * `drive_mirror_path` is what makes the next refile notice the row.
 */
async function applyAnswers(file, { canonical }) {
  if (!fs.existsSync(file)) {
    console.error(`No such file: ${file}`);
    process.exit(1);
  }
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(file);
  const sheet = workbook.getWorksheet("Which area") ?? workbook.worksheets[0];
  if (!sheet) {
    console.error("That workbook has no sheets.");
    process.exit(1);
  }

  const accepted = [];
  const refused = [];
  sheet.eachRow((row, number) => {
    if (number <= HEADER_ROW) return;
    const id = cellText(row.getCell(ID_COLUMN)).trim();
    const answer = cellText(row.getCell(ANSWER_COLUMN)).trim();
    if (!id || !answer) return;
    const name = cellText(row.getCell(1)).trim();
    const canonicalName = canonical.get(answer.toLowerCase());
    if (canonicalName) accepted.push({ answer: canonicalName, id, name });
    else refused.push({ answer, name });
  });

  if (refused.length) {
    console.log("NOT one of our areas — left untouched:");
    for (const entry of refused) console.log(`  ${entry.name}: ${JSON.stringify(entry.answer)}`);
    console.log("");
  }
  if (!accepted.length) {
    console.log("No answered rows to apply.");
    return;
  }

  console.log(`${accepted.length} answer(s) to apply${DRY_RUN ? " (DRY RUN — nothing written)" : ""}:`);
  for (const entry of accepted) {
    console.log(`  ${entry.name}  ->  ${entry.answer}`);
    if (DRY_RUN) continue;
    await rest(`ats_candidates?id=eq.${entry.id}`, {
      body: JSON.stringify({ folder_key: entry.answer }),
      headers: { Prefer: "return=minimal" },
      method: "PATCH",
    });
    await rest(`ats_files?candidate_id=eq.${entry.id}&kind=eq.cv`, {
      body: JSON.stringify({ drive_mirror_path: null }),
      headers: { Prefer: "return=minimal" },
      method: "PATCH",
    });
  }
  if (!DRY_RUN) console.log("\nRun `pnpm run cv-drive:refile` to move the CVs into their new folders.");
}

const areaData = await loadAreas();
if (APPLY_FILE) {
  await applyAnswers(path.resolve(APPLY_FILE), areaData);
} else {
  const rows = await outstandingQuestions(areaData);
  if (!rows.length) {
    console.log(
      UNPLACEABLE_ONLY
        ? "Nothing outstanding — every hand-typed area reaches a region on its own."
        : "Nothing outstanding — every CV's area is one of our areas.",
    );
    process.exit(0);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  await buildWorkbook(rows, areaData).xlsx.writeFile(OUT_FILE);
  const loose = rows.filter((row) => !row.placedRegionLabel).length;
  console.log(`${rows.length} question(s) written to ${OUT_FILE}`);
  if (loose) console.log(`  ${loose} of them are sitting loose with no region at all.`);
  for (const row of rows) {
    const where = row.placedRegionLabel ? row.placedPath.slice(1).join(" / ") : "LOOSE";
    console.log(`  ${where.padEnd(24)}  ${row.full_name} — typed ${JSON.stringify(row.typed)}`);
  }
}

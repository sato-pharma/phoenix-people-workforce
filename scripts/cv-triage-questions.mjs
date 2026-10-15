#!/usr/bin/env node
// Ask the owner to decide the CVs the system already rates a strong fit — and read his answers back.
//
//   node scripts/cv-triage-questions.mjs                   build the decision workbook
//   node scripts/cv-triage-questions.mjs --all             every untriaged CV, not just the recommended
//   node scripts/cv-triage-questions.mjs --rest            untriaged, MINUS the recommended pile
//   node scripts/cv-triage-questions.mjs --band sales      one fit band only
//   node scripts/cv-triage-questions.mjs --exclude-from <file>   skip ids already in that workbook
//   node scripts/cv-triage-questions.mjs --apply <file>    read the answered workbook and decide them
//   node scripts/cv-triage-questions.mjs --apply <file> --dry-run    show the writes, make none
//
// RUN IT THROUGH THE ALIAS LOADER — it imports the live screening modules rather than copying them.
//
// WHY A WORKBOOK AND NOT A LIST IN CHAT. Standing owner rule: a "which of these is which" question
// is asked as an XLSX with dropdowns — one row per item, the context that makes the call easy, a
// locked list of valid answers, and a free-text Note column. Never as prose.
//
// WHY THE DECISION IS NOT MINE. Measured 2026-09-08: 660 candidates had never been triaged. Every
// one is a real person's job application, and this repository's standing pattern is that the system
// recommends and the owner decides — the same rule that keeps rejection notices manual and keeps an
// agent away from approving on the CEO's behalf. So this builds the question and applies the answer;
// it never invents one. A row left blank is left alone.
//
// WHICH CVs. By default only the `recommended` work queue — the system's own "worth meeting first"
// band, 90 of the untriaged on the day this shipped. Deciding those first is worth more than
// grinding the pile in arrival order, and it is a short enough list to finish in one sitting.
//
// ONE SHEET PER BAND, NOT ONE SHEET FOR EVERYTHING. Measured 2026-09-08: 436 untriaged, of which 97
// are `recommended` and 339 are not. A single 339-row question is one nobody finishes, and the
// remainder is not one population — `recommended` turned out to be exactly the `field_force` and
// `pharma_adjacent` bands, leaving `sales` (29) and `unknown` (22), which want a real look, beside
// `unrelated` (268) and `no_cv` (20), which mostly want one ruling each. `--band` cuts the pile the
// way the reader's attention actually divides, so a short sheet can be finished in one sitting and
// the long one is a deliberate choice rather than the only option on offer.
//
// `--exclude-from` exists so a re-run does not re-ask what is already out for answer: arrivals since
// a sheet was sent become a small top-up rather than a reissue that would discard rows the owner has
// already filled in.
//
// NO IMAGES, NO OUTLINE GROUPS, and ONE sheet-level validation per contiguous block rather than per
// cell — the three things that make Excel "repair" an ExcelJS workbook on open. Per-cell validation
// coalesces into overlapping `sqref` ranges, which is its own repair prompt.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import ExcelJS from "exceljs";

// Imported, never copied: the queue membership, the fit band and the decision vocabulary all come
// from the modules the app itself reads, so this sheet cannot disagree with the screen.
import { cairoDayKey } from "@/lib/recruitment/candidate-stats";
import { statusChangeRefusal } from "@/lib/recruitment/candidate-status";
import { loadScreeningWorkspace } from "@/lib/recruitment/screening-workspace";

import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";

// A flag this script does not know is refused, never ignored (scripts/lib/refuse-arguments.mjs).
refuseUnknownFlags({
  name: "cv-triage-questions",
  entry: import.meta.url,
  known: ["--all", "--apply", "--band", "--dry-run", "--exclude-from", "--rest"],
  hints: [
    "--apply <file> decides the answered workbook; add --dry-run to show the writes and make none",
  ],
});

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const rawLine of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadEnvFile(path.resolve(".env.local"));
loadEnvFile(path.resolve(".env"));

const args = process.argv.slice(2);
const ALL = args.includes("--all");
const REST = args.includes("--rest");
const DRY_RUN = args.includes("--dry-run");
const applyAt = args.indexOf("--apply");
const APPLY_FILE = applyAt >= 0 ? args[applyAt + 1] : null;
const bandAt = args.indexOf("--band");
const BAND = bandAt >= 0 ? String(args[bandAt + 1] ?? "").trim() : null;
const excludeAt = args.indexOf("--exclude-from");
const EXCLUDE_FROM = excludeAt >= 0 ? args[excludeAt + 1] : null;

const HEADER_ROW = 1;
const DECISION_COLUMN = "H";
const ID_COLUMN = "I";

/**
 * The only two answers this sheet accepts, and why there is no third.
 *
 * `Shortlist` and `Reject` are exactly the pair the app itself allows as a bulk verdict
 * (`bulkDecidableStatuses`), for reasons recorded there: `sent_to_manager` in bulk would claim a
 * manager was told when none was, `hired` routes around the offer guard, and `new` erases the fact
 * that somebody looked. A sheet offering more than the screen does would be a way around all three.
 *
 * Blank means "not decided", not "no". 660 people have been waiting on a decision; the one thing
 * worse than no answer is a silent one.
 */
const DECISIONS = ["Shortlist", "Reject"];
const DECISION_TO_STATUS = { Reject: "rejected", Shortlist: "shortlisted" };

function text(value) {
  return String(value ?? "").trim();
}

/**
 * A workspace fact, which is NOT always a string.
 *
 * `currentRole` and `currentEmployer` come back as `{ value, confirmed }`, and a plain String() on
 * those writes the literal text "[object Object]" into the cell — which is exactly what the first
 * build of this sheet did, in the two columns a reader looks at first. Caught only because the
 * workbook was read back and its values inspected; nothing about building it complained.
 *
 * `confirmed` is carried through rather than dropped. It says whether a human verified the fact or
 * the CV extractor guessed it, and this sheet is asking somebody to make a hiring decision on these
 * two lines — the same reason the CV database shows how its eligibility verdict was reached. An
 * unconfirmed value is marked, never silently presented as fact.
 */
function fact(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") {
    const inner = text(value.value);
    if (!inner) return "";
    return value.confirmed === false ? `${inner} (read from CV)` : inner;
  }
  return text(value);
}

/**
 * The ids already out for answer in an existing workbook.
 *
 * Keyed on the hidden id column, never on the name: two candidates share a name often enough here
 * that a name-keyed exclusion would silently drop a second, real person from the question.
 */
async function idsAlreadyAsked(file) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(file);
  const sheet = workbook.getWorksheet("Decide these CVs") ?? workbook.worksheets[0];
  if (!sheet) throw new Error(`${file} has no sheet to read.`);
  const ids = new Set();
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber <= HEADER_ROW) return;
    const id = cellText(row.getCell(ID_COLUMN)).trim();
    if (id) ids.add(id);
  });
  return ids;
}

function selectionLabel() {
  if (BAND) return BAND.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  if (REST) return "rest";
  if (ALL) return "all";
  return "recommended";
}

async function untriagedRows() {
  const workspace = await loadScreeningWorkspace(null, {}, { canSendToManagers: true });
  const untriaged = (workspace.rows ?? []).filter((row) => text(row.status) === "new");
  const isRecommended = (row) => Array.isArray(row.queues) && row.queues.includes("recommended");

  let rows;
  if (BAND) rows = untriaged.filter((row) => text(row.band) === BAND);
  else if (REST) rows = untriaged.filter((row) => !isRecommended(row));
  else if (ALL) rows = untriaged;
  else rows = untriaged.filter(isRecommended);

  // A misspelt band selects nothing, and "nothing waiting" is exactly what a finished pile looks
  // like — so say which bands exist rather than let a typo read as good news.
  if (BAND && rows.length === 0 && untriaged.length > 0) {
    const available = [...new Set(untriaged.map((row) => text(row.band) || "(none)"))].sort();
    console.log(`No untriaged CV is in band "${BAND}". Bands present: ${available.join(", ")}`);
  }

  if (EXCLUDE_FROM) {
    const asked = await idsAlreadyAsked(EXCLUDE_FROM);
    const before = rows.length;
    rows = rows.filter((row) => !asked.has(String(row.id)));
    console.log(`Skipped ${before - rows.length} already out for answer in ${path.basename(EXCLUDE_FROM)}.`);
  }
  return rows;
}

function buildWorkbook(rows) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Decide these CVs", { views: [{ state: "frozen", ySplit: HEADER_ROW }] });

  // Every column here is a fact the reader needs to make the call without opening the CV. The order
  // is the order a person reads one: who, what they do now, how long, where, what they asked for.
  const columns = [
    { key: "name", header: "Candidate", width: 30 },
    { key: "role", header: "Doing now", width: 30 },
    { key: "employer", header: "Employer", width: 24 },
    { key: "experience", header: "Experience", width: 16 },
    { key: "location", header: "Where", width: 22 },
    { key: "appliedFor", header: "Applied for", width: 26 },
    { key: "fit", header: "Why recommended", width: 26 },
    { key: "decision", header: "Decision", width: 14 },
    { key: "id", header: "id", width: 10 },
    { key: "note", header: "Note (optional)", width: 44 },
  ];
  sheet.columns = columns.map((column) => ({ key: column.key, width: column.width }));
  sheet.getRow(HEADER_ROW).values = columns.map((column) => column.header);
  sheet.getRow(HEADER_ROW).font = { bold: true };

  for (const row of rows) {
    sheet.addRow({
      appliedFor: text(row.appliedForText) || "—",
      decision: "",
      employer: fact(row.currentEmployer) || "—",
      experience: text(row.experienceLabel) || "—",
      fit: text(row.fitVerdict) || text(row.fitRoleLabel) || text(row.band) || "—",
      id: row.id,
      location: text(row.locationLabel) || "—",
      name: text(row.fullName) || "(no name read)",
      note: "",
      role: fact(row.currentRole) || "—",
    });
  }

  // ONE validation over the whole block, never per cell — see the header note.
  if (rows.length > 0) {
    sheet.dataValidations.add(`${DECISION_COLUMN}${HEADER_ROW + 1}:${DECISION_COLUMN}${HEADER_ROW + rows.length}`, {
      allowBlank: true,
      error: "Choose Shortlist or Reject, or leave it blank to decide later.",
      errorTitle: "Pick a decision",
      formulae: [`"${DECISIONS.join(",")}"`],
      showErrorMessage: true,
      type: "list",
    });
  }

  // The join key for --apply, and nothing a person needs to read.
  sheet.getColumn(ID_COLUMN).hidden = true;
  return workbook;
}

function cellText(cell) {
  const raw = cell.value;
  if (raw === null || raw === undefined) return "";
  if (typeof raw === "object") {
    return String(raw.text ?? raw.result ?? raw.richText?.map((part) => part.text).join("") ?? "");
  }
  return String(raw);
}

/**
 * Read the answered workbook back and decide each candidate.
 *
 * Refuses anything that is not one of the two offered answers rather than guessing at it, and goes
 * through `updateCandidateStatus` so each decision writes its own status event with the owner's own
 * note attached — a decision with no trail is the thing this whole audit kept tripping over.
 */
async function applyWorkbook(file) {
  const { systemAccessContext } = await import("@/lib/auth/permissions");
  const { updateCandidateStatus, getCandidate } = await import("@/lib/recruitment/candidates");

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(file);
  const sheet = workbook.getWorksheet("Decide these CVs") ?? workbook.worksheets[0];
  if (!sheet) throw new Error("That workbook has no sheet to read.");

  const planned = [];
  const refused = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber <= HEADER_ROW) return;
    const id = cellText(row.getCell(ID_COLUMN)).trim();
    const answer = cellText(row.getCell(DECISION_COLUMN)).trim();
    const note = cellText(row.getCell("J")).trim();
    const name = cellText(row.getCell("A")).trim();
    if (!id || !answer) return;
    const status = DECISION_TO_STATUS[answer];
    if (!status) {
      refused.push(`${name || id}: "${answer}" is not Shortlist or Reject`);
      return;
    }
    planned.push({ answer, id, name, note: note || null, status });
  });

  console.log(`${DRY_RUN ? "DRY RUN — " : ""}${planned.length} decision(s) read from the sheet.`);
  for (const bad of refused) console.log(`  SKIPPED  ${bad}`);
  for (const item of planned.slice(0, 8)) console.log(`  ${item.answer.padEnd(10)} ${item.name}`);
  if (planned.length > 8) console.log(`  ... and ${planned.length - 8} more`);
  if (DRY_RUN || planned.length === 0) {
    if (!DRY_RUN) console.log("\nNothing to apply — every Decision cell was blank.");
    return;
  }

  let done = 0;
  let failed = 0;
  for (const item of planned) {
    try {
      // The status may have moved since the sheet was built — somebody else may have decided this
      // person in the meantime. Asking the same rule the screen asks means the sheet cannot walk a
      // sent CV back to shortlisted just because it was built before the send.
      const current = await getCandidate(item.id);
      const refusal = current ? statusChangeRefusal(current.status, item.status) : null;
      if (refusal) {
        failed += 1;
        console.log(`  REFUSED  ${item.name}: ${refusal}`);
        continue;
      }
      await updateCandidateStatus(systemAccessContext, item.id, item.status, item.note);
      done += 1;
    } catch (error) {
      failed += 1;
      console.error(`  FAILED  ${item.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  console.log(`\nDone. decided ${done}, refused/failed ${failed}.`);
}

async function main() {
  if (APPLY_FILE) {
    await applyWorkbook(APPLY_FILE);
    return;
  }

  const rows = await untriagedRows();
  const label = selectionLabel();
  console.log(`${rows.length} CV(s) to decide (${label}).`);
  if (rows.length === 0) {
    console.log("Nothing waiting — no sheet written.");
    return;
  }

  const workbook = buildWorkbook(rows);
  // Cairo, never the server's own clock: these are built after midnight often enough that a UTC
  // stamp names the previous day on the file the owner is looking at.
  const stamp = cairoDayKey(new Date());
  const outDir = path.resolve("xlsx");
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, `cv-triage-${label}-${stamp}.xlsx`);
  await workbook.xlsx.writeFile(out);

  console.log(`\nWrote ${out}`);
  console.log(`Columns: ${DECISION_COLUMN} is the dropdown (${DECISIONS.join(" / ")}), J is a free-text note.`);
  console.log("Leave a row blank to decide it later — blank is never read as 'no'.");
  console.log(`Read the answers back with: --apply "${out}"`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { createClient } from "@supabase/supabase-js";
import ExcelJS from "exceljs";

import type { AccessContext } from "@/lib/auth/permissions";
import { updateCandidate } from "@/lib/recruitment/candidates";
import { extractCandidateFieldsFromCv } from "@/lib/recruitment/cv-extraction";
import {
  type ExtractedCandidateFields,
  normalizeStoredExtractionFields,
} from "@/lib/recruitment/cv-extraction-fields";
import {
  CORRECTABLE_KEYS,
  type FactCorrection,
  selectFactCorrections,
} from "@/lib/recruitment/cv-fact-correction";
import { defaultCvPositionKey } from "@/lib/recruitment/cv-field-schemas";
import {
  EXTRACTOR_FIX_LANDED_AT,
  needsRereadThroughFixedExtractor,
} from "@/lib/recruitment/cv-reread-staleness";
import { cvRereadOpsMarker } from "@/lib/recruitment/ops-marker";
import type { UpdateCandidateInput } from "@/lib/recruitment/types";

import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";

// A flag this script does not know is refused, never ignored (scripts/lib/refuse-arguments.mjs).
refuseUnknownFlags({
  name: "recruitment-cv-fact-corrections",
  entry: import.meta.url,
  known: ["--reread", "--confirm-spend", "--apply", "--allow-clearing-graduation-year", "--only-stale", "--decisions", "--limit", "--out"],
});

// ─────────────────────────────────────────────────────────────────────────────
// Re-extract the four CV facts the extractor used to get wrong, and propose corrections.
//
// THE PROBLEM THIS EXISTS FOR. On 2026-09-11 the owner found four fact classes wrong while
// screening vacant-area CVs: a graduation year taken from the START of an ongoing degree,
// experience inflated for a fresh graduate, the CV headline stored as the current job, and a
// governorate contradicting the address. #3729 fixed the extractor. It could not fix the rows
// already written, because selectAutoApplyFields only ever FILLS a blank column — a populated one
// is never overwritten, by design and correctly. So a wrong stored fact is permanent unless
// something is allowed to overwrite it. This is that something.
//
// WHY IT CANNOT SIMPLY WRITE. A blanket "the new reading wins" was measured against production on
// 2026-09-12 and refused. Re-deriving current_job_title from stored work history alone returned 120
// open candidates, including "Marketing Manager" -> "best", "Chemist" -> "Chemist." and a district
// manager demoted to his own oldest job; and of the 10 governorate disagreements the shipped
// resolver found, at least 3 stored values were RIGHT and the proposal wrong (a street named
// "Assuit Street" that is in Sohag, Obour City which is administratively Qalyubia, and a CV
// carrying three addresses). A job that had applied its own findings would have corrupted records
// that were correct.
//
// So this job PROPOSES and the owner decides:
//
//   1. It builds the diff and writes it to an XLSX with a dropdown per row (§4 — business facts are
//      asked as a sheet, never interrogated in prose). Nothing in the database changes.
//   2. The owner fills the "Your answer" column and sends it back.
//   3. --apply reads that sheet and writes ONLY the rows marked Apply. There is no flag that
//      applies everything; the decisions file is the only input the write path has.
//
// WHAT IT NEVER TOUCHES. selectFactCorrections restricts every proposal to the four correctable
// keys. full_name, email, phone and national_id are excluded permanently — they decide dedupe and
// their _norm indexes are app-maintained (AGENTS.md), so a correction job must not be able to
// repoint one person's record at another. The write goes through updateCandidate, never raw SQL,
// for the same reason.
//
// A DECLARED ANSWER ALWAYS WINS. Where preferences_declared_at is set, the applicant answered on
// WhatsApp and that is the owner's source of truth: governorate and currentJobTitle are not
// proposed for those candidates at all, whatever the CV says.
//
// TARGET IS PRODUCTION. .env.local points at the production Supabase project, which is where the
// candidates and their stored CVs are. Deliberate, as in the sibling re-read script.
//
// Usage (from the worktree root):
//   node --env-file-if-exists=.env.local --experimental-strip-types \
//        --experimental-specifier-resolution=node --experimental-loader ./tests/alias-loader.mjs \
//        scripts/recruitment-cv-fact-corrections.ts [flags]
//
//   The loader is ./tests/alias-loader.mjs, NOT the one beside this script — only that one resolves
//   `next/cache`, which arrives transitively through the extraction import chain.
//
//   (no flags)     STORED mode. Compares the newest extraction row already on file against the
//                  candidate record. Free: no model call, no spend, no write.
//
//                  Read the honest limit before trusting it: a row written BEFORE #3729 carries the
//                  OLD reading, so for those candidates this mode can only find disagreements the
//                  old extractor already saw — it cannot see the fix. It is a shape preview and a
//                  zero-cost way to check the gates, not the repair.
//   --reread       Re-reads each target CV through the FIXED extractor. This is the actual job.
//                  Costs money, so it prints the estimate and refuses without --confirm-spend.
//
//                  Note what the re-read itself does on the way past: extractCandidateFieldsFromCv
//                  INSERTs an extraction row and gap-fills blank columns via selectAutoApplyFields.
//                  That gap-fill is the existing, conservative behaviour and is not this job's
//                  write — but it does mean --reread is not read-only against the database, and
//                  saying otherwise would be the mistake the sibling script's header made for
//                  twelve days.
//   --confirm-spend  required beside --reread. Nothing else in this file turns a free run into a
//                  paid one. The estimate PRINTS before this refuses, so `--reread --only-stale`
//                  with no --confirm-spend is the free way to ask what the job would cost.
//   --only-stale[=<ISO>]
//                  narrows --reread to candidates whose newest reading is at or before the cutoff,
//                  plus every candidate with no reading at all. Defaults to the instant #3729 —
//                  the extractor fix — merged. Exists because a re-read is charged per CV and a
//                  third of the population had already been done: without it, finishing the job
//                  means paying twice for work already paid for. See
//                  src/lib/recruitment/cv-reread-staleness.ts for why the cut is a timestamp and
//                  not the `created_by` marker, and why it leans towards re-reading when unsure.
//                  The override is accepted ONLY as `--only-stale=<ISO>`, never as a separate
//                  argument — a bare flag followed by a value would read the neighbouring flag.
//   --limit N      first N targets only. Prove the path on one before firing all.
//   --allow-clearing-graduation-year
//                  lets a proposal BLANK a populated graduation_year when the CV shows the degree is
//                  still in progress. That is pattern 1 itself, so it is the one clearing this job
//                  can do — off by default, because emptying a populated column is the one
//                  destructive shape here and must never be a side effect.
//   --out PATH     where the decision sheet goes. Default xlsx/cv-fact-corrections-<Cairo day>.xlsx.
//   --apply --decisions PATH
//                  writes the corrections the owner marked Apply in that sheet, and nothing else.
//                  Takes a pre-image FIRST (see below) and refuses to write if it cannot.
//
// THE PRE-IMAGE. Production has NO PITR; the recovery unit is a whole-database daily backup
// (AGENTS.md §2.3). Before the first write, --apply saves every affected candidate's current value
// for all four columns to xlsx/cv-fact-corrections-preimage-<run>.json, re-reads that file, and
// only proceeds once it parses back to the same row count. Four scalar columns reverse from it by
// hand in minutes. If the pre-image cannot be written, nothing is.
// ─────────────────────────────────────────────────────────────────────────────

const OPS_MARKER = cvRereadOpsMarker("fact-corrections");

// Serial, and for the same reason as the sibling: high-reasoning calls against multi-megabyte PDFs
// on a 16 GB laptop running other sessions. Concurrency buys minutes and risks the machine.
const DELAY_BETWEEN_MS = 1_000;

// Measured 2026-08-27 over the universal 38-field schema on the nano tier the text route uses.
// Vision-route CVs cost roughly 12x more.
const NANO_COST_PER_CV = 0.0043;

const PAGE = 1_000;

const APPLY_ANSWER = "Apply the correction";
const KEEP_ANSWER = "Keep what we have";
const NEITHER_ANSWER = "Neither - see my note";

type CandidateRow = {
  id: string;
  full_name: string | null;
  address: string | null;
  governorate: string | null;
  current_job_title: string | null;
  years_experience: number | null;
  graduation_year: number | null;
  degree: string | null;
  status: string | null;
  preferences_declared_at: string | null;
};

const CANDIDATE_COLUMNS =
  "id, full_name, address, governorate, current_job_title, years_experience, graduation_year, degree, status, preferences_declared_at";

/**
 * The position key lives on the EXTRACTION row, not on the candidate.
 *
 * `ats_candidates` has no such column — an earlier draft of this file selected `cv_position_key`
 * and PostgREST answered 42703. `ats_candidate_cv_extractions.position_key` is the one place it is
 * recorded, which is also where `cv-extraction.ts` reads it from, so a candidate with no extraction
 * on file has no key at all and falls back to the universal schema.
 */
type NewestExtraction = {
  fields: ExtractedCandidateFields;
  positionKey: string;
  /** When this reading was produced — the one thing that says whether the extractor had the fix. */
  createdAt: string;
};

type Proposal = {
  candidateId: string;
  candidateName: string | null;
  address: string | null;
  correction: FactCorrection;
};

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}. Run with --env-file-if-exists=.env.local from the worktree root.`);
  return value;
}

/**
 * One factory, so the helpers below can be typed from the REAL call site.
 *
 * `ReturnType<typeof createClient>` is not that type — the bare generic defaults differ from what
 * the three-argument call infers, and a helper annotated with it rejects the very client this file
 * creates. Taking the type off this function keeps the two in step by construction.
 */
function opsClient() {
  return createClient(requireEnv("NEXT_PUBLIC_SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

type OpsClient = ReturnType<typeof opsClient>;

function flagValue(args: string[], flag: string): string | null {
  const found = args.find((arg) => arg === flag || arg.startsWith(`${flag}=`));
  if (!found) return null;
  if (found.includes("=")) return found.slice(found.indexOf("=") + 1);
  return args[args.indexOf(found) + 1] ?? null;
}

/** The camelCase view of a candidate row, which is what selectFactCorrections reads. */
function asCamelCase(row: CandidateRow): Record<string, unknown> {
  return {
    address: row.address,
    currentJobTitle: row.current_job_title,
    degree: row.degree,
    fullName: row.full_name,
    governorate: row.governorate,
    graduationYear: row.graduation_year,
    yearsExperience: row.years_experience,
  };
}

function show(value: unknown): string {
  if (value === null || value === undefined) return "(blank)";
  return String(value);
}

// ─────────────────────────────────────────────────────────────────────────────
// The decision sheet.
//
// One row per proposal, a locked dropdown in the answer column, and the CV address beside the two
// values so the call can be made without opening anything. Deliberately plain: no images, no
// outline groups. ExcelJS emits two schema-invalid OOXML fragments for those and Excel then
// silently "repairs" the workbook (AGENTS.md §2.1); the precedent in this repo is avoidance.
// ─────────────────────────────────────────────────────────────────────────────
async function writeDecisionSheet(proposals: Proposal[], outPath: string): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Fact corrections");

  sheet.columns = [
    { header: "Candidate", key: "name", width: 30 },
    { header: "Fact", key: "fact", width: 18 },
    { header: "Address on the CV", key: "address", width: 42 },
    { header: "We stored", key: "from", width: 24 },
    { header: "The CV reads", key: "to", width: 24 },
    { header: "Your answer", key: "answer", width: 26 },
    { header: "Note", key: "note", width: 40 },
  ];
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: "frozen", ySplit: 1 }];

  for (const proposal of proposals) {
    sheet.addRow({
      address: proposal.address ?? "",
      answer: "",
      fact: proposal.correction.key,
      from: show(proposal.correction.from),
      name: proposal.candidateName ?? "(no name)",
      note: "",
      to: show(proposal.correction.to),
    });
  }

  // The id column the apply path keys on. Last, and narrow, so it stays out of the way while
  // remaining the thing that makes a returned sheet machine-readable — matching by NAME would
  // re-introduce the name-matching trap this repo has paid for elsewhere.
  const idColumn = sheet.getColumn(8);
  idColumn.width = 38;
  idColumn.header = "Candidate id (do not edit)";
  sheet.getRow(1).getCell(8).font = { bold: true };
  for (const [index, proposal] of proposals.entries()) {
    sheet.getRow(index + 2).getCell(8).value = proposal.candidateId;
  }

  const options = [APPLY_ANSWER, KEEP_ANSWER, NEITHER_ANSWER];
  for (let row = 2; row <= proposals.length + 1; row += 1) {
    sheet.getCell(`F${row}`).dataValidation = {
      allowBlank: true,
      formulae: [`"${options.join(",")}"`],
      showErrorMessage: true,
      type: "list",
    };
  }

  mkdirSync(path.dirname(outPath), { recursive: true });
  await workbook.xlsx.writeFile(outPath);
}

type Decision = {
  candidateId: string;
  key: string;
  /** What the sheet said we stored, so a record changed since can be detected. */
  storedWhenAsked: string;
  /** What the sheet showed as the CV's reading — the value the owner approved, verbatim. */
  proposed: string;
  answer: string;
  note: string;
};

async function readDecisionSheet(filePath: string): Promise<Decision[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const sheet = workbook.getWorksheet("Fact corrections") ?? workbook.worksheets[0];
  if (!sheet) throw new Error(`No worksheet found in ${filePath}.`);

  const decisions: Decision[] = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const cell = (column: number) => String(row.getCell(column).value ?? "").trim();
    const candidateId = cell(8);
    const key = cell(2);
    if (!candidateId || !key) return;
    decisions.push({
      answer: cell(6),
      candidateId,
      key,
      note: cell(7),
      proposed: cell(5),
      storedWhenAsked: cell(4),
    });
  });
  return decisions;
}

/**
 * The update payload one approved sheet row means — or a refusal, with the reason to print.
 *
 * Every column this job can write is named literally here, and there is no computed-property path
 * out of this function. That is the point: the set of writable columns is readable in one screen
 * and cannot widen because a string reached the wrong place. A key that is not one of the four
 * falls through to a refusal.
 *
 * `(blank)` is how writeDecisionSheet renders null, and for graduationYear that is a real answer —
 * "this degree is still in progress, so it has produced no graduation year" is pattern 1 itself.
 * For every other key a blank is refused rather than written, because emptying a populated column
 * must never happen by accident.
 */
function decisionPayload(
  key: string,
  proposed: string,
): { ok: true; payload: UpdateCandidateInput } | { ok: false; why: string } {
  const blank = proposed === "" || proposed === "(blank)";

  if (key === "graduationYear") {
    if (blank) return { ok: true, payload: { graduationYear: null } };
    const year = Number(proposed);
    if (!Number.isFinite(year)) return { ok: false, why: `"${proposed}" is not a year` };
    return { ok: true, payload: { graduationYear: year } };
  }
  if (blank) return { ok: false, why: `a blank "${key}" would empty a populated column` };

  if (key === "yearsExperience") {
    const years = Number(proposed);
    if (!Number.isFinite(years)) return { ok: false, why: `"${proposed}" is not a number` };
    return { ok: true, payload: { yearsExperience: years } };
  }
  if (key === "governorate") return { ok: true, payload: { governorate: proposed } };
  if (key === "currentJobTitle") return { ok: true, payload: { currentJobTitle: proposed } };

  return { ok: false, why: `"${key}" has no write path here` };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const reread = args.includes("--reread");
  const confirmSpend = args.includes("--confirm-spend");
  const apply = args.includes("--apply");
  const allowClearingGraduationYear = args.includes("--allow-clearing-graduation-year");
  // `--only-stale` takes its override ONLY as `--only-stale=<ISO>`. The shared flagValue() helper
  // reads a bare flag's value from the NEXT argv entry, which would quietly turn
  // `--only-stale --confirm-spend` into a cutoff of "--confirm-spend" — an unparseable date, which
  // the predicate then treats as "re-read everything". That is a silent quadrupling of the bill, so
  // the bare form is matched exactly and never looks at its neighbour.
  const onlyStaleArg = args.find((arg) => arg === "--only-stale" || arg.startsWith("--only-stale="));
  const onlyStale = onlyStaleArg !== undefined;
  const staleCutoff = onlyStaleArg?.includes("=")
    ? onlyStaleArg.slice(onlyStaleArg.indexOf("=") + 1).trim()
    : EXTRACTOR_FIX_LANDED_AT;
  const decisionsPath = flagValue(args, "--decisions");
  const limitRaw = flagValue(args, "--limit");
  const limit = limitRaw === null ? Number.NaN : Number(limitRaw);
  const day = OPS_MARKER.slice(OPS_MARKER.lastIndexOf("-") + 1);
  const outPath = flagValue(args, "--out") ?? path.join("xlsx", `cv-fact-corrections-${day}.xlsx`);

  if (apply && !decisionsPath) {
    throw new Error("--apply needs --decisions <path to the sheet you filled in>. It has no other input.");
  }
  if (onlyStale && !reread) {
    throw new Error("--only-stale narrows what --reread pays for. On its own it changes nothing — add --reread.");
  }
  if (onlyStale && Number.isNaN(Date.parse(staleCutoff))) {
    throw new Error(
      `--only-stale=${staleCutoff} is not a date this can read. Use an ISO instant, e.g. --only-stale=2026-09-12T00:09:24Z.`,
    );
  }

  const supabase = opsClient();

  console.log(`Supabase project : ${requireEnv("NEXT_PUBLIC_SUPABASE_URL")}`);
  console.log(`Run marker       : ${OPS_MARKER}`);
  console.log(`Correctable keys : ${CORRECTABLE_KEYS.join(", ")}`);

  if (apply) {
    await runApply(supabase, decisionsPath!, day);
    return;
  }

  // PAGINATED. PostgREST caps an unbounded select at 1000 rows and says nothing when it does — the
  // array simply stops, and the candidates that fall off are the NEWEST, which reads as "nobody
  // needs correcting" (AGENTS.md §2.1).
  const candidates: CandidateRow[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data: page, error } = await supabase
      .from("ats_candidates")
      .select(CANDIDATE_COLUMNS)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    const rows = (page ?? []) as unknown as CandidateRow[];
    candidates.push(...rows);
    if (rows.length < PAGE) break;
  }
  console.log(`\nCandidates total : ${candidates.length}`);

  // Only a candidate with at least one of the four columns POPULATED can be corrected — a blank
  // column is a gap, and cv-auto-apply.ts already owns that case on every inbound CV.
  let targets = candidates.filter(
    (row) =>
      (row.governorate ?? "").trim() !== "" ||
      (row.current_job_title ?? "").trim() !== "" ||
      row.years_experience !== null ||
      row.graduation_year !== null,
  );
  console.log(`Has a stored fact: ${targets.length}`);

  const declared = targets.filter((row) => row.preferences_declared_at !== null).length;
  console.log(`Declared answers : ${declared}  (their governorate and job title are never proposed against)`);

  if (Number.isFinite(limit) && limit > 0) {
    targets = targets.slice(0, limit);
    console.log(`Limited to       : ${targets.length}`);
  }

  const proposals: Proposal[] = [];

  // Loaded for BOTH paths: in STORED mode it is the reading being compared, and in --reread mode it
  // is still the only record of which schema this candidate's CV was read under.
  const newest = await loadNewestExtractions(supabase);

  if (reread) {
    if (onlyStale) {
      const before = targets.length;
      targets = targets.filter((row) => needsRereadThroughFixedExtractor(newest.get(row.id)?.createdAt, staleCutoff));
      console.log(
        `\n--only-stale     : ON, cutoff ${staleCutoff}.` +
          ` ${before - targets.length} of ${before} already read after it — skipped, not re-paid for.`,
      );
      console.log(
        "                   A candidate with NO reading on file counts as stale and IS re-read.",
      );
    }

    console.log(
      `\n--reread         : ON. ${targets.length} target(s) reach the model through the FIXED extractor.`,
    );
    console.log(
      `Estimated spend  : ~$${(targets.length * NANO_COST_PER_CV).toFixed(2)} (${targets.length} x ~$${NANO_COST_PER_CV.toFixed(4)}); vision-route CVs cost ~12x more.`,
    );

    // The refusal sits BELOW the estimate on purpose: the number above is the whole reason to run
    // this without committing, so `--reread --only-stale` with no --confirm-spend is the free way to
    // ask "what would this cost me?". Nothing has called the model at this point.
    if (!confirmSpend) {
      throw new Error("--reread calls the model and costs money. Add --confirm-spend once you mean it.");
    }

    const access: AccessContext = {
      hrId: null,
      loginId: OPS_MARKER,
      role: "Super Admin",
      scope: "system",
      source: "system",
    };

    for (const [index, row] of targets.entries()) {
      const label = `${String(index + 1).padStart(4)}/${targets.length}  ${row.full_name ?? "(no name)"}`;
      const positionKey = newest.get(row.id)?.positionKey ?? defaultCvPositionKey;
      try {
        const result = await extractCandidateFieldsFromCv(row.id, access, positionKey);
        const found = collect(row, result.fields, positionKey, allowClearingGraduationYear);
        proposals.push(...found);
        console.log(`${label} — ${found.length} correction(s)`);
      } catch (error) {
        console.log(`${label} — FAILED: ${error instanceof Error ? error.message : String(error)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, DELAY_BETWEEN_MS));
    }
  } else {
    console.log(
      "\nSTORED mode      : comparing the NEWEST extraction row already on file. No model call, no spend.",
    );
    console.log(
      "                   A row written before #3729 carries the OLD reading, so this cannot see the\n" +
        "                   fix for those candidates. Pass --reread --confirm-spend for the repair.",
    );

    for (const row of targets) {
      const extraction = newest.get(row.id);
      if (!extraction) continue;
      proposals.push(...collect(row, extraction.fields, extraction.positionKey, allowClearingGraduationYear));
    }
  }

  console.log(`\nProposals        : ${proposals.length} across ${new Set(proposals.map((p) => p.candidateId)).size} candidates`);
  for (const key of CORRECTABLE_KEYS) {
    const count = proposals.filter((proposal) => proposal.correction.key === key).length;
    console.log(`  ${key.padEnd(18)} ${count}`);
  }

  if (proposals.length === 0) {
    console.log("\nNothing to propose. No sheet written.");
    return;
  }

  await writeDecisionSheet(proposals, outPath);
  console.log(`\nDecision sheet   : ${outPath}`);
  console.log("Nothing was written to the database. Fill in the answer column and re-run with");
  console.log(`  --apply --decisions ${outPath}`);
}

function collect(
  row: CandidateRow,
  fields: ExtractedCandidateFields,
  positionKey: string,
  allowClearingGraduationYear: boolean,
): Proposal[] {
  return selectFactCorrections({
    allowClearingGraduationYear,
    candidate: asCamelCase(row),
    extractedFields: fields,
    hasDeclaredPreferences: row.preferences_declared_at !== null,
    positionKey,
  }).map((correction) => ({
    address: row.address,
    candidateId: row.id,
    candidateName: row.full_name,
    correction,
  }));
}

/** The newest extraction row per candidate, normalized to { value, confidence }. */
async function loadNewestExtractions(supabase: OpsClient): Promise<Map<string, NewestExtraction>> {
  type Row = {
    candidate_id: string;
    created_at: string;
    extracted_fields: unknown;
    position_key: string | null;
  };
  const rows: Row[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data: page, error } = await supabase
      .from("ats_candidate_cv_extractions")
      .select("candidate_id, created_at, extracted_fields, position_key")
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    const batch = (page ?? []) as unknown as Row[];
    rows.push(...batch);
    if (batch.length < PAGE) break;
  }

  // Ordered oldest-first, so a plain overwrite leaves the newest standing.
  const newest = new Map<string, NewestExtraction>();
  for (const row of rows) {
    newest.set(String(row.candidate_id), {
      fields: normalizeStoredExtractionFields(row.extracted_fields),
      positionKey: row.position_key ?? defaultCvPositionKey,
      createdAt: row.created_at,
    });
  }
  return newest;
}

async function runApply(supabase: OpsClient, decisionsPath: string, day: string): Promise<void> {
  const decisions = await readDecisionSheet(decisionsPath);
  const chosen = decisions.filter((decision) => decision.answer === APPLY_ANSWER);
  console.log(`\nDecisions sheet  : ${decisionsPath}`);
  console.log(`Rows             : ${decisions.length}`);
  console.log(`Marked "${APPLY_ANSWER}" : ${chosen.length}`);
  console.log(`Marked "${KEEP_ANSWER}"  : ${decisions.filter((d) => d.answer === KEEP_ANSWER).length}`);
  console.log(`Left blank or "${NEITHER_ANSWER}" : ${decisions.filter((d) => d.answer !== APPLY_ANSWER && d.answer !== KEEP_ANSWER).length}`);

  if (chosen.length === 0) {
    console.log("\nNothing marked for applying. No write.");
    return;
  }

  // The proposals are re-derived rather than read from the sheet: the sheet says WHICH corrections
  // the owner approved, never what to write. Re-reading the record also catches a candidate edited
  // by a person between the sheet going out and coming back — their edit wins, and the row is
  // skipped rather than silently overwritten.
  const ids = [...new Set(chosen.map((decision) => decision.candidateId))];
  const rows: CandidateRow[] = [];
  for (let index = 0; index < ids.length; index += 50) {
    // Chunked at 50: a PostgREST .in() fails three ways past that, and one of them is zero rows
    // with no error (AGENTS.md §2.1).
    const { data, error } = await supabase
      .from("ats_candidates")
      .select(CANDIDATE_COLUMNS)
      .in("id", ids.slice(index, index + 50));
    if (error) throw error;
    rows.push(...((data ?? []) as unknown as CandidateRow[]));
  }
  const byId = new Map(rows.map((row) => [String(row.id), row]));

  // THE PRE-IMAGE, BEFORE ANY WRITE. Production has no PITR; the recovery unit is a whole-database
  // daily backup. Four scalar columns per candidate reverse from this file by hand.
  const preimagePath = path.join("xlsx", `cv-fact-corrections-preimage-${day}.json`);
  const preimage = rows.map((row) => ({
    candidateId: row.id,
    currentJobTitle: row.current_job_title,
    fullName: row.full_name,
    governorate: row.governorate,
    graduationYear: row.graduation_year,
    yearsExperience: row.years_experience,
  }));
  mkdirSync(path.dirname(preimagePath), { recursive: true });
  writeFileSync(preimagePath, JSON.stringify({ marker: OPS_MARKER, rows: preimage }, null, 2), "utf8");
  const readBack = JSON.parse(readFileSync(preimagePath, "utf8")) as { rows: unknown[] };
  if (!Array.isArray(readBack.rows) || readBack.rows.length !== preimage.length) {
    throw new Error(`Pre-image at ${preimagePath} did not read back with ${preimage.length} rows. Nothing was written.`);
  }
  console.log(`\nPre-image        : ${preimagePath} (${preimage.length} candidates, verified readable)`);

  let applied = 0;
  let skipped = 0;
  for (const decision of chosen) {
    const row = byId.get(decision.candidateId);
    if (!row) {
      console.log(`  SKIP ${decision.candidateId} — candidate not found.`);
      skipped += 1;
      continue;
    }
    if (!CORRECTABLE_KEYS.includes(decision.key)) {
      // Cannot happen from a sheet this script wrote. It can happen from a sheet somebody edited,
      // and "someone typed a column name into the Fact cell" must never become a write.
      console.log(`  SKIP ${row.full_name ?? decision.candidateId} — "${decision.key}" is not a correctable fact.`);
      skipped += 1;
      continue;
    }

    // The record must still hold what the sheet said it held. If a person edited the candidate
    // while the sheet was out, THEIR edit wins — an approval given against an older value is not
    // an approval to overwrite a newer one, and overwriting it silently is the whole failure this
    // job exists to avoid.
    const storedNow = show(asCamelCase(row)[decision.key]);
    if (storedNow !== decision.storedWhenAsked) {
      console.log(
        `  SKIP ${row.full_name ?? decision.candidateId} — ${decision.key} now reads "${storedNow}", not the "${decision.storedWhenAsked}" you were shown.`,
      );
      skipped += 1;
      continue;
    }

    const resolved = decisionPayload(decision.key, decision.proposed);
    if (!resolved.ok) {
      console.log(`  SKIP ${row.full_name ?? decision.candidateId} — ${decision.key}: ${resolved.why}.`);
      skipped += 1;
      continue;
    }

    // updateCandidate, never raw SQL: the identity columns carry app-maintained _norm indexes, and
    // a partial payload leaves every column it does not name alone.
    await updateCandidate(row.id, resolved.payload);
    applied += 1;
    console.log(
      `  APPLIED ${row.full_name ?? decision.candidateId} — ${decision.key}: "${decision.storedWhenAsked}" -> "${decision.proposed}"`,
    );
  }

  console.log(`\nApplied          : ${applied}`);
  console.log(`Skipped          : ${skipped}`);
  console.log(`Reverse from     : ${preimagePath}`);
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

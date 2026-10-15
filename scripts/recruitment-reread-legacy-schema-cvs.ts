import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { createClient } from "@supabase/supabase-js";

import type { AccessContext } from "@/lib/auth/permissions";
import { defaultCvPositionKey, LEGACY_CV_POSITION_KEYS } from "@/lib/recruitment/cv-field-schemas";
import { CvExtractionError, extractCandidateFieldsFromCv } from "@/lib/recruitment/cv-extraction";
import { type ExtractedCandidateFields, isEmptyExtractedField } from "@/lib/recruitment/cv-extraction-fields";
import { cvRereadOpsMarker } from "@/lib/recruitment/ops-marker";

import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";

// A flag this script does not know is refused, never ignored (scripts/lib/refuse-arguments.mjs).
refuseUnknownFlags({
  name: "recruitment-reread-legacy-schema-cvs",
  entry: import.meta.url,
  known: ["--dry-run", "--include-titled", "--never-read", "--limit"],
});

// ─────────────────────────────────────────────────────────────────────────────
// Re-read the CVs that were read with the OLD, NARROW schema.
//
// Owner instruction: 2026-08-24, after being shown the table below. One-off, hand-run, not wired
// to a route, a cron, or package.json — the same shape as the 2026-08-16 batch beside it.
//
// WHY THIS EXISTS
//
//   Until the schemas were collapsed, a CV could be read with `medical_rep`, which asked the model
//   for TWELVE fields. currentJobTitle was not one of them. The universal schema asks for 25+ and
//   does include it. Measured on production 2026-08-24, over the 382 undecided real CVs:
//
//     read with        candidates   have a job title   avg fields returned
//     universal              250          208 (83%)                    25
//     medical_rep            122            0 (0%)                     12
//     (never read)            10            0 (0%)                      -
//
//   Not "few". Zero. Every candidate whose newest read was `medical_rep` is blank on the one fact
//   that decides who a CV goes to, and no amount of table design can show a fact that was never
//   asked for. That is the measured reason the pool still reads as useless after the row rebuild.
//
//   The extractor itself is ALREADY FIXED: `medical_rep` and `district_manager` are now aliases
//   onto the universal schema (cv-field-schemas.ts) and inbound intake passes no positionKey at
//   all. Nothing new arrives narrow. This is a historical backlog and nothing else, which is why
//   it is a one-off script and not a change to any live path.
//
// WHAT THIS WRITES
//
//   extractCandidateFieldsFromCv downloads the stored CV, reads it, INSERTs one row into
//   ats_candidate_cv_extractions, and — since #2359 — fills the candidate's STILL-EMPTY columns
//   from the high-confidence values by the same conservative rule inbound intake uses
//   (selectAutoApplyFields: high confidence, column storage, blank column only, gap-fill only).
//   A human edit always wins; nothing already filled is touched.
//
//   It does NOT create a candidate, an application or a requisition, and it sends NO notification
//   of any kind — no in-app row, no Telegram, and per the standing rule certainly no email. The
//   "new CV received" path lives in the inbound intake service, which this script never enters.
//
// TARGET IS PRODUCTION, deliberately: .env.local points at the production Supabase project, which
// is where the candidates and their stored CVs are.
//
// SAFE TO RE-RUN: the truth set is "the candidate's NEWEST extraction was stamped with a legacy
// position_key". A successful re-read writes a newer row stamped `universal`, so that candidate
// drops out of the set. A failure leaves the legacy row newest and will be retried.
//
//   The caveat that applies to every re-read here: an EMPTY read still writes a row, so a file the
//   model looked at and got nothing from also drops out of the set. That is the CORRECT answer for
//   a photographed certificate — see the 2026-08-16 README beside this file — but it means the
//   Empty count in the summary is the number to look at, not the failure count.
//
// Usage (from the worktree root):
//   node --env-file-if-exists=.env.local --experimental-strip-types \
//        --experimental-specifier-resolution=node --experimental-loader ./scripts/alias-loader.mjs \
//        scripts/recruitment-reread-legacy-schema-cvs.ts [--limit N] [--dry-run] [--include-titled]
//
//   --dry-run         lists the target set and exits. No AI call, no write, no spend.
//   --limit N         reads only the first N. Prove the path on one before firing all of them.
//   --include-titled  widens the set to legacy-read candidates who DO already have a job title.
//                     Off by default: their row already answers the question the re-read is for,
//                     so reading them is spend that changes nothing on screen.
// ─────────────────────────────────────────────────────────────────────────────

// Same rule as the batch beside it: the run's own Cairo day, resolved once. This one happened to
// still be honest — it has only ever been run on 2026-08-24 — which is exactly why it was worth
// fixing before a second run made it a lie too.
const OPS_MARKER = cvRereadOpsMarker("legacy-schema");

// Serial on purpose, same reasoning as the 2026-08-16 batch: these are model calls against
// multi-megabyte PDFs on a 16 GB laptop already running other sessions. Concurrency buys minutes
// and risks both an OpenAI rate limit and the machine.
const PAUSE_MS = 400;

type TargetRow = {
  current_job_title: string | null;
  full_name: string | null;
  id: string;
  legacy_key: string;
  read_at: string;
};

type Outcome = {
  candidateId: string;
  detail: string;
  fieldsReturned: number;
  gainedTitle: boolean;
  name: string;
  status: "read" | "empty" | "failed";
};

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}. Run with --env-file-if-exists=.env.local from the worktree root.`);
  return value;
}

// The payload is { field: { value, confidence } }; reading it with ->>'field' yields the
// stringified object, which is the trap that nearly wrote JSON blobs into 145 phone columns.
// Emptiness is decided by the one shared rule, never by a hand-rolled `value === ""`.
function readValue(fields: ExtractedCandidateFields, key: string): string | null {
  const field = fields[key];
  if (isEmptyExtractedField(field)) return null;
  return String(field!.value);
}

function countFilled(fields: ExtractedCandidateFields): number {
  return Object.keys(fields).filter((key) => !isEmptyExtractedField(fields[key])).length;
}

function cairo(iso: string): string {
  // A never-read candidate has no read timestamp; formatting "" prints "Invalid Date", which reads
  // as a fault in the report rather than as the plain fact that there was never a read.
  if (!iso) return "never";
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Africa/Cairo",
  }).format(new Date(iso));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const includeTitled = args.includes("--include-titled");
  // A candidate with a stored file and NO extraction row at all was never read once. They are
  // not "legacy schema", so the main filter skips them forever — and they are the worst case in
  // the pool, since nothing whatsoever is known about them. 10 in production on 2026-08-25.
  const includeNeverRead = args.includes("--never-read");
  const limitArg = args.find((a) => a.startsWith("--limit"));
  const limit = limitArg ? Number(limitArg.split("=")[1] ?? args[args.indexOf(limitArg) + 1]) : Number.NaN;

  const supabase = createClient(requireEnv("NEXT_PUBLIC_SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  console.log(`Supabase project : ${requireEnv("NEXT_PUBLIC_SUPABASE_URL")}`);
  console.log(`OpenAI key       : ${process.env.OPENAI_API_KEY ? "present" : "MISSING"}`);
  console.log(`Re-reading with  : ${defaultCvPositionKey}`);

  // Newest extraction per candidate. Ordered newest-first and taken once per candidate, so a
  // candidate re-read since the legacy batch is judged on the read that actually counts — the
  // same "first row seen wins" rule the pool loaders use.
  const { data: extractionRows, error: extractionError } = await supabase
    .from("ats_candidate_cv_extractions")
    .select("candidate_id, position_key, created_at, is_cv")
    .order("created_at", { ascending: false });
  if (extractionError) throw extractionError;

  const newest = new Map<string, { createdAt: string; isCv: unknown; positionKey: string }>();
  for (const row of extractionRows ?? []) {
    const candidateId = String((row as { candidate_id: unknown }).candidate_id ?? "");
    if (!candidateId || newest.has(candidateId)) continue;
    newest.set(candidateId, {
      createdAt: String((row as { created_at: unknown }).created_at ?? ""),
      isCv: (row as { is_cv: unknown }).is_cv,
      positionKey: String((row as { position_key: unknown }).position_key ?? ""),
    });
  }

  const { data: allCandidates, error: candidateError } = await supabase
    .from("ats_candidates")
    .select("id, full_name, current_job_title, created_at")
    .order("created_at", { ascending: true });
  if (candidateError) throw candidateError;

  // A candidate with no stored file cannot be read at all — including one buys a guaranteed
  // failure and a line in the report that looks like a problem to fix.
  const { data: fileRows, error: fileError } = await supabase.from("ats_files").select("candidate_id");
  if (fileError) throw fileError;
  const withAFile = new Set((fileRows ?? []).map((row) => String((row as { candidate_id: unknown }).candidate_id)));

  let legacyCount = 0;
  let neverReadCount = 0;
  let notACvCount = 0;
  let noFileCount = 0;
  let alreadyTitledCount = 0;
  let targets: TargetRow[] = [];

  for (const row of (allCandidates ?? []) as Array<{ current_job_title: unknown; full_name: unknown; id: unknown }>) {
    const id = String(row.id);
    const read = newest.get(id);
    const neverRead = !read;
    if (neverRead) {
      if (!includeNeverRead) continue;
      neverReadCount += 1;
    } else {
      if (!LEGACY_CV_POSITION_KEYS.has(read.positionKey)) continue;
      legacyCount += 1;
    }
    // An explicit false is a verdict the model already gave: this file is not a CV. Reading it
    // again buys the same nothing at full price — 23 of these in production are photographed
    // certificates. NULL is not a verdict and stays in the set.
    if (read?.isCv === false) {
      notACvCount += 1;
      continue;
    }
    if (!withAFile.has(id)) {
      noFileCount += 1;
      continue;
    }
    const title = typeof row.current_job_title === "string" ? row.current_job_title.trim() : "";
    if (title && !includeTitled) {
      alreadyTitledCount += 1;
      continue;
    }
    targets.push({
      current_job_title: title || null,
      full_name: typeof row.full_name === "string" ? row.full_name : null,
      id,
      legacy_key: read?.positionKey ?? "(never read)",
      read_at: read?.createdAt ?? "",
    });
  }

  console.log(`\nCandidates total : ${(allCandidates ?? []).length}`);
  console.log(`Newest read legacy: ${legacyCount}   (position_key in ${[...LEGACY_CV_POSITION_KEYS].join(", ")})`);
  console.log(`Never read at all : ${neverReadCount}${includeNeverRead ? "" : "   (not included — pass --never-read)"}`);
  console.log(`  confirmed not a CV : skipped ${notACvCount}`);
  console.log(`  no stored file     : skipped ${noFileCount}`);
  console.log(
    `  already has a title: skipped ${alreadyTitledCount}${includeTitled ? " (--include-titled: none skipped)" : " (use --include-titled to widen)"}`,
  );
  console.log(`TO RE-READ       : ${targets.length}`);

  if (Number.isFinite(limit) && limit > 0 && targets.length > limit) {
    targets = targets.slice(0, limit);
    console.log(`--limit          : ${targets.length}`);
  }

  if (dryRun) {
    console.log("\n--dry-run: nothing was read, nothing was written, nothing was spent.\n");
    for (const row of targets.slice(0, 25)) {
      console.log(`  ${row.full_name ?? "(no name)"}  ·  ${row.legacy_key}  ·  read ${cairo(row.read_at)}`);
    }
    if (targets.length > 25) console.log(`  … and ${targets.length - 25} more`);
    return;
  }

  // loginId carries the ops marker so every row this writes is distinguishable from a Talent
  // Acquisition review forever after. Do not "clean up" that marker.
  const access: AccessContext = {
    hrId: null,
    loginId: OPS_MARKER,
    role: "Super Admin",
    scope: "system",
    source: "system",
  };

  const outcomes: Outcome[] = [];
  const startedAt = Date.now();

  for (const [index, row] of targets.entries()) {
    const label = `${String(index + 1).padStart(3)}/${targets.length}  ${row.full_name ?? "(no name)"}`;
    try {
      const result = await extractCandidateFieldsFromCv(row.id, access, defaultCvPositionKey);
      const title = readValue(result.fields, "currentJobTitle");
      const filled = countFilled(result.fields);
      if (filled === 0) {
        outcomes.push({
          candidateId: row.id,
          detail: "the model read the file and returned nothing — check whether it is a CV at all",
          fieldsReturned: 0,
          gainedTitle: false,
          name: row.full_name ?? "",
          status: "empty",
        });
        console.log(`${label}  ·  EMPTY`);
      } else {
        outcomes.push({
          candidateId: row.id,
          detail: title ? `title: ${title}` : "read, but still no job title",
          fieldsReturned: filled,
          gainedTitle: Boolean(title),
          name: row.full_name ?? "",
          status: "read",
        });
        console.log(`${label}  ·  ${filled} fields${title ? `  ·  ${title}` : "  ·  (no title)"}`);
      }
    } catch (error) {
      const detail =
        error instanceof CvExtractionError ? `${error.code}: ${error.message}` : String((error as Error)?.message ?? error);
      outcomes.push({
        candidateId: row.id,
        detail,
        fieldsReturned: 0,
        gainedTitle: false,
        name: row.full_name ?? "",
        status: "failed",
      });
      console.log(`${label}  ·  FAILED  ·  ${detail}`);
    }
    if (index < targets.length - 1) await new Promise((resolve) => setTimeout(resolve, PAUSE_MS));
  }

  const read = outcomes.filter((o) => o.status === "read").length;
  const empty = outcomes.filter((o) => o.status === "empty").length;
  const failed = outcomes.filter((o) => o.status === "failed").length;
  const gained = outcomes.filter((o) => o.gainedTitle).length;
  const minutes = Math.round((Date.now() - startedAt) / 60_000);

  console.log(`\n─────────────────────────────────────────────`);
  console.log(`Attempted        : ${outcomes.length} in ~${minutes} min`);
  console.log(`Read             : ${read}`);
  console.log(`GAINED A TITLE   : ${gained}`);
  console.log(`Empty            : ${empty}   (look at these — an empty read still writes a row)`);
  console.log(`Failed           : ${failed}`);

  // The report carries real names and job titles, so it is written OUTSIDE the repository — the
  // same rule the 2026-08-16 batch documented. Committing it would put personal data in git
  // history permanently.
  const outDir = process.env.CV_REREAD_OUT_DIR;
  if (!outDir) {
    console.log(`\nNo CV_REREAD_OUT_DIR set — the per-candidate report was NOT written.`);
    return;
  }
  mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "cv-reread-legacy-schema-report.json");
  writeFileSync(outPath, JSON.stringify({ finishedAt: new Date().toISOString(), outcomes }, null, 2), "utf8");
  console.log(`\nReport           : ${outPath}`);
}

await main();

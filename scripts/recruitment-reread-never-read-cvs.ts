import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { createClient } from "@supabase/supabase-js";

import type { AccessContext } from "@/lib/auth/permissions";
import { candidateAppliedFor } from "@/lib/recruitment/applied-for";
import { describeCandidateSource, type SourceContextRow } from "@/lib/recruitment/candidate-source-context";
import { defaultCvPositionKey } from "@/lib/recruitment/cv-field-schemas";
import {
  CvExtractionError,
  extractCandidateFieldsFromCv,
  OCR_EXTRACTION_MODEL,
  RULE_ONLY_EXTRACTION_MODEL,
} from "@/lib/recruitment/cv-extraction";
import { type ExtractedCandidateFields, isEmptyExtractedField } from "@/lib/recruitment/cv-extraction-fields";
import { describeCvRead } from "@/lib/recruitment/cv-extraction-quality";

// ─────────────────────────────────────────────────────────────────────────────
// Re-read the CVs the AI never read.
//
// Owner approval: 2026-08-16 ("re-read the CVs"). One-off, hand-run, not wired to anything.
//
// WHAT THIS TOUCHES, AND — more importantly — WHAT IT DOES NOT
//
//   It calls extractCandidateFieldsFromCv, which downloads the stored CV, sends it to the
//   model, and INSERTs one row into ats_candidate_cv_extractions. That is the whole write.
//
//   It does NOT update ats_candidates. It does NOT create a candidate, an application or a
//   requisition. It does NOT send a notification of any kind — no in-app row, no Telegram,
//   and (per the standing rule) certainly no email. The "new CV received" path lives in the
//   inbound intake service, which this script never enters. Applying the extracted values
//   onto a candidate is a SEPARATE, later decision; recordAppliedExtractionFields is never
//   called here, so applied_fields stays null and the review queue still shows these as
//   awaiting a human.
//
//   Every row it writes is stamped created_by = OPS_MARKER, so a re-read is distinguishable
//   from a Talent Acquisition review forever after. Do not "clean up" that marker.
//
// TARGET IS PRODUCTION. .env.local points at the production Supabase project, which is where
// the candidates and their stored CVs actually are. That is deliberate, not an accident.
//
// SAFE TO RE-RUN: the truth set is "candidates with no extraction row at all", so anything
// this script successfully reads drops out of the set on the next run. A failure stays in the
// set and will be retried. It never re-reads a CV that already has an extraction.
//
//   CAVEAT, and it is the one to know: an EMPTY read still writes an extraction row, so a CV the
//   model looked at and got nothing from ALSO drops out of the set — the same trap the
//   RULES_ONLY_MODELS hold-back below exists to close, one layer up. The Empty count in the summary
//   is how you find those; they are not retried automatically and need their rows removed first.
//
// Usage (from the worktree root):
//   node --env-file-if-exists=.env.local --experimental-strip-types \
//        --experimental-specifier-resolution=node --experimental-loader ./scripts/alias-loader.mjs \
//        scripts/recruitment-reread-never-read-cvs.ts [--limit N] [--dry-run] [--unresolved-only]
//
//   --dry-run          lists the target set and exits. No AI call, no write, no spend.
//   --limit N          reads only the first N. Used to prove the path on one before firing all.
//   --unresolved-only  narrows the set to candidates whose "Applying for" column is EMPTY and who
//                      actually have a stored file. Added 2026-08-21 at the owner's instruction
//                      ("run the extraction on the 56"). Most never-read CVs belong to candidates
//                      the column ALREADY answers from their subject line, so reading those is
//                      pure spend that changes nothing on screen. This flag runs the shipped
//                      resolver over the same evidence the page uses, so the set it picks is
//                      exactly the set the page shows as "Not stated".
// ─────────────────────────────────────────────────────────────────────────────

const OPS_MARKER = "ops:cv-reread-20260816";

// Serial on purpose. These are high-reasoning calls against 2 MB PDFs on a 16 GB laptop that
// is running other sessions; concurrency buys minutes and risks both an OpenAI rate limit and
// the machine. A slow correct run beats a fast half-finished one.
const DELAY_BETWEEN_MS = 1_000;

type TargetRow = {
  id: string;
  full_name: string | null;
  created_at: string;
  source: string | null;
};

// "empty" is a THIRD outcome, not a flavour of success.
//
// 2026-08-21: 23 WhatsApp photo CVs came back from the model with every scalar null and five empty
// arrays. The counter below treated an empty array as a field with a value, so each one printed
// "READ 5 fields (5 high)" and the summary read "Read: 23, Failed: 0" — a complete failure reported
// as a complete success, on the strength of which the 23 rows were deleted from production. The
// only honest numbers on screen were the three keyField counters at the bottom, all reading 0/23.
//
// A read that produced nothing usable is now counted and printed on its own line, so "Failed: 0"
// can never again be read as "everything was extracted".
type Outcome = {
  candidateId: string;
  name: string | null;
  received: string;
  status: "read" | "empty" | "failed";
  errorCode?: string;
  errorMessage?: string;
  extractionId?: string;
  fieldsWithAValue?: number;
  fieldsHighConfidence?: number;
  keyFields?: Record<string, string | null>;
  seconds: number;
};

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}. Run with --env-file-if-exists=.env.local from the worktree root.`);
  return value;
}

// The extracted payload is { field: { value, confidence } } — reading it with ->>'field'
// yields the stringified object, which is exactly the trap that nearly wrote JSON blobs into
// 145 phone columns during the phone backfill. Read .value explicitly, always.
//
// Emptiness is decided by isEmptyExtractedField, the one shared rule, and NOT by the hand-rolled
// `value === ""` check that used to live here. That check missed the two cases that matter: a
// whitespace-only string, and an empty array — which `String([])` then turned into "", a value the
// counter happily counted. Never re-derive this predicate locally.
function readValue(fields: ExtractedCandidateFields, key: string): string | null {
  const field = fields[key];
  if (isEmptyExtractedField(field)) return null;
  return String(field!.value);
}

function cairo(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Africa/Cairo",
  }).format(new Date(iso));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const unresolvedOnly = args.includes("--unresolved-only");
  const limitArg = args.find((a) => a.startsWith("--limit"));
  const limit = limitArg ? Number(limitArg.split("=")[1] ?? args[args.indexOf(limitArg) + 1]) : Number.NaN;

  const supabase = createClient(requireEnv("NEXT_PUBLIC_SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  console.log(`Supabase project : ${requireEnv("NEXT_PUBLIC_SUPABASE_URL")}`);
  console.log(`OpenAI key       : ${process.env.OPENAI_API_KEY ? "present" : "MISSING"}`);

  // Truth set: every candidate with no extraction row at all — EXCEPT that a free rules-only read
  // does not count as read.
  //
  // Owner decision 2026-08-21: the OpenAI key was deleted deliberately, for cost. The rule engine
  // still runs and still costs nothing, so this script remains useful — but a rules row carries
  // ~11-15 fields where a model row carries 38. If a rules row counted as "read", every candidate
  // it touched would be excluded from every future run FOREVER, so restoring the key later would
  // silently skip exactly the CVs that were read most poorly. They stay in the set instead, and the
  // insert-vs-replace decision below keeps the newest read as the one that counts.
  //
  // These are the CONSTANTS, never re-typed as literals. The set spelled its own strings until
  // 2026-08-21 and one of them, "phoenix-ocr", was a value nothing has ever written: the OCR path
  // records OCR_EXTRACTION_MODEL, which is "phoenix-rules+ocr". So an OCR-only row matched neither
  // entry, counted as a genuine model read, and dropped that candidate out of the set FOREVER —
  // exactly the failure the paragraph above exists to prevent, arriving through the back door.
  // Four production candidates were already frozen that way. Importing the constants makes the two
  // unable to drift again; tests/recruitment-reread-model-constants.test.ts holds the door shut.
  const RULES_ONLY_MODELS = new Set<string>([RULE_ONLY_EXTRACTION_MODEL, OCR_EXTRACTION_MODEL]);
  const { data: alreadyRead, error: readError } = await supabase
    .from("ats_candidate_cv_extractions")
    .select("candidate_id, ai_model");
  if (readError) throw readError;
  const readIds = new Set(
    (alreadyRead ?? [])
      .filter((row) => !RULES_ONLY_MODELS.has(String((row as { ai_model: unknown }).ai_model ?? "")))
      .map((row) => String(row.candidate_id)),
  );
  const rulesOnlyIds = new Set(
    (alreadyRead ?? [])
      .filter((row) => RULES_ONLY_MODELS.has(String((row as { ai_model: unknown }).ai_model ?? "")))
      .map((row) => String(row.candidate_id)),
  );

  const { data: allCandidates, error: candidateError } = await supabase
    .from("ats_candidates")
    .select("id, full_name, created_at, source")
    .order("created_at", { ascending: true });
  if (candidateError) throw candidateError;

  let targets = ((allCandidates ?? []) as TargetRow[]).filter((row) => !readIds.has(String(row.id)));
  console.log(`\nCandidates total : ${(allCandidates ?? []).length}`);
  console.log(`Already read     : ${readIds.size} distinct candidates`);
  console.log(`Never read       : ${targets.length}`);
  if (rulesOnlyIds.size > 0) {
    // Re-reading these while the key is still gone would only write the same free row again.
    const before = targets.length;
    targets = targets.filter((row) => !rulesOnlyIds.has(String(row.id)));
    console.log(`Rules-only so far: ${rulesOnlyIds.size}  (held back ${before - targets.length}; they need a real key)`);
  }

  if (unresolvedOnly) {
    // Two extra reads, both cheap, both needed to answer "would this row change on screen?".
    const { data: contextRows, error: contextError } = await supabase
      .from("ats_candidate_source_context")
      .select("candidate_id, channel, subject, raw_metadata");
    if (contextError) throw contextError;
    const contexts = new Map<string, ReturnType<typeof describeCandidateSource>>();
    for (const row of contextRows ?? []) {
      const key = String((row as { candidate_id: unknown }).candidate_id);
      contexts.set(key, describeCandidateSource(row as SourceContextRow));
    }

    // A candidate with no stored CV cannot be read at all — including one buys a guaranteed
    // failure and an entry in the report that looks like a problem to fix.
    const { data: fileRows, error: fileError } = await supabase.from("ats_files").select("candidate_id");
    if (fileError) throw fileError;
    const withAFile = new Set((fileRows ?? []).map((row) => String((row as { candidate_id: unknown }).candidate_id)));

    const before = targets.length;
    targets = targets.filter((row) => {
      if (!withAFile.has(String(row.id))) return false;
      const context = contexts.get(String(row.id)) ?? null;
      // No CV rung is passed, deliberately: having no extraction row is what makes this a target.
      return !candidateAppliedFor({
        fullName: row.full_name,
        sourceMessages: context?.channel === "whatsapp" ? context.detailLines : [],
        sourceSubject: context?.channel === "email" ? context.shortLabel : null,
        statedJobTitle: null,
      }).text;
    });
    console.log(`Column empty     : ${targets.length}  (--unresolved-only dropped ${before - targets.length})`);
  }

  if (Number.isFinite(limit) && limit > 0) {
    targets = targets.slice(0, limit);
    console.log(`Limited to       : ${targets.length}`);
  }

  if (dryRun) {
    console.log("\n--dry-run: listing only, no AI call and no write.\n");
    for (const [index, row] of targets.entries()) {
      console.log(`${String(index + 1).padStart(3)}. ${cairo(row.created_at)}  ${row.source ?? "-"}  ${row.full_name ?? "(no name)"}`);
    }
    return;
  }

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
    const began = Date.now();
    try {
      const result = await extractCandidateFieldsFromCv(String(row.id), access, defaultCvPositionKey);
      const fields = result.fields ?? {};
      // describeCvRead counts with the shared emptiness rule and decides read-vs-empty from that
      // count. Do not re-count here — a second opinion about what "has a value" means is the exact
      // defect this replaced.
      const outcome = describeCvRead(fields);
      const seconds = Math.round((Date.now() - began) / 100) / 10;

      outcomes.push({
        candidateId: String(row.id),
        name: row.full_name,
        received: cairo(row.created_at),
        status: outcome.status,
        extractionId: result.extractionId,
        fieldsWithAValue: outcome.fieldsWithAValue,
        fieldsHighConfidence: outcome.fieldsHighConfidence,
        // camelCase, NOT snake_case. The extracted payload is keyed exactly like
        // CreateCandidateInput — fullName, appliedForJobTitle. Reading it as full_name /
        // applied_for_job_title silently returns null for every row, which made this script's own
        // summary report "Names found 0/37" while 35 of them had a perfectly good name.
        keyFields: {
          fullName: readValue(fields, "fullName"),
          phone: readValue(fields, "phone"),
          email: readValue(fields, "email"),
          appliedForJobTitle: readValue(fields, "appliedForJobTitle"),
          currentJobTitle: readValue(fields, "currentJobTitle"),
          nationality: readValue(fields, "nationality"),
        },
        seconds,
      });
      console.log(
        outcome.status === "read"
          ? `${label}  ->  READ   ${outcome.fieldsWithAValue} fields (${outcome.fieldsHighConfidence} high)  ${seconds}s`
          : `${label}  ->  EMPTY  nothing usable — every field came back blank (${result.model})  ${seconds}s`,
      );
    } catch (error) {
      const seconds = Math.round((Date.now() - began) / 100) / 10;
      const code = error instanceof CvExtractionError ? error.code : "unexpected";
      const message = error instanceof Error ? error.message : String(error);
      outcomes.push({
        candidateId: String(row.id),
        name: row.full_name,
        received: cairo(row.created_at),
        status: "failed",
        errorCode: code,
        errorMessage: message,
        seconds,
      });
      console.log(`${label}  ->  FAILED ${code}: ${message.slice(0, 90)}  ${seconds}s`);
    }
    if (index < targets.length - 1) await new Promise((resolve) => setTimeout(resolve, DELAY_BETWEEN_MS));
  }

  const read = outcomes.filter((o) => o.status === "read");
  const empty = outcomes.filter((o) => o.status === "empty");
  const failed = outcomes.filter((o) => o.status === "failed");
  const totalMinutes = Math.round((Date.now() - startedAt) / 6_000) / 10;

  console.log(`\n${"=".repeat(70)}`);
  console.log(`Read   : ${read.length}`);
  // On its own line, above Failed, and named in full — because "Failed: 0" next to "Read: 23" is
  // what made 23 unreadable photo CVs look like a clean run.
  console.log(`Empty  : ${empty.length}  (call succeeded, extraction row written, NOT a read)`);
  for (const blank of empty) {
    console.log(`         nothing extracted  ${blank.name ?? "(no name)"}`);
  }
  console.log(`Failed : ${failed.length}`);
  for (const failure of failed) {
    console.log(`         ${failure.errorCode}  ${failure.name ?? "(no name)"}`);
  }
  console.log(`Elapsed: ${totalMinutes} minutes`);
  // camelCase, matching how keyFields is WRITTEN above. These three read full_name and
  // applied_for_job_title until 2026-08-21, so two of them could only ever print 0 — which is why
  // the one set of numbers that was telling the truth about the 23 empty reads was dismissed as a
  // known reporting bug rather than believed.
  console.log(`Names found  : ${read.filter((o) => o.keyFields?.fullName).length}/${read.length}`);
  console.log(`Phones found : ${read.filter((o) => o.keyFields?.phone).length}/${read.length}`);
  console.log(`Applied-for  : ${read.filter((o) => o.keyFields?.appliedForJobTitle).length}/${read.length}`);

  const outDir = process.env.CV_REREAD_OUT_DIR ?? path.join(process.cwd(), ".cv-reread");
  mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, "cv-reread-report.json");
  writeFileSync(outFile, JSON.stringify({ marker: OPS_MARKER, outcomes }, null, 2), "utf8");
  console.log(`\nReport: ${outFile}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

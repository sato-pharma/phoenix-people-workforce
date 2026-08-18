import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { createClient } from "@supabase/supabase-js";

import type { AccessContext } from "@/lib/auth/permissions";
import { defaultCvPositionKey } from "@/lib/recruitment/cv-field-schemas";
import { CvExtractionError, extractCandidateFieldsFromCv } from "@/lib/recruitment/cv-extraction";

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
// Usage (from the worktree root):
//   node --env-file-if-exists=.env.local --experimental-strip-types \
//        --experimental-specifier-resolution=node --experimental-loader ./scripts/alias-loader.mjs \
//        scripts/recruitment-reread-never-read-cvs.ts [--limit N] [--dry-run]
//
//   --dry-run   lists the target set and exits. No AI call, no write, no spend.
//   --limit N   reads only the first N. Used to prove the path on one before firing all of them.
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

type Outcome = {
  candidateId: string;
  name: string | null;
  received: string;
  status: "read" | "failed";
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
function readValue(fields: Record<string, unknown>, key: string): string | null {
  const entry = fields[key];
  if (!entry || typeof entry !== "object") return null;
  const value = (entry as { value?: unknown }).value;
  return value === null || value === undefined || value === "" ? null : String(value);
}

function readConfidence(fields: Record<string, unknown>, key: string): string | null {
  const entry = fields[key];
  if (!entry || typeof entry !== "object") return null;
  const confidence = (entry as { confidence?: unknown }).confidence;
  return confidence ? String(confidence) : null;
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
  const limitArg = args.find((a) => a.startsWith("--limit"));
  const limit = limitArg ? Number(limitArg.split("=")[1] ?? args[args.indexOf(limitArg) + 1]) : Number.NaN;

  const supabase = createClient(requireEnv("NEXT_PUBLIC_SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  console.log(`Supabase project : ${requireEnv("NEXT_PUBLIC_SUPABASE_URL")}`);
  console.log(`OpenAI key       : ${process.env.OPENAI_API_KEY ? "present" : "MISSING"}`);

  // Truth set: every candidate with no extraction row at all.
  const { data: alreadyRead, error: readError } = await supabase
    .from("ats_candidate_cv_extractions")
    .select("candidate_id");
  if (readError) throw readError;
  const readIds = new Set((alreadyRead ?? []).map((row) => String(row.candidate_id)));

  const { data: allCandidates, error: candidateError } = await supabase
    .from("ats_candidates")
    .select("id, full_name, created_at, source")
    .order("created_at", { ascending: true });
  if (candidateError) throw candidateError;

  let targets = ((allCandidates ?? []) as TargetRow[]).filter((row) => !readIds.has(String(row.id)));
  console.log(`\nCandidates total : ${(allCandidates ?? []).length}`);
  console.log(`Already read     : ${readIds.size} distinct candidates`);
  console.log(`Never read       : ${targets.length}`);

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
      const fields = (result.fields ?? {}) as Record<string, unknown>;
      const keys = Object.keys(fields);
      const withValue = keys.filter((key) => readValue(fields, key) !== null);
      const highConfidence = withValue.filter((key) => readConfidence(fields, key) === "high");
      const seconds = Math.round((Date.now() - began) / 100) / 10;

      outcomes.push({
        candidateId: String(row.id),
        name: row.full_name,
        received: cairo(row.created_at),
        status: "read",
        extractionId: result.extractionId,
        fieldsWithAValue: withValue.length,
        fieldsHighConfidence: highConfidence.length,
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
      console.log(`${label}  ->  READ   ${withValue.length} fields (${highConfidence.length} high)  ${seconds}s`);
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
  const failed = outcomes.filter((o) => o.status === "failed");
  const totalMinutes = Math.round((Date.now() - startedAt) / 6_000) / 10;

  console.log(`\n${"=".repeat(70)}`);
  console.log(`Read   : ${read.length}`);
  console.log(`Failed : ${failed.length}`);
  for (const failure of failed) {
    console.log(`         ${failure.errorCode}  ${failure.name ?? "(no name)"}`);
  }
  console.log(`Elapsed: ${totalMinutes} minutes`);
  console.log(`Names found  : ${read.filter((o) => o.keyFields?.full_name).length}/${read.length}`);
  console.log(`Phones found : ${read.filter((o) => o.keyFields?.phone).length}/${read.length}`);
  console.log(`Applied-for  : ${read.filter((o) => o.keyFields?.applied_for_job_title).length}/${read.length}`);

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

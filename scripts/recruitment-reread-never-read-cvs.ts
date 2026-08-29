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
import {
  selectNewestIsRulesCandidateIds,
  selectReadCandidateIds,
  selectRulesOnlyCandidateIds,
} from "@/lib/recruitment/cv-reread-target-sets";
import { cvRereadOpsMarker } from "@/lib/recruitment/ops-marker";

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
//   Every row it writes is stamped created_by = OPS_MARKER — `ops:cv-reread-<this run's Cairo
//   day>` — so a re-read is distinguishable from a Talent Acquisition review forever after, and
//   one run is distinguishable from the next. Do not "clean up" that marker, and do not freeze
//   it back into a literal: src/lib/recruitment/ops-marker.ts records what that cost last time.
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
//   AND THE CAVEAT TO THAT CAVEAT, learned 2026-08-21: "delete the empty rows so the next run
//   reaches them" is WRONG when the file is not a CV. 23 WhatsApp JPEGs proved to be photographed
//   certificates and 4 email attachments proved to be outbound job offers and an Outlook signature
//   image; for those, empty is the CORRECT answer and their rows are load-bearing — they keep a
//   confirmed non-CV out of every future run at zero cost. Before deleting an empty row to re-arm
//   a read, check what the file actually IS. NOT_A_CV_CANDIDATES below covers the ones whose rows
//   were already removed.
//
// Usage (from the worktree root):
//   node --env-file-if-exists=.env.local --experimental-strip-types \
//        --experimental-specifier-resolution=node --experimental-loader ./tests/alias-loader.mjs \
//        scripts/recruitment-reread-never-read-cvs.ts [--limit N] [--dry-run] [--unresolved-only]
//
//   The loader is ./tests/alias-loader.mjs, NOT the one beside this script. Both exist; only that
//   one resolves `next/cache`, which arrives transitively through the extraction import chain. With
//   ./scripts/alias-loader.mjs the run dies before its first line with ERR_MODULE_NOT_FOUND naming
//   company-vacation-report.ts — a file this script has nothing to do with, which is why the error
//   reads like a broken checkout rather than a wrong flag. Corrected here 2026-08-27 after it cost
//   a cycle; the same wrong path was in this comment while every real run used the right one.
//
//   --dry-run          lists the target set and exits. No AI call, no write, no spend.
//   --limit N          reads only the first N. Used to prove the path on one before firing all.
//   --include-rules-only  releases the candidates held back because their only extraction row is a
//                      free rules/OCR read. Owner-approved 2026-08-27, after credits were restored.
//                      Releasing them is necessary but NOT sufficient — see --force-model.
//   --newest-rules-only  widens the set to candidates whose NEWEST extraction row is a free rules
//                      row, even though an older model row exists. Owner-approved 2026-08-27.
//
//                      These are unreachable by every other flag, --include-rules-only included.
//                      The truth set asks "has this candidate EVER had a model row", so one bad
//                      model read in the past excludes a candidate permanently — while the value
//                      of re-reading is decided by the NEWEST row, which is this file's own stated
//                      rule. Measured on production 2026-08-27: 38 candidates, all with a stored
//                      CV, 25 of them with no job title on the candidate record.
//
//                      It ADDS to the set and never subtracts, so it cannot shrink a run.
//                      Deliberately NOT paired with --force-model: post-#2453 the gate escalates a
//                      missing currentJobTitle or currentEmployer on its own, so letting the gate
//                      decide is both the cheaper run and the honest test of it.
//   --force-model      bypasses shouldEscalateToAi, so every target reaches the model.
//
//                      WITHOUT it, releasing a rules-only candidate mostly achieves nothing. The
//                      gate is a spend decision taken BEFORE any model call: when the rules have
//                      answered everything worth asking, it returns their read for free. Measured
//                      on production 2026-08-27 over the 59 candidates who have never had a model
//                      read: 20 escalate on their own (#2453 made a lone missing job title or
//                      employer enough), and 39 are refused — 35 of them for "rules answered every
//                      field worth asking about". No number of re-runs reaches those 39, which is
//                      why the same candidates carry two, three and four identical free rows.
//
//                      This is the ONLY flag here that turns a free run into a paid one for
//                      candidates the system had decided not to spend on, so it is deliberately
//                      explicit, prints what it will cost, and is never set by anything but a
//                      human typing it. Inbound intake cannot reach it. Measured price at the nano
//                      tier (post-#2451): ~$0.0043 per CV, so all 59 ≈ $0.25.
//   --unresolved-only  narrows the set to candidates whose "Applying for" column is EMPTY and who
//                      actually have a stored file. Added 2026-08-21 at the owner's instruction
//                      ("run the extraction on the 56"). Most never-read CVs belong to candidates
//                      the column ALREADY answers from their subject line, so reading those is
//                      pure spend that changes nothing on screen. This flag runs the shipped
//                      resolver over the same evidence the page uses, so the set it picks is
//                      exactly the set the page shows as "Not stated".
// ─────────────────────────────────────────────────────────────────────────────

// Resolved once, at module load, so one run stamps one day even if it crosses Cairo midnight —
// which these long serial batches routinely do. Every row still carries its own created_at.
const OPS_MARKER = cvRereadOpsMarker();

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

// Candidates whose only stored file is CONFIRMED not to be a CV. Never re-read; there is nothing
// on these pages to extract and a perfect model returns the same nothing.
//
// WHY A LIST AND NOT A RULE. The truth set here is "has no extraction row", which is a proxy for
// "was never read" — and the proxy inverts for a file that is not a CV at all. Reading one of these
// does not fail. It SUCCEEDS on the wrong document and writes a row that then hides the candidate
// from every future run, so the failure is self-concealing. Worse, a job offer has a clean text
// layer, so the rules engine parses it confidently into the wrong fields. Measured on production
// 2026-08-21, from the 08:49 run:
//
//     Fady Nashaat   fullName       = "Total Monthly Package"                    <- a salary
//                                                                                      table HEADER
//     Hesham Abdelaziz  currentJobTitle = "Medical Sales Representative Job Offer"  (HIGH conf.)
//
// Both rows were deleted the same day. An empty read announces itself in the Empty count; a
// confidently wrong one does not, which is what makes this class worth a hard list.
//
// THE REAL FIX IS is_cv, NOT THIS LIST. Since 3f3c0e05 (2026-08-21) every extraction records
// whether the read judged the document to be a CV, so a future run can ask instead of consulting a
// hand-kept list. This list covers the rows written BEFORE that shipped, whose judgement is gone.
// Prefer extending is_cv coverage over extending this array.
//
// Every entry needs the evidence, because an id with no reason behind it can never be safely
// removed. Adding one is a decision to spend nothing on that candidate forever — take it only when
// somebody has OPENED the file.
const NOT_A_CV_CANDIDATES: ReadonlyArray<{ id: string; name: string; file: string; why: string }> = [
  {
    file: "Fady Nashaat JO ٍSigned.pdf",
    id: "254a228f-5458-40ab-b79d-62c29686c930",
    name: "Fady Nashaat",
    why: "His own signed job offer — outbound, Phoenix sent it. Read 2026-08-21 as fullName='Total Monthly Package'.",
  },
  {
    file: "MRs JO.pdf",
    id: "cfd39f22-3cb3-4b5e-9d65-9dc868a6ea6e",
    name: "Hesham Abdelaziz",
    why: "Signed job offer. Read 2026-08-21 as currentJobTitle='Medical Sales Representative Job Offer' at HIGH confidence.",
  },
  {
    file: "Dr Hatem Sorour RM JO.pdf",
    id: "7b7141fb-496b-4183-ac76-7e1b8f6208b3",
    name: "dr.hatem sorour",
    why: "Signed job offer, same class and same state as the two above — 0 extractions, so the next run would read it and write the same nonsense.",
  },
];

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
  const includeRulesOnly = args.includes("--include-rules-only");
  const forceModel = args.includes("--force-model");
  const newestRulesOnly = args.includes("--newest-rules-only");
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

  // PAGINATED ON PURPOSE. PostgREST caps an unbounded select at 1000 rows and returns no error and
  // no marker when it does — the array simply stops. Measured 2026-08-27 this table held 912 rows
  // against 431 candidates, i.e. 88 rows from silently truncating, and every run of this script
  // adds one row per candidate it reads. Past the cap the rows that fall off take their candidates
  // out of readIds, so a candidate the model HAS read is re-read as "never read" while another
  // freezes out of the set — the exact class of silent misclassification the comment above spends a
  // paragraph on, arriving through a row limit instead of a typo. Ask for an explicit ordered range
  // and keep asking until a short page proves the end.
  type ExtractionRow = { candidate_id: string; ai_model: unknown; created_at: string };
  const PAGE = 1000;
  const extractionRows: ExtractionRow[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data: page, error: readError } = await supabase
      .from("ats_candidate_cv_extractions")
      .select("candidate_id, ai_model, created_at")
      .order("created_at", { ascending: true })
      .range(from, from + PAGE - 1);
    if (readError) throw readError;
    const rows = (page ?? []) as ExtractionRow[];
    extractionRows.push(...rows);
    if (rows.length < PAGE) break;
  }

  // All three sets live in @/lib/recruitment/cv-reread-target-sets so a test can actually EXERCISE
  // them: this file calls main() at import time against production, so nothing here can be imported,
  // and a source-shape pin cannot catch a set that answers the wrong question. One of them did.
  const readIds = selectReadCandidateIds(extractionRows, RULES_ONLY_MODELS);

  // Candidates whose history is free rules output and nothing else. Until 2026-08-27 this asked
  // "has a rules row ANYWHERE in its history", so a candidate the model read today still counted
  // for ever after: it read 174 on production when the truth was 0. See the library for why the
  // printed number mattered even though the filter below was never wrong.
  const rulesOnlyIds = selectRulesOnlyCandidateIds(extractionRows, RULES_ONLY_MODELS);

  // The candidates whose NEWEST row is a free rules row, whatever came before it.
  //
  // readIds above asks "has this candidate EVER had a model row", which permanently excludes a
  // candidate the model read once and badly. That contradicts this file's own rule — "the
  // insert-vs-replace decision keeps the newest read as the one that counts" — because the target
  // set was keyed on history while the value of a re-read is decided by the newest row alone.
  // Measured on production 2026-08-27: 38 candidates sit exactly there, all 38 with a stored CV,
  // and 25 of them still have no job title on the candidate record. --include-rules-only cannot
  // reach a single one of them: it only stops rules-only candidates being REMOVED from the
  // never-read set, and these were never in it.
  //
  // extractionRows is ordered oldest-first, which is what makes "newest" meaningful.
  const newestIsRulesIds = selectNewestIsRulesCandidateIds(extractionRows, RULES_ONLY_MODELS);

  const { data: allCandidates, error: candidateError } = await supabase
    .from("ats_candidates")
    .select("id, full_name, created_at, source")
    .order("created_at", { ascending: true });
  if (candidateError) throw candidateError;

  let targets = ((allCandidates ?? []) as TargetRow[]).filter((row) => !readIds.has(String(row.id)));
  console.log(`\nCandidates total : ${(allCandidates ?? []).length}`);
  console.log(`Already read     : ${readIds.size} distinct candidates`);
  console.log(`Never read       : ${targets.length}`);

  // --newest-rules-only ADDS to the set; it never subtracts. A candidate already selected as never
  // read stays selected, so the flag cannot shrink a run or quietly skip anybody.
  if (newestRulesOnly) {
    const before = targets.length;
    const selected = new Set(targets.map((row) => String(row.id)));
    const widened = ((allCandidates ?? []) as TargetRow[]).filter(
      (row) => newestIsRulesIds.has(String(row.id)) && !selected.has(String(row.id)),
    );
    targets = [...targets, ...widened].sort(
      (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
    );
    console.log(
      `Newest row rules : ${newestIsRulesIds.size}  (--newest-rules-only ADDED ${targets.length - before} already-read candidates whose newest row is a free rules row)`,
    );
  } else if (newestIsRulesIds.size > 0) {
    console.log(
      `Newest row rules : ${newestIsRulesIds.size}  (not included — pass --newest-rules-only to re-read the ones whose newest row is free rules output)`,
    );
  }
  if (rulesOnlyIds.size > 0) {
    // Re-reading these while the key is still gone would only write the same free row again — so
    // the default is to hold them back. --include-rules-only releases them, which is what you want
    // once the key is spending again: these are precisely the CVs that were read WORST (a rules row
    // carries ~11-15 fields where a model row carries 38), so they are the highest-value re-read in
    // the whole set and the most expensive to leave alone.
    //
    // The hold-back has never been conditional on a key actually being absent, and cannot safely
    // become so: hasOpenAiApiKey() answers on the key's PRESENCE, and a present key with an
    // exhausted balance returns 200 from /v1/models while every completion 429s. A run that
    // released these on "the key looks fine" would rewrite the same free rows at scale and call it
    // a re-read. Releasing them stays an explicit, owner-approved instruction.
    const before = targets.length;
    if (includeRulesOnly) {
      console.log(`Rules-only, never read by a model: ${rulesOnlyIds.size}  (RELEASED by --include-rules-only: ${targets.filter((row) => rulesOnlyIds.has(String(row.id))).length} re-read this run)`);
    } else {
      targets = targets.filter((row) => !rulesOnlyIds.has(String(row.id)));
      console.log(`Rules-only, never read by a model: ${rulesOnlyIds.size}  (held back ${before - targets.length}; they need a real key — pass --include-rules-only to read them)`);
    }
  }

  // Confirmed non-CVs. Report what was actually hit, not just the size of the list — a listed id
  // that matches nothing means the candidate has since been read, deleted, or re-keyed, and a
  // silently ineffective skip entry is exactly the kind of thing that rots unnoticed.
  {
    const notACvIds = new Set(NOT_A_CV_CANDIDATES.map((entry) => entry.id));
    const before = targets.length;
    targets = targets.filter((row) => !notACvIds.has(String(row.id)));
    const skipped = before - targets.length;
    console.log(`Not a CV         : skipped ${skipped} of ${NOT_A_CV_CANDIDATES.length} listed  (outbound job offers — see NOT_A_CV_CANDIDATES)`);
    if (skipped < NOT_A_CV_CANDIDATES.length) {
      const inTargets = new Set(targets.map((row) => String(row.id)));
      for (const entry of NOT_A_CV_CANDIDATES) {
        if (!notACvIds.has(entry.id) || inTargets.has(entry.id)) continue;
        console.log(`  note: "${entry.name}" (${entry.id}) was not in the target set this run — already read, or gone.`);
      }
    }
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

  // Say what this will cost BEFORE spending it. Neither --limit nor anything else in this script is
  // a cost ceiling, and the two bulk bursts that dominate this account's OpenAI bill were both runs
  // exactly like this one. The rate is measured, not guessed: 2026-08-27, real API usage over the
  // universal 38-field schema, $0.0043/CV on the nano tier the text route now uses.
  const NANO_COST_PER_CV = 0.0043;
  if (forceModel) {
    console.log(
      `\n--force-model    : ON — the escalation gate is BYPASSED. All ${targets.length} targets reach the model.`,
    );
    console.log(
      `Estimated spend  : ~$${(targets.length * NANO_COST_PER_CV).toFixed(2)} (${targets.length} x ~$${NANO_COST_PER_CV.toFixed(4)}), vision-route CVs cost ~12x more.`,
    );
  } else {
    console.log(`\n--force-model    : off — the gate decides per CV; candidates it refuses cost nothing and change nothing.`);
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
      const result = await extractCandidateFieldsFromCv(String(row.id), access, defaultCvPositionKey, { forceModel });
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

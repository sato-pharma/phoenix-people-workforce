// =============================================================================
// Backfill candidates whose WhatsApp classify answers never reached ats_candidates
// =============================================================================
// WHY THIS EXISTS: commit 7ebb06022 fixed a race in applyPendingClassification /
// applyPendingExtraAnswers (src/lib/recruitment/inbound/) that could snapshot an
// IN-PROGRESS WhatsApp conversation onto a candidate the moment the CV-intake worker's
// candidate-creation race won before the applicant finished answering. Once that happened,
// `applied_at` was set and nothing ever re-synced the record, even though the applicant went
// on to answer more questions in the same, now-completed session sitting right there in
// ats_whatsapp_classification_sessions.
//
// A second, unrelated mechanism produces the exact same visible symptom (preferences_declared_at
// null, region/area blank, on an otherwise-answered candidate): a candidate MERGE. Per
// src/lib/recruitment/candidate-merge.ts's mergeableFields, a merge survivor can only ever
// borrow declared_background / declared_experience / declared_expected_salary /
// applied_for_job_title from the duplicate it absorbs — preferred_region_code/name and
// preferred_area_name are deliberately excluded (borrowing them independently could pair one
// record's region code with another's free-typed area name), and preferences_declared_at is
// never borrowable at all. So a survivor whose OWN pre-merge session already answered the
// region/preferences questions is fine; one that never did stays blank forever unless this
// backfill (or a fresh WhatsApp completion) fills it in. The merge's own relink step already
// repoints the session's applied_candidate_id at the live survivor, so both mechanisms are
// recoverable the exact same way: re-run the applicant's latest COMPLETED session through the
// same production write path a live completion would use today.
//
// Discovery is per CANDIDATE, not per session: for every WhatsApp session whose
// applied_candidate_id points at a real candidate and whose conversation actually completed,
// only the MOST RECENTLY COMPLETED one per candidate is used — the same "most recent wins" rule
// applyClassificationToCandidate already applies to any future completion. A gap is only ever a
// field that is BLANK on the candidate today; a field the candidate ALREADY holds a value for is
// never touched, so a candidate who completed the flow twice with two different typed spellings
// of the same answer is correctly left alone (writeClassification's own label-normalizing
// functions make that a no-op even if it were re-run).
//
// One shape is NOT auto-applied: a candidate whose REGION is already filled but disagrees with
// the region_code on their latest completed session. That is not a gap — it is a live value that
// would be overwritten by a different live value (Mina Magdy Khamies, candidate
// 257dd5e0-b15f-4d5b-8b28-9f3bff4b8608, is the one case found on 2026-09-12: her candidate holds
// D1/Gharbia 1 from an 2026-08-29 completion; a later 2026-09-01 completion says CA/Cairo East 1,
// whose write landed on a since-merged-away duplicate and was never carried onto her survivor
// record). Deciding which region is the applicant's real current answer is a judgement call, not
// a blank to fill, so this script reports it under `skipped` with reason
// "region_conflict_needs_owner_decision" and writes nothing for it — per AGENTS.md §4, ask when
// the answer changes the outcome.
//
// A candidate NOT in either bucket needs no action: e.g. Amr Kamel
// (38adf153-39ab-4134-a761-89a68a29bdda) looked like a gap under a looser query, but his own
// session genuinely never asked a region question for his (non-medical-rep) role — his candidate
// record already matches his session exactly.
//
// Usage (dry-run discovers the plan and writes nothing):
//   pnpm run ops:backfill-whatsapp-classify-gaps
//
// Apply (production only; the confirm token must be the count the dry-run just printed, re-run
// immediately before applying — this refuses a stale plan rather than trusting a number copied
// from an earlier run):
//   pnpm run ops:backfill-whatsapp-classify-gaps -- --apply --confirm-production=<N>
//
// Idempotent: re-running after a successful apply finds zero remaining gaps, because every
// candidate it touched now holds whatever its latest completed session answered.
// =============================================================================

import type { SupabaseClient } from "@supabase/supabase-js";

import { applyClassificationToCandidate } from "@/lib/recruitment/inbound/whatsapp-classify-session";
import { SESSION_COLUMNS, type SessionRow } from "@/lib/recruitment/inbound/whatsapp-classify-session-row";
import { EXTRA_SESSION_COLUMNS, type ExtraSessionRow } from "@/lib/recruitment/inbound/whatsapp-screening-questions-session";
import { fetchAllRows } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";

// A flag this script does not know is refused, never ignored (scripts/lib/refuse-arguments.mjs).
refuseUnknownFlags({
  name: "backfill-whatsapp-classify-gaps",
  entry: import.meta.url,
  known: ["--apply", "--dry-run", "--confirm-production"],
});

const productionSupabaseRef = "ozucdzovmcqvepbozvqf";
const SESSIONS_TABLE = "ats_whatsapp_classification_sessions";
const FIX_COMMIT = "7ebb06022";

type ScriptMode = "dry-run" | "apply";

type CliOptions = { confirm: string | null; mode: ScriptMode };

function parseArgs(argv: string[]): CliOptions {
  const hasApply = argv.includes("--apply");
  const hasDryRun = argv.includes("--dry-run");
  if (hasApply && hasDryRun) throw new Error("Choose either --dry-run or --apply, not both.");

  const readValue = (prefix: string) =>
    argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length).trim() ?? null;

  return { confirm: readValue("--confirm-production="), mode: hasApply ? "apply" : "dry-run" };
}

function requiredEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function assertProductionTarget() {
  const supabaseUrl = requiredEnv("NEXT_PUBLIC_SUPABASE_URL");
  let host = "";
  try {
    host = new URL(supabaseUrl).hostname;
  } catch {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL is not a valid URL.");
  }
  if (!host.startsWith(`${productionSupabaseRef}.`)) {
    throw new Error(
      `Refusing to run: NEXT_PUBLIC_SUPABASE_URL points to ${host}, not production ref ${productionSupabaseRef}.`,
    );
  }
}

function isBlank(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim().length === 0;
  return false;
}

// ── Discovery ────────────────────────────────────────────────────────────────────────────────

type SessionDiscoveryRow = {
  id: string;
  applied_candidate_id: string | null;
  wa_id: string;
  job_title_family: string | null;
  job_title_other_text: string | null;
  region_code: string | null;
  region_other_text: string | null;
  area_name: string | null;
  area_other_text: string | null;
  background: string | null;
  background_other_text: string | null;
  experience: string | null;
  expected_salary: string | null;
  extra_answers: Record<string, string> | null;
  completed_at: string;
};

// One unbroken literal on purpose: `"a," + "b"` widens to `string`, and PostgREST's typings then
// cannot infer a row shape from it, so every `as SessionDiscoveryRow[]` below stops compiling.
const DISCOVERY_SESSION_COLUMNS =
  "id,applied_candidate_id,wa_id,job_title_family,job_title_other_text,region_code,region_other_text,area_name,area_other_text,background,background_other_text,experience,expected_salary,extra_answers,completed_at";

/**
 * One row per candidate: their MOST RECENTLY COMPLETED WhatsApp session. Rows arrive
 * newest-first, so the first one seen per applied_candidate_id is kept — the same "most recent
 * wins" rule applyClassificationToCandidate applies to any live completion today.
 *
 * Read in pages: an unbounded `.select()` on this table stops at 1000 rows with no marker (a
 * documented trap here), and this script used to refuse to run at 1000 eligible rows instead of
 * reading past them. `id` is the tiebreak, so two sessions completed in the same instant keep a
 * stable order across pages.
 */
async function loadLatestSessionByCandidate(supabase: SupabaseClient): Promise<Map<string, SessionDiscoveryRow>> {
  let rows: SessionDiscoveryRow[];
  try {
    rows = await fetchAllRows<SessionDiscoveryRow>(
      () =>
        supabase
          .from(SESSIONS_TABLE)
          .select(DISCOVERY_SESSION_COLUMNS)
          .not("applied_candidate_id", "is", null)
          .not("completed_at", "is", null)
          .order("completed_at", { ascending: false }),
      "id",
    );
  } catch (error) {
    throw new Error(`${SESSIONS_TABLE} load failed: ${(error as { message?: string }).message ?? String(error)}`);
  }

  const latest = new Map<string, SessionDiscoveryRow>();
  for (const row of rows) {
    const candidateId = row.applied_candidate_id;
    if (!candidateId) continue;
    if (!latest.has(candidateId)) latest.set(candidateId, row);
  }
  return latest;
}

type CandidateSnapshot = {
  id: string;
  full_name: string | null;
  status: string | null;
  preferences_declared_at: string | null;
  preferred_region_code: string | null;
  preferred_region_name: string | null;
  preferred_area_name: string | null;
  declared_background: string | null;
  declared_experience: string | null;
  declared_expected_salary: string | null;
  applied_for_job_title: string | null;
  screening_extra_answers: Record<string, unknown> | null;
};

// One unbroken literal, for the same reason as DISCOVERY_SESSION_COLUMNS above.
const CANDIDATE_SNAPSHOT_COLUMNS =
  "id,full_name,status,preferences_declared_at,preferred_region_code,preferred_region_name,preferred_area_name,declared_background,declared_experience,declared_expected_salary,applied_for_job_title,screening_extra_answers";

/** Chunked at 50: a PostgREST `.in()` can fail on a large id list (a documented trap here). */
async function loadCandidateSnapshots(
  supabase: SupabaseClient,
  candidateIds: string[],
): Promise<Map<string, CandidateSnapshot>> {
  const byId = new Map<string, CandidateSnapshot>();
  for (let i = 0; i < candidateIds.length; i += 50) {
    const chunk = candidateIds.slice(i, i + 50);
    const { data, error } = await supabase.from("ats_candidates").select(CANDIDATE_SNAPSHOT_COLUMNS).in("id", chunk);
    if (error) throw new Error(`ats_candidates load failed: ${error.message}`);
    for (const row of (data ?? []) as CandidateSnapshot[]) byId.set(row.id, row);
  }
  return byId;
}

type ClassifyGapField = "preferences" | "region" | "background" | "experience" | "salary" | "job_title";

function classifyGapFields(candidate: CandidateSnapshot, session: SessionDiscoveryRow): ClassifyGapField[] {
  const gaps: ClassifyGapField[] = [];
  if (isBlank(candidate.preferences_declared_at)) gaps.push("preferences");

  const sessionAnsweredRegion =
    !isBlank(session.region_code) || !isBlank(session.region_other_text) || !isBlank(session.area_name) || !isBlank(session.area_other_text);
  const candidateRegionBlank =
    isBlank(candidate.preferred_region_code) && isBlank(candidate.preferred_region_name) && isBlank(candidate.preferred_area_name);
  if (sessionAnsweredRegion && candidateRegionBlank) gaps.push("region");

  if ((!isBlank(session.background) || !isBlank(session.background_other_text)) && isBlank(candidate.declared_background)) {
    gaps.push("background");
  }
  if (!isBlank(session.experience) && isBlank(candidate.declared_experience)) gaps.push("experience");
  if (!isBlank(session.expected_salary) && isBlank(candidate.declared_expected_salary)) gaps.push("salary");
  if ((!isBlank(session.job_title_family) || !isBlank(session.job_title_other_text)) && isBlank(candidate.applied_for_job_title)) {
    gaps.push("job_title");
  }
  return gaps;
}

/**
 * A real region VALUE conflict — never a blank to fill. Compared on the CODE only: the candidate
 * and the session's free-typed "other" text can legitimately differ in spelling for the same
 * answer (writeClassification stores a normalized label, not the raw text), and that is not a
 * conflict — it is the exact normalization-noise this check must not flag.
 */
function hasRegionConflict(candidate: CandidateSnapshot, session: SessionDiscoveryRow): boolean {
  const candidateHasRegion = !isBlank(candidate.preferred_region_code) || !isBlank(candidate.preferred_area_name);
  if (!candidateHasRegion || isBlank(session.region_code)) return false;
  return (candidate.preferred_region_code ?? "") !== session.region_code;
}

function hasExtraAnswersGap(candidate: CandidateSnapshot, session: SessionDiscoveryRow): boolean {
  const sessionAnswers = session.extra_answers ?? {};
  if (Object.keys(sessionAnswers).length === 0) return false;
  const candidateAnswers = candidate.screening_extra_answers ?? {};
  return Object.keys(candidateAnswers).length === 0;
}

type PlannedAction =
  | {
      kind: "classify_backfill";
      candidateId: string;
      candidateName: string;
      sessionId: string;
      waId: string;
      gaps: ClassifyGapField[];
    }
  | { kind: "extra_answers_backfill"; candidateId: string; candidateName: string; sessionId: string; waId: string };

type SkippedCandidate = { candidateId: string; candidateName: string; reason: string; detail?: Record<string, unknown> };

async function buildPlan(supabase: SupabaseClient): Promise<{ plan: PlannedAction[]; skipped: SkippedCandidate[] }> {
  const sessionsByCandidate = await loadLatestSessionByCandidate(supabase);
  const candidates = await loadCandidateSnapshots(supabase, [...sessionsByCandidate.keys()]);

  const plan: PlannedAction[] = [];
  const skipped: SkippedCandidate[] = [];

  for (const [candidateId, session] of sessionsByCandidate) {
    const candidate = candidates.get(candidateId);
    if (!candidate) {
      skipped.push({ candidateId, candidateName: "(candidate row not found)", reason: "candidate_row_not_found" });
      continue;
    }
    const candidateName = candidate.full_name ?? candidateId;

    if (hasRegionConflict(candidate, session)) {
      skipped.push({
        candidateId,
        candidateName,
        reason: "region_conflict_needs_owner_decision",
        detail: {
          candidateRegionCode: candidate.preferred_region_code,
          candidateAreaName: candidate.preferred_area_name,
          latestSessionRegionCode: session.region_code,
          latestSessionAreaName: session.area_name,
          latestSessionCompletedAt: session.completed_at,
        },
      });
      // Fall through on purpose: the region conflict does not block filling any OTHER genuinely
      // blank field on the same candidate (classifyGapFields never re-flags "region" here, since
      // candidateRegionBlank is false whenever hasRegionConflict is true).
    }

    const gaps = classifyGapFields(candidate, session);
    if (gaps.length > 0) {
      plan.push({ kind: "classify_backfill", candidateId, candidateName, sessionId: session.id, waId: session.wa_id, gaps });
    }

    if (hasExtraAnswersGap(candidate, session)) {
      plan.push({ kind: "extra_answers_backfill", candidateId, candidateName, sessionId: session.id, waId: session.wa_id });
    }
  }

  return { plan, skipped };
}

// ── Applying ─────────────────────────────────────────────────────────────────────────────────

const FIELD_LABELS: Record<string, string> = {
  preferences_declared_at: "the preferences-declared timestamp",
  preferred_region_code: "the region",
  // Both region columns must be listed. A tapped region lands in the code column and a free-typed
  // one ("my region is not listed") lands in the name column, so omitting either makes the history
  // line under-report what the run actually changed — which is how Micheal Nasser Shawky's line on
  // 2026-09-12 recorded only a timestamp for a run that also filled his region name.
  preferred_region_name: "the region they typed",
  preferred_area_name: "the area",
  declared_background: "what they said they studied",
  declared_experience: "the experience band they chose",
  declared_expected_salary: "expected salary in their words",
  applied_for_job_title: "the job applied for",
  screening_extra_answers: "the screening question answers",
};

function describeChangedFields(before: CandidateSnapshot, after: CandidateSnapshot): string[] {
  const changed: string[] = [];
  for (const key of Object.keys(FIELD_LABELS) as Array<keyof CandidateSnapshot>) {
    const beforeValue = JSON.stringify(before[key] ?? null);
    const afterValue = JSON.stringify(after[key] ?? null);
    if (beforeValue !== afterValue) changed.push(FIELD_LABELS[key]);
  }
  return changed;
}

async function loadCandidateSnapshot(supabase: SupabaseClient, candidateId: string): Promise<CandidateSnapshot> {
  const { data, error } = await supabase
    .from("ats_candidates")
    .select(CANDIDATE_SNAPSHOT_COLUMNS)
    .eq("id", candidateId)
    .limit(1);
  if (error) throw new Error(`ats_candidates load failed for ${candidateId}: ${error.message}`);
  const row = (data ?? [])[0] as CandidateSnapshot | undefined;
  if (!row) throw new Error(`Candidate ${candidateId} vanished between plan and apply.`);
  return row;
}

/**
 * Best-effort, same reasoning as candidate-merge-service.ts's recordMergeEvent: the backfill
 * write has already happened by this point and cannot be undone by throwing over a missing
 * history line. from_status/to_status carry the SAME value on purpose, so this never reads as a
 * status change in the candidate's timeline.
 */
async function writeBackfillHistoryLine(supabase: SupabaseClient, candidateId: string, status: string | null, note: string) {
  const { error } = await supabase.from("ats_candidate_status_events").insert({
    actor_hr_id: null,
    candidate_id: candidateId,
    from_status: status,
    to_status: status,
    note,
  });
  if (error) {
    console.error(`ats_candidate_status_events insert failed for ${candidateId}: ${error.message}`);
  }
}

async function applyAction(supabase: SupabaseClient, action: PlannedAction): Promise<{ changedFields: string[] }> {
  const before = await loadCandidateSnapshot(supabase, action.candidateId);

  if (action.kind === "classify_backfill") {
    const { data, error } = await supabase.from(SESSIONS_TABLE).select(SESSION_COLUMNS).eq("id", action.sessionId).limit(1);
    if (error) throw new Error(`Session load failed for ${action.sessionId}: ${error.message}`);
    const session = (data ?? [])[0] as SessionRow | undefined;
    if (!session) throw new Error(`Session ${action.sessionId} vanished between plan and apply.`);

    // Reuses the exact production write path — the same function a live WhatsApp completion
    // calls today — so this backfill can never disagree with how a fresh answer is written.
    const wrote = await applyClassificationToCandidate(session);
    if (!wrote) {
      throw new Error(`applyClassificationToCandidate returned false for candidate ${action.candidateId} (session ${action.sessionId}).`);
    }
  } else {
    const { data, error } = await supabase.from(SESSIONS_TABLE).select(EXTRA_SESSION_COLUMNS).eq("id", action.sessionId).limit(1);
    if (error) throw new Error(`Session load failed for ${action.sessionId}: ${error.message}`);
    const session = (data ?? [])[0] as ExtraSessionRow | undefined;
    if (!session) throw new Error(`Session ${action.sessionId} vanished between plan and apply.`);
    const answers = session.extra_answers ?? {};
    if (Object.keys(answers).length === 0) throw new Error(`Session ${action.sessionId} no longer holds extra answers.`);

    // Same shape as finishExtraQuestionLoop's own write — a full JSON replace of the answers map.
    const { error: updateError } = await supabase
      .from("ats_candidates")
      .update({ screening_extra_answers: answers, updated_at: new Date().toISOString() })
      .eq("id", action.candidateId);
    if (updateError) throw new Error(`ats_candidates update failed for ${action.candidateId}: ${updateError.message}`);
  }

  const after = await loadCandidateSnapshot(supabase, action.candidateId);
  const changedFields = describeChangedFields(before, after);
  const note =
    changedFields.length > 0
      ? `WhatsApp classify backfill (ops:backfill-whatsapp-classify-gaps, fix ${FIX_COMMIT}): filled in ${changedFields.join(", ")} from session ${action.sessionId}.`
      : `WhatsApp classify backfill (ops:backfill-whatsapp-classify-gaps, fix ${FIX_COMMIT}): re-ran session ${action.sessionId}; nothing changed.`;
  await writeBackfillHistoryLine(supabase, action.candidateId, before.status, note);

  return { changedFields };
}

function summarize(plan: PlannedAction[], skipped: SkippedCandidate[]) {
  return {
    candidatesNeedingAction: plan.length,
    candidatesSkipped: skipped.length,
    byAction: {
      classify_backfill: plan.filter((action) => action.kind === "classify_backfill").length,
      extra_answers_backfill: plan.filter((action) => action.kind === "extra_answers_backfill").length,
    },
    skipped,
    targets: plan.map((action) => ({
      action: action.kind,
      candidateId: action.candidateId,
      candidateName: action.candidateName,
      sessionId: action.sessionId,
      waId: action.waId,
      ...(action.kind === "classify_backfill" ? { gaps: action.gaps } : {}),
    })),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  assertProductionTarget();
  requiredEnv("SUPABASE_SERVICE_ROLE_KEY");

  const supabase = getSupabaseAdmin({ requestTimeoutMs: 30000 });
  const { plan, skipped } = await buildPlan(supabase);
  const summary = summarize(plan, skipped);

  if (options.mode === "dry-run") {
    console.log(JSON.stringify({
      ...summary,
      mode: "dry-run",
      nextRequiredApproval:
        plan.length === 0
          ? "Nothing to do — every candidate linked to a completed WhatsApp session already matches it."
          : `Run with --apply --confirm-production=${plan.length} immediately after this dry-run, after explicit owner ` +
            `approval. The confirm token must equal the CURRENT plan size — if the count has changed by the time you ` +
            `apply, the script refuses to write rather than act on a stale plan.`,
      status: "dry_run_ok",
    }, null, 2));
    return;
  }

  if (plan.length === 0) {
    console.log(JSON.stringify({ ...summary, mode: "apply", results: [], status: "apply_ok_nothing_to_do" }, null, 2));
    return;
  }

  if (options.confirm !== String(plan.length)) {
    throw new Error(
      `Apply requires --confirm-production=${plan.length} (the plan size from THIS run, not an earlier one). ` +
      `Re-run the dry-run immediately before applying.`,
    );
  }

  // Each candidate is independent, so one candidate's failure must not abort the rest of a
  // data-recovery run — collected and reported, never silently swallowed.
  const results: Array<{
    action: string;
    candidateId: string;
    candidateName: string;
    sessionId: string;
    changedFields?: string[];
    error?: string;
    ok: boolean;
  }> = [];
  for (const action of plan) {
    try {
      const outcome = await applyAction(supabase, action);
      results.push({
        action: action.kind,
        candidateId: action.candidateId,
        candidateName: action.candidateName,
        changedFields: outcome.changedFields,
        ok: true,
        sessionId: action.sessionId,
      });
    } catch (error) {
      results.push({
        action: action.kind,
        candidateId: action.candidateId,
        candidateName: action.candidateName,
        error: error instanceof Error ? error.message : String(error),
        ok: false,
        sessionId: action.sessionId,
      });
    }
  }

  const failureCount = results.filter((result) => !result.ok).length;
  console.log(JSON.stringify({
    ...summary,
    failureCount,
    mode: "apply",
    results,
    status: failureCount > 0 ? "apply_completed_with_failures" : "apply_ok",
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

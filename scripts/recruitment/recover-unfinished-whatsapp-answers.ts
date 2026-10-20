// =============================================================================
// Recover the WhatsApp answers that never reached their candidate (owner, 2026-10-20)
// =============================================================================
// WHY. Until 20 Oct 2026 an applicant's answers reached the candidate only when the conversation
// FINISHED, and the intake backfill read only finished conversations. Everyone who stopped half-way —
// or whose CV was processed after their first taps — kept those answers in
// ats_whatsapp_classification_sessions and nowhere else (27 people on the day the rule changed). The
// code now saves every answer as it is given; this script carries the old ones across once.
//
// WHAT IT WRITES — BLANKS ONLY. For each conversation that holds answers, the candidate is found by the
// same three SAFE links the bot uses (src/lib/recruitment/inbound/whatsapp-session-link.ts: the bot's
// own link, the CV that opened the conversation, a number whose CVs all became one person). A number
// that sent CVs for several people links nobody, and that conversation is listed, not applied.
// Then, per candidate, only an answer the candidate does NOT hold yet is written:
//   * one of the six, when its column is blank and HR has not typed it ("added by HR" mark);
//   * an extra answer, when that key is absent and HR has not typed it.
// A value already on the candidate is never overwritten — not by an older conversation, not by a
// newer one. When one person has several conversations the newest fills first, the older ones only
// what is still blank. The conversation is linked to the person (`applied_candidate_id`) so any
// answer it receives later follows them, and the stored completeness is recomputed.
//
// Filing in the workspace tabs is NOT done here: run scripts/recruitment/place-existing-candidates.ts
// after this one, so every person is filed from their final answers in one pass.
//
// Usage (from the primary checkout; the dry run writes nothing but the pre-image workbook in xlsx/):
//   node --env-file-if-exists=.env.local --experimental-strip-types --experimental-specifier-resolution=node \
//     --experimental-loader ./scripts/alias-loader.mjs scripts/recruitment/recover-unfinished-whatsapp-answers.ts
// Apply (production only; N is the plan size the dry run just printed):
//   ... scripts/recruitment/recover-unfinished-whatsapp-answers.ts --apply --confirm-production=<N>
// Idempotent: a second run finds nothing left to fill.
// =============================================================================

import { recruitmentDb } from "@/lib/recruitment/db";
import { classificationPayload, sessionAreaLabel, sessionBackgroundLabel, sessionExperienceLabel, sessionRoleLabel } from "@/lib/recruitment/inbound/whatsapp-classify-session";
import type { SessionRow } from "@/lib/recruitment/inbound/whatsapp-classify-session-row";
import { mergeExtraAnswers } from "@/lib/recruitment/inbound/whatsapp-answer-sync";
import type { BuiltInQuestionKey } from "@/lib/recruitment/inbound/whatsapp-question-audience";
import { EXTRA_SESSION_COLUMNS, type ExtraSessionRow } from "@/lib/recruitment/inbound/whatsapp-screening-questions-session";
import { linkSessionsToCandidates, readEveryPage } from "@/lib/recruitment/inbound/whatsapp-session-link";
import { BUILT_IN_ANSWER_KEYS, recomputeCompleteness } from "@/lib/recruitment/workspace/completeness";

import { refuseUnknownFlags } from "../lib/refuse-arguments.mjs";
import {
  assertConfirmed,
  assertProductionTarget,
  cairoTime,
  isBlank,
  parseScriptOptions,
  writePreImage,
} from "./lib/script-kit.ts";

refuseUnknownFlags({
  name: "recover-unfinished-whatsapp-answers",
  entry: import.meta.url,
  known: ["--apply", "--dry-run", "--confirm-production"],
});

const SESSIONS_TABLE = "ats_whatsapp_classification_sessions";

type SessionWithTimes = ExtraSessionRow & { updated_at: string | null; completed_at: string | null; applied_at: string | null };

type CandidateRow = {
  id: string;
  full_name: string | null;
  declared_role_family: string | null;
  applied_for_job_title: string | null;
  declared_background: string | null;
  preferred_region_code: string | null;
  preferred_region_name: string | null;
  preferred_area_name: string | null;
  declared_experience: string | null;
  declared_expected_salary: string | null;
  expected_salary: number | null;
  preferences_declared_at: string | null;
  screening_extra_answers: Record<string, unknown> | null;
  answer_marks: Record<string, unknown> | null;
};

const CANDIDATE_COLUMNS =
  "id,full_name,declared_role_family,applied_for_job_title,declared_background,preferred_region_code,preferred_region_name,preferred_area_name,declared_experience,declared_expected_salary,expected_salary,preferences_declared_at,screening_extra_answers,answer_marks";

/** Whether the candidate still lacks this one of the six. */
function candidateLacks(candidate: CandidateRow, key: BuiltInQuestionKey): boolean {
  switch (key) {
    case "job_title":
      return isBlank(candidate.declared_role_family);
    case "background":
      return isBlank(candidate.declared_background);
    case "region":
      return isBlank(candidate.preferred_region_code) && isBlank(candidate.preferred_region_name);
    case "area":
      return isBlank(candidate.preferred_area_name);
    case "experience":
      return isBlank(candidate.declared_experience);
    case "salary":
      return isBlank(candidate.declared_expected_salary);
  }
}

/** The one of the six this conversation answered, as the words a person reads. */
function sessionAnswerText(session: SessionRow, key: BuiltInQuestionKey): string | null {
  switch (key) {
    case "job_title":
      return sessionRoleLabel(session);
    case "background":
      return sessionBackgroundLabel(session);
    case "region":
      return session.region_code ?? session.region_other_text ?? null;
    case "area":
      return sessionAreaLabel(session);
    case "experience":
      return sessionExperienceLabel(session);
    case "salary":
      return session.expected_salary;
  }
}

const BUILT_IN_KEYS: readonly BuiltInQuestionKey[] = ["job_title", "background", "region", "area", "experience", "salary"];

type PlanItem = {
  candidate: CandidateRow;
  session: SessionWithTimes;
  builtIns: BuiltInQuestionKey[];
  extras: Record<string, string>;
};

async function main() {
  const options = parseScriptOptions(process.argv.slice(2));
  assertProductionTarget();
  const db = recruitmentDb();

  // Every conversation that holds at least one answer.
  const sessions = (
    await readEveryPage<SessionWithTimes>("WhatsApp conversations", (from, to) =>
      db
        .from(SESSIONS_TABLE)
        .select(`${EXTRA_SESSION_COLUMNS},updated_at,completed_at,applied_at`)
        .order("id", { ascending: true })
        .range(from, to),
    )
  ).filter((row) => Boolean(row.job_title_family) || Object.keys(row.extra_answers ?? {}).length > 0);

  const links = await linkSessionsToCandidates(sessions);
  const unlinked = sessions.filter((row) => !links.has(row.id));
  const candidateIds = Array.from(new Set(links.values()));

  const candidates = new Map<string, CandidateRow>();
  for (let index = 0; index < candidateIds.length; index += 100) {
    const { data, error } = await db.from("ats_candidates").select(CANDIDATE_COLUMNS).in("id", candidateIds.slice(index, index + 100));
    if (error) throw error;
    for (const row of (data ?? []) as unknown as CandidateRow[]) candidates.set(row.id, row);
  }

  // Newest conversation first; an older one fills only what is still blank.
  const ordered = sessions
    .filter((row) => links.has(row.id))
    .sort((a, b) => Date.parse(b.updated_at ?? "") - Date.parse(a.updated_at ?? ""));
  const claimed = new Map<string, Set<string>>();
  const plan: PlanItem[] = [];
  for (const session of ordered) {
    const candidate = candidates.get(links.get(session.id) as string);
    if (!candidate) continue;
    const marks = candidate.answer_marks ?? {};
    const taken = claimed.get(candidate.id) ?? new Set<string>();
    const builtIns = BUILT_IN_KEYS.filter(
      (key) =>
        !taken.has(key) &&
        !(BUILT_IN_ANSWER_KEYS[key] in marks) &&
        candidateLacks(candidate, key) &&
        !isBlank(sessionAnswerText(session, key)),
    );
    const held = candidate.screening_extra_answers ?? {};
    const extras: Record<string, string> = {};
    for (const [key, value] of Object.entries(session.extra_answers ?? {})) {
      if (taken.has(`extra:${key}`) || key in marks || !isBlank(held[key]) || isBlank(value)) continue;
      extras[key] = String(value).trim();
    }
    if (builtIns.length === 0 && Object.keys(extras).length === 0) continue;
    for (const key of builtIns) taken.add(key);
    for (const key of Object.keys(extras)) taken.add(`extra:${key}`);
    claimed.set(candidate.id, taken);
    plan.push({ builtIns, candidate, extras, session });
  }

  const preImage = await writePreImage("recover-unfinished-whatsapp-answers", options.mode, [
    {
      columns: [
        { header: "Candidate", key: "candidate", width: 28 },
        { header: "Answer", key: "answer", width: 26 },
        { header: "On the candidate now", key: "before", width: 26 },
        { header: "Will be", key: "after", width: 36 },
        { header: "Conversation last active (Cairo)", key: "when", width: 24 },
        { header: "Conversation finished", key: "finished", width: 12 },
      ],
      name: "Answers to fill",
      rows: plan.flatMap((item) => [
        ...item.builtIns.map((key) => ({
          after: sessionAnswerText(item.session, key),
          answer: key === "job_title" ? "Role" : key[0].toUpperCase() + key.slice(1),
          before: "(blank)",
          candidate: item.candidate.full_name ?? "(no name)",
          finished: item.session.completed_at ? "Yes" : "No",
          when: cairoTime(item.session.updated_at),
        })),
        ...Object.entries(item.extras).map(([key, value]) => ({
          after: value,
          answer: key,
          before: "(blank)",
          candidate: item.candidate.full_name ?? "(no name)",
          finished: item.session.completed_at ? "Yes" : "No",
          when: cairoTime(item.session.updated_at),
        })),
      ]),
    },
    {
      columns: [
        { header: "WhatsApp number", key: "number", width: 18 },
        { header: "Role tapped", key: "role", width: 24 },
        { header: "Answers held", key: "answers", width: 14 },
        { header: "Last active (Cairo)", key: "when", width: 24 },
        { header: "Why not applied", key: "why", width: 60 },
      ],
      name: "Not linked to anyone",
      rows: unlinked.map((row) => ({
        answers: BUILT_IN_KEYS.filter((key) => !isBlank(sessionAnswerText(row, key))).length + Object.keys(row.extra_answers ?? {}).length,
        number: `+${row.wa_id}`,
        role: sessionRoleLabel(row) ?? "",
        when: cairoTime(row.updated_at),
        why: "No safe link: no candidate from this conversation's CV, and the number's CVs became several people or none.",
      })),
    },
  ]);

  const summary = {
    candidatesToFill: new Set(plan.map((item) => item.candidate.id)).size,
    conversationsWithAnswers: sessions.length,
    notLinked: unlinked.length,
    planSize: plan.length,
    preImage,
  };

  if (options.mode === "dry-run") {
    console.log(JSON.stringify({ ...summary, mode: "dry-run", status: "dry_run_ok" }, null, 2));
    return;
  }
  if (plan.length === 0) {
    console.log(JSON.stringify({ ...summary, mode: "apply", status: "apply_ok_nothing_to_do" }, null, 2));
    return;
  }
  assertConfirmed(options, plan.length);

  const results: { candidate: string; ok: boolean; filled: string[]; error?: string }[] = [];
  for (const item of plan) {
    const filled = [...item.builtIns.map((key) => BUILT_IN_ANSWER_KEYS[key]), ...Object.keys(item.extras)];
    try {
      if (item.builtIns.length > 0) {
        const payload = classificationPayload(item.session, item.builtIns);
        // Blanks only: a column the candidate already holds is taken out of the write.
        if (!isBlank(item.candidate.applied_for_job_title)) delete payload.applied_for_job_title;
        if (item.candidate.expected_salary !== null) delete payload.expected_salary;
        if (!isBlank(item.candidate.preferences_declared_at)) delete payload.preferences_declared_at;
        const { error } = await db.from("ats_candidates").update(payload).eq("id", item.candidate.id);
        if (error) throw error;
      }
      if (Object.keys(item.extras).length > 0) {
        await mergeExtraAnswers(item.candidate.id, item.extras, { keepHrAnswers: true });
      }
      if (!item.session.applied_candidate_id) {
        const { error } = await db.from(SESSIONS_TABLE).update({ applied_candidate_id: item.candidate.id }).eq("id", item.session.id);
        if (error) throw error;
      }
      results.push({ candidate: item.candidate.full_name ?? item.candidate.id, filled, ok: true });
    } catch (error) {
      results.push({
        candidate: item.candidate.full_name ?? item.candidate.id,
        error: error instanceof Error ? error.message : String(error),
        filled,
        ok: false,
      });
    }
  }
  await recomputeCompleteness(Array.from(new Set(plan.map((item) => item.candidate.id))));

  const failures = results.filter((result) => !result.ok).length;
  console.log(
    JSON.stringify(
      { ...summary, failures, mode: "apply", results, status: failures > 0 ? "apply_completed_with_failures" : "apply_ok" },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

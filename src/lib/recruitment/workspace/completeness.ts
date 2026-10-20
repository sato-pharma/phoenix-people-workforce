// Recruitment workspace — how many of the questions a candidate should have answered they did, stored
// on the candidate (`answers_expected`, `answers_given`, `missing_answer_keys`) so the "Missing data"
// filter, its count and the "5 of 6 answered" mark all read ONE column and never two calculations.
//
// WHAT "EXPECTED" MEANS. Exactly the questions the bot would ask THIS applicant, by the same rules the
// bot runs: the six built-ins through their saved audiences (`resolveBuiltInAudience`, so the area
// question is a Medical Rep's only, unless the owner widened it), then the role's ACTIVE extra
// questions (`questionsForRole`) in the live order, a conditional one counted only when the answers
// so far call for it (`questionIsVisible`), and nothing after an answer that ended the conversation
// (`endOn`) — those were never asked, so they are not missing.
//
// A candidate whose role is not known (an emailed CV, an applicant who never tapped a role) is
// computed with no role, as the bot would treat them: the role itself is missing, and only the
// questions asked of everyone are expected. That is what lets "Ask again" reach them.
//
// Written on every answer save and recomputed when the question set changes. Never throws into a
// caller: a failed recompute leaves the old numbers and is logged.

import { logError } from "@/lib/observability/log";
import { recruitmentDb } from "@/lib/recruitment/db";
import {
  audienceAppliesToRole,
  builtInQuestionKeys,
  resolveBuiltInAudience,
  type BuiltInQuestionKey,
  type SavedAudiences,
} from "@/lib/recruitment/inbound/whatsapp-question-audience";
import {
  questionIsVisible,
  questionsForRole,
  type ScreeningQuestion,
} from "@/lib/recruitment/inbound/whatsapp-screening-questions";
import { listPlacementsFor } from "@/lib/recruitment/workspace/placements-db";

const ID_BATCH = 100;

/** The workspace's answer keys for the six built-ins: `job_title` is shown as `role`. */
export const BUILT_IN_ANSWER_KEYS: Readonly<Record<BuiltInQuestionKey, string>> = {
  area: "area",
  background: "background",
  experience: "experience",
  job_title: "role",
  region: "region",
  salary: "salary",
};

/** The answers on one candidate, as completeness reads them. */
export type CompletenessAnswers = {
  /** The role family they tapped (`declared_role_family`), else the one a placement carries. */
  roleFamily: string | null;
  /** Whether each built-in has an answer on the record. */
  builtIns: Readonly<Record<BuiltInQuestionKey, boolean>>;
  /** The extra answers by question key, as stored (the option TITLE for a tapped answer). */
  extras: Readonly<Record<string, string>>;
};

export type Completeness = { expected: number; given: number; missingKeys: string[] };

function hasText(value: unknown): boolean {
  return typeof value === "string" ? value.trim().length > 0 : value !== null && value !== undefined;
}

/** True when this tapped answer is one of the values that ends the conversation. */
function answerEnds(question: ScreeningQuestion, given: string): boolean {
  const endOn = question.endOn;
  if (!endOn || endOn.values.length === 0 || !endOn.message.trim()) return false;
  const option = (question.options ?? []).find((candidate) => candidate.title === given);
  return option ? endOn.values.includes(option.value) : false;
}

/**
 * Pure: what this candidate was expected to answer and what they did. `questions` is the whole live
 * list (active or not, in sort order); only the active ones for the role are counted.
 */
export function computeCompleteness(input: {
  answers: CompletenessAnswers;
  audiences: SavedAudiences;
  questions: readonly ScreeningQuestion[];
}): Completeness {
  const { answers, audiences } = input;
  const role = answers.roleFamily;
  let expected = 0;
  let given = 0;
  const missingKeys: string[] = [];

  for (const key of builtInQuestionKeys) {
    // The role question is asked of everyone, and its audience cannot be narrowed.
    const applies = key === "job_title" || audienceAppliesToRole(resolveBuiltInAudience(key, audiences.get(key)), role);
    if (!applies) continue;
    expected += 1;
    if (answers.builtIns[key]) given += 1;
    else missingKeys.push(BUILT_IN_ANSWER_KEYS[key]);
  }

  const active = questionsForRole(
    input.questions.filter((question) => question.isActive),
    role,
  );
  const soFar: Record<string, string> = {};
  for (const question of active) {
    if (!questionIsVisible(question, soFar, active)) continue;
    expected += 1;
    const answer = answers.extras[question.questionKey];
    if (hasText(answer)) {
      given += 1;
      soFar[question.questionKey] = String(answer);
      // Nothing after an answer that ended the conversation was ever asked.
      if (answerEnds(question, String(answer))) break;
    } else {
      missingKeys.push(question.questionKey);
    }
  }

  return { expected, given, missingKeys };
}

// ── The database half ─────────────────────────────────────────────────────────────────────────

type CandidateAnswerRow = {
  id: string;
  declared_role_family: string | null;
  declared_background: string | null;
  preferred_region_code: string | null;
  preferred_region_name: string | null;
  preferred_area_name: string | null;
  declared_experience: string | null;
  declared_expected_salary: string | null;
  screening_extra_answers: Record<string, unknown> | null;
  answers_expected: number | null;
  answers_given: number | null;
  missing_answer_keys: string[] | null;
};

const CANDIDATE_COLUMNS =
  "id,declared_role_family,declared_background,preferred_region_code,preferred_region_name,preferred_area_name,declared_experience,declared_expected_salary,screening_extra_answers,answers_expected,answers_given,missing_answer_keys";

/** One candidate row as completeness reads it. `placementFamily` is the role a placement carries. */
export function answersFromRow(row: CandidateAnswerRow, placementFamily: string | null): CompletenessAnswers {
  const extras: Record<string, string> = {};
  for (const [key, value] of Object.entries(row.screening_extra_answers ?? {})) {
    if (typeof value === "string" && value.trim()) extras[key] = value;
  }
  const roleFamily = row.declared_role_family?.trim() || placementFamily || null;
  return {
    builtIns: {
      area: hasText(row.preferred_area_name),
      background: hasText(row.declared_background),
      experience: hasText(row.declared_experience),
      job_title: Boolean(roleFamily),
      region: hasText(row.preferred_region_code) || hasText(row.preferred_region_name),
      // The applicant's own words only, exactly as the chip reads them. Both intakes write the words
      // whenever they write the figure, so a figure with no words came from the CV or a form, and a
      // CV reading never counts as an answer (owner, 2026-10-20).
      salary: hasText(row.declared_expected_salary),
    },
    extras,
    roleFamily,
  };
}

function sameKeys(a: readonly string[] | null, b: readonly string[]): boolean {
  if (!a || a.length !== b.length) return false;
  return a.every((key, index) => key === b[index]);
}

async function loadRules(): Promise<{ audiences: SavedAudiences; questions: ScreeningQuestion[] }> {
  // Imported lazily: the session files import this one, and a module cycle at load time would leave
  // one side reading `undefined`.
  const [{ loadSavedAudiences }, { loadAllQuestions }] = await Promise.all([
    import("@/lib/recruitment/inbound/whatsapp-classify-session"),
    import("@/lib/recruitment/inbound/whatsapp-screening-questions-session"),
  ]);
  const [audiences, questions] = await Promise.all([loadSavedAudiences(), loadAllQuestions()]);
  return { audiences, questions };
}

/**
 * Recomputes and stores completeness for these candidates. Rows whose numbers did not change are not
 * written; rows that did are written in one update per identical result. Never throws.
 */
export async function recomputeCompleteness(candidateIds: string[]): Promise<void> {
  const ids = Array.from(new Set(candidateIds.filter((id) => typeof id === "string" && id.length > 0)));
  if (ids.length === 0) return;
  try {
    const rules = await loadRules();
    const db = recruitmentDb();
    for (let start = 0; start < ids.length; start += ID_BATCH) {
      const batch = ids.slice(start, start + ID_BATCH);
      const { data, error } = await db.from("ats_candidates").select(CANDIDATE_COLUMNS).in("id", batch);
      if (error) throw error;
      const rows = (data ?? []) as CandidateAnswerRow[];
      const placements = await listPlacementsFor(rows.filter((row) => !row.declared_role_family).map((row) => row.id));

      const groups = new Map<string, { result: Completeness; ids: string[] }>();
      for (const row of rows) {
        const placementFamily = (placements.get(row.id) ?? []).find((placement) => placement.botRoleFamily)?.botRoleFamily ?? null;
        const result = computeCompleteness({ ...rules, answers: answersFromRow(row, placementFamily) });
        if (
          row.answers_expected === result.expected &&
          row.answers_given === result.given &&
          sameKeys(row.missing_answer_keys, result.missingKeys)
        ) {
          continue;
        }
        const tuple = `${result.expected}|${result.given}|${result.missingKeys.join("\u0001")}`;
        const group = groups.get(tuple);
        if (group) group.ids.push(row.id);
        else groups.set(tuple, { ids: [row.id], result });
      }

      for (const { result, ids: groupIds } of groups.values()) {
        const { error: writeError } = await db
          .from("ats_candidates")
          .update({
            answers_expected: result.expected,
            answers_given: result.given,
            missing_answer_keys: result.missingKeys,
          })
          .in("id", groupIds);
        if (writeError) throw writeError;
      }
    }
  } catch (error) {
    logError("Recruitment answer completeness could not be recomputed", {
      error,
      labels: { event: "recruitment_completeness_recompute_failed" },
    });
  }
}

/**
 * Recomputes every candidate a change to the question set can touch: those whose role is one of
 * these families (and those with no tapped role, whose family comes from the tab they are filed in),
 * or everyone when `families` is null (a question asked of everyone changed).
 * Pages through the table; the pool is a few hundred people.
 */
export async function recomputeCompletenessForRoles(families: readonly string[] | null): Promise<number> {
  const db = recruitmentDb();
  const pageSize = 500;
  let touched = 0;
  for (let from = 0; ; from += pageSize) {
    let query = db.from("ats_candidates").select("id").order("id", { ascending: true }).range(from, from + pageSize - 1);
    // A person with no tapped role takes the family of the tab they are filed in, so they are read too.
    if (families && families.length > 0) {
      const codes = families.filter((family) => /^[a-z0-9_]+$/.test(family));
      query = query.or(`declared_role_family.is.null,declared_role_family.in.(${codes.join(",")})`);
    }
    const { data, error } = await query;
    if (error) throw error;
    const ids = ((data ?? []) as Array<{ id: string }>).map((row) => row.id);
    if (ids.length === 0) break;
    await recomputeCompleteness(ids);
    touched += ids.length;
    if (ids.length < pageSize) break;
  }
  return touched;
}

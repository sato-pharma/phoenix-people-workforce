// Recruitment / ATS — admin CRUD for the Super-Admin-defined extra WhatsApp screening questions
// (whatsapp-screening-questions.ts / whatsapp-screening-questions-session.ts).
//
// The gate for every screen and route in this family now lives HERE, as
// assertScreeningQuestionsAccess below, so the page and its two save routes cannot drift apart.
//
// Named apart from the pre-existing screening.ts / screening-filter.ts / candidate-screening-facts.ts
// family on purpose — those are the CV review queue, a different thing entirely, and sharing the name
// would be actively confusing in file search and the sidebar.

import { assertPermission, canAccess, type AccessContext } from "@/lib/auth/permissions";
import { recruitmentDb } from "@/lib/recruitment/db";
import { invalidateScreeningQuestionCache } from "@/lib/recruitment/inbound/whatsapp-screening-questions-session";
import {
  screeningQuestionViolations,
  type ScreeningQuestion,
  type ScreeningQuestionKind,
  type ScreeningQuestionOption,
} from "@/lib/recruitment/inbound/whatsapp-screening-questions";

/**
 * WHO MAY EDIT THE WHATSAPP SCREENING QUESTIONS.
 *
 * Was `admin:update` — the Super Admin alone. The owner asked on 2026-09-01 for this screen to
 * reach the HR Business Partner, and `admin:update` was the wrong door to widen: it also gates
 * module locks, scope visibility, salary flags, the email-notification configuration and a
 * notification TEST-SEND endpoint (17 assertions in all), and firing a test email is a standing
 * prohibition in this repo. So the PAGE was re-gated instead of the RESOURCE being widened.
 *
 * `recruitment:update` is the honest description of the act: these are the questions an applicant
 * is asked on WhatsApp, and running the intake is the recruiting function. Anyone who held the
 * screen before still holds it — the admin assertion is the fallback, unchanged, and it is what
 * produces the refusal (and its message) for everyone else.
 *
 * Exported and called by the page AND both save routes. A page that renders the builder and then
 * fails on save is worse than one that never renders it, which is why all three call this and not
 * a copy of it.
 */
export async function assertScreeningQuestionsAccess(access: AccessContext): Promise<void> {
  if (await canAccess(access, "recruitment", "update")) return;
  await assertPermission(access, "admin", "update");
}

const QUESTIONS_TABLE = "ats_whatsapp_screening_questions";

export type ScreeningQuestionAdminRow = ScreeningQuestion & {
  /** True once any candidate has answered this question — active or not. Drives the delete guard:
   *  both here (server-side, authoritative) and again in the UI (hides the Delete button), because a
   *  hidden button is not the same thing as an enforced rule. */
  hasAnswers: boolean;
};

/** One row of the admin's whole-array save. `id: null` means "create". `questionKey` is intentionally
 *  absent — it is generated once, server-side, for a new row, and is immutable thereafter. */
export type ScreeningQuestionDraft = {
  id: string | null;
  bodyText: string;
  kind: ScreeningQuestionKind;
  options: ScreeningQuestionOption[] | null;
  isActive: boolean;
  /** Null (or absent, from a client that predates scoping) means ask everyone — see the column
   *  comment on the migration. A non-empty array narrows the question to those role families. */
  appliesToRoleFamilies?: string[] | null;
};

type QuestionDbRow = {
  id: string;
  question_key: string;
  body_text: string;
  kind: ScreeningQuestionKind;
  options: ScreeningQuestionOption[] | null;
  sort_order: number;
  is_active: boolean;
  applies_to_role_families: string[] | null;
};

function mapQuestionRow(row: QuestionDbRow): ScreeningQuestion {
  return {
    appliesToRoleFamilies: row.applies_to_role_families,
    bodyText: row.body_text,
    id: row.id,
    isActive: row.is_active,
    kind: row.kind,
    options: row.options,
    questionKey: row.question_key,
    sortOrder: row.sort_order,
  };
}

/**
 * Whether any candidate has recorded an answer for this key. One query per question rather than a
 * single clever aggregate — this repo has been bitten more than once by a jsonb comparison operator
 * that silently matches nothing (see AGENTS.md's postgrest jsonb hooks), and the admin screen carries
 * at most a handful of questions, so N simple queries costs nothing a human would notice.
 */
async function countAnswers(questionKey: string): Promise<number> {
  const supabase = recruitmentDb();
  const { count, error } = await supabase
    .from("ats_candidates")
    .select("id", { count: "exact", head: true })
    .not(`screening_extra_answers->>${questionKey}`, "is", null);
  if (error) throw error;
  return count ?? 0;
}

/** Every question, active and inactive — inactive ones stay listed so they can be reactivated,
 *  reordered, or (if never answered) deleted outright. */
export async function listScreeningQuestions(): Promise<ScreeningQuestionAdminRow[]> {
  const supabase = recruitmentDb();
  const { data, error } = await supabase
    .from(QUESTIONS_TABLE)
    .select("id,question_key,body_text,kind,options,sort_order,is_active,applies_to_role_families")
    .order("sort_order", { ascending: true });
  if (error) throw error;

  const rows = ((data ?? []) as QuestionDbRow[]).map(mapQuestionRow);
  return Promise.all(
    rows.map(async (row) => ({ ...row, hasAnswers: (await countAnswers(row.questionKey)) > 0 })),
  );
}

/** Exported for direct unit testing (whatsapp-screening-questions-admin.test.ts) — pure, no DB. */
export function slugifyQuestionKey(bodyText: string): string {
  const slug = bodyText
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 50);
  const withLetterStart = /^[a-z]/.test(slug) ? slug : `q_${slug}`;
  return withLetterStart.replace(/^_+/, "q_") || "question";
}

/** Appends `_2`, `_3`, ... until the key is free — against both what is already in the database and
 *  what this same save batch has already claimed. */
/** Exported for direct unit testing (whatsapp-screening-questions-admin.test.ts) — pure, no DB. */
export function disambiguateQuestionKey(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  let suffix = 2;
  let attempt = `${base}_${suffix}`;
  while (taken.has(attempt)) {
    suffix += 1;
    attempt = `${base}_${suffix}`;
  }
  return attempt;
}

export type SaveScreeningQuestionSetResult = { questions: ScreeningQuestionAdminRow[] };

/**
 * Upserts the admin's whole ordered array. Deliberately never deletes a row simply missing from the
 * array — a delete-all-reinsert on every save would risk destroying an already-answered question the
 * moment any client's copy of the array goes stale. Use deleteScreeningQuestion for an explicit,
 * individually-guarded delete instead.
 *
 * `sort_order` is recomputed from array position here, never trusted from the client. Every row is
 * validated (screeningQuestionViolations, the same check the chatbot's own send path runs) BEFORE
 * anything is written, so a save either fully succeeds or changes nothing.
 */
export async function saveScreeningQuestionSet(input: {
  questions: readonly ScreeningQuestionDraft[];
  actorHrId: string | null;
}): Promise<SaveScreeningQuestionSetResult> {
  const supabase = recruitmentDb();

  const { data: existingRows, error: existingError } = await supabase
    .from(QUESTIONS_TABLE)
    .select("id,question_key");
  if (existingError) throw existingError;

  const existingKeyById = new Map<string, string>();
  const takenKeys = new Set<string>();
  for (const row of (existingRows ?? []) as { id: string; question_key: string }[]) {
    existingKeyById.set(row.id, row.question_key);
    takenKeys.add(row.question_key);
  }

  // Resolve every row's key BEFORE validating, so validation checks exactly what will be written —
  // a new row's freshly generated key included, never a placeholder.
  // An EMPTY scope array is normalised to null here, once, before anything reads it. Both meanings
  // arrive from real clients — absent from one that predates scoping, empty from this screen when the
  // admin ticks nothing — and both mean "ask everyone". Doing it here rather than at each use is what
  // keeps the validator and the payload below reading the same value; the database refuses a stored
  // empty array outright, because an empty scope reads as "ask nobody" and would silently retire a
  // question that still shows as active.
  const resolved = input.questions.map((draft) => {
    const appliesToRoleFamilies =
      draft.appliesToRoleFamilies && draft.appliesToRoleFamilies.length > 0 ? draft.appliesToRoleFamilies : null;
    if (draft.id) {
      const questionKey = existingKeyById.get(draft.id);
      if (!questionKey) throw new Error("One of these questions no longer exists — reload and try again.");
      return { ...draft, appliesToRoleFamilies, questionKey };
    }
    const questionKey = disambiguateQuestionKey(slugifyQuestionKey(draft.bodyText), takenKeys);
    takenKeys.add(questionKey);
    return { ...draft, appliesToRoleFamilies, questionKey };
  });

  // screeningQuestionViolations checks question-key format for every row, new or existing — no
  // separate pass needed here.
  const problems = resolved.flatMap((question) => screeningQuestionViolations(question));
  if (problems.length > 0) throw new Error(problems.join("; "));

  const nowIso = new Date().toISOString();
  for (const [index, question] of resolved.entries()) {
    const payload = {
      applies_to_role_families: question.appliesToRoleFamilies,
      body_text: question.bodyText,
      is_active: question.isActive,
      kind: question.kind,
      options: question.kind === "tappable" ? question.options : null,
      sort_order: index + 1,
      updated_at: nowIso,
      updated_by_hr_id: input.actorHrId,
    };
    if (question.id) {
      const { error } = await supabase.from(QUESTIONS_TABLE).update(payload).eq("id", question.id);
      if (error) throw error;
    } else {
      const { error } = await supabase.from(QUESTIONS_TABLE).insert({
        ...payload,
        created_by_hr_id: input.actorHrId,
        question_key: question.questionKey,
      });
      if (error) throw error;
    }
  }

  invalidateScreeningQuestionCache();
  return { questions: await listScreeningQuestions() };
}

/**
 * Hard-deletes a question — only when nobody has ever answered it. Otherwise throws with a message
 * the admin screen can show verbatim: deactivate instead. The UI hides the Delete button on an
 * already-answered question, but this check is independent of that and re-runs regardless, because a
 * hidden button is never proof of server-side state at request time.
 */
export async function deleteScreeningQuestion(input: { id: string }): Promise<void> {
  const supabase = recruitmentDb();
  const { data, error } = await supabase
    .from(QUESTIONS_TABLE)
    .select("question_key")
    .eq("id", input.id)
    .maybeSingle();
  if (error) throw error;
  if (!data) return; // Already gone — deleting twice is not an error.

  const questionKey = String((data as { question_key: string }).question_key);
  if ((await countAnswers(questionKey)) > 0) {
    throw new Error("This question already has answers on file — deactivate it instead of deleting it.");
  }

  const { error: deleteError } = await supabase.from(QUESTIONS_TABLE).delete().eq("id", input.id);
  if (deleteError) throw deleteError;
  invalidateScreeningQuestionCache();
}

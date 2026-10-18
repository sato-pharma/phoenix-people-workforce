// Recruitment / ATS — the wording of every admin-defined WhatsApp screening question, for the screens
// that print a candidate's answers back (whatsapp-answers.ts).
//
// Its own small module rather than an export of whatsapp-screening-questions-session.ts, which holds
// the same rows behind a cache: that module imports the whole WhatsApp webhook state machine, and the
// candidate profile route — the one every screening screen loads a CV through — must not start
// depending on it for six rows of text.

import { recruitmentDb } from "@/lib/recruitment/db";
import type { ScreeningQuestionLabel } from "@/lib/recruitment/whatsapp-answers";

/**
 * Every question, ACTIVE AND RETIRED, in the admin's own order.
 *
 * Retired ones are included on purpose: an applicant who answered a question that has since been
 * switched off still gave that answer, and a screener needs the question it answers. Uncached — it is
 * a handful of rows, and a cache here would keep printing an admin's old wording after he saved new.
 */
export async function listScreeningQuestionLabels(): Promise<ScreeningQuestionLabel[]> {
  const { data, error } = await recruitmentDb()
    .from("ats_whatsapp_screening_questions")
    .select("question_key,body_text,applies_to_role_families,is_active")
    .order("sort_order", { ascending: true });
  if (error) throw error;
  type Row = { question_key: string; body_text: string; applies_to_role_families: string[] | null; is_active: boolean | null };
  return ((data ?? []) as Row[]).map((row) => ({
    appliesToRoleFamilies: Array.isArray(row.applies_to_role_families) ? row.applies_to_role_families : null,
    bodyText: String(row.body_text ?? ""),
    isActive: row.is_active !== false,
    questionKey: String(row.question_key ?? ""),
  }));
}

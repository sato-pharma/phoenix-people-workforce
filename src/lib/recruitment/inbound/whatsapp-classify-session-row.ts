// Recruitment / ATS — the shape of one row in ats_whatsapp_classification_sessions.
//
// Split out of whatsapp-classify-session.ts on purpose: that file and whatsapp-screening-questions-
// session.ts import from each other (the extra-question loop calls back into finishSession /
// findCandidateForSender / isWhatsAppClassifyEnabled), and SessionRow/SESSION_COLUMNS were the two
// symbols the extra-question side needed from the classify side. A `function` declaration survives a
// circular import fine — it's hoisted before either module's top-level code runs — but SESSION_COLUMNS
// is a `const`, and reading a `const` from a module that is still mid-initialization throws
// "Cannot access '<name>' before initialization" (the TDZ). This file has zero dependency on either
// side of that cycle, so both can import these two symbols from here without re-introducing it.

export type SessionRow = {
  id: string;
  wa_id: string;
  phone_number_id: string | null;
  step: string;
  job_title_family: string | null;
  /** What they typed after choosing "Other". Null for every other answer. */
  job_title_other_text: string | null;
  /** Graduation background CODE (pharmacy/science/vet), or "other" when they typed their own. */
  background: string | null;
  /** What they typed after choosing "Other" on the background question. Null otherwise. */
  background_other_text: string | null;
  region_code: string | null;
  /** What they typed after choosing "my region is not listed". Null otherwise. */
  region_other_text: string | null;
  area_name: string | null;
  /** What they typed after choosing "my area is not listed", or when the region had no areas. */
  area_other_text: string | null;
  /** Years-of-experience CODE (fresh/lt_1/1_3/3_5/gt_5). No "Other" — the bands are exhaustive. */
  experience: string | null;
  /** Expected monthly salary, VERBATIM as the applicant typed it. Never coerced to a number. */
  expected_salary: string | null;
  last_prompt_wamid: string | null;
  applied_candidate_id: string | null;
  /**
   * The CV that opened (or last re-opened) the conversation. Read so the bot can find whose answers
   * these are by the CV, not by the number (whatsapp-session-link.ts, rule 2). Optional because rows
   * built by hand in the tests predate it.
   */
  cv_wamid?: string | null;
};

export const SESSION_COLUMNS =
  "id,wa_id,phone_number_id,step,job_title_family,job_title_other_text,background,background_other_text,region_code,region_other_text,area_name,area_other_text,experience,expected_salary,last_prompt_wamid,applied_candidate_id,cv_wamid";

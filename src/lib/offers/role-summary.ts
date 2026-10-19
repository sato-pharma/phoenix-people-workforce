/**
 * The paragraph of an offer letter that describes the JOB, and why it belongs to the job title
 * rather than to the letter design.
 *
 * ── THE DEFECT THIS FIXES ──
 * Until now that paragraph was typed into the designs themselves. Three of the four shipped
 * letters — the classic, the executive and the HR-forms one that production sends by default —
 * carried this sentence, verbatim, for every position in the company:
 *
 *   "…you demonstrated the commercial judgement and the people leadership this district needs …
 *    you will be fully accountable for the territory's sales performance — translating commercial
 *    strategy into an executable district plan, leading and developing your field team…"
 *
 * It was transcribed from one signed letter (Dr Samaa Shalaby, DSM Delta 3, SP-HR-DSM-2026-019) and
 * then shipped as the words EVERY offer says. So an offer to a Talent Acquisition Specialist told
 * them they would lead a district's field team and own its sales number, and there was nowhere to
 * change that without rewriting the design itself — which would have changed the letter every
 * medical representative and district manager receives as well. The Letter Designer has no filter
 * by position, correctly: it designs LOOKS. Nothing owned the WORDS.
 *
 * ── WHERE THE WORDS LIVE NOW ──
 * On the job title, beside the figures that already behave this way. Cost of living, reports-to and
 * the contract term are per title and prefill an offer that can still override them; the role
 * paragraph is the same kind of fact, so it is stored the same way and reaches the letter as the
 * `{{roleSummary}}` placeholder. One design therefore serves every position, and a new position is
 * a row on the Job Titles screen rather than a duplicated 20-block letter.
 *
 * ── WHY BLANK MEANS THE STANDARD SENTENCE, NOT AN EMPTY PARAGRAPH ──
 * A legal document with a hole in it is worse than one with a general sentence in it, and this
 * module's whole point is that nobody has to notice. A title nobody has worded yet prints
 * `OFFER_ROLE_SUMMARY_FALLBACK` — role-neutral, true of any position, and already the wording the
 * Sato Corporate design shipped with. Clearing the field is therefore a reset to that sentence, in
 * exactly the way an absent WhatsApp reply row means "the code's own words".
 *
 * ── PLAIN TEXT, NOT HTML ──
 * `fillOfferTokens` escapes every value it substitutes, so what is stored here prints as typed:
 * write a real em dash and a real apostrophe, never `&mdash;` or `&rsquo;`, which would print as
 * those characters on a letter somebody signs. `{{token}}` placeholders DO work inside it — they
 * are substituted before the paragraph reaches the letter — which is what lets one stored sentence
 * name the candidate's own territory.
 */

/**
 * What a position with no wording of its own says.
 *
 * Role-neutral on purpose: it is true of a medical representative, an office coordinator and a
 * talent acquisition specialist alike, and it makes no promise about a team, a territory's number
 * or a plan. This is the SATO Corporate design's own shipped paragraph, which is where the wording
 * was proven before it became the default for everybody.
 */
export const OFFER_ROLE_SUMMARY_FALLBACK =
  "Throughout our selection process you demonstrated the judgement and the commitment this role "
  + "calls for, and we would like you to bring both to {{territory}}. We are confident you will make "
  + "a strong contribution to the company and to the people you work alongside.";

/**
 * The field-force paragraph, carried across unchanged.
 *
 * This is the sentence the classic, executive and HR-forms designs printed on every letter, with
 * `&rsquo;` and `&mdash;` restored to the real characters because this text is escaped on the way
 * into the letter rather than being HTML. It is seeded onto the three sales titles so that NOTHING
 * CHANGES for a letter that has ever actually been sent — all 36 offers on production went out on
 * the HR-forms or the classic design, and both said exactly this. Whoever is hiring can reword any
 * of the three on the Job Titles screen; this is only where they start.
 */
export const OFFER_FIELD_FORCE_ROLE_SUMMARY =
  "Throughout our selection process you demonstrated the commercial judgement and the people "
  + "leadership this district needs, and we would like you to bring both to {{territory}}. In this "
  + "role you will be fully accountable for the territory’s sales performance — translating "
  + "commercial strategy into an executable district plan, leading and developing your field team, "
  + "and driving sustainable growth and market expansion.";

/**
 * The talent-acquisition paragraph — the first position whose letter this mechanism exists for.
 *
 * It describes recruitment work and makes no claim about a sales territory, a field team or a
 * district plan, because a talent acquisition specialist has none of those and a letter that says
 * otherwise is wrong on the one page a candidate reads before signing.
 */
export const OFFER_TALENT_ACQUISITION_ROLE_SUMMARY =
  "Throughout our selection process you demonstrated the judgement and the people skills this role "
  + "calls for, and we would like you to bring both to our Human Resources team. In this role you "
  + "will own hiring end to end — building the pipeline for the seats the business is opening, "
  + "screening and interviewing with care, keeping every candidate properly informed, and giving the "
  + "hiring managers you support a shortlist they can decide on.";

/**
 * The training-manager paragraph — the second position worded for a role that carries no territory.
 *
 * A Training Manager builds the capability of the field force rather than leading a district, so
 * this describes learning work and promises no sales number, territory or district plan. It is a
 * starting point on the Job Titles screen like every other, reworded there, never in a design.
 */
export const OFFER_TRAINING_MANAGER_ROLE_SUMMARY =
  "Throughout our selection process you demonstrated the expertise and the teaching skill this role "
  + "calls for, and we would like you to bring both to {{territory}}. In this role you will own the "
  + "learning of our teams — designing and delivering product-knowledge, selling-skills and induction "
  + "programmes, coaching representatives in the field, measuring what each programme changes in "
  + "practice, and giving managers a clear view of how ready every team is.";

/**
 * The paragraph a letter prints for a position, given whatever is stored against it.
 *
 * `null`, absent and whitespace all answer the same way, because the three arrive from different
 * places — a column that predates the migration, a cleared textarea, a title added through the API
 * without the field — and all three mean the same thing: nobody has worded this position yet.
 */
export function offerRoleSummary(stored: string | null | undefined): string {
  const trimmed = typeof stored === "string" ? stored.trim() : "";
  return trimmed === "" ? OFFER_ROLE_SUMMARY_FALLBACK : trimmed;
}

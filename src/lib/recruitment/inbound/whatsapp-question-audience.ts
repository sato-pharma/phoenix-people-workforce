// Recruitment / ATS — WHICH APPLICANTS ARE ASKED WHICH of the six built-in WhatsApp questions.
//
// The extra-question builder has had a per-question audience since 20260902120000
// (`applies_to_role_families`, whatsapp-screening-questions.ts). The SIX BUILT-IN questions never
// did: they were asked to everybody, with exactly one exception — the area question, hardcoded to
// Medical Reps in `askAreaForRole`. The owner asked on 2026-09-05 for the same control on every
// single question, worded the same way it already works on the extra ones. This module is that
// control's whole vocabulary and every rule that reads it.
//
// PURE — no I/O, and it imports nothing from this folder. That last part is deliberate rather than
// tidy: whatsapp-classify-menus.ts imports THIS to implement `askAreaForRole`, so an import back the
// other way would be a cycle. Everything here is testable without a database.
//
// ── DEFAULTS LIVE HERE, NOT IN A SEED ROW ────────────────────────────────────────────────────────
//
// The prompts table holds OVERRIDES only — there are no seed rows, for the reason the editor states
// about wording: a stored copy of a default silently goes stale the day the default is improved. The
// audience follows the same rule. `BUILT_IN_DEFAULT_AUDIENCE` is what each question does with
// nothing saved, and `area` carries the Medical-Rep rule that used to be spelled out in
// `askAreaForRole`. So this change is behaviour-neutral until somebody actually ticks a box: with an
// empty table every question resolves to exactly what it resolved to before it existed.
//
// ── QUESTION 1 CAN NEVER BE SCOPED ───────────────────────────────────────────────────────────────
//
// `job_title` is the question that ESTABLISHES the role. Scoping it would mean deciding whether to
// ask it from an answer it has not collected yet, so there is no coherent behaviour to implement —
// not a restriction, an impossibility. Refused in three places (`canChooseAudience` for the screen,
// `audienceViolations` for the save path, and a CHECK constraint in the migration), because a
// silently ignored setting reads on screen exactly like one that works.

import { candidateRoleFamilies } from "@/lib/recruitment/candidate-role-family";

/** The six steps, in the order an applicant meets them. Same spelling as the session's `step`
 *  column, the prompts table's CHECK constraint, and `builtInPromptKeys` — one vocabulary. */
export const builtInQuestionKeys = [
  "job_title",
  "background",
  "region",
  "area",
  "experience",
  "salary",
] as const;

export type BuiltInQuestionKey = (typeof builtInQuestionKeys)[number];

export function isBuiltInQuestionKey(value: string): value is BuiltInQuestionKey {
  return (builtInQuestionKeys as readonly string[]).includes(value);
}

/**
 * A RESOLVED audience: null means EVERY applicant, a non-empty array means only those role families.
 * Never an empty array — that state is resolved away before anything reads one of these.
 *
 * The same two meanings the extra questions use, spelled the same way, so one mental model covers
 * the whole screen.
 */
export type QuestionAudience = readonly string[] | null;

/**
 * A STORED audience, which has THREE states where the resolved one has two. This distinction is the
 * single most load-bearing thing in this file, so it is spelled out rather than inferred:
 *
 *   undefined  nothing configured   -> the code default below. The column is NULL.
 *   []         configured: EVERYONE -> beats the default. The column is '{}'.
 *   [a, b]     configured: those    -> only those families.
 *
 * The middle state exists because `area` is the one question whose default is NOT everyone, and
 * "ask everyone" is exactly the change somebody would want to make to it. With two states, NULL
 * would have to mean both "untouched" and "everyone", so widening the area question would save
 * cleanly, read back as untouched, and keep asking Medical Reps only — a setting that looks saved
 * and does nothing, which is the failure mode this whole screen exists to avoid.
 *
 * The extra-questions table spells `[]` differently ON PURPOSE: there it is refused outright,
 * because a question with no rows in the sibling table has no code default to fall back to, so an
 * empty scope there really would mean "ask nobody". Two tables, two meanings, one reason — noted
 * here because the columns share a name and a reader would otherwise assume they share semantics.
 */
export type StoredAudience = readonly string[] | undefined;

/**
 * What each built-in question does with nothing saved.
 *
 * `area` is the only one that is not "everybody", and its value is the owner's rule of 2026-08-30
 * moved here verbatim from `askAreaForRole`: a Medical Rep is asked which area, and nobody else is,
 * because a manager is hired for a region rather than a territory inside it. It is now an ordinary
 * default the owner can change on the screen rather than a rule only a deploy could reach.
 */
export const BUILT_IN_DEFAULT_AUDIENCE: Readonly<Record<BuiltInQuestionKey, QuestionAudience>> = {
  area: ["medical_rep"],
  background: null,
  experience: null,
  job_title: null,
  region: null,
  salary: null,
};

/** The one question whose audience is not a choice — see the header. */
export function canChooseAudience(key: string): boolean {
  return isBuiltInQuestionKey(key) && key !== "job_title";
}

/**
 * The audience actually in force: what the owner saved, else the code default. The one place the
 * three stored states collapse into the two resolved ones — see `StoredAudience`.
 *
 * FALLING BACK TO THE CODE DEFAULT IS A SAFETY PROPERTY, not a convenience. Reads of the prompts
 * table are best-effort and never throw: a database hiccup returns an empty override map so that
 * every question keeps its default wording rather than the conversation stopping. That same empty
 * map arrives here, and it must leave the area question asked to Medical Reps only. Had the default
 * been a seed ROW instead, a failed read would silently WIDEN the question to every applicant —
 * degrading to something broader than anything the owner ever configured, which is the one direction
 * a fallback must never go.
 */
export function resolveBuiltInAudience(key: BuiltInQuestionKey, saved: StoredAudience): QuestionAudience {
  if (saved === undefined) return BUILT_IN_DEFAULT_AUDIENCE[key];
  return saved.length > 0 ? saved : null;
}

/**
 * Whether an applicant is asked a question with this audience.
 *
 * TWO NULLS, TWO MEANINGS — the same asymmetry `questionAppliesToRole` documents for the extra
 * questions, and the reason this is not a one-liner. A question with no audience is asked to
 * everyone. An applicant with no KNOWN role is asked only the unscoped questions: asking a general
 * question to somebody whose job we cannot name costs nothing, while asking a role-specific one is
 * exactly the failure the audience exists to prevent. It also keeps `askAreaForRole(null) === false`
 * true, which is what it has always returned.
 */
export function audienceAppliesToRole(audience: QuestionAudience, roleFamily: string | null | undefined): boolean {
  if (!audience || audience.length === 0) return true;
  if (!roleFamily) return false;
  return audience.includes(roleFamily);
}

/** The two calls above, together — the form nearly every caller wants. */
export function builtInQuestionAppliesToRole(
  key: BuiltInQuestionKey,
  saved: StoredAudience,
  roleFamily: string | null | undefined,
): boolean {
  return audienceAppliesToRole(resolveBuiltInAudience(key, saved), roleFamily);
}

/**
 * Everything wrong with a proposed audience, as sentences an admin can read. Empty means saveable.
 *
 * The membership check is the one the database deliberately does not make — the migration explains
 * why: `candidateRoleFamilies` gains a member whenever the company opens a kind of seat it has not
 * hired for before, and a CHECK listing them would need a migration every time. An unknown family is
 * not a harmless typo: it matches no applicant, so the question is asked to NOBODY while the screen
 * still shows it as live, which reads as the bot being broken rather than as a mis-typed audience.
 */
export function audienceViolations(input: { key: string; appliesToRoleFamilies: StoredAudience }): string[] {
  const problems: string[] = [];
  const scope = input.appliesToRoleFamilies;
  // Nothing configured is always saveable — it is the state every question starts in.
  if (scope === undefined) return problems;

  if (!canChooseAudience(input.key)) {
    problems.push(
      "The first question decides which job someone is applying for, so it is always asked — it cannot be limited to a job title.",
    );
    return problems;
  }
  // An EMPTY array is legal here and means "asked to everyone" — see StoredAudience. It is the one
  // place this validator deliberately disagrees with its extra-question counterpart, which refuses
  // the same shape.
  for (const family of scope) {
    if (!(candidateRoleFamilies as readonly string[]).includes(family)) {
      problems.push(`"${family}" is not a job title we recognise.`);
    }
  }
  return problems;
}

/** The saved audience for each of the six, as the store hands it over. A key ABSENT from the map is
 *  "nothing configured" and takes its code default, which is exactly the `undefined` that
 *  `resolveBuiltInAudience` expects — so a plain `.get()` is already the right argument. */
export type SavedAudiences = ReadonlyMap<string, readonly string[]>;

/**
 * THE STEP RESOLVER — the next of the six to ask after one is answered, or null when the fixed six
 * are finished for this applicant.
 *
 * This exists because the alternative is the shape the session file had: eight hardcoded
 * `step: "<the next one>"` transitions, one per answer path, tapped and typed. That was already
 * carrying one skip (`askAreaForRole`) at three of those eight sites, and making all six skippable
 * that way would have meant every question's rule written out five more times, with the "other"
 * branches as the places a rule quietly goes missing. One resolver, called from every site, is the
 * only version of this that cannot disagree with itself.
 *
 * TWO RULES, AND THE SECOND IS NOT AN AUDIENCE RULE:
 *
 *   1. A question whose audience excludes this applicant is skipped.
 *   2. `area` additionally requires a REGION to have been answered, whatever the audience says. Its
 *      menu rows ARE the live areas of the chosen region, so with no region there is no list to
 *      send — and an owner who narrows the region question without thinking about the area question
 *      would otherwise strand every applicant on a menu that cannot be built. Expressed here rather
 *      than as a hidden extra audience, because it is a data dependency between two questions and
 *      not an opinion about who should be asked.
 */
export function nextBuiltInQuestion(input: {
  /** The question just answered. Pass the plain key for a typed "other" answer too — `region_other`
   *  finishes the region question exactly as a tapped region does. */
  after: BuiltInQuestionKey;
  roleFamily: string | null | undefined;
  audiences: SavedAudiences;
  /** Whether this applicant has a region on file — tapped or typed. Gates `area`; see rule 2. */
  hasRegion: boolean;
}): BuiltInQuestionKey | null {
  const startAt = builtInQuestionKeys.indexOf(input.after) + 1;
  for (const key of builtInQuestionKeys.slice(startAt)) {
    if (key === "area" && !input.hasRegion) continue;
    if (!builtInQuestionAppliesToRole(key, input.audiences.get(key), input.roleFamily)) continue;
    return key;
  }
  return null;
}

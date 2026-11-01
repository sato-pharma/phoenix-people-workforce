/**
 * Phoenix CRM — the rules for a comment and a recommendation written on a place check.
 *
 * Owner, 13 October 2026: a district manager reads his own team's Place checks, comments on a row,
 * and chooses per comment whether the rep may read it; he also recommends validating it or not
 * validating it. The decision stays the Super Admin's alone, and nothing on the manager's screen says
 * so.
 *
 * Pure and screen-free on purpose: the wording a rep is shown is the one thing in this feature that
 * touches golden rule #1, so it lives in one function a test can pin rather than in a component.
 */

/** Who wrote a note. It is the ONE thing a rep is told about one he may read — a role, never a name. */
export type PlaceNoteSource = "system_admin" | "manager";

/** What a manager recommends. `reject` is "do not validate this", never "rejected". */
export type PlaceRecommendation = "validate" | "reject";

/**
 * The verdict a System Administrator's by-eye note closes on (owner, 2026-10-19: show it by the
 * buttons in the one-by-one review, and put the "approve" ones first). It decides nothing; the
 * database CHECK allows it on a `system_admin` note only, and a manager's word is his recommendation.
 * The order is the review's order within a tab.
 */
export const PLACE_NOTE_ADVICE = ["approve", "your_call", "new_photo", "reject"] as const;
export type PlaceNoteAdvice = (typeof PLACE_NOTE_ADVICE)[number];

export function parsePlaceNoteAdvice(value: unknown): PlaceNoteAdvice | null {
  return (PLACE_NOTE_ADVICE as ReadonlyArray<unknown>).includes(value) ? (value as PlaceNoteAdvice) : null;
}

/** What the tag beside the decision buttons says. */
export function placeNoteAdviceLabel(advice: PlaceNoteAdvice): string {
  switch (advice) {
    case "approve":
      return "Approve";
    case "your_call":
      return "Your call";
    case "new_photo":
      return "Ask for a new photo";
    case "reject":
      return "Reject";
  }
}

/** The two subjects a note or a recommendation can be about: a place, or a polyclinic. */
export type PlaceNoteSubjectKind = "place" | "shared_place";

/** The longest a comment may be. The database CHECK is the same number. */
export const PLACE_NOTE_MAX_LENGTH = 1_000;

export const PLACE_NOTE_REQUIRED = "Write the comment before you save it.";
export const PLACE_NOTE_VISIBILITY_REQUIRED = "Choose whether the medical rep sees this comment.";
export const PLACE_RECOMMENDATION_REQUIRED = "Choose whether you recommend validating this one.";

/**
 * How a rep is told who wrote a comment he may read (owner, 2026-10-13: "it is from the system
 * administrator, then show from the system administrator. If from his manager, then show that it is
 * from his manager").
 *
 * 🔴 A ROLE, NEVER A NAME, AND NEVER AN HR ID. This is the one door the owner opened in golden rule #1,
 * and he opened it exactly this wide: the rep learns which authority wrote to him and nothing else.
 * Every other thing a rep receives still reads as the system's own answer (`google-place-rules.ts`,
 * `validation-feedback.ts`) and names nobody at all.
 */
export function placeNoteRepAuthorText(source: PlaceNoteSource): string {
  return source === "system_admin" ? "From the System Administrator" : "From your manager";
}

/** How the two boards label a note's author to a reader who may see every note. */
export function placeNoteAuthorLabel(source: PlaceNoteSource, name: string | null): string {
  const role = source === "system_admin" ? "System Administrator" : "District Manager";
  return name ? `${name} · ${role}` : role;
}

/**
 * True when a decision's own note is already on the row as a comment (since 2026-11-01 every comment
 * written with a decision is), so the company board prints it once, under "The rep can read this".
 */
export function decisionNoteIsAComment(decisionNote: string | null, comments: ReadonlyArray<{ body: string }>): boolean {
  const said = decisionNote?.trim();
  return Boolean(said) && comments.some((comment) => comment.body.trim() === said);
}

/** What a recommendation reads as, in the owner's own words for the two buttons. */
export function placeRecommendationLabel(value: PlaceRecommendation): string {
  return value === "validate" ? "Recommend validate" : "Recommend not validate";
}

/** What a recommendation already made reads as, in the past tense, on either board. */
export function placeRecommendationMadeLabel(value: PlaceRecommendation): string {
  return value === "validate" ? "Recommends validating" : "Recommends not validating";
}

export function parsePlaceNoteSource(value: unknown): PlaceNoteSource | null {
  return value === "system_admin" || value === "manager" ? value : null;
}

export function parsePlaceRecommendation(value: unknown): PlaceRecommendation | null {
  return value === "validate" || value === "reject" ? value : null;
}

export function parsePlaceNoteSubjectKind(value: unknown): PlaceNoteSubjectKind | null {
  return value === "place" || value === "shared_place" ? value : null;
}

/**
 * The key both boards index a subject's notes and recommendations by — one flat record for the whole
 * page rather than a field on four different row types, so adding this feature changed no loader's
 * shape and no section's own read.
 */
export function placeNoteSubjectKey(kind: PlaceNoteSubjectKind, id: string): string {
  return `${kind}:${id}`;
}

/**
 * One integrity case the system holds on a place or a polyclinic, as a Place checks board draws it.
 *
 * 🔴 THE DISTRICT MANAGER READS THIS, AND THAT IS A CHANGE TO TIER 1 HE MADE HIMSELF (owner,
 * 2026-10-13: "system and device evidence the dm can see", after being shown that his new board
 * carried the system's evidence and not the device's). It still is the Super Admin's everywhere ELSE:
 * `/admin/phoenix-crm/integrity` is unchanged, the place-vs-actual report shows him the DISTANCE only,
 * and the REP is told nothing at all — he has no screen that reaches a case or the fact one exists.
 *
 * 🔴 EVERY FIELD IS ALREADY IN WORDS, AND THAT IS NOT A STYLE. The words are built on the SERVER,
 * beside the evidence, because the component that draws them sits in `src/components/phoenix-crm/` —
 * the rep's own bundle directory — and `tests/phoenix-crm-blind-half.test.ts` refuses the silent words
 * in a literal in any file there. A screen that formats nothing cannot leak a sentence a rep must
 * never read, and the one place the sentences exist is the one place the audience is checked.
 *
 * 🔴 AND THE TYPE LIVES HERE, IN THE PURE MODULE, for the same test's second check: no rep-facing file
 * may so much as name `server/integrity-board`, and `view-types.ts` — the wire the phone reads — may
 * not reach it. The loader is there; the shape is here.
 */
export type PlaceCheckIntegrityView = {
  caseId: string;
  /** Which detector filed it, in words — Position, Photograph, Signboard … */
  sourceLabel: string;
  strong: boolean;
  /** The flags in plain English, never codes. */
  reasons: string[];
  /** The phone's own answer, in words, when it gave one worth saying. Null when there is nothing. */
  deviceText: string | null;
  /** When the system noticed, in Cairo time, with the accuracy it reported if it reported one. */
  noticedText: string;
  /** Null unless the Super Admin has already closed it — so a manager never reads a settled case as standing. */
  settledText: string | null;
};

/** Every case on a page's subjects, keyed by {@link placeNoteSubjectKey} — the notes index's own key. */
export type PlaceCheckIntegrityIndex = Record<string, PlaceCheckIntegrityView[]>;

// Recruitment / ATS — the menus a CV sender taps to say what they are applying for.
//
// Six questions: role -> graduation background -> region -> area -> years of experience -> expected
// salary. WHICH of them an applicant is asked is the owner's to set per question since 2026-09-05
// (whatsapp-question-audience.ts) — the area question defaults to Medical Reps only, his cascade rule
// of 2026-08-30, and the other five default to everyone. Question 1 is always asked: it establishes
// the role the rest are judged against. Expected salary is the one free-typed question — every other
// question is a tappable list.
//
// WHY THIS EXISTS. Measured against production 2026-08-28: 446 candidates, 227 of them (51%) from
// WhatsApp, and `applied_for_job_title` filled on 60. Those 60 hold 41 DISTINCT spellings, because
// every one is free text somebody typed or an extractor guessed. A tapped answer is not a better
// guess — it is the applicant stating their own intent, in a fixed vocabulary, at the moment they
// send the CV. That is the top rung of `applied-for.ts`'s ladder ("a human typed it. Always wins"),
// so a tapped role lights up the existing "Applying for" column with no new read path at all.
//
// Vocabulary is BORROWED, never invented here:
//   role   -> `candidateRoleFamily` codes (candidate-role-family.ts), so an answer lands in the same
//             vocabulary the pool's Role filter reads. The MENU offers a subset the owner named
//             (see ROLE_MENU_ORDER) — a question put to a person, not a dump of the whole list —
//             and "Other" opens a free-text follow-up for anything it does not cover.
//   region -> `candidateRegionLabels` (candidate-region.ts) — the company's own `au.regions` names.
//             Owner decision 2026-08-24: company regions, NOT geography.
//   area   -> `au.canonical_areas`, read live (see whatsapp-classify-session.ts). Areas are the one
//             layer that genuinely moves as the org changes, and a hard-coded list would offer a
//             territory that no longer exists.
//
// This module is PURE — no I/O — so the menus can be asserted in a test without a database.

import { candidateRegionCodes, candidateRegionLabels, type CandidateRegionCode } from "@/lib/recruitment/candidate-region";
import { candidateRoleFamilies, candidateRoleFamilyLabels, type CandidateRoleFamily } from "@/lib/recruitment/candidate-role-family";
import { resolveAutoReply, type AutoReplyOverrides } from "@/lib/recruitment/inbound/whatsapp-auto-replies";
import { areaPlaceHint, regionPlaceHint } from "@/lib/recruitment/inbound/whatsapp-classify-place-hints";

// ── Meta's interactive-message limits ────────────────────────────────────────────────────────────
// From the Cloud API reference. They are enforced SERVER-SIDE: an over-long row title is a 400 for
// the whole message, not a truncation, so the flow would simply stop for that candidate with a
// generic error. Every menu below is checked against these at module load.
export const WHATSAPP_LIST_MAX_ROWS = 10;
export const WHATSAPP_ROW_TITLE_MAX = 24;
export const WHATSAPP_ROW_DESCRIPTION_MAX = 72;
export const WHATSAPP_LIST_BUTTON_MAX = 20;
export const WHATSAPP_SECTION_TITLE_MAX = 24;
export const WHATSAPP_BODY_MAX = 1024;

/** A step that is asked as a tappable list. Every menu below has one of these. */
export type ClassifyStep = "job_title" | "background" | "region" | "area" | "experience";

/**
 * Every value the session's `step` column may hold — the tappable steps, plus the typed follow-up
 * after "Other", plus the terminal state. Kept separate from `ClassifyStep` on purpose:
 * `job_title_other` has no menu and no row ids, so letting it into `ClassifyStep` would imply a
 * list that cannot exist. `salary` is the same case — the last question is typed, not tapped — so it
 * lives here and not in `ClassifyStep`. This union is the same vocabulary as the table's CHECK
 * constraint.
 */
export type ClassifySessionStep =
  | ClassifyStep
  | "job_title_other"
  | "background_other"
  | "region_other"
  | "area_other"
  | "salary"
  | "done";

export const classifySessionSteps: readonly ClassifySessionStep[] = [
  "job_title",
  "job_title_other",
  "background",
  "background_other",
  "region",
  "region_other",
  "area",
  "area_other",
  "experience",
  "salary",
  "done",
];

/**
 * The row value that means "none of these — let me type it". Shared by all three questions so the
 * reply handler tests one constant, and deliberately not a real code: `isOfferedRegion("other")` and
 * `isOfferedRoleFamily`-style guards must keep rejecting it, so every branch has to handle it
 * explicitly before validating. A silent fall-through would look like an unknown value and drop the
 * applicant's answer.
 */
export const OTHER_ROW_VALUE = "other";

export type ClassifyRow = {
  /** Row id sent back to us verbatim when tapped. Namespaced so a stray reply can't be misread. */
  id: string;
  /** What the candidate sees. Never an ellipsis — see the override maps below. */
  title: string;
  /** Second line. Carries the FULL name whenever the title had to be shortened to fit. */
  description?: string;
};

export type ClassifyMenu = {
  // "extra" is an admin-defined question (whatsapp-screening-questions.ts) — same menu shape, same
  // Meta-limit checks, just not one of the fixed six steps this file owns.
  step: ClassifyStep | "extra";
  body: string;
  buttonLabel: string;
  sectionTitle: string;
  rows: ClassifyRow[];
};

// ── Row ids ──────────────────────────────────────────────────────────────────────────────────────
// `phx:<step>:<value>`. The prefix is what makes an inbound interactive reply attributable: WhatsApp
// hands back only the id, and without a namespace any future interactive feature's reply would be
// indistinguishable from this one's.
const ID_PREFIX = "phx";

export function classifyRowId(step: ClassifyStep, value: string): string {
  return `${ID_PREFIX}:${step}:${value}`;
}

export type ParsedClassifyRowId = { step: ClassifyStep; value: string };

/** Reads one of our row ids back, or null for anything we did not send. Never throws. */
export function parseClassifyRowId(raw: string | null | undefined): ParsedClassifyRowId | null {
  const parts = String(raw ?? "").split(":");
  if (parts.length !== 3) return null;
  const [prefix, step, value] = parts;
  if (prefix !== ID_PREFIX) return null;
  if (
    step !== "job_title" &&
    step !== "background" &&
    step !== "region" &&
    step !== "area" &&
    step !== "experience"
  ) {
    return null;
  }
  if (!value.trim()) return null;
  return { step, value };
}

// ── What the APPLICANT sees ──────────────────────────────────────────────────────────────────────
// The pool's own label (`candidateRoleFamilyLabels`) is written for a recruiter reading a filter
// dropdown; this map is the wording an applicant reads on their phone, given verbatim by the owner
// on 2026-08-28. Only the entries that differ are listed — everything else falls through to the
// pool label, so the two vocabularies cannot drift apart silently.
//
// A row title also has a hard 24-character ceiling that Meta enforces server-side, and the owner's
// standing rule is that text is never cut with an ellipsis. So where a name does not fit, the short
// form here is a real abbreviation a person would write and the FULL name goes on the description
// line, where all 72 characters are available.
const MENU_ROLE_TITLES: Partial<Record<CandidateRoleFamily, string>> = {
  // "Area / Regional Manager" fits, but the owner asked for the shorter name on the applicant's
  // side. The pool filter keeps the longer label, which is the same bucket.
  area_regional_manager: "Regional Manager",
  // "Finance & Accounting" in the pool; the applicant is asked for "Finance".
  finance: "Finance",
  // "Sales & Business Development" is 28 characters. Not offered on the menu today, but kept so the
  // ceiling stays satisfied if it is ever put back.
  sales: "Sales & Business Dev.",
};

const LONG_AREA_TITLES: Record<string, string> = {
  // The only active area name over 24 characters (26), verified against au.canonical_areas.
  "Dokki - Mohandseen - Bolak": "Dokki - Mohandseen",
};

/**
 * One row. The second line carries, in order of precedence:
 *
 *   1. the FULL name, whenever the title had to be shortened to fit 24 characters — losing the real
 *      name is not acceptable, so this always wins the space;
 *   2. the place hint, naming the biggest places inside this region or area (owner's instruction
 *      2026-08-28, see whatsapp-classify-place-hints.ts);
 *   3. both, joined, when they fit together.
 *
 * The hint is DROPPED rather than cut when it does not fit. Text is never truncated here — that is
 * the owner's standing rule, and a half-written town name is worse than no hint, because a name cut
 * mid-word can read as a different place entirely.
 */
function rowFor(
  step: ClassifyStep,
  value: string,
  fullName: string,
  shortTitle?: string,
  hint?: string | null,
): ClassifyRow {
  const title = shortTitle ?? fullName;
  const needsFullName = title !== fullName;
  const id = classifyRowId(step, value);

  // Bracketed on the owner's explicit instruction, twice on 2026-08-28: "just add a bracket".
  // The brackets are applied HERE, not stored in the hint data, so the data file stays a clean list
  // of place names and this stays the only place that decides how a hint is presented.
  const bracketed = hint ? `(${hint})` : null;

  if (!needsFullName) {
    // The description repeats the full name ONLY when the title is not already it — a second line
    // saying the same words twice reads as a bug. So an unshortened title's line is the hint alone.
    return bracketed && bracketed.length <= WHATSAPP_ROW_DESCRIPTION_MAX
      ? { description: bracketed, id, title }
      : { id, title };
  }

  const both = `${fullName} ${bracketed ?? ""}`;
  const description =
    bracketed && both.length <= WHATSAPP_ROW_DESCRIPTION_MAX
      ? both
      : fullName.slice(0, WHATSAPP_ROW_DESCRIPTION_MAX);
  return { description, id, title };
}

// ── Question 1 — what are you applying for? ──────────────────────────────────────────────────────
// THE OWNER NAMED THIS LIST, in this order, on 2026-08-28. It is NOT every role family and must not
// be "corrected" back into one: `sales` and `pharmacist` are deliberately absent, because a menu is
// a question put to a person rather than a dump of an internal vocabulary. Both families still
// exist and still bucket CVs — someone applying for either taps "Other" and types it, which is a
// better record than a bucket they did not choose.
//
// A list is read top-down and this pool is overwhelmingly medical reps, so the order is the owner's
// own. "Other" stays last because it is the answer meaning "none of these", and offering it early
// invites it.
const ROLE_MENU_ORDER: CandidateRoleFamily[] = [
  "medical_rep",
  "district_manager",
  "area_regional_manager",
  "product_manager",
  "national_sales_manager",
  // `human_resources` WAS HERE until 2026-10-06 — removed from the menu at the owner's instruction
  // ("remove the human resources choice in whatsapp bot"), now that the two HR seats each have their
  // own row below. It is not a deleted family: it stays in the pool (jobTitleMenuAllFamilies), so the
  // Screening Questions screen still offers it as an answer to switch back on, a typed "Other" that
  // reads as an HR job still lands in `human_resources` through the title classifier, and an old
  // tapped row still resolves (isOfferedRoleFamily accepts every family).
  // HR Section Head, added 2026-10-06 at the owner's instruction for the HR Section Head opening —
  // the seat under the HR Manager. It took the slot the Finance row held, because the list was then
  // FULL at Meta's 10-row cap (see below). Finance was the displaced row, not a removed family: a
  // finance applicant types it under "Other" and still lands in the `finance` family through the
  // title classifier, and the owner can put the Finance row back on the Screening Questions screen.
  // A tap (not a typed "Other") is what puts every Section Head applicant in one family the pool
  // can filter and the extra questions can be scoped to.
  "hr_section_head",
  // Talent Acquisition, added 2026-09-22 for the TA Specialist opening. It sits beside the other HR
  // seat because it is the recruiting seat inside HR, and the owner wants these CVs in their own
  // bucket. Making it a tap (not a typed "Other") is what puts every TA applicant in one family the
  // pool can filter and the extra questions can be scoped to — the same reason Office Coordinator
  // was made tappable below.
  "talent_acquisition",
  // `finance` WAS HERE until 2026-10-06 — displaced by hr_section_head, not deleted. It stays in the
  // pool (jobTitleMenuAllFamilies), so the Screening Questions screen offers it as an answer to
  // switch back on.
  // Added 2026-09-02 for the Sheraton Office Coordinator opening. It sits with the other head-office
  // seats and above "Other" — which stays last, because it is the answer meaning "none of these" and
  // offering it early invites it. The list was 9 rows against Metas 10-row cap (Talent Acquisition
  // filled it on 2026-09-22; HR Section Head replaced Finance on 2026-10-06 rather than append; the
  // Human Resources row was then removed the same day, which freed ONE slot). Personnel took that
  // slot on 2026-10-31 — see below.
  //
  // This row is what makes the position tappable instead of typed, which matters twice over: the
  // applicant lands in a real family (so the extra questions can be scoped to them), and the job
  // title is spelled by the system rather than by somebody phone keyboard — the folder shelf already
  // carries five spellings of Kafr El-Sheikh from free-typed keys, and this is how that is avoided.
  "office_coordinator",
  // Personnel Specialist, added 2026-10-31 at the owner's instruction ("add to whatsapp bot") for the
  // Personnel Specialist / Senior Personnel Specialist opening. It took the ONE free slot, so the
  // list is now 10 rows — FULL at Meta's cap. The next role has to DISPLACE a row (as HR Section Head
  // displaced Finance on 2026-10-06), never append: an eleventh row is a 400 for the whole message.
  // Which of the two grades the applicant wants is the first extra question (`pers_position`), so
  // one tap files both grades in one family and one tab.
  "personnel",
  "other",
];

export function jobTitleMenu(): ClassifyMenu {
  return {
    body: "Thanks for sending your CV to Sato Pharma. To get it to the right manager, please tell us what you are applying for.",
    buttonLabel: "Choose a role",
    rows: ROLE_MENU_ORDER.map((family) =>
      rowFor("job_title", family, candidateRoleFamilyLabels[family], MENU_ROLE_TITLES[family]),
    ),
    sectionTitle: "Roles",
    step: "job_title",
  };
}

/** The families this menu offers. Exported so a test can pin the owner's list, not re-derive it. */
export const offeredRoleMenuFamilies: readonly CandidateRoleFamily[] = ROLE_MENU_ORDER;

/**
 * EVERY role family as a menu row — the owner's eight in his order, then the two he left off.
 *
 * This is NOT what the bot sends; `jobTitleMenu()` is, and it is unchanged. This exists so the admin
 * screen can offer `sales` and `pharmacist` as answers to switch ON, built by the same `rowFor` the
 * real menu uses. That reuse is the point: a hand-built row would miss `MENU_ROLE_TITLES`, and
 * "Sales & Business Development" is 28 characters against Meta's 24-character ceiling — a row that
 * would 400 the whole message rather than merely look untidy. The short title for it has sat in that
 * table since the menu was written, against exactly this day.
 *
 * Switching one on is safe because `isOfferedRoleFamily` already accepts both: the reply handler has
 * always understood the value, the menu simply never offered it.
 */
export function jobTitleMenuAllFamilies(): ClassifyMenu {
  const unoffered = candidateRoleFamilies.filter((family) => !ROLE_MENU_ORDER.includes(family));
  return {
    ...jobTitleMenu(),
    rows: [...ROLE_MENU_ORDER, ...unoffered].map((family) =>
      rowFor("job_title", family, candidateRoleFamilyLabels[family], MENU_ROLE_TITLES[family]),
    ),
  };
}

// ── Question 1b — "Other", in their own words ────────────────────────────────────────────────────
// Owner's instruction, 2026-08-28: "if he choose other, he free text what he want." So "Other" is
// not a dead end that files someone under a label meaning nothing — it opens the one question this
// flow cannot put in a list, and their typed answer becomes `applied_for_job_title` verbatim.
//
// Plain text, not a menu: there is nothing to tap. The reply arrives as an ordinary inbound message,
// which is why the webhook has to route text into the session before buffering it as CV context.
export function jobTitleOtherPromptText(): string {
  return [
    "No problem — please type the job title you are applying for.",
    "",
    "Send it as a normal message and we will record it exactly as you write it.",
  ].join("\n");
}

/**
 * What a typed "Other" answer is worth keeping. Trimmed, collapsed to single spaces, and capped at
 * a length a job title can actually be — a pasted CV or a paragraph is not a job title, and storing
 * one would put junk in the column the hiring manager reads.
 *
 * Returns null when there is nothing usable, so the caller can ask again rather than record noise.
 */
export const JOB_TITLE_OTHER_MAX = 120;

/**
 * Sent when the typed answer is too long to be a job title — someone pasted a paragraph or their
 * whole CV. Names the limit rather than silently ignoring them, and deliberately does NOT quote
 * their text back: it is already too long, and repeating it is what an ellipsis would be for.
 */
export function jobTitleOtherTooLongText(): string {
  return [
    "That looks longer than a job title.",
    "",
    `Please send just the title itself — up to ${JOB_TITLE_OTHER_MAX} characters, for example "Regulatory Affairs Specialist".`,
  ].join("\n");
}

export function cleanTypedAnswer(raw: string | null | undefined, max: number): string | null {
  const cleaned = String(raw ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return null;
  if (cleaned.length > max) return null;
  return cleaned;
}

export function cleanTypedJobTitle(raw: string | null | undefined): string | null {
  return cleanTypedAnswer(raw, JOB_TITLE_OTHER_MAX);
}

// ── Question 2 — graduation background ─────────────────────────────────────────────────────────────
// Owner's instruction 2026-08-30: right after the role, ask what the applicant graduated in. In this
// industry a field applicant is a Pharmacy, Science or Veterinary graduate far more often than not,
// and which one a hiring manager wants to know before reading a word of the CV. Asked to EVERYONE —
// a head-office applicant (HR, Finance) simply taps "Other" and types their degree, exactly as the
// role question already works.
//
// This is a NEW vocabulary, not borrowed: nothing else in the app buckets candidates by degree yet,
// so the codes are defined here and the answer is stored as its own declaration on the candidate.
//
// MEDICINE AND DENTISTRY ADDED 2026-08-31, on the owner's instruction: *"medicine and dentistry are
// accepted. And add them in the question."* They were reachable before only by tapping "Other" and
// typing, which filed a fully eligible graduate as an unrecognised answer — the exact shape the
// paramedical split must not produce. Measured in production the same day, 10 candidates carry a
// medicine or dentistry faculty read off their CV, and the one person who had answered the question
// with something outside the three codes had typed "Bachelor of Commerce", so nothing already
// stored is disturbed by widening the list.
export const candidateBackgroundCodes = ["pharmacy", "science", "vet", "medicine", "dentistry"] as const;
export type CandidateBackgroundCode = (typeof candidateBackgroundCodes)[number];

/** What the applicant reads. "Veterinary" rather than the owner's shorthand "vet" — it is clearer
 *  on the phone and well inside the 24-character row ceiling. */
export const candidateBackgroundLabels: Record<CandidateBackgroundCode, string> = {
  dentistry: "Dentistry",
  medicine: "Medicine",
  pharmacy: "Pharmacy",
  science: "Science",
  vet: "Veterinary",
};

// Order is the owner's: the degrees a field applicant actually holds, then "Other" last — offering
// "Other" early invites it, the same reasoning as the role menu. The three commonest stay first so
// the tap most applicants need is the one they reach without reading to the bottom; medicine and
// dentistry follow because production says they are the rarer pair (10 against 201).
const BACKGROUND_MENU_ORDER: readonly string[] = [...candidateBackgroundCodes, OTHER_ROW_VALUE];

export function backgroundMenu(): ClassifyMenu {
  return {
    body: "What did you graduate in?",
    buttonLabel: "Choose background",
    rows: BACKGROUND_MENU_ORDER.map((value) =>
      value === OTHER_ROW_VALUE
        ? rowFor("background", OTHER_ROW_VALUE, "Other")
        : rowFor("background", value, candidateBackgroundLabels[value as CandidateBackgroundCode]),
    ),
    sectionTitle: "Background",
    step: "background",
  };
}

/** True for a background we offer — guards a stale value arriving in a reply, and keeps rejecting
 *  the "Other" escape so its branch has to be handled explicitly before validating. */
export function isOfferedBackground(value: string): value is CandidateBackgroundCode {
  return (candidateBackgroundCodes as readonly string[]).includes(value);
}

export const BACKGROUND_OTHER_MAX = 80;

/**
 * The example CANNOT be a degree the menu already offers.
 *
 * It read "Dentistry" until 2026-08-31, which was correct while dentistry was reachable only by
 * typing. Now that it is a row, an example naming it would tell the one applicant who got here by
 * mistake to type an answer they should have tapped — and a typed "Dentistry" is stored as free
 * text rather than as the code, so it would land in the review queue instead of being recognised as
 * eligible. "Commerce" is the honest example: it is what the only real "Other" answer in production
 * actually was, and it is not on the menu and never will be.
 */
export function backgroundOtherPromptText(): string {
  return [
    "No problem — please type what you graduated in.",
    "",
    "Send it as a normal message, for example \"Commerce\".",
  ].join("\n");
}

/** Same shape as the other too-long nudges: names the limit, quotes nothing back. */
export function backgroundOtherTooLongText(): string {
  return typedAnswerTooLongText("background", BACKGROUND_OTHER_MAX);
}

// ── The typed escape on the region and area questions ────────────────────────────────────────────
// Owner's instruction, 2026-08-28, after hitting this himself: he was opening a District Manager
// seat in Delta (3) — a region that is live and carries target in `au.regions` but had ZERO areas —
// and found the applicant could neither pick the region nor type it. A list is a closed vocabulary
// and the organogram moves faster than the list: a brand-new district exists for a while before it
// has any areas, and that window is exactly when its first candidates apply.
//
// So every question now has a way out. A typed region and a typed area are recorded as the
// applicant's own words and never mistaken for organogram values — see writeClassification, which
// keeps them in separate columns from the codes.

export const REGION_OTHER_MAX = 80;
export const AREA_OTHER_MAX = 80;

export function regionOtherPromptText(): string {
  return [
    "No problem — please type the region you would like to work in.",
    "",
    "Send it as a normal message, for example \"Delta (3)\".",
  ].join("\n");
}

export function areaOtherPromptText(): string {
  return [
    "Please type the area or governorate you would like to work in.",
    "",
    "Send it as a normal message, for example \"Mansoura\".",
  ].join("\n");
}

/** Same shape as the job-title nudge: names the limit, quotes nothing back. */
export function typedAnswerTooLongText(what: string, max: number): string {
  return [
    `That looks longer than a ${what}.`,
    "",
    `Please send just the ${what} itself — up to ${max} characters.`,
  ].join("\n");
}

// ── Question 3 — which region? ───────────────────────────────────────────────────────────────────
// Still NOT read from au.regions live: that table also carries `UE-1` and `UE-2`, sales subdivisions
// of Upper Egypt, and asking an applicant to choose between them asks them to know an internal
// split. `candidateRegionCodes` stays the reviewed list.
//
// "ZERO active areas" stopped being true on 2026-09-01 — do not read this note as still saying so.
// Pedia's Upper Egypt split into UE-1/UE-2 that day (AGENTS.md's August/Upper Egypt golden rule), so
// both now carry real seats. That does not by itself make the split offerable HERE: AGENTS.md is
// explicit that UE-1/UE-2 membership DIFFERS by product line, and this question is asked before the
// flow knows which line an applicant is bound for, so there is still no line to resolve the split
// with. A district manager who types "Upper Egypt 1" instead of tapping the one Upper Egypt row is
// read by `readDeclaredRegionFreeText` in candidate-folder-suggestion.ts, which — the owner's decision
// 2026-09-11, asked directly — files it into the single Upper Egypt folder this apply flow offers,
// same as a plain "Upper Egypt" answer. Which HALF they meant is not recovered by that; it is still
// sitting in `preferred_region_name` verbatim for whoever needs it once the flow can ask a line.
//
// Revised 2026-08-28. That reviewed list had gone stale in the one way that matters: Delta (3) was
// live and carrying target in `au.regions` while absent here, so the owner could open a District
// Manager seat in it that no applicant could ever select. D3 is now offered even though it has no
// areas yet — which the old note rightly called a dead end, and which is only safe because the
// "not listed" escape below means an empty area list is answerable instead of terminal.
export function regionMenu(): ClassifyMenu {
  return {
    body: "Which region would you like to work in?",
    buttonLabel: "Choose a region",
    rows: [
      // The second line is what makes "Delta (1)" answerable by someone who has never worked here.
      ...candidateRegionCodes.map((code) =>
        rowFor("region", code, candidateRegionLabels[code], undefined, regionPlaceHint(code)),
      ),
      // Worded "not listed" rather than "Other" on purpose: `OT` is already a real selling region
      // labelled "Others", and two rows reading Other/Others would be a coin flip for the applicant.
      rowFor("region", OTHER_ROW_VALUE, "My region is not listed"),
    ],
    sectionTitle: "Regions",
    step: "region",
  };
}

/** True for a region we are willing to offer — guards against a stale code arriving in a reply. */
export function isOfferedRegion(value: string): value is CandidateRegionCode {
  return (candidateRegionCodes as readonly string[]).includes(value);
}

/** True for a role family we offered. Same guard, for question 1. */
export function isOfferedRoleFamily(value: string): value is CandidateRoleFamily {
  return (candidateRoleFamilies as readonly string[]).includes(value);
}

// `askAreaForRole` USED TO LIVE HERE, and it is gone rather than moved: the owner's cascade rule of
// 2026-08-30 — a Medical Rep is asked region THEN area, everyone else region only — is now the
// DEFAULT AUDIENCE for the area question in whatsapp-question-audience.ts, one of six he can change
// on /admin/screening-questions without a deploy. Deleted rather than kept as a wrapper, because a
// wrapper would answer for the default while the flow answered for the saved audience, and the two
// disagreeing is the exact bug the control was added to prevent. Use
// builtInQuestionAppliesToRole("area", audiences.get("area"), family).

// ── Question 4 — which area? ─────────────────────────────────────────────────────────────────────
// Areas are passed in because they are read live from au.canonical_areas. Largest region is Others
// at 9 active areas, so every region fits the 10-row cap with a row to spare — but the cap is
// enforced here anyway rather than assumed, because an org change could add a tenth and a silently
// dropped area is a territory no candidate can ever choose.
export function areaMenu(regionCode: CandidateRegionCode, areaNames: readonly string[]): ClassifyMenu {
  // The escape takes a row, so the areas get one fewer. Sliced to MAX - 1 rather than appended and
  // hoped for: the largest region (Others) runs 9 areas against a 10-row cap, so appending blindly
  // would have been correct today and silently dropped a real area the day a tenth was added.
  const rows = areaNames
    .map((name) => name.trim())
    .filter((name) => name.length > 0)
    .slice(0, WHATSAPP_LIST_MAX_ROWS - 1)
    .map((name) => rowFor("area", name, name, LONG_AREA_TITLES[name], areaPlaceHint(name)));
  rows.push(rowFor("area", OTHER_ROW_VALUE, "My area is not listed"));

  return {
    body: `Which area inside ${candidateRegionLabels[regionCode]}?`,
    buttonLabel: "Choose an area",
    rows,
    sectionTitle: "Areas",
    step: "area",
  };
}

// ── Question 5 — years of experience ─────────────────────────────────────────────────────────────
// Owner's instruction 2026-08-30 (bucket 1 screening): after geography, ask how much experience the
// applicant has. Asked to EVERYONE and placed second-to-last, so it never gets between a CV and the
// role/region answers that route it — a manager still files themselves quickly, and this sits after.
//
// The ranges are exhaustive — fresh graduate through more than five years covers every applicant —
// so there is deliberately NO "Other" row. A closed, tappable band is worth more than a free-typed
// "about 4-ish years": it sorts, it filters, and it cannot arrive as junk in the column a manager
// reads. This is a NEW vocabulary, stored as its own declaration on the candidate.
export const candidateExperienceCodes = ["fresh", "lt_1", "1_3", "3_5", "gt_5"] as const;
export type CandidateExperienceCode = (typeof candidateExperienceCodes)[number];

/** What the applicant reads. Every label is well inside the 24-character row ceiling. The keys are
 *  quoted because `1_3` unquoted is a numeric-separator literal (the number 13), not a string key. */
export const candidateExperienceLabels: Record<CandidateExperienceCode, string> = {
  fresh: "Fresh graduate",
  lt_1: "Less than 1 year",
  "1_3": "1 - 3 years",
  "3_5": "3 - 5 years",
  gt_5: "More than 5 years",
};

// Order is least-to-most experience — a natural ladder, and there is no "Other" to keep last because
// the bands leave nothing uncovered.
const EXPERIENCE_MENU_ORDER: readonly CandidateExperienceCode[] = candidateExperienceCodes;

export function experienceMenu(): ClassifyMenu {
  return {
    body: "How many years of experience do you have?",
    buttonLabel: "Choose experience",
    rows: EXPERIENCE_MENU_ORDER.map((code) => rowFor("experience", code, candidateExperienceLabels[code])),
    sectionTitle: "Experience",
    step: "experience",
  };
}

/** True for an experience band we offer — guards a stale value arriving in a reply. There is no
 *  "Other" escape here, so unlike the region/background guards this rejects everything else outright. */
export function isOfferedExperience(value: string): value is CandidateExperienceCode {
  return (candidateExperienceCodes as readonly string[]).includes(value);
}

// ── Question 6 — expected salary ─────────────────────────────────────────────────────────────────
// Owner's instruction 2026-08-30: the last question. Free text, not a band, and on purpose — an
// expected salary is a figure the applicant names, and offering ranges would both anchor them and
// force a real answer into a bucket. So it is typed, stored VERBATIM, and never coerced to a number:
// applicants write "negotiable", a range, or Arabic numerals, and every one of those is a truthful
// answer a recruiter can read. Placed dead last because it is the highest-friction question — an
// applicant who drops here has already answered everything else.
//
// Plain text, like the "Other" follow-ups: there is nothing to tap, so the reply arrives as an
// ordinary inbound message the webhook routes into the session before buffering it as CV context.
export const EXPECTED_SALARY_MAX = 60;

export function salaryPromptText(): string {
  return [
    "Last question — what monthly net salary are you looking for?",
    "",
    'Send it as a normal message, in EGP. You can write a number, a range, or "negotiable".',
  ].join("\n");
}

/**
 * The figure inside a salary answer, when the answer IS just a figure — otherwise nothing.
 *
 * `ats_candidates.expected_salary` is numeric and every other writer fills it with a real figure,
 * so it may only ever receive a number. This is deliberately strict. "12000" and "12,000" are one
 * number written two ways and both parse; "25 k to 30 k" is a RANGE, "negotiable" is not a figure
 * at all, and pulling the first number out of either would print a precise answer nobody gave.
 * Those keep their own words in `declared_expected_salary`, which is the column a recruiter reads.
 *
 * Before 2026-09-02 the verbatim answer went straight at the numeric column and the cast failed —
 * 31 of 42 answered salaries in production — taking the other five answers in the same update down
 * with it. The prompt itself invites the shape that broke it — it says, in so many words, "You
 * can write a number, a range, or negotiable".
 */
export function parseDeclaredSalaryFigure(raw: string | null | undefined): number | null {
  const cleaned = String(raw ?? "")
    .trim()
    .replace(/,/g, "");
  if (!/^[0-9]+(\.[0-9]+)?$/.test(cleaned)) return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

/** Sent when the typed salary is longer than a figure should be — someone pasted a sentence. Names
 *  the limit, quotes nothing back, and reads naturally (the shared nudge would say "a expected
 *  salary"). */
export function salaryTooLongText(): string {
  return [
    "That looks a little long for a salary.",
    "",
    `Please send just the amount — up to ${EXPECTED_SALARY_MAX} characters, for example "12000" or "negotiable".`,
  ].join("\n");
}

/** The closing message's opening line, in code. The owner may reword it on the Screening Questions
 *  screen (`closing_intro`); the summary lines under it are written from his applicant's own answers
 *  and are deliberately not editable. */
export const CLOSING_INTRO_DEFAULT = "Thank you — your application is now recorded as:";

/** The last line of that same message (`closing_outro`). */
export const CLOSING_OUTRO_DEFAULT =
  "Our HR team will review your CV and contact you if there is a suitable opening.";

/**
 * The closing message, sent once the answers are in. Plain text, not a menu.
 *
 * Background, experience and expected salary are shown when given (everyone is asked, so they are
 * normally present); the area line is shown only for a Medical Rep, who is the only role asked it —
 * a manager's confirmation reading "Area: —" would look like they missed a question never shown.
 *
 * THE FIRST AND LAST LINES ARE THE OWNER'S to reword; everything between them is generated. Keeping
 * that split is the whole safety property here: a free-typed copy of "Role: …" could tell somebody
 * their application was recorded against a role they never chose.
 */
export function classifyThankYouText(input: {
  roleLabel: string;
  backgroundLabel: string | null;
  /**
   * Nullable since 2026-09-05, when the region question became one the owner can narrow to
   * particular job titles. Before that it was asked to everybody, so a non-null region was a safe
   * assumption; now an Office Coordinator can legitimately finish the conversation without one, and
   * a required field here is what would have turned that into an applicant who gets no reply at all.
   */
  regionLabel: string | null;
  areaName: string | null;
  experienceLabel: string | null;
  expectedSalary: string | null;
  /** The owner's saved wording for the first and last lines, when he has any. */
  overrides?: AutoReplyOverrides | null;
}): string {
  const lines = [
    resolveAutoReply({ fallback: CLOSING_INTRO_DEFAULT, key: "closing_intro", overrides: input.overrides }),
    "",
    `Role: ${input.roleLabel}`,
  ];
  if (input.backgroundLabel) lines.push(`Background: ${input.backgroundLabel}`);
  // Printed only when there is one — same rule as every other optional line below. A question the
  // applicant was never asked has no place in the summary of what they told us.
  if (input.regionLabel) lines.push(`Region: ${input.regionLabel}`);
  if (input.areaName) lines.push(`Area: ${input.areaName}`);
  if (input.experienceLabel) lines.push(`Experience: ${input.experienceLabel}`);
  if (input.expectedSalary) lines.push(`Expected salary: ${input.expectedSalary}`);
  lines.push(
    "",
    resolveAutoReply({ fallback: CLOSING_OUTRO_DEFAULT, key: "closing_outro", overrides: input.overrides }),
  );
  return lines.join("\n");
}

// ── Re-asking a conversation that stalled ────────────────────────────────────────────────────────
// A CV arriving while a conversation is still open used to be met with total silence: the sender
// already had a row, so nothing was sent and nothing recorded that nothing was sent. Measured on
// production 2026-09-02 that had parked 68 conversations, 22 of them on question one with not a
// single answer, and three of those senders had sent a SECOND CV into the silence. Sending another
// CV is exactly the signal that somebody is trying again, so it re-asks the question they are
// parked on rather than starting a parallel conversation (which the partial unique index would
// reject anyway).

/**
 * How long a conversation must have been quiet before a fresh CV re-asks its question.
 *
 * Guards the ordinary case rather than the stalled one: an applicant who taps an answer and sends a
 * second document moments later is mid-conversation, not stuck, and must not be asked the same
 * thing twice. A genuinely parked conversation is silent for hours, so an hour separates them
 * cleanly with room to spare.
 */
export const CLASSIFY_REASK_QUIET_MS = 60 * 60 * 1000;

/**
 * True when a parked conversation has been quiet long enough that a new CV should re-ask.
 *
 * An unreadable or absent timestamp answers TRUE deliberately. Silence is the failure this exists
 * to end; a duplicate question is the smaller harm of the two.
 */
export function shouldReaskParkedSession(input: { updatedAt: string | null; nowMs: number }): boolean {
  if (!input.updatedAt) return true;
  const last = Date.parse(input.updatedAt);
  if (!Number.isFinite(last)) return true;
  return input.nowMs - last >= CLASSIFY_REASK_QUIET_MS;
}

/** What to re-send. `salary` carries no body: it is the one prompt whose wording is resolved async. */
export type ClassifyReaskPrompt =
  | { kind: "menu"; menu: ClassifyMenu; regionLabel: string | null }
  | { kind: "text"; body: string }
  | { kind: "salary" }
  // Like `salary`, a marker rather than a body — and for a stronger reason. The extra question lives
  // in the database and is scoped to the role the applicant tapped, so only the session layer can
  // resolve it. This file must not reach for it.
  | { kind: "extra" };

/**
 * The question a parked conversation is waiting on, ready to send again.
 *
 * Null means there is nothing sensible to re-ask, and the caller stays quiet: `done` (finished), an
 * `area` step whose region is missing or has no areas left, and any step this file does not know.
 * Null is a decision, never a fallback — every step in `classifySessionSteps` except `done` is
 * covered, and so is `extra`, which is absent from that union only because the admin-defined loop
 * owns its own vocabulary.
 *
 * `extra` WAS deliberately excluded when this was written, on the grounds that no session was parked
 * there. That was true, and it was true because the admin-defined questions had gone live only hours
 * earlier — so the first applicant to reach them and go quiet would have met exactly the permanent
 * silence the rest of this function exists to end. "Nobody is standing there yet" dates badly.
 */
export function reaskPromptForStep(input: {
  step: string;
  regionCode: string | null;
  areaNames: readonly string[];
}): ClassifyReaskPrompt | null {
  switch (input.step) {
    case "job_title":
      return { kind: "menu", menu: jobTitleMenu(), regionLabel: null };
    case "job_title_other":
      return { kind: "text", body: jobTitleOtherPromptText() };
    case "background":
      return { kind: "menu", menu: backgroundMenu(), regionLabel: null };
    case "background_other":
      return { kind: "text", body: backgroundOtherPromptText() };
    case "region":
      return { kind: "menu", menu: regionMenu(), regionLabel: null };
    case "region_other":
      return { kind: "text", body: regionOtherPromptText() };
    case "area": {
      // The one step whose menu is built from live data. With no region on the row, or a region
      // whose areas have since gone, there is no menu to build — and an empty one is a 400 from
      // Meta, not a truncation, so it must not be attempted.
      const code = input.regionCode;
      if (!code || !isOfferedRegion(code) || input.areaNames.length === 0) return null;
      return { kind: "menu", menu: areaMenu(code, input.areaNames), regionLabel: candidateRegionLabels[code] };
    }
    case "area_other":
      return { kind: "text", body: areaOtherPromptText() };
    case "experience":
      return { kind: "menu", menu: experienceMenu(), regionLabel: null };
    case "salary":
      return { kind: "salary" };
    // Written by the admin-defined question loop, which is why this switch is on `string` and not on
    // ClassifySessionStep — that union deliberately stops at the fixed six.
    case "extra":
      return { kind: "extra" };
    default:
      return null;
  }
}

// ── Validation ───────────────────────────────────────────────────────────────────────────────────
// Runs on any menu before it is sent. Meta rejects the whole message on a violation, so catching it
// here turns a silent dead end into a loud, testable failure.
export function menuViolations(menu: ClassifyMenu): string[] {
  const problems: string[] = [];
  if (menu.rows.length === 0) problems.push(`${menu.step}: no rows`);
  if (menu.rows.length > WHATSAPP_LIST_MAX_ROWS) {
    problems.push(`${menu.step}: ${menu.rows.length} rows exceeds the ${WHATSAPP_LIST_MAX_ROWS}-row cap`);
  }
  if (menu.body.length > WHATSAPP_BODY_MAX) problems.push(`${menu.step}: body over ${WHATSAPP_BODY_MAX}`);
  if (menu.buttonLabel.length > WHATSAPP_LIST_BUTTON_MAX) {
    problems.push(`${menu.step}: button label "${menu.buttonLabel}" over ${WHATSAPP_LIST_BUTTON_MAX}`);
  }
  if (menu.sectionTitle.length > WHATSAPP_SECTION_TITLE_MAX) {
    problems.push(`${menu.step}: section title over ${WHATSAPP_SECTION_TITLE_MAX}`);
  }
  const seen = new Set<string>();
  for (const row of menu.rows) {
    if (row.title.length > WHATSAPP_ROW_TITLE_MAX) {
      problems.push(`${menu.step}: row title "${row.title}" is ${row.title.length}, over ${WHATSAPP_ROW_TITLE_MAX}`);
    }
    if (!row.title.trim()) problems.push(`${menu.step}: a row has an empty title`);
    if ((row.description?.length ?? 0) > WHATSAPP_ROW_DESCRIPTION_MAX) {
      problems.push(`${menu.step}: row description over ${WHATSAPP_ROW_DESCRIPTION_MAX}`);
    }
    if (seen.has(row.id)) problems.push(`${menu.step}: duplicate row id ${row.id}`);
    seen.add(row.id);
  }
  return problems;
}

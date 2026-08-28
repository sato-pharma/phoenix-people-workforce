// Recruitment / ATS — the three menus a CV sender taps to say what they are applying for.
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
export type ClassifyStep = "job_title" | "region" | "area";

/**
 * Every value the session's `step` column may hold — the three tappable steps, plus the typed
 * follow-up after "Other", plus the terminal state. Kept separate from `ClassifyStep` on purpose:
 * `job_title_other` has no menu and no row ids, so letting it into `ClassifyStep` would imply a
 * list that cannot exist. This union is the same vocabulary as the table's CHECK constraint.
 */
export type ClassifySessionStep = ClassifyStep | "job_title_other" | "done";

export const classifySessionSteps: readonly ClassifySessionStep[] = [
  "job_title",
  "job_title_other",
  "region",
  "area",
  "done",
];

export type ClassifyRow = {
  /** Row id sent back to us verbatim when tapped. Namespaced so a stray reply can't be misread. */
  id: string;
  /** What the candidate sees. Never an ellipsis — see the override maps below. */
  title: string;
  /** Second line. Carries the FULL name whenever the title had to be shortened to fit. */
  description?: string;
};

export type ClassifyMenu = {
  step: ClassifyStep;
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
  if (step !== "job_title" && step !== "region" && step !== "area") return null;
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

function rowFor(step: ClassifyStep, value: string, fullName: string, shortTitle?: string): ClassifyRow {
  const title = shortTitle ?? fullName;
  // The description repeats the full name ONLY when the title is not already it — a second line
  // saying the same words twice reads as a bug.
  return title === fullName
    ? { id: classifyRowId(step, value), title }
    : { description: fullName.slice(0, WHATSAPP_ROW_DESCRIPTION_MAX), id: classifyRowId(step, value), title };
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
  "human_resources",
  "finance",
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

export function cleanTypedJobTitle(raw: string | null | undefined): string | null {
  const cleaned = String(raw ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return null;
  if (cleaned.length > JOB_TITLE_OTHER_MAX) return null;
  return cleaned;
}

// ── Question 2 — which region? ───────────────────────────────────────────────────────────────────
// The company regions that CAN be followed by question 3. The caller passes which ones those are,
// read live from au.canonical_areas, and the menu never offers one that has no areas behind it.
//
// This used to be `candidateRegionCodes` verbatim, with a comment explaining that au.regions also
// carries `UE-1`/`UE-2` — regions with ZERO active areas that would walk an applicant to question 3
// and show an empty list. That was a hazard held off by a hand-maintained list, and it went stale
// the moment a real region joined the vocabulary before its areas moved: "Delta (3)" was added to
// the pool's Region filter on 2026-08-28, while the sales geography move behind it waits on the
// August closing. Deriving the offer from the areas themselves fixes both cases at once — UE-1 and
// UE-2 stay out because they have no areas, and Delta (3) starts being offered by itself, with no
// second code change, on the day its areas arrive.
//
// Ordered by `candidateRegionCodes` rather than by the caller's set, so the list a candidate sees
// keeps the company's own order however the areas were read.
export function regionMenu(offeredCodes: readonly CandidateRegionCode[]): ClassifyMenu {
  const offered = new Set<string>(offeredCodes);
  return {
    body: "Which region would you like to work in?",
    buttonLabel: "Choose a region",
    rows: candidateRegionCodes
      .filter((code) => offered.has(code))
      .map((code) => rowFor("region", code, candidateRegionLabels[code])),
    sectionTitle: "Regions",
    step: "region",
  };
}

/**
 * True for a region we are willing to offer — guards against a stale code arriving in a reply.
 * `offeredCodes` is the same set the menu was built from, so a candidate who kept an old message
 * open cannot answer with a region that has since stopped being offered.
 */
export function isOfferedRegion(
  value: string,
  offeredCodes: readonly CandidateRegionCode[],
): value is CandidateRegionCode {
  return (offeredCodes as readonly string[]).includes(value);
}

/** True for a role family we offered. Same guard, for question 1. */
export function isOfferedRoleFamily(value: string): value is CandidateRoleFamily {
  return (candidateRoleFamilies as readonly string[]).includes(value);
}

// ── Question 3 — which area? ─────────────────────────────────────────────────────────────────────
// Areas are passed in because they are read live from au.canonical_areas. Largest region is Others
// at 9 active areas, so every region fits the 10-row cap with a row to spare — but the cap is
// enforced here anyway rather than assumed, because an org change could add a tenth and a silently
// dropped area is a territory no candidate can ever choose.
export function areaMenu(regionCode: CandidateRegionCode, areaNames: readonly string[]): ClassifyMenu {
  const rows = areaNames
    .map((name) => name.trim())
    .filter((name) => name.length > 0)
    .slice(0, WHATSAPP_LIST_MAX_ROWS)
    .map((name) => rowFor("area", name, name, LONG_AREA_TITLES[name]));

  return {
    body: `Which area inside ${candidateRegionLabels[regionCode]}?`,
    buttonLabel: "Choose an area",
    rows,
    sectionTitle: "Areas",
    step: "area",
  };
}

/** The closing message, sent once all three answers are in. Plain text, not a menu. */
export function classifyThankYouText(input: { roleLabel: string; regionLabel: string; areaName: string }): string {
  return [
    "Thank you — your application is now recorded as:",
    "",
    `Role: ${input.roleLabel}`,
    `Region: ${input.regionLabel}`,
    `Area: ${input.areaName}`,
    "",
    "Our HR team will review your CV and contact you if there is a suitable opening.",
  ].join("\n");
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

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
//   role   -> `candidateRoleFamilyLabels` (candidate-role-family.ts) — the same 9 families the
//             pool's Role filter already offers, so an answer lands in the vocabulary the filter reads.
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

export type ClassifyStep = "job_title" | "region" | "area";

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

// ── Titles that do not fit 24 characters ─────────────────────────────────────────────────────────
// Listed explicitly rather than truncated. The owner's standing rule is that text is never cut with
// an ellipsis, so the shortened form is a real abbreviation a person would write, and the full name
// is carried on the description line where all 72 characters are available.
const LONG_ROLE_TITLES: Partial<Record<CandidateRoleFamily, string>> = {
  // "Sales & Business Development" is 28 characters.
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
// The 9 families, most-applied-for first rather than alphabetically: this pool is overwhelmingly
// medical reps, and a list is read top-down. "Other" is last because it is the answer that means
// "none of these", and offering it early invites it.
const ROLE_MENU_ORDER: CandidateRoleFamily[] = [
  "medical_rep",
  "district_manager",
  "area_regional_manager",
  "product_manager",
  "sales",
  "pharmacist",
  "human_resources",
  "finance",
  "other",
];

export function jobTitleMenu(): ClassifyMenu {
  return {
    body: "Thanks for sending your CV to Sato Pharma. To get it to the right manager, please tell us what you are applying for.",
    buttonLabel: "Choose a role",
    rows: ROLE_MENU_ORDER.map((family) =>
      rowFor("job_title", family, candidateRoleFamilyLabels[family], LONG_ROLE_TITLES[family]),
    ),
    sectionTitle: "Roles",
    step: "job_title",
  };
}

// ── Question 2 — which region? ───────────────────────────────────────────────────────────────────
// The 7 company regions. Deliberately NOT read from au.regions live: that table also carries
// `UE-1` and `UE-2`, which have ZERO active areas (verified 2026-08-28) and would dead-end the
// candidate at question 3 with an empty list. `candidateRegionCodes` is the reviewed 7 that have
// areas, and it is the same vocabulary the pool's Region filter offers.
export function regionMenu(): ClassifyMenu {
  return {
    body: "Which region would you like to work in?",
    buttonLabel: "Choose a region",
    rows: candidateRegionCodes.map((code) => rowFor("region", code, candidateRegionLabels[code])),
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

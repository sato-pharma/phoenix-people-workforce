// Recruitment workspace — "Place this candidate": HR types the answers the WhatsApp bot never got,
// and the candidate is filed from them (owner, 20 Oct 2026, on Needs placing: "pick Applying for from
// a list, then the region, then the areas of that region, and answer most of the WhatsApp questions by
// hand, so he is placed correctly based on my entries").
//
// EVERY ANSWER GOES THROUGH THE ONE ANSWER SAVER (`saveCandidateWhatsAppAnswer`), so each one HR types
// carries the "added by HR · name · time" mark and its own audit row, exactly as an answer edited on
// the table does. An answer HR did NOT change is never re-saved: re-saving it would stamp the
// applicant's own reply as HR's.
//
// ONE FILING, AT THE END. The answers are saved with re-filing switched off, then the person is filed
// once by `placeCandidate` — HR's placement, with its audit row and the completeness recompute — so a
// form of ten answers is one filing, not three. A changed role also takes the person out of the tabs
// their OLD answers filed them in (the bot's and the careers form's rows only — never HR's), which is
// what correcting a role answer has always done.
//
// Every refusal happens BEFORE the first write, so a refused form leaves the record as it was.

import type { AccessContext } from "@/lib/auth/permissions";
import { notFoundError, validationError } from "@/lib/http/api-errors";
import { candidateRoleFamilyLabels, type CandidateRoleFamily } from "@/lib/recruitment/candidate-role-family";
import { recruitmentDb, textOrNull } from "@/lib/recruitment/db";
import { saveCandidateWhatsAppAnswer } from "@/lib/recruitment/whatsapp-answer-edit";
import { whatsAppAnswerEditPayload } from "@/lib/recruitment/whatsapp-answer-edit-rules";
import { loadAnswerChipContext, placingQuestionsFor } from "@/lib/recruitment/workspace/answer-chips";
import { assertWorkspaceWorker, placeCandidate } from "@/lib/recruitment/workspace/candidate-actions";
import { validRegionCode } from "@/lib/recruitment/workspace/placement-from-reply";
import { ANSWER_PLACEMENT_SOURCES, removePlacementsWhere } from "@/lib/recruitment/workspace/placements-db";
import { findWorkspaceArea, loadWorkspacePlaces } from "@/lib/recruitment/workspace/places";
import {
  PLACING_BUILT_IN_KEYS,
  placingRefusal,
  placingRoleFamilies,
  placingShape,
  type PlacingInput,
  type PlacingQuestion,
} from "@/lib/recruitment/workspace/placing-rules";
import type { WorkspacePlacement, WorkspacePlaces } from "@/lib/recruitment/workspace/types";

const PLACING_COLUMNS =
  "id,declared_role_family,declared_background,declared_experience,declared_expected_salary,screening_extra_answers,preferred_region_code,preferred_area_name";

type PlacingRow = {
  id: string;
  declared_role_family: string | null;
  declared_background: string | null;
  declared_experience: string | null;
  declared_expected_salary: string | null;
  screening_extra_answers: Record<string, unknown> | null;
  preferred_region_code: string | null;
  preferred_area_name: string | null;
};

/** What the form opens with: the role, its questions and places, and every answer already on record. */
export type PlacingForm = {
  /** The role families this viewer may choose, in the bot's menu order, with the bot's labels. */
  roles: { family: CandidateRoleFamily; label: string }[];
  /** The chosen (or already declared) role, when it is one of `roles`. */
  roleFamily: CandidateRoleFamily | null;
  questions: PlacingQuestion[];
  places: WorkspacePlaces;
  /** The answers on record, by chip key — the form starts from them. */
  current: Record<string, string>;
  regionCode: string | null;
  areaCode: string | null;
};

async function readPlacingRow(candidateId: string): Promise<PlacingRow> {
  const { data, error } = await recruitmentDb().from("ats_candidates").select(PLACING_COLUMNS).eq("id", candidateId).maybeSingle();
  if (error) throw error;
  if (!data) throw notFoundError("Candidate not found.");
  return data as unknown as PlacingRow;
}

/** The answers on record, by chip key. Own keys only — `constructor` is a valid question key. */
function currentAnswers(row: PlacingRow): Record<string, string> {
  // No prototype, so a question keyed `constructor` or `toString` reads as unanswered, never as a function.
  const out: Record<string, string> = Object.create(null);
  const put = (key: string, raw: unknown) => {
    const value = textOrNull(raw);
    if (value) out[key] = value;
  };
  put("background", row.declared_background);
  put("experience", row.declared_experience);
  put("salary", row.declared_expected_salary);
  const extras = row.screening_extra_answers ?? {};
  for (const key of Object.keys(extras)) put(key, extras[key]);
  return out;
}

/** The answer saver's key for a chip key: a built-in by its own name, an admin question as `extra:<key>`. */
function editKeyFor(chipKey: string): string {
  return (PLACING_BUILT_IN_KEYS as readonly string[]).includes(chipKey) ? chipKey : `extra:${chipKey}`;
}

function sameAnswer(a: string | null | undefined, b: string | null | undefined): boolean {
  return (textOrNull(a) ?? "").toLowerCase() === (textOrNull(b) ?? "").toLowerCase();
}

/** The form for one candidate, for the role asked about (or the role they already declared). */
export async function loadPlacingForm(access: AccessContext, candidateId: string, requestedFamily: string | null): Promise<PlacingForm> {
  const viewer = assertWorkspaceWorker(access);
  const row = await readPlacingRow(candidateId);
  const roles = placingRoleFamilies(viewer.roleTabs);
  const offered = (family: string | null): CandidateRoleFamily | null =>
    family && (roles as readonly string[]).includes(family) ? (family as CandidateRoleFamily) : null;
  const wanted = textOrNull(requestedFamily);
  if (wanted && !offered(wanted)) throw validationError("Choose one of the roles on the list.");
  const roleFamily = offered(wanted) ?? offered(row.declared_role_family);

  const shape = placingShape(roleFamily);
  const [context, places] = await Promise.all([
    loadAnswerChipContext(),
    shape.region && shape.tab ? loadWorkspacePlaces(shape.tab) : Promise.resolve<WorkspacePlaces>({ regions: [] }),
  ]);
  const regionCode = shape.region ? validRegionCode(row.preferred_region_code) : null;
  const areaName = textOrNull(row.preferred_area_name)?.toLowerCase() ?? null;
  const area =
    shape.area && regionCode && areaName
      ? places.regions.find((region) => region.code === regionCode)?.areas.find((entry) => entry.name.toLowerCase() === areaName) ?? null
      : null;

  return {
    areaCode: area?.code ?? null,
    current: currentAnswers(row),
    places,
    questions: roleFamily ? placingQuestionsFor(roleFamily, context) : [],
    regionCode,
    roleFamily,
    roles: roles.map((family) => ({ family, label: candidateRoleFamilyLabels[family] })),
  };
}

/**
 * Saves what HR typed and files the person. Answers with every tab they are now filed in, and the chip
 * keys whose answers changed.
 */
export async function placeWithAnswers(
  access: AccessContext,
  candidateId: string,
  input: PlacingInput,
): Promise<{ placements: WorkspacePlacement[]; saved: string[] }> {
  const viewer = assertWorkspaceWorker(access);
  const refusal = placingRefusal(input, viewer.roleTabs);
  if (refusal) throw validationError(refusal);
  const roleFamily = (input.roleFamily ?? "").trim() as CandidateRoleFamily;
  const roleTab = placingShape(roleFamily).tab;
  if (!roleTab) throw validationError("That role files in no tab. Choose another.");

  // ── Every check before the first write ──────────────────────────────────────────────────────────
  const regionCode = textOrNull(input.regionCode) ? validRegionCode(input.regionCode) : null;
  if (textOrNull(input.regionCode) && !regionCode) throw validationError("That is not one of the recruitment regions.");
  let area: { code: string; name: string } | null = null;
  if (textOrNull(input.areaCode)) {
    const found = await findWorkspaceArea(String(input.areaCode));
    if (!found) throw validationError("That area is not one of the company's active areas.");
    if (found.regionCode !== regionCode) throw validationError("That area is not in the region you chose.");
    area = { code: found.code, name: found.name };
  }

  const row = await readPlacingRow(candidateId);
  const context = await loadAnswerChipContext();
  const asked = new Set(placingQuestionsFor(roleFamily, context).map((question) => question.key));
  const current = currentAnswers(row);
  const changes: [string, string | null][] = [];
  for (const [key, raw] of Object.entries(input.answers ?? {})) {
    if (!asked.has(key)) throw validationError("That is not one of the questions for this role.");
    const value = textOrNull(raw);
    const check = whatsAppAnswerEditPayload(editKeyFor(key), value, {});
    if (!check.ok) throw validationError(check.message);
    if (!sameAnswer(current[key], value)) changes.push([key, value]);
  }

  // ── The answers, then the three that file the person, then one filing ───────────────────────────
  const actor = { hrId: access.hrId ?? null, loginId: access.loginId ?? null };
  const quiet = { recompute: false, refile: false };
  const saved: string[] = [];
  for (const [key, value] of changes) {
    await saveCandidateWhatsAppAnswer(candidateId, editKeyFor(key), value, actor, quiet);
    saved.push(key);
  }
  const roleChanged = row.declared_role_family !== roleFamily;
  if (roleChanged) {
    // The menu's own label, which the answer saver reads back to this exact family.
    await saveCandidateWhatsAppAnswer(candidateId, "job_title", candidateRoleFamilyLabels[roleFamily], actor, quiet);
    saved.push("role");
  }
  if (regionCode && validRegionCode(row.preferred_region_code) !== regionCode) {
    await saveCandidateWhatsAppAnswer(candidateId, "region", regionCode, actor, quiet);
    saved.push("region");
  }
  if (area && !sameAnswer(row.preferred_area_name, area.name)) {
    await saveCandidateWhatsAppAnswer(candidateId, "area", area.name, actor, quiet);
    saved.push("area");
  }
  // Every tab the person's OWN answers filed them in, other than this role's, goes — decided from the
  // placements on record, never from whether the role changed in this save: a retry after a save that
  // stored the new role and then failed would otherwise see no change and leave them in two tabs.
  // HR's own placements in other tabs stay; taking one of those out is its own act.
  await removePlacementsWhere({ candidateId, exceptRoleTab: roleTab, placedBy: ANSWER_PLACEMENT_SOURCES });

  const placements = await placeCandidate(access, candidateId, { areaCode: area?.code ?? null, regionCode, roleTab });
  return { placements, saved };
}

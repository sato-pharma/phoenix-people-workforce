// Recruitment workspace — the region and area answers are CHOSEN from the company's own list, never
// typed, and a save that leaves the CV in Needs placing says why. PURE.
//
// WHY (Talent Acquisition's report, 24 Nov 2026: "there is an issue in Needs placing"). The table's
// region and area cells were free text. She typed what the applicant said — "kom hamada", "Cairo",
// "Kafrelsheikh", "Shobra", "Facous", and "Behiera 1" in the REGION cell — and every save answered
// "Saved" while the CV stayed in Needs placing: a typed region that is not one of the eight is kept as
// words with no code, and a typed area the AU directory does not know files nobody (a Medical Rep is
// placed only with a known area — "PLACED MEANS POSITION, REGION AND AREA", owner 2026-11-15). Nothing
// on screen said so.
//
// So the two cells are drop-downs: the region lists the eight recruitment regions (saved by CODE, the
// way a tap is), and the area lists every active company area under its recruitment region — the same
// list the WhatsApp bot offers and the placing form uses (`loadWorkspacePlaces("medical_rep")`), saved
// by its canonical NAME, which is what `resolveAuArea` matches. Choosing an area alone files a Medical
// Rep whole: the area carries its own region (`placementFromReply`). An answer already stored that is
// not on the list stays selectable (the chip keeps the current value), so nothing is lost by opening it.

import { candidateRegionCodes, candidateRegionLabels } from "@/lib/recruitment/candidate-region";
import { roleTabForFamily } from "@/lib/recruitment/workspace/role-tabs";
import type { WorkspacePlaces } from "@/lib/recruitment/workspace/types";

export type PlaceAnswerOption = { value: string; label: string };

/** The region and area answers' choices, keyed by the chip key they belong to. */
export type PlaceAnswerOptions = { region: PlaceAnswerOption[]; area: PlaceAnswerOption[] };

/** The answer keys whose save can file (or un-file) a person. */
export const PLACING_ANSWER_KEYS: readonly string[] = ["job_title", "region", "area"];

/**
 * The two lists from the Medical Rep places (every active area, grouped under its recruitment region).
 * The regions are all eight, whatever the places hold, so a District Manager's region is always choosable.
 */
export function placeAnswerOptions(places: WorkspacePlaces | null | undefined): PlaceAnswerOptions {
  const region = candidateRegionCodes.map((code) => ({ label: candidateRegionLabels[code], value: code }));
  const area: PlaceAnswerOption[] = [];
  const seen = new Set<string>();
  for (const entry of places?.regions ?? []) {
    for (const item of entry.areas) {
      const key = item.name.trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      area.push({ label: `${item.name} · ${entry.name}`, value: item.name });
    }
  }
  return { area, region };
}

export type PlacingGapInput = {
  /** `declared_role_family` after the save. */
  roleFamily: string | null | undefined;
  /** `preferred_region_code` after the save — null when the region was typed as words. */
  regionCode: string | null | undefined;
  /** The region as typed, when it is not one of the eight. */
  regionWords?: string | null | undefined;
  /** `preferred_area_name` after the save. */
  areaName: string | null | undefined;
  /** Whether that area name is one of the company's active areas. */
  areaKnown: boolean;
  /** Whether the person now sits whole in a role tab. */
  placed: boolean;
};

function clean(value: string | null | undefined): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  return text ? text : null;
}

/**
 * Why a person whose role, region or area was just saved is STILL in Needs placing, in one sentence —
 * or null when they are placed (or their role files with the role alone and nothing is missing).
 */
export function placingGap(input: PlacingGapInput): string | null {
  if (input.placed) return null;
  const tab = roleTabForFamily(clean(input.roleFamily));
  if (!tab) return "Still in Needs placing — choose what they are applying for first.";
  const regionWords = clean(input.regionWords);
  if (tab === "medical_rep") {
    const area = clean(input.areaName);
    if (area && !input.areaKnown) {
      return `Still in Needs placing — “${area}” is not one of the company's areas. Choose the area from the list.`;
    }
    if (!area) return "Still in Needs placing — a Medical Rep needs an area as well. Choose the area from the list.";
    return null;
  }
  if (tab === "district_manager" && !clean(input.regionCode)) {
    return regionWords
      ? `Still in Needs placing — “${regionWords}” is not one of the regions. Choose the region from the list.`
      : "Still in Needs placing — a District Manager needs a region. Choose the region from the list.";
  }
  return null;
}

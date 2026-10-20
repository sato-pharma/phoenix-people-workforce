// Recruitment workspace — where an applicant's OWN reply files them. Pure.
//
// THE RULE (owner, 2026-10-20: "we do not look at the cv we folder based on whatsapp replies"). The
// role the applicant tapped (or picked on the careers form) chooses the tab; the region and the area
// they gave choose the sub-tab. Nothing here reads a CV field, and nothing is guessed:
//
//   * a role that fits no tab (the retired Human Resources tap, or anything unknown) → null, so the
//     person waits in Needs placing rather than being filed somewhere a guess put them;
//   * a Medical Rep who named an area the AU directory does not know (a name with no area code) →
//     null as well: the area tab is the whole point of the Medical Rep tab, and a wrong one is worse
//     than none;
//   * a Medical Rep who gave no area at all → filed, area unspecified;
//   * a Medical Rep WITH a known area → the area's own recruitment region (recruitmentRegionForArea),
//     never the region they typed, so an area tab always sits under the region tab it belongs to;
//   * District Manager → region only; every other tab → region kept for the filters, area dropped.
//
// The database half (placements-db.ts) resolves the area name against `au_v_canonical_areas` and
// hands this function the code and the area's sales region; this file never reads anything.

import { candidateRegionCodes, recruitmentRegionForArea } from "@/lib/recruitment/candidate-region";
import { roleTabForFamily, type WorkspaceRoleTab } from "@/lib/recruitment/workspace/role-tabs";

export type PlacementReply = {
  /** The bot role family the applicant tapped (`declared_role_family`), e.g. "medical_rep". */
  roleFamily: string | null | undefined;
  /** The recruitment region code they answered (CA GZ AB D1 D2 D3 UE OT). */
  regionCode: string | null | undefined;
  /** The AU canonical area code their area answer resolved to. Null when it did not resolve. */
  areaCode: string | null | undefined;
  /** The area name as they gave it (or as the directory spells it). */
  areaName: string | null | undefined;
  /** The resolved area's sales region in `au.canonical_areas` (`code_region_code`). */
  areaSalesRegionCode?: string | null | undefined;
};

export type PlacementFromReply = {
  roleTab: WorkspaceRoleTab;
  botRoleFamily: string;
  regionCode: string | null;
  areaCode: string | null;
  areaName: string | null;
};

function clean(value: string | null | undefined): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  return text.length > 0 ? text : null;
}

/** A recruitment region code, upper-cased, or null when it is not one of the eight. */
export function validRegionCode(value: string | null | undefined): string | null {
  const code = clean(value)?.toUpperCase() ?? null;
  return code && (candidateRegionCodes as readonly string[]).includes(code) ? code : null;
}

/** The placement an applicant's own answers file them in, or null for Needs placing. */
export function placementFromReply(reply: PlacementReply): PlacementFromReply | null {
  const family = clean(reply.roleFamily);
  const roleTab = roleTabForFamily(family);
  if (!family || !roleTab) return null;

  const regionCode = validRegionCode(reply.regionCode);
  const areaCode = clean(reply.areaCode);
  const areaName = clean(reply.areaName);

  if (roleTab === "medical_rep") {
    // An area they named that the directory does not know: never guessed into a tab.
    if (areaName && !areaCode) return null;
    if (areaCode) {
      const salesRegion = clean(reply.areaSalesRegionCode);
      const areaRegion = salesRegion ? validRegionCode(recruitmentRegionForArea(areaName ?? "", salesRegion)) : null;
      return { roleTab, botRoleFamily: family, regionCode: areaRegion ?? regionCode, areaCode, areaName };
    }
    return { roleTab, botRoleFamily: family, regionCode, areaCode: null, areaName: null };
  }

  // District Manager is filed by region only; every other tab keeps the region for its filters.
  return { roleTab, botRoleFamily: family, regionCode, areaCode: null, areaName: null };
}

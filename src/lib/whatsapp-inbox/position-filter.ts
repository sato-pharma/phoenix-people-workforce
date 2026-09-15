// WhatsApp Inbox — filtering chats by the job the person applied for, then where.
//
// The owner's rule: a District Manager is hired for a REGION, so picking that position offers the
// regions; a Medical Representative is hired for an AREA inside a region, so picking that position
// offers the regions and then, once one is chosen, that region's areas. Other positions are not
// hired by place, and the applicant menu never asked them for one worth filtering on.
//
// Pure — no imports beyond the two vocabularies, which are pure too — because the list screen
// decides which filters to show with the same rules the server filters with.

import { candidateRegionCodes, type CandidateRegionCode } from "@/lib/recruitment/candidate-region";
import { candidateRoleFamilies, type CandidateRoleFamily } from "@/lib/recruitment/candidate-role-family";

/** A chat's position filter value when nothing says which job the person applied for. */
export const INBOX_NO_POSITION = "none";

export type InboxPositionFilter = CandidateRoleFamily | typeof INBOX_NO_POSITION;

/** One application as the filter reads it: the job, and the place the person chose for it. */
export type InboxPositionFact = {
  family: CandidateRoleFamily;
  regionCode: CandidateRegionCode | null;
  areaName: string | null;
};

export function isInboxRoleFamily(value: string | null | undefined): value is CandidateRoleFamily {
  return (candidateRoleFamilies as readonly string[]).includes(String(value));
}

export function isInboxRegionCode(value: string | null | undefined): value is CandidateRegionCode {
  return (candidateRegionCodes as readonly string[]).includes(String(value));
}

/** The position filter as the list understands it: a known family, "none", or no filter. */
export function parseInboxPositionFilter(value: string | null | undefined): InboxPositionFilter | null {
  const trimmed = String(value ?? "").trim();
  if (trimmed === INBOX_NO_POSITION) return INBOX_NO_POSITION;
  return isInboxRoleFamily(trimmed) ? trimmed : null;
}

/** District Managers and Medical Representatives are hired for a place; the Region filter shows for them. */
export function inboxPositionHasRegion(position: string | null | undefined): boolean {
  return position === "district_manager" || position === "medical_rep";
}

/** Only a Medical Representative is hired for an area; the Area filter shows once a region is chosen. */
export function inboxPositionHasArea(position: string | null | undefined): boolean {
  return position === "medical_rep";
}

/** Area names are compared the way people type them: case and spacing do not make a different area. */
export function inboxAreaKey(value: string | null | undefined): string {
  return String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

export type InboxPlaceFilter = { position: InboxPositionFilter | null; region: CandidateRegionCode | null; area: string | null };

/**
 * The three filters, each kept only where the one before it allows it — a region without a position
 * that is hired by region, or an area without a region, is dropped rather than quietly matching nothing.
 */
export function parseInboxPlaceFilter(input: {
  position?: string | null;
  region?: string | null;
  area?: string | null;
}): InboxPlaceFilter {
  const position = parseInboxPositionFilter(input.position);
  const regionRaw = String(input.region ?? "").trim();
  const region = inboxPositionHasRegion(position) && isInboxRegionCode(regionRaw) ? regionRaw : null;
  const areaRaw = String(input.area ?? "").trim().replace(/\s+/g, " ").slice(0, 80);
  const area = region && inboxPositionHasArea(position) && areaRaw ? areaRaw : null;
  return { area, position, region };
}

/** Whether one chat's applications pass the filter. The job, region and area must all be ONE application's. */
export function matchesInboxPlaceFilter(facts: readonly InboxPositionFact[], filter: InboxPlaceFilter): boolean {
  if (!filter.position) return true;
  if (filter.position === INBOX_NO_POSITION) return facts.length === 0;
  const areaKey = filter.area ? inboxAreaKey(filter.area) : null;
  return facts.some(
    (fact) =>
      fact.family === filter.position &&
      (!filter.region || fact.regionCode === filter.region) &&
      (!areaKey || inboxAreaKey(fact.areaName) === areaKey),
  );
}

/** The areas people actually chose for the filtered position and region, for the Area menu. */
export function inboxAreaOptions(allFacts: Iterable<readonly InboxPositionFact[]>, filter: InboxPlaceFilter): string[] {
  if (!filter.region || !inboxPositionHasArea(filter.position)) return [];
  const byKey = new Map<string, string>();
  for (const facts of allFacts) {
    for (const fact of facts) {
      if (fact.family !== filter.position || fact.regionCode !== filter.region || !fact.areaName) continue;
      const key = inboxAreaKey(fact.areaName);
      if (key && !byKey.has(key)) byKey.set(key, fact.areaName.trim().replace(/\s+/g, " "));
    }
  }
  return Array.from(byKey.values()).sort((a, b) => a.localeCompare(b, "en", { numeric: true, sensitivity: "base" }));
}

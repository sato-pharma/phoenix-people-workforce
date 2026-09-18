import type { AiUnknown } from "@/lib/sales/normalizer/ai-suggest";
import { buildAddressMatchIndex, matchByAddress, type AddressMatchIndex } from "@/lib/sales/normalizer/customer-address-match";
import { customerPharmacyKey } from "@/lib/sales/normalizer/customer-normalize";
import { buildPlaceGazetteer, placeFromName, type PlaceBrick, type PlaceGazetteer } from "@/lib/sales/normalizer/customer-place-match";
import { buildPropagationIndex, propagateSuggestions, type MappedCustomerRow, type PropagatedSuggestion, type PropagationIndex } from "@/lib/sales/normalizer/customer-propagate";

// The free half of the customer pipeline (customer-suggest.ts): everything answered here costs no
// AI call. Pure — no I/O. The owner asked for it on 2026-09-18, when AI suggest cost about $2 for
// 2,000 customers with 28,000 more waiting: "make it by steps … then fall back to the AI assist",
// and "pass by the whole customers … to group them and don't duplicate the work".
//
// The order is the one measured that day on 300 held-out Pharma Overseas pharmacies whose brick the
// owner's own sources settled. Free steps first, then the AI at 60 a call for the rest: 262 right,
// 35 wrong, 3 unanswered — against 247, 36 and 17 for the pipeline before it, which sent all but
// the twins to the AI at 20 a call. On the 3,348 still-unmapped Pharma Overseas pharmacies the free
// steps answer 1,646, and the AI's estimated bill for the rest is about $0.92 instead of about $4.13.
//
//   0. group     identical pharmacy texts are ONE question — answered once, copied to every code
//   1. address   the same address as pharmacies already mapped (customer-address-match.ts)
//   2. twin      the same pharmacy name already mapped at any distributor (customer-propagate.ts)
//   3. place     one of our brick names inside the pharmacy's name (customer-place-match.ts)
//
// The owner's own order was name first, then address, then a map lookup, then the AI. Each of his
// steps was measured. The name step is kept, and runs after the two steps that measured more
// accurate, so a pharmacy they also answer gets their answer. A place named in the ADDRESS was
// wrong too often to answer, so it only vetoes step 3. The map lookup (LocationIQ or alike) is
// replaced by step 1, which needs no outside service and no key.

// Where each free step starts before geography is scored (customer-suggest.ts blends these with the
// geocode exactly as it always blended a twin's). The address match was the most accurate step
// measured; the place in the name was as accurate as the AI, never more.
export const ADDRESS_MATCH_CONFIDENCE = 90;
export const PLACE_IN_NAME_CONFIDENCE = 80;

export type PharmacyGroup = { key: string; representative: AiUnknown; members: AiUnknown[] };

/**
 * One group per distinct pharmacy text (customerPharmacyKey), in first-seen order. A customer whose
 * name normalizes to nothing is its own group with an empty key: the AI is shown its code, not a
 * name, so it is never the same question as another code.
 */
export function groupIdenticalPharmacies(unknowns: readonly AiUnknown[]): PharmacyGroup[] {
  const groups: PharmacyGroup[] = [];
  const byKey = new Map<string, PharmacyGroup>();
  for (const unknown of unknowns) {
    const key = customerPharmacyKey(unknown.rawName ?? "", unknown.rawAddress ?? "", unknown.rawTerritory ?? "");
    const group = key ? byKey.get(key) : undefined;
    if (group) {
      group.members.push(unknown);
      continue;
    }
    const created: PharmacyGroup = { key, members: [unknown], representative: unknown };
    if (key) byKey.set(key, created);
    groups.push(created);
  }
  return groups;
}

export type FreeStepIndexes = { address: AddressMatchIndex; places: PlaceGazetteer; twins: PropagationIndex };

/**
 * `mapped` is every active mapping, as customer-suggest.ts loads it. `bricks` is the live brick
 * master. The address index reads only mappings whose brick is still live, as it was measured; the
 * twin index reads them all, as it always has, and its answers are filtered to live bricks after.
 */
export function buildFreeStepIndexes(mapped: readonly MappedCustomerRow[], bricks: readonly PlaceBrick[]): FreeStepIndexes {
  const areaByBrick = new Map(bricks.map((brick) => [brick.brickId, brick.areaCode]));
  const live = mapped.filter((row) => areaByBrick.has(String(row.brickId).trim()));
  return {
    address: buildAddressMatchIndex(live.map((row) => ({ address: row.address, brickId: row.brickId })), areaByBrick),
    places: buildPlaceGazetteer(bricks),
    twins: buildPropagationIndex([...mapped]),
  };
}

export type FreeAnswer =
  | { source: "address"; code: string; confidence: number; evidence: { topScore: number; areaShare: number } }
  | { source: "propagated"; code: string; confidence: number; matchedFrom: PropagatedSuggestion["matchedFrom"]; addressCorroborated: boolean }
  | { source: "place"; code: string; confidence: number };

/** Steps 1–3 over the given pharmacies, keyed by `raw`. A pharmacy no step answers is absent. */
export function answerFromFreeSteps(
  unknowns: readonly AiUnknown[],
  indexes: FreeStepIndexes,
  isLiveBrick: (code: string) => boolean,
): Map<string, FreeAnswer> {
  const answers = new Map<string, FreeAnswer>();

  for (const unknown of unknowns) {
    const match = matchByAddress(indexes.address, unknown.rawAddress ?? "");
    if (match && isLiveBrick(match.brickId)) {
      answers.set(unknown.raw, {
        code: match.brickId,
        confidence: ADDRESS_MATCH_CONFIDENCE,
        evidence: { areaShare: match.areaShare, topScore: match.topScore },
        source: "address",
      });
    }
  }

  const afterAddress = unknowns.filter((unknown) => !answers.has(unknown.raw));
  for (const twin of propagateSuggestions(afterAddress, indexes.twins)) {
    if (!isLiveBrick(twin.code) || answers.has(twin.raw)) continue;
    answers.set(twin.raw, {
      addressCorroborated: twin.addressCorroborated,
      code: twin.code,
      confidence: twin.confidence,
      matchedFrom: twin.matchedFrom,
      source: "propagated",
    });
  }

  for (const unknown of unknowns) {
    if (answers.has(unknown.raw)) continue;
    const place = placeFromName(indexes.places, unknown.rawName ?? "", unknown.rawAddress ?? "");
    if (place && isLiveBrick(place.brickId)) {
      answers.set(unknown.raw, { code: place.brickId, confidence: PLACE_IN_NAME_CONFIDENCE, source: "place" });
    }
  }

  return answers;
}

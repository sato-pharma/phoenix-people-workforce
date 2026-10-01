/**
 * Phoenix CRM Wave 2 — which rows in different systems might be the same doctor or the same shop.
 *
 * Pure rules, no I/O. The caller hands in the candidate rows it has already read; this module
 * decides which pairs are worth a human's attention and says why in words he can check. It never
 * links anything: the owner confirms, one by one or in bulk (his ruling, 2026-09-30).
 *
 * 🔴 THE ENGINE IS DELIBERATELY PESSIMISTIC. A wrong link merges two real people's work into one
 * record, and the owner's standing rule is that a false positive is worse than a missed catch — so
 * every band below demands a name match AND a second independent fact, a one-word name is not
 * evidence at all, and a speciality conflict throws the pair out however well everything else
 * agrees. What it misses, he can still link by hand; what it wrongly offers, he has to notice.
 */

import { normalizeContactName } from "@/lib/crm/campaign-contact-match";
import { metresBetween } from "@/lib/crm/location-confidence";
import { placeNameKey } from "@/lib/geo/arabic-name-key";
import { isCertainWholesalerVenue } from "@/lib/venues/wholesaler-venue-guard";
import {
  BAND_ORDER,
  type DistributorCodePair,
  type EvidenceBand,
  type IdentityCandidate,
  type IdentitySuggestion,
} from "@/lib/customer-identity/types";

/**
 * How close two places must stand for the `strong` band.
 *
 * 200 m is the owner's own shape of the problem rather than a tuned figure: across all 127
 * validated customer-pharmacy links carrying GPS on both sides the median separation is 23 m and
 * the 90th percentile 272 m, so 200 m keeps the great majority of genuinely co-located pairs while
 * staying far inside the 4 km ceiling he set for a venue link. It only ever PROMOTES a pair that
 * already matched by name — distance alone suggests nothing.
 */
export const STRONG_METRES = 200;

/**
 * The folded key two names are compared on.
 *
 * `normalizeContactName` already strips titles, diacritics and punctuation and folds أ/إ/آ → ا,
 * ى → ي and ة → ه. On top of it this adds the EMPHATIC folding `placeNameKey` does — ض↔د and its
 * neighbours — because the same pharmacist is written "الرضا" in one system and "الردا" in
 * another, and a Latin transliteration of either has to land on the same key as both. Running the
 * two in that order rather than picking one is the whole point: the contact folding understands a
 * person's name, the place folding understands how Egyptian spelling actually varies.
 */
export function identityNameKey(raw: string | null | undefined): string {
  const contact = normalizeContactName(raw);
  if (!contact) return "";
  return placeNameKey(contact);
}

/**
 * 🔴 A ONE-WORD NAME IS NOT EVIDENCE. "أحمد" is one of the commonest first names in Egypt, so a
 * bare match on it would offer the owner two strangers and call them one doctor. Two tokens is the
 * floor — a first name and one more thing — which is the same floor `isMatchableName` sets for the
 * campaign matcher, applied here to the folded key so the count survives the folding.
 */
export function isLinkableName(raw: string | null | undefined): boolean {
  return normalizeContactName(raw).split(" ").filter(Boolean).length >= 2;
}

/**
 * The key a pair is remembered by, in both the suggestion list and a "not the same" ruling.
 *
 * Ordered, so (a, b) and (b, a) produce the SAME string. Without that a ruling made on one
 * ordering would never be found when the pair came back the other way round, and the owner would
 * be asked the same question again after he had already answered it.
 */
export function identityPairKey(
  left: Pick<IdentityCandidate, "source" | "sourceId">,
  right: Pick<IdentityCandidate, "source" | "sourceId">,
): string {
  const a = `${left.source}:${left.sourceId}`;
  const b = `${right.source}:${right.sourceId}`;
  return a <= b ? `${a}|${b}` : `${b}|${a}`;
}

/** The stronger of two bands, so a pair keeps the best evidence any rule found for it. */
export function betterBand(a: EvidenceBand, b: EvidenceBand): EvidenceBand {
  return BAND_ORDER.indexOf(a) >= BAND_ORDER.indexOf(b) ? a : b;
}

/**
 * 🔴 A SPECIALITY CONFLICT VETOES THE PAIR, whatever else agrees.
 *
 * Two doctors of the same name in the same city are common; one of them being a paediatrician and
 * the other a surgeon is the cheapest proof available that they are two people. A blank on either
 * side is NOT a conflict — most rows carry no speciality at all, and treating absence as
 * disagreement would veto nearly every real pair.
 */
export function specialityConflicts(left: IdentityCandidate, right: IdentityCandidate): boolean {
  const a = identityNameKey(left.speciality);
  const b = identityNameKey(right.speciality);
  if (!a || !b) return false;
  return a !== b;
}

/** Digits only, so `+20 100 123 4567` and `01001234567` are one number. */
function phoneKey(raw: string | null | undefined): string {
  const digits = String(raw ?? "").replace(/\D+/g, "");
  if (digits.length < 9) return "";
  // Egyptian numbers reach the same handset as 01…, 201… or 00201… — compare the last nine.
  return digits.slice(-9);
}

function bothHavePoint(left: IdentityCandidate, right: IdentityCandidate): boolean {
  return (
    typeof left.lat === "number" && typeof left.lon === "number" && typeof right.lat === "number" && typeof right.lon === "number"
  );
}

/**
 * 🔴 A SHARED DISTRIBUTOR CODE PROVES NOTHING ACROSS DISTRIBUTORS. Each distributor keeps its own
 * customer numbering, so the same code at two different distributors is two different shops that
 * happen to share an integer — a standing rule in this repo, learned from real venue data. The
 * code is evidence only when `distributorId` is the same on both sides.
 */
export function sharedDistributorPair(left: IdentityCandidate, right: IdentityCandidate): DistributorCodePair | null {
  for (const mine of distributorPairsOf(left)) {
    for (const theirs of distributorPairsOf(right)) {
      if (mine.distributorId === theirs.distributorId && mine.code === theirs.code) return mine;
    }
  }
  return null;
}

/** The same question as a yes or no, for a caller that does not need to name the code. */
export function sharesDistributorCode(left: IdentityCandidate, right: IdentityCandidate): boolean {
  return sharedDistributorPair(left, right) !== null;
}

/**
 * 🔴 EP-PHS ISSUES ONE CODE TO MORE THAN ONE NAME AT A TIME, SO ITS CODE CANNOT BE THE PROOF.
 *
 * Measured on production 2026-08-23 across all eight distributors: **232 EP-PHS codes carry two or
 * three different pharmacy names, 168 of them CONCURRENTLY** — the two names invoicing in overlapping
 * months, which is the test that separates a real reuse from a rename. Every other distributor came
 * back clean: PS had 224 multi-name codes and 0 concurrent, IS 108 and 0, EG/IS-S/EP-BK/SF 38 and 0.
 * So this is one distributor's numbering, not a general caveat, and the set below holds exactly it.
 *
 * 🔴 WHAT IS *NOT* ESTABLISHED, because the first write-up of this overstated it and the owner caught
 * it: whether those concurrent names are two real shops, one shop written two ways, or a bad lookup
 * in the sheet the importer reads. The address column turned out to be a byte-identical copy of the
 * name column, so it corroborated nothing. Do not repeat "two different pharmacies on one code" as
 * fact.
 *
 * Either way it disqualifies the `fact` band, and that is the whole point: `fact` means the systems
 * themselves already say it is one row, and it is the ONE band that skips the name check entirely
 * (see `judgePair`). On an EP-PHS code that combination offered two unlike names as certain — which
 * is precisely the shape the owner's standing rule calls worse than a missed catch, because the
 * Super Admin confirming it would be recording a merge on evidence that says "look", not "yes".
 *
 * Such a pair is NOT hidden. It falls through to the name-based bands and stands on its own
 * evidence — `strong` if the places sit together, `likely` on a shared brick or phone, nothing at all
 * if the names do not match. Keep this narrow: widening it to another distributor throws away real
 * evidence, and `sharedDistributorPair` above is deliberately left alone for callers asking the plain
 * question "do these two share a code?".
 */
export const DISTRIBUTORS_WHOSE_CODE_IS_NOT_PROOF: ReadonlySet<string> = new Set(["EP-PHS"]);

/** A shared code that is strong enough to stand as `fact` — every distributor except the set above. */
export function sharedProvingDistributorPair(
  left: IdentityCandidate,
  right: IdentityCandidate,
): DistributorCodePair | null {
  for (const mine of distributorPairsOf(left)) {
    if (DISTRIBUTORS_WHOSE_CODE_IS_NOT_PROOF.has(mine.distributorId.trim().toUpperCase())) continue;
    for (const theirs of distributorPairsOf(right)) {
      if (mine.distributorId === theirs.distributorId && mine.code === theirs.code) return mine;
    }
  }
  return null;
}

/** Trimmed, both halves present, duplicates dropped — the one place a pair is read from a row. */
function distributorPairsOf(candidate: IdentityCandidate): DistributorCodePair[] {
  const seen = new Set<string>();
  const out: DistributorCodePair[] = [];
  for (const pair of candidate.distributorPairs ?? []) {
    const distributorId = String(pair?.distributorId ?? "").trim();
    const code = String(pair?.code ?? "").trim();
    if (!distributorId || !code) continue;
    const key = `${distributorId}|${code}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ code, distributorId });
  }
  return out;
}

/**
 * 🔴 A WHOLESALER IS NEVER OFFERED AS A PHARMACY IDENTITY (owner, 2026-09-22, "never never never").
 * The guard is the repo's one implementation, reused rather than re-derived: a مخزن or a جملة is
 * not a shop a doctor's prescriptions can be traced to, and putting one in front of the owner as a
 * pharmacy to confirm is exactly the offer that rule exists to stop.
 */
export function isLinkableCandidate(candidate: IdentityCandidate): boolean {
  if (!isLinkableName(candidate.name)) return false;
  if (candidate.kind !== "pharmacy") return true;
  // EVERY code it carries is offered to the guard, not just one: the code-keyed overrides are what
  // catch a warehouse whose NAME reads like a shop, so a pharmacy with two codes would otherwise
  // slip through on whichever of them happened to be first. Any code that says warehouse is enough.
  //
  // 🔴 EACH HALF GOES IN ITS OWN PARAMETER — `(name, clientCode, distributorCode)`. #4978 passed
  //    `(name, null, pair.code)`, putting the CUSTOMER code where the DISTRIBUTOR belongs and
  //    leaving `clientCode` empty, and that silently disabled both account-level rulings: an owner
  //    pharmacy-override could never protect a real shop, and `isStoreOverride`, which needs the
  //    two halves TOGETHER, could never fire. Measured over all 496 named shops on production
  //    2026-10-01: the corrected order changes exactly one verdict — one marketing venue at
  //    `386724@IS` is now hard-blocked by the owner's own store ruling — and it refuses NOTHING
  //    that was being offered, which is the direction that would have mattered.
  //
  // A shop with no code at all still reaches the guard with both empty. That is the documented,
  // still-correct answer: only the account-level overrides are skipped, and those belong to the
  // desk that owns the code.
  const codes = distributorPairsOf(candidate);
  if (codes.length === 0) return !isCertainWholesalerVenue(candidate.name, null, null);
  return !codes.some((pair) => isCertainWholesalerVenue(candidate.name, pair.code, pair.distributorId));
}

type PairVerdict = { band: EvidenceBand; reason: string } | null;

/**
 * The bands, in the order they are tested — the first one that holds wins, because they are
 * ordered by certainty and a `fact` needs no further support.
 *
 * Note what is NOT here: nothing promotes a pair on distance alone, on a shared brick alone or on
 * a region alone. Every band below `fact` requires the names to match first, so geography only
 * ever strengthens a name match and can never create one.
 */
export function judgePair(left: IdentityCandidate, right: IdentityCandidate): PairVerdict {
  if (left.kind !== right.kind) return null;
  if (left.source === right.source && left.sourceId === right.sourceId) return null;
  if (!isLinkableCandidate(left) || !isLinkableCandidate(right)) return null;
  if (specialityConflicts(left, right)) return null;

  // FACT — the systems themselves already say it is one row.
  if (left.contactCrmId != null && left.contactCrmId === right.contactCrmId) {
    return { band: "fact", reason: `Both carry iReports360 contact ${left.contactCrmId}.` };
  }
  // `sharedProvingDistributorPair`, not `sharedDistributorPair`: EP-PHS issues one code to more than
  // one name at a time, so its code is a reason to look and never the proof. See the constant above.
  const shared = left.kind === "pharmacy" ? sharedProvingDistributorPair(left, right) : null;
  if (shared) {
    return { band: "fact", reason: `Both carry customer code ${shared.code} at ${shared.distributorId}.` };
  }

  const nameKey = identityNameKey(left.name);
  if (!nameKey || nameKey !== identityNameKey(right.name)) return null;

  // STRONG — the names match and the two places stand together.
  if (bothHavePoint(left, right)) {
    const metres = Math.round(metresBetween(Number(left.lat), Number(left.lon), Number(right.lat), Number(right.lon)));
    if (metres <= STRONG_METRES) {
      return { band: "strong", reason: `Same name, and the two places stand ${metres} m apart.` };
    }
  }

  // LIKELY — the names match and one more thing ties them to the same place or person.
  const phone = phoneKey(left.phone);
  if (phone && phone === phoneKey(right.phone)) {
    return { band: "likely", reason: "Same name, and the same phone number." };
  }
  const brick = String(left.brickCode ?? "").trim();
  if (brick && brick === String(right.brickCode ?? "").trim()) {
    return { band: "likely", reason: `Same name, and both sit in brick ${brick}.` };
  }

  // POSSIBLE — the same name in the same region, and nothing else.
  const region = String(left.regionCode ?? "").trim();
  if (region && region === String(right.regionCode ?? "").trim()) {
    return { band: "possible", reason: `Same name, in ${region}. Nothing else ties them together.` };
  }

  return null;
}

/**
 * The keys a candidate is bucketed under, so the sweep compares it against everything it could
 * possibly match without comparing it against everything full stop.
 *
 * 🔴 THE NAME IS NOT THE ONLY BUCKET, AND ASSUMING IT WAS MADE THE STRONGEST EVIDENCE INVISIBLE.
 * The first cut grouped on the folded name alone, on the reasoning that every band needs a name
 * match. Two of them do not: a shared iReports360 contact id and a shared distributor code are
 * `fact`, and they hold WHATEVER the two rows are called — which is exactly when a link is worth
 * most, because nothing else would ever find it. Measured on the real engine before this fix:
 * `judgePair` returned `fact` for two rows carrying contact 4321 under "احمد الهضيمي" and
 * "Ahmed El Hodeimy Clinic", and `suggestIdentityPairs` over the same two rows returned **zero
 * pairs**. The rule and the sweep disagreed, silently, in the sweep's favour.
 *
 * So a candidate is bucketed under its name AND under each fact key it carries. A pair found in
 * two buckets is de-duplicated by `pairKey`, which is what that key is for.
 */
function bucketKeysFor(candidate: IdentityCandidate): string[] {
  const keys = [`${candidate.kind}|name|${identityNameKey(candidate.name)}`];
  if (candidate.contactCrmId != null) keys.push(`${candidate.kind}|contact|${candidate.contactCrmId}`);
  // ONE BUCKET PER CODE, not one per shop: a pharmacy known at two distributors belongs in both
  // buckets, or the pair that shares only its second code is never compared at all.
  for (const pair of distributorPairsOf(candidate)) keys.push(`${candidate.kind}|code|${pair.distributorId}|${pair.code}`);
  return keys;
}

/**
 * Every pair worth offering, from the candidates handed in.
 *
 * Bucketed rather than compared all-against-all, so the work is quadratic only INSIDE a bucket:
 * on production's scale that is the difference between a few thousand comparisons and tens of
 * millions. A pair already ruled "not the same" is dropped here rather than in the screen, so a
 * withdrawn ruling brings it straight back simply by leaving the key out of `ruledOut`.
 */
export function suggestIdentityPairs(
  candidates: readonly IdentityCandidate[],
  options: { ruledOut?: ReadonlySet<string>; linkedSourceIds?: ReadonlySet<string> } = {},
): IdentitySuggestion[] {
  const ruledOut = options.ruledOut ?? new Set<string>();
  const linked = options.linkedSourceIds ?? new Set<string>();

  const groups = new Map<string, IdentityCandidate[]>();
  for (const candidate of candidates) {
    if (!isLinkableCandidate(candidate)) continue;
    // A row already on a master is settled; offering it again would ask a question he has answered.
    if (linked.has(`${candidate.source}:${candidate.sourceId}`)) continue;
    for (const key of bucketKeysFor(candidate)) {
      const found = groups.get(key);
      if (found) found.push(candidate);
      else groups.set(key, [candidate]);
    }
  }

  // Keyed by `pairKey`, because a pair can be found in two buckets at once — the same two rows
  // sharing both a name and a contact id — and the owner must be asked about it exactly once.
  const found = new Map<string, IdentitySuggestion>();
  for (const group of groups.values()) {
    for (let i = 0; i < group.length; i += 1) {
      for (let j = i + 1; j < group.length; j += 1) {
        const left = group[i];
        const right = group[j];
        if (!left || !right) continue;
        const pairKey = identityPairKey(left, right);
        if (ruledOut.has(pairKey) || found.has(pairKey)) continue;
        const verdict = judgePair(left, right);
        if (!verdict) continue;
        found.set(pairKey, { band: verdict.band, kind: left.kind, left, pairKey, reason: verdict.reason, right });
      }
    }
  }
  const out = [...found.values()];

  // Certain first, then by name, so the screen reads in the order he works it and two runs over
  // unchanged data always produce the same list.
  return out.sort(
    (a, b) =>
      BAND_ORDER.indexOf(b.band) - BAND_ORDER.indexOf(a.band) ||
      a.left.name.localeCompare(b.left.name) ||
      a.pairKey.localeCompare(b.pairKey),
  );
}

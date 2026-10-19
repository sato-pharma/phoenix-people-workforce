import { normalizeArabicPharmacyName } from "@/lib/pharmacy-master/pharmacy-matching";

// ─────────────────────────────────────────────────────────────────────────────
// Does the geography on this request agree with the distributor's own record? (owner rule, 2026-08-08)
//
// The approval window used to print a single field, "Geography check: Not flagged", derived from
// `geo_variance_resolved`. That one string covered THREE opposite situations:
//
//   - checked, and everything agrees
//   - never checked at all
//   - not checkable, because there is no distributor code to check against
//
// All three rendered identically, which made the field worth nothing: "Not flagged" reads as a pass
// and most often meant nobody had looked. Same failure the retail empty-state already fixed once
// (spec D2 — "an established pharmacy that has not bought and a provisional one that was never
// proved both produce zero rows, and they are opposite risks").
//
// THE THIRD SIGNAL, found live on 2026-08-08: order e6740fcf declared brick بركة السبع (B201-3,
// Menoufia) while the submitter typed the address "كفر شكر بنها" — Kafr Shukr, a different
// governorate. The distributor's own record for that customer says بركة السبع, agreeing with the
// brick. Nothing compared them, so it passed silently. Sales attribution follows the BRICK, so a
// wrong brick credits the wrong rep and moves the wrong area's numbers — and the typed address is
// the only human-readable clue that something is off.
//
// FAIL SOFT, NEVER CLOSED. An address that matches no known brick is UNKNOWN, not a mismatch. Only a
// positive match on a DIFFERENT brick or area is a flag. The alternative — treating every
// unrecognised address as suspicious — produces so many false alarms that people stop reading them,
// which is worse than no check at all. Same rule the storefront evidence check already follows.
// ─────────────────────────────────────────────────────────────────────────────

export type DirectOrderGeographyVerdict = "match" | "mismatch" | "unknown" | "not_checkable";

/**
 * Where the live evidence photo's own GPS puts the venue — the nearest brick centre to the pin that
 * is stamped on the photo, which is how the Phoenix evidence stamp itself names its territory.
 */
export type DirectOrderPhotoTerritory = {
  brickId: string | null;
  brickName: string | null;
  areaCode: string | null;
  areaName: string | null;
  /** Great-circle distance from the photo's pin to that brick's centre. */
  distanceKm: number | null;
};

/**
 * Past this the nearest centre is not a believable reading of the pin — brick centres are geocoded
 * guesses, and a "nearest" 40 km away is nonsense rather than a territory. The photo is then
 * reported as not usable instead of accusing a rep on it (a false accusation costs more than a miss).
 */
export const PHOTO_TERRITORY_TRUST_KM = 15;

export type DirectOrderGeographyCheck = {
  /**
   * THE PRIMARY SOURCE OF TRUST (owner, 2026-10-18): wherever a module holds a live evidence photo,
   * the photo's own GPS territory outranks every declared or derived value. This is the declared
   * brick and area read against it, and it is listed FIRST on the panel.
   */
  photo: {
    brick: { verdict: DirectOrderGeographyVerdict; declared: string | null; photo: string | null };
    area: { verdict: DirectOrderGeographyVerdict; declared: string | null; photo: string | null };
    distanceKm: number | null;
    /**
     * Why the photo could not speak — null when it did. `brick_map_unavailable` is a photo WITH a pin
     * whose territory was never looked up, because the brick centres did not load: not a missing photo.
     */
    unusableReason: "brick_map_unavailable" | "no_photo" | "too_far" | null;
  };
  /** Distributor's recorded brick for the code vs the brick declared on the request. */
  brick: {
    verdict: DirectOrderGeographyVerdict;
    declared: string | null;
    master: string | null;
  };
  /** Same, for area. */
  area: {
    verdict: DirectOrderGeographyVerdict;
    declared: string | null;
    master: string | null;
  };
  /** The free-text address, tested against known brick/area NAMES. */
  address: {
    verdict: DirectOrderGeographyVerdict;
    /** The brick/area the address positively named, when it named a different one. */
    matchedName: string | null;
    /**
     * GOLDEN RULE (owner, 2026-08-08): no field on this panel is ever left blank. The address is
     * free text nobody validates, so it is RESOLVED to a place here — and the resolution always
     * comes with its provenance, because a derived value shown as though the distributor's master
     * database said it is the same defect as "Not flagged": a confident answer nobody checked.
     *
     * `resolvedPlace` is what the address itself names, whoever it agrees with.
     * `resolvedFrom` says how we know:
     *   "address-text" — the address literally contains a known place name (normalized Arabic)
     *   "unresolved"   — no known place matched, which is stated in words, never left empty
     */
    resolvedPlace: string | null;
    resolvedFrom: "address-text" | "unresolved";
  };
  /** One sentence for the screen. Never "Not flagged". */
  summary: string;
};

export type DirectOrderGeographyInput = {
  declaredBrickId: string | null;
  declaredBrickName: string | null;
  declaredAreaCode: string | null;
  declaredAreaName: string | null;
  /** From the matched distributor customer row; null when there is no code to check against. */
  masterBrickId: string | null;
  masterBrickName: string | null;
  masterAreaCode: string | null;
  masterAreaName: string | null;
  /** Free text the submitter typed. */
  address: string | null;
  /**
   * The territory the live evidence photo's GPS falls in. `null` = this request carries no live
   * photo with coordinates (an invoice-route venue, or none filed) — said in words, never skipped.
   */
  photoTerritory?: DirectOrderPhotoTerritory | null;
  /**
   * Why a photo that DOES carry a pin has no `photoTerritory`: the brick centres did not load, or no
   * brick centre lies anywhere near the pin. Absent/null when there is no pin at all.
   *
   * 🔴 A MAP THAT DID NOT LOAD IS NOT A MISSING PHOTO (code review, 19 Oct 2026). `loadBrickCentroids`
   * degrades to an empty list on a read failure, so the pin resolved to nothing and the panel told the
   * approver "No live evidence photo with GPS" about a photo that had one — dropping the primary
   * evidence check without saying it had not run.
   */
  photoPinUnresolved?: "brick_map_unavailable" | "no_brick_near" | null;
  /**
   * The venue kind's own name (for example "Nursery") when this kind of venue has NO distributor
   * account by definition. Such a venue can never be cross-checked against a customer code, so the
   * sentence must not read as though a code were missing — the live photo is its only territory
   * evidence. Null/absent for a pharmacy.
   */
  noDistributorAccountVenueLabel?: string | null;
  /**
   * Every known brick/area name, so the address can be tested for naming a DIFFERENT one. Without
   * this the address check can only ever say "unknown" — it has nothing to compare against.
   */
  knownPlaces?: ReadonlyArray<{ name: string; brickId?: string | null; areaCode?: string | null }>;
};

/** Codes compared case- and whitespace-insensitively; empty on either side is "no answer". */
function compareCodes(declared: string | null, master: string | null): DirectOrderGeographyVerdict {
  const left = String(declared ?? "").trim().toUpperCase();
  const right = String(master ?? "").trim().toUpperCase();
  if (!right) return "not_checkable";
  if (!left) return "unknown";
  return left === right ? "match" : "mismatch";
}

/** Arabic-safe containment: both sides folded through the pharmacy matcher's own normalizer. */
function addressNames(address: string, placeName: string): boolean {
  const haystack = normalizeArabicPharmacyName(address);
  const needle = normalizeArabicPharmacyName(placeName);
  // Two characters is noise — "ال" would match half of Egypt.
  if (!haystack || !needle || needle.length < 3) return false;
  return haystack.includes(needle);
}

export function checkDirectOrderGeography(input: DirectOrderGeographyInput): DirectOrderGeographyCheck {
  const brickVerdict = compareCodes(input.declaredBrickId, input.masterBrickId);
  const areaVerdict = compareCodes(input.declaredAreaCode, input.masterAreaCode);

  // ── The address ──────────────────────────────────────────────────────────────────────────
  let addressVerdict: DirectOrderGeographyVerdict = "unknown";
  let matchedName: string | null = null;
  let resolvedPlace: string | null = null;
  let resolvedFrom: "address-text" | "unresolved" = "unresolved";
  const address = String(input.address ?? "").trim();
  const declaredNames = [input.declaredBrickName, input.declaredAreaName].filter(Boolean) as string[];

  if (!address) {
    addressVerdict = "not_checkable";
  } else {
    // Resolve the address to a place FIRST, independently of whether it agrees with anything —
    // the golden rule is that this column always says something true, and "which place does this
    // address name?" has an answer even when that answer is the declared one.
    const declaredHit = declaredNames.find((name) => addressNames(address, name)) ?? null;
    // LONGEST match wins: "بركة السبع" must beat a shorter place name that happens to be a
    // substring of it, or the address resolves to the wrong place with full confidence.
    const elsewhere = (input.knownPlaces ?? [])
      .filter((place) => {
        if (!place.name) return false;
        const sameBrick = place.brickId && input.declaredBrickId && place.brickId === input.declaredBrickId;
        const sameArea = place.areaCode && input.declaredAreaCode && place.areaCode === input.declaredAreaCode;
        if (sameBrick || sameArea) return false;
        return addressNames(address, place.name);
      })
      .sort((a, b) => b.name.length - a.name.length)[0];

    if (declaredHit && (!elsewhere || declaredHit.length >= elsewhere.name.length)) {
      addressVerdict = "match";
      resolvedPlace = declaredHit;
      resolvedFrom = "address-text";
    } else if (elsewhere) {
      addressVerdict = "mismatch";
      matchedName = elsewhere.name;
      resolvedPlace = elsewhere.name;
      resolvedFrom = "address-text";
    }
    // else: unresolved. FAIL SOFT — an address matching no known place is UNKNOWN, never a
    // mismatch. Only a positive match on a different place is an accusation, and a wrong
    // accusation teaches people to ignore the warning entirely.
  }

  // ── The live photo — the PRIMARY source of trust (owner, 2026-10-18) ────────────────────────
  // "In any module that has an evidence photo, the photo is the primary source of trust." The
  // declared brick and area are a rep's typing (or an inherited marketing label); the photo's pin is
  // a measurement. So the photo is read FIRST, and a disagreement with it leads the summary even when
  // the distributor-code check below passes. The master check is kept, never removed.
  const photoTerritory = input.photoTerritory ?? null;
  const photoTooFar =
    photoTerritory !== null && photoTerritory.distanceKm !== null && photoTerritory.distanceKm > PHOTO_TERRITORY_TRUST_KM;
  const photoUnusableReason: DirectOrderGeographyCheck["photo"]["unusableReason"] =
    !photoTerritory || (!photoTerritory.brickId && !photoTerritory.areaCode)
      ? input.photoPinUnresolved === "brick_map_unavailable"
        ? "brick_map_unavailable"
        : input.photoPinUnresolved === "no_brick_near"
          ? "too_far"
          : "no_photo"
      : photoTooFar
        ? "too_far"
        : null;
  const photoNotLookedUp = photoUnusableReason === "brick_map_unavailable";
  const photoBrickVerdict: DirectOrderGeographyVerdict = photoUnusableReason
    ? "not_checkable"
    : compareCodes(input.declaredBrickId, photoTerritory?.brickId ?? null);
  const photoAreaVerdict: DirectOrderGeographyVerdict = photoUnusableReason
    ? "not_checkable"
    : compareCodes(input.declaredAreaCode, photoTerritory?.areaCode ?? null);
  const photoBrickName = photoTerritory?.brickName ?? photoTerritory?.brickId ?? null;
  const photoAreaName = photoTerritory?.areaName ?? photoTerritory?.areaCode ?? null;
  const photoKm = photoTerritory?.distanceKm == null ? null : Math.round(photoTerritory.distanceKm * 10) / 10;
  const noAccountLabel = input.noDistributorAccountVenueLabel?.trim().toLowerCase() || null;
  const declaredBrickLabel = input.declaredBrickName ?? input.declaredBrickId ?? "—";
  const declaredAreaLabel = input.declaredAreaName ?? input.declaredAreaCode ?? "—";

  // ── The sentence ─────────────────────────────────────────────────────────────────────────
  let summary: string;
  if (photoAreaVerdict === "mismatch") {
    summary = `PHOTO MISMATCH — the live evidence photo was taken in area ${photoAreaName ?? "—"} (nearest brick ${photoBrickName ?? "—"}${photoKm === null ? "" : `, ${photoKm} km from the pin`}), but this venue is filed under ${declaredAreaLabel}, brick ${declaredBrickLabel}. The photo is the primary evidence of where the shop stands, and sales attribution follows the brick, so this decides which rep and which area get credited.`;
  } else if (photoBrickVerdict === "mismatch") {
    summary = `PHOTO MISMATCH — the live evidence photo's pin is nearest brick ${photoBrickName ?? "—"}${photoKm === null ? "" : ` (${photoKm} km)`} in the same area, but this venue is filed under brick ${declaredBrickLabel}. The photo is the primary evidence of where the shop stands; sales attribution follows the brick.`;
  } else if (brickVerdict === "mismatch") {
    summary = `MISMATCH — the distributor places this customer in brick ${input.masterBrickName ?? input.masterBrickId ?? "—"}, but the request declares ${input.declaredBrickName ?? input.declaredBrickId ?? "—"}. Sales attribution follows the brick, so this decides which rep and which area get credited.`;
  } else if (areaVerdict === "mismatch") {
    summary = `MISMATCH — the distributor places this customer in area ${input.masterAreaName ?? input.masterAreaCode ?? "—"}, not the ${input.declaredAreaName ?? input.declaredAreaCode ?? "—"} declared here.`;
  } else if (addressVerdict === "mismatch") {
    summary = `The brick agrees with the distributor, but the typed address names ${matchedName} — somewhere else entirely. Most likely a careless address; worth one look before approving.`;
  } else if (photoBrickVerdict === "match" && photoAreaVerdict === "match" && brickVerdict !== "match") {
    summary = noAccountLabel
      ? `Checked against the live photo — its GPS falls in the brick and area this request declares. A ${noAccountLabel} has no distributor account, so the photo is its only territory evidence.`
      : "Checked against the live photo — its GPS falls in the brick and area this request declares. No distributor customer code was available to cross-check.";
  } else if (brickVerdict === "match") {
    summary =
      addressVerdict === "match"
        ? "Checked and agrees — the distributor's own record, the declared brick and the typed address all point to the same place."
        : "Checked and agrees — the distributor's own record places this customer in the brick this request declares.";
  } else if (brickVerdict === "not_checkable") {
    summary = noAccountLabel
      ? photoNotLookedUp
        ? `NOT CHECKED — a ${noAccountLabel} has no distributor account, and the brick map did not load, so its live photo's territory was not looked up. Nothing here has been verified; reload before deciding. This is not a pass.`
        : `NOT CHECKED — a ${noAccountLabel} has no distributor account and this request carries no usable live photo, so nothing here has been verified. This is not a pass.`
      : "NOT CHECKED — there is no distributor customer code to check against, so nothing here has been verified against the master database. This is not a pass.";
  } else {
    summary = "NOT CHECKED — the request declares no brick, so there is nothing to compare.";
  }
  // The photo is the primary evidence, so a sentence that rests on the master alone must say the photo
  // was never read — or "Checked and agrees" reads as a pass the photo never gave.
  if (photoNotLookedUp && !(noAccountLabel && brickVerdict === "not_checkable")) {
    summary = `${summary} The live photo has GPS, but the brick map did not load, so the photo's own territory — the primary evidence — was not checked; reload before deciding.`;
  }

  return {
    photo: {
      brick: { verdict: photoBrickVerdict, declared: input.declaredBrickName ?? input.declaredBrickId, photo: photoBrickName },
      area: { verdict: photoAreaVerdict, declared: input.declaredAreaName ?? input.declaredAreaCode, photo: photoAreaName },
      distanceKm: photoKm,
      unusableReason: photoUnusableReason,
    },
    brick: { verdict: brickVerdict, declared: input.declaredBrickName ?? input.declaredBrickId, master: input.masterBrickName ?? input.masterBrickId },
    area: { verdict: areaVerdict, declared: input.declaredAreaName ?? input.declaredAreaCode, master: input.masterAreaName ?? input.masterAreaCode },
    address: { verdict: addressVerdict, matchedName, resolvedPlace, resolvedFrom },
    summary,
  };
}

/**
 * What the address column shows on the master side — never blank (golden rule, owner 2026-08-08).
 *
 * A derived value ALWAYS carries "(read from the address)" so nobody mistakes it for something the
 * distributor's master database asserted. When nothing resolves, it says so in words rather than
 * rendering a dash, because a dash is indistinguishable from "we forgot to look".
 */
export function describeResolvedAddressPlace(address: DirectOrderGeographyCheck["address"]): string {
  if (address.verdict === "not_checkable") return "No address was entered";
  if (address.resolvedPlace) return `${address.resolvedPlace} (read from the address)`;
  return "Could not be matched to a known area";
}

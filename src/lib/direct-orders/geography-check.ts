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

export type DirectOrderGeographyCheck = {
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

  // ── The sentence ─────────────────────────────────────────────────────────────────────────
  let summary: string;
  if (brickVerdict === "mismatch") {
    summary = `MISMATCH — the distributor places this customer in brick ${input.masterBrickName ?? input.masterBrickId ?? "—"}, but the request declares ${input.declaredBrickName ?? input.declaredBrickId ?? "—"}. Sales attribution follows the brick, so this decides which rep and which area get credited.`;
  } else if (areaVerdict === "mismatch") {
    summary = `MISMATCH — the distributor places this customer in area ${input.masterAreaName ?? input.masterAreaCode ?? "—"}, not the ${input.declaredAreaName ?? input.declaredAreaCode ?? "—"} declared here.`;
  } else if (addressVerdict === "mismatch") {
    summary = `The brick agrees with the distributor, but the typed address names ${matchedName} — somewhere else entirely. Most likely a careless address; worth one look before approving.`;
  } else if (brickVerdict === "match") {
    summary =
      addressVerdict === "match"
        ? "Checked and agrees — the distributor's own record, the declared brick and the typed address all point to the same place."
        : "Checked and agrees — the distributor's own record places this customer in the brick this request declares.";
  } else if (brickVerdict === "not_checkable") {
    summary =
      "NOT CHECKED — there is no distributor customer code to check against, so nothing here has been verified against the master database. This is not a pass.";
  } else {
    summary = "NOT CHECKED — the request declares no brick, so there is nothing to compare.";
  }

  return {
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

import type { PhoenixCrmGrade, PhoenixCrmListType } from "@/lib/phoenix-crm/types";

/**
 * Phoenix CRM — what a List row SAYS about a customer, and where each word came from.
 *
 * 🔴 THE OWNER'S RULE, 2026-09-30: "the rep list in Phoenix CRM will be exactly the same [as the old
 * Reps List]. And when the rep validates it, the validation will OVERRIDE the iReports360 data — the
 * location and the bricks and everything. And any missing data from iReports360, you will make a
 * PLACEHOLDER for it, because when he comes to validate it he finds what he wants."
 *
 * So every field on a row is resolved the same way, in one place:
 *
 *   1. what the rep CAPTURED when he validated (the place: its address, its brick, its area);
 *   2. failing that, what iReports360 carried over;
 *   3. failing that, a PLACEHOLDER — never a blank cell, and never a dash.
 *
 * 🔴 THE OVERRIDE IS A PRECEDENCE, NOT A WRITE. Nothing here edits the iReports360 mirror: the
 * vendor's row is left exactly as it arrived, and the captured place simply wins wherever both have
 * something to say. That matters because the two disagree legitimately — the vendor's address is a
 * typed record, the place is a GPS fix taken at the door — and because a write would be unrecoverable
 * while a precedence can be re-read at any time. `brickOf` in customer-list-grouping.ts already picks
 * the row's GROUP this way; this module is the same decision for everything the row prints, so the
 * heading a customer sits under and the brick printed on his line can never disagree.
 *
 * 🔴 THE PLACEHOLDER IS AN INVITATION, NOT A COMPLAINT. The owner's reason for wanting one is that
 * the rep "finds what he wants" when he opens the row — so an unvalidated customer's empty field says
 * what validating will fill, and a validated one's says only that nothing is recorded. Neither ever
 * says missing, blocked, cannot or must (labels.ts's standing rule for this module), and neither is
 * ever an empty cell, which reads as a bug rather than as a gap.
 *
 * 🔴 NOTHING HERE MAY CARRY A CHECK. `ListPlace` also holds `brickDistanceKm`, `accuracyMeters` and
 * the two raw readings — golden rule #1 keeps every one of those off the rep's own screens, and this
 * module is the funnel every List row passes through, so it is the place that must not leak one.
 */

/** Where a row's word came from — the rep's own capture, the vendor's mirror, or nothing yet. */
export type FactSource = "validated" | "reference" | "placeholder";

export type ListRowFact = {
  text: string;
  source: FactSource;
};

/** The shape this module needs, named structurally so it can be tested without a database. */
export type ListRowFactsInput = {
  listType: PhoenixCrmListType;
  grade: PhoenixCrmGrade | null;
  speciality: string | null;
  validatedAt: string | null;
  places: ReadonlyArray<{
    label: string | null;
    address: string | null;
    brickName: string | null;
    areaName: string | null;
    zone: string | null;
    /** The place's own point. Used ONLY to open a map on it — never to judge the rep. */
    lat: number;
    lon: number;
  }>;
  reference: {
    address: string | null;
    city: string | null;
    zone: string | null;
    brickName: string | null;
    areaName: string | null;
  } | null;
};

export type ListRowFacts = {
  address: ListRowFact;
  brick: ListRowFact;
  area: ListRowFact;
  speciality: ListRowFact;
  grade: ListRowFact;
  /**
   * 🔴 THE ADDRESS IS CLICKABLE, as the old Reps List had it (owner, 2026-09-30: "you were writing
   * the FULL address and the full address was CLICKABLE"). Null only when there is no address and no
   * point — a placeholder is never a link.
   */
  mapsHref: string | null;
};

/**
 * The Google Maps URL for an exact fix — `?api=1&query=lat,lon` drops a pin at the coordinate, which
 * is the documented cross-platform form: on a phone it hands off to the Maps app, on a desktop it
 * opens the web map. No key, no embed, no third-party script on the page. Lifted verbatim from the
 * old board so one address behaves the same in both.
 */
function pinHref(lat: number, lon: number): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${lat},${lon}`)}`;
}

/**
 * The Maps URL for an address with no fix behind it — a SEARCH, not a pin.
 *
 * The locality is appended because a bare Egyptian street name resolves almost anywhere: "برج
 * الصيرفي" alone is a coin toss between governorates, and a rep who drives to the wrong one has been
 * actively misled. The old board's reasoning, and it applies to every customer not validated yet.
 */
function searchHref(address: string, locality: string | null): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent([address, locality].filter(Boolean).join(", "))}`;
}

/**
 * What an empty field says.
 *
 * Before validation it names the act that fills it, which is the owner's whole reason for asking for
 * placeholders. After validation the act is done, so it states the gap plainly instead of telling him
 * to do something he has already done.
 */
export const FILLED_BY_VALIDATING = "Set when you validate";
export const NOT_RECORDED = "Not recorded yet";
export const NO_GRADE = "No grade";

function firstText(...values: ReadonlyArray<string | null | undefined>): string | null {
  for (const value of values) {
    const text = value?.trim();
    if (text) return text;
  }
  return null;
}

function placeholder(validated: boolean): ListRowFact {
  return { source: "placeholder", text: validated ? NOT_RECORDED : FILLED_BY_VALIDATING };
}

/** The captured place a row speaks for: the first one, which is the one every other screen uses. */
function resolve(
  validated: boolean,
  fromPlace: string | null,
  fromReference: string | null,
): ListRowFact {
  if (fromPlace) return { source: "validated", text: fromPlace };
  if (fromReference) return { source: "reference", text: fromReference };
  return placeholder(validated);
}

export function listRowFacts(customer: ListRowFactsInput): ListRowFacts {
  // Validated is the STAMP, not "has a place": a customer met outside the list is captured at the
  // door and carries a place long before he is admitted, and telling him to validate again would be
  // wrong. `validatedAt` is set once he is validated AND on the list.
  const validated = customer.validatedAt !== null;
  const place = customer.places[0] ?? null;

  // 🔴 THE FULL ADDRESS, NOT A FRAGMENT OF IT (owner, 2026-09-30: "you were writing the full
  // address"). From the place that is the resolved street FIRST — the long one a rep can actually
  // drive to — and only then what he called it or its part of town, because a label like "the clinic
  // behind the mosque" is a landmark, not an address. From the vendor it is the whole record joined,
  // the order `referenceAddressText` uses, written out rather than imported so this module stays
  // free of the component layer.
  const placeAddress = firstText(place?.address, place?.label, place?.zone);
  const referenceAddress = customer.reference
    ? firstText([customer.reference.address, customer.reference.zone, customer.reference.city].filter(Boolean).join(" · "))
    : null;

  const address = resolve(validated, placeAddress, referenceAddress);
  // The point wins for the link even when the words came from the vendor: a captured place is an
  // exact fix, and a pin beats a text search every time. Failing that, search on what the row shows,
  // qualified by its locality so an Egyptian street name cannot resolve into the wrong governorate.
  const mapsHref = place
    ? pinHref(place.lat, place.lon)
    : address.source === "placeholder"
      ? null
      : searchHref(address.text, customer.reference?.city ?? customer.reference?.zone ?? null);

  return {
    address,
    mapsHref,
    brick: resolve(validated, place?.brickName ?? null, customer.reference?.brickName ?? null),
    area: resolve(validated, place?.areaName ?? null, customer.reference?.areaName ?? null),
    // Speciality and grade are the CRM's own columns — iReports360 seeded them and the rep can
    // correct the speciality on Open, so there is no second source to fall back to. They still get a
    // placeholder rather than a blank, because an empty cell on a board reads as a fault.
    speciality: customer.speciality?.trim()
      ? { source: validated ? "validated" : "reference", text: customer.speciality.trim() }
      : placeholder(validated),
    grade: customer.grade ? { source: "validated", text: `Grade ${customer.grade}` } : { source: "placeholder", text: NO_GRADE },
  };
}

/**
 * The ink a grade is printed in, as the old Reps List painted it: A and A+ red, B amber, the rest
 * grey, and no grade the palest — so a board reads by weight before it reads by word.
 */
export function gradeInk(grade: PhoenixCrmGrade | null): string {
  if (grade === "A") return "text-rose-700";
  if (grade === "B") return "text-amber-700";
  if (!grade) return "text-slate-300";
  // C. The old board also painted an "A+", which Phoenix CRM's own grades (A | B | C) do not carry.
  return "text-slate-500";
}

/** A placeholder is drawn lighter and in italics, so a real value is never mistaken for a gap. */
export function factInk(fact: ListRowFact): string {
  return fact.source === "placeholder" ? "italic text-slate-400" : "text-slate-600";
}

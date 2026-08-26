/**
 * The pharmacy trade licence (رخصة الصيدلية) as a piece of identity evidence.
 *
 * WHY IT EXISTS. Every other proof Phoenix holds about a venue answers "is this shop where the rep
 * says it is" — a GPS fix and a live photograph of the front. None of them answers "is this shop
 * WHO it says it is", and for a pharmacy that question is normally answered by somebody else: the
 * distributor. A code in a distributor's book means a real company invoiced a real pharmacy under
 * that name, which is an identity check Phoenix gets for free.
 *
 * A venue with NO code in ANY distributor gets none of that. Nothing outside the rep's own words
 * ties the name on the record to the business standing behind it, and that is precisely the venue
 * an approver is being asked to mint a brand-new identity for. The licence closes it: the trade
 * name printed on the licence is compared against the name on the shop sign (اليافطة) in the
 * storefront photo the same submission already carries. Two documents, one name, one decision.
 *
 * DELIBERATELY NOT A LIVE CAPTURE, unlike every other evidence photo in this repo. A storefront
 * photo asserts "taken at this place, at this time" and a file picker would destroy that claim, so
 * those paths refuse anything but a live JPEG. A licence asserts nothing about place or time — it
 * is a document, and it is routinely handed over as a scan or sent ahead on WhatsApp by the
 * pharmacist rather than being available on the wall to photograph. Owner's call, 2026-08-25:
 * offer BOTH the camera and the file picker, and accept a PDF, because refusing the form the
 * document actually arrives in would simply mean no licence is ever attached.
 *
 * ALWAYS OPTIONAL. Nothing here refuses a submission that has no licence — the system flags, it
 * never rejects (owner's standing rule). What it does is put the missing proof in front of the
 * person deciding.
 */

import { venueRequiresDistributorCode, type VenueType } from "@/lib/venues/venue-type";

/**
 * ITS OWN PRIVATE BUCKET, shared by both modules — not `direct-order-evidence` and not
 * `marketing-evidence`.
 *
 * Those two are deliberately provisioned JPEG-only with a 2MB ceiling, and that MIME allow-list is
 * a second wall standing behind the live-capture parser: a gallery upload cannot reach storage even
 * if a caller somehow got past the service. Widening either one to admit a PDF would knock that
 * wall down for the storefront photos too, which is a real loss of a guard to buy a feature that
 * does not need it. A separate bucket keeps the licence's looser rules from ever touching them.
 *
 * Private, like both of them: a licence carries a real business's registration details, and is
 * reachable only through a short-lived signed URL minted server-side.
 */
export const PHARMACY_LICENSE_BUCKET = "pharmacy-licenses";

/**
 * Larger than the 2MB live-capture cap on purpose. That cap sizes a quality-0.86 canvas JPEG the
 * app itself produced; this is whatever the pharmacist's scanner or phone produced, and a
 * multi-page PDF of an Egyptian trade licence routinely clears 2MB with nothing wrong with it.
 */
export const PHARMACY_LICENSE_MAX_BYTES = 5 * 1024 * 1024;

/**
 * PDF is here because that is how a licence most often arrives; PNG because that is what a
 * scanner app produces by default. Anything else is refused — an approver must be able to OPEN
 * this in a browser tab, and a HEIC or a .doc reaches the desk as an unreadable download.
 */
export const PHARMACY_LICENSE_CONTENT_TYPES = ["image/jpeg", "image/png", "application/pdf"] as const;

export type PharmacyLicenseContentType = (typeof PHARMACY_LICENSE_CONTENT_TYPES)[number];

/** For the `accept` attribute of a file input, so the picker filters to what the server takes. */
export const PHARMACY_LICENSE_ACCEPT_ATTRIBUTE = PHARMACY_LICENSE_CONTENT_TYPES.join(",");

const EXTENSION_BY_CONTENT_TYPE: Record<PharmacyLicenseContentType, string> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
};

export function pharmacyLicenseFileExtension(contentType: PharmacyLicenseContentType): string {
  return EXTENSION_BY_CONTENT_TYPE[contentType];
}

export function isPharmacyLicenseContentType(value: unknown): value is PharmacyLicenseContentType {
  return (PHARMACY_LICENSE_CONTENT_TYPES as readonly string[]).includes(String(value ?? ""));
}

export type ParsedPharmacyLicenseFile = {
  bytes: Buffer;
  contentType: PharmacyLicenseContentType;
  /** `jpg` / `png` / `pdf` — what the storage path should end in so a signed URL opens inline. */
  extension: string;
};

/**
 * The error a caller shows when the file is refused. Thrown as a plain `Error` and translated to
 * the module's own 400 by each caller, because the two modules that use this raise their validation
 * errors differently and neither should import the other's.
 */
function refuse(message: string): never {
  throw new Error(message);
}

/**
 * Parse `data:<type>;base64,<payload>` into storable bytes.
 *
 * Every rule is checked HERE rather than at the two call sites, so the direct-order desk and the
 * marketing desk can never end up accepting different files — the one thing that would make
 * "the licence is on file" mean two different things depending on which screen wrote it.
 */
export function parsePharmacyLicenseDataUrl(dataUrl: unknown): ParsedPharmacyLicenseFile {
  const raw = typeof dataUrl === "string" ? dataUrl.trim() : "";
  if (!raw) refuse("The pharmacy licence file is empty. Attach it again.");

  const match = /^data:([a-z]+\/[a-z0-9.+-]+);base64,([a-zA-Z0-9+/=\s]+)$/i.exec(raw);
  if (!match) {
    refuse("The pharmacy licence must be a photo or a PDF attached inside the app.");
  }

  const contentType = String(match![1]).toLowerCase();
  if (!isPharmacyLicenseContentType(contentType)) {
    refuse("The pharmacy licence must be a JPEG, a PNG, or a PDF.");
  }

  // Whitespace is stripped because a base64 payload that travelled through a textarea or a JSON
  // pretty-printer arrives line-wrapped, and `Buffer.from` would silently decode the wrapped form
  // into different bytes rather than failing.
  const bytes = Buffer.from(String(match![2]).replace(/\s+/g, ""), "base64");
  if (bytes.length === 0) refuse("The pharmacy licence file is empty. Attach it again.");
  if (bytes.length > PHARMACY_LICENSE_MAX_BYTES) {
    refuse("The pharmacy licence file is too large. Attach a file under 5 MB.");
  }

  return {
    bytes,
    contentType: contentType as PharmacyLicenseContentType,
    extension: pharmacyLicenseFileExtension(contentType as PharmacyLicenseContentType),
  };
}

/**
 * Is a licence the evidence this venue is actually short of?
 *
 * TRUE when the venue is one that normally carries a distributor account and this one names no
 * code — the case the owner asked for on 2026-08-25. FALSE for a nursery, which has no distributor
 * account by its nature: its codelessness is its type, not a gap, and prompting for a pharmacy
 * trade licence there would be asking for a document that does not exist.
 *
 * A prompt, never a gate. Callers use it to decide what to SAY, not what to refuse.
 */
export function pharmacyLicenseFillsTheIdentityGap(input: {
  distributorCodeCount: number;
  venueType: VenueType;
}): boolean {
  return venueRequiresDistributorCode(input.venueType) && input.distributorCodeCount === 0;
}

/**
 * One sentence naming what the reviewer is being asked to compare, or null when nothing is missing.
 *
 * Written once here so the rep's form and the approver's desk say the same thing — they are two
 * halves of one check, and wording them separately is how the two ends of a check drift apart.
 */
export function pharmacyLicensePrompt(input: {
  distributorCodeCount: number;
  hasLicenseOnFile: boolean;
  venueType: VenueType;
}): string | null {
  if (!pharmacyLicenseFillsTheIdentityGap(input)) return null;
  return input.hasLicenseOnFile
    ? "No distributor code — check the trade name on the licence against the name on the shop sign."
    : "No distributor code in any distributor. Attach the pharmacy licence (رخصة الصيدلية) so the trade name can be checked against the shop sign.";
}

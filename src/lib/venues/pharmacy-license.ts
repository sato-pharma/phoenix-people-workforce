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

  // NO REGEX EVER RUNS ACROSS THE PAYLOAD. This used to be one pattern over the whole data URL,
  // ending `([a-zA-Z0-9+/=\s]+)$`, and a greedy quantifier spanning megabytes exhausts V8's regexp
  // stack: it threw `RangeError: Maximum call stack size exceeded` instead of matching. That is
  // worse than it sounds, because the SIZE check below sits after the match — so the one file the
  // ceiling exists to refuse was the one file that never reached the ceiling, and an oversized
  // licence reached the rep as an opaque crash rather than "attach a file under 5 MB".
  //
  // It is stack-depth dependent, so it survives a single test and dies inside a full suite: it
  // turned CI red at random on 2026-09-08 while passing locally on the same commit.
  //
  // Both quantifiers in the header are bounded for the same reason. A MIME type is never near
  // these lengths, and without the bounds `[a-z0-9.+-]+` would scan the entire file looking for a
  // `;base64,` that is not there — the identical failure by another route.
  const header = /^data:([a-z]{1,40}\/[a-z0-9.+-]{1,60});base64,/i.exec(raw);
  if (!header) {
    refuse("The pharmacy licence must be a photo or a PDF attached inside the app.");
  }

  const contentType = String(header![1]).toLowerCase();
  if (!isPharmacyLicenseContentType(contentType)) {
    refuse("The pharmacy licence must be a JPEG, a PNG, or a PDF.");
  }

  // Whitespace is stripped because a base64 payload that travelled through a textarea or a JSON
  // pretty-printer arrives line-wrapped, and `Buffer.from` would silently decode the wrapped form
  // into different bytes rather than failing. `\s+` in a global replace is a flat scan with no
  // alternation and nothing nested, so it carries none of the risk the old payload match did.
  const payload = raw.slice(header![0].length).replace(/\s+/g, "");
  if (!payload) refuse("The pharmacy licence file is empty. Attach it again.");

  // SIZE IS DECIDED BEFORE ANYTHING IS DECODED, from the encoded length alone — four base64
  // characters carry three bytes, less the padding. Refusing here means a 40MB attachment costs a
  // subtraction rather than a 40MB Buffer, and it means the ceiling can no longer be skipped by
  // whatever the payload does to the parser on the way past it.
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  const encodedBytes = Math.floor((payload.length * 3) / 4) - padding;
  if (encodedBytes > PHARMACY_LICENSE_MAX_BYTES) {
    refuse("The pharmacy licence file is too large. Attach a file under 5 MB.");
  }

  const bytes = Buffer.from(payload, "base64");
  if (bytes.length === 0) refuse("The pharmacy licence file is empty. Attach it again.");

  // Node's base64 decoder SKIPS characters it does not recognise rather than failing, so a payload
  // that is not really base64 still decodes — to different bytes than anyone intended. The old
  // pattern rejected those by charset; comparing a re-encode restores that check without putting a
  // quantifier back over the payload. Trailing padding is normalised because a sender may omit it.
  // Trimmed by a backward walk, not `/=+$/`: that pattern restarts at every `=` in a long run that
  // is not at the end, so a payload of millions of `=` followed by one other character is quadratic.
  const withoutPadding = (value: string) => {
    let end = value.length;
    while (end > 0 && value.charCodeAt(end - 1) === 61 /* "=" */) end -= 1;
    return value.slice(0, end);
  };
  if (withoutPadding(bytes.toString("base64")) !== withoutPadding(payload)) {
    refuse("The pharmacy licence must be a photo or a PDF attached inside the app.");
  }

  // Kept as well as the encoded-length check above: that one bounds what we are willing to decode,
  // this one is the truth about what we actually decoded, and they must agree.
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
 * code — the case the owner asked for on 2026-08-25.
 *
 * FALSE FOR A VENUE WITH NO DISTRIBUTOR ACCOUNT. This reads back and forth across three dates, so
 * the whole of it in order: it was FALSE for a nursery originally, because a *pharmacy trade*
 * licence is a document a nursery does not have; it was flipped TRUE on 2026-08-26 on the reasoning
 * that a nursery has no code either, so the licence was the only route it had left; and the owner
 * settled it on 2026-08-29 — "Nursery does not have distributor code or license. So nursery, they
 * are validated by location and live photo, and then it's approval depends on the admin."
 *
 * The 08-26 reasoning was sound about the code and wrong about what follows from it. Both routes of
 * leg 3 are pharmacy-trade documents; a venue outside that trade has NEITHER, and the answer to
 * "it has no route" is that it is not judged by routes at all, not that the route it cannot take
 * becomes mandatory. Asking anyway produced a prompt that could not be satisfied standing next to a
 * gate that could not be passed.
 *
 * STILL A PROMPT — callers use it to decide what to SAY. What refuses is
 * `venueIdentityGapMessage` at the approval desk, and the two must agree: a gate that bites where
 * nothing was ever asked is how a rep gets blocked for a document nobody mentioned. They agree in
 * the other direction now — the desk refuses no nursery, so the form asks no nursery for anything.
 */
export function pharmacyLicenseFillsTheIdentityGap(input: {
  distributorCodeCount: number;
  venueType: VenueType;
}): boolean {
  if (!venueRequiresDistributorCode(input.venueType)) return false;
  return input.distributorCodeCount === 0;
}

/**
 * A PHARMACY SAVED ON ITS LICENCE ALONE (owner, 2026-10-14): a pharmacy with no distributor code
 * may still be validated when its licence is attached, and it is saved as NOT USABLE IN REQUESTS
 * YET. A request target needs a code, so this link is held on `pending` for a Super Admin or the
 * CEO to release — and the licence is what they read, big, to decide.
 *
 * The marker is written into the link's validation notes, the way the desk and history markers are,
 * so the register, the validation queue and the reviewers' screens all recognise it from the row.
 */
export const LICENSE_ONLY_PHARMACY_NOTE =
  "Licence only — this pharmacy has no distributor code, so it is held as not usable in requests until a code is added or a Super Admin releases it. Read the attached licence against the shop sign.";

/**
 * Written on a request's target row when the target is a pharmacy released on its licence (owner,
 * 2026-10-14): spend there is allowed, like a nursery, and no sale can be matched to it until a
 * distributor code is added. The ROI panel reads this instead of printing a misleading zero.
 */
export const LICENSE_RELEASED_TARGET_NOTE =
  "Pharmacy released on its licence — no distributor code yet, so sales cannot be matched to this target until one is added.";

export function isLicenseOnlyPharmacyNote(notes: string | null | undefined): boolean {
  return String(notes ?? "").includes(LICENSE_ONLY_PHARMACY_NOTE);
}

/** Whether a pharmacy is being registered with a licence standing in for its distributor code. */
export function pharmacyRegistersOnLicenseAlone(input: {
  codeCount: number;
  hasLicense: boolean;
  venueType: VenueType;
}): boolean {
  return venueRequiresDistributorCode(input.venueType) && input.codeCount === 0 && input.hasLicense;
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
  // A venue with no distributor account returns here, silently, on the line above — the gap this
  // document fills is not one it has. The two nursery sentences that used to sit at this point were
  // removed on 2026-08-29 with the rule they belonged to: both told a nursery to attach a licence,
  // and "attach it before sending" is a bad instruction to print beside a file input when the
  // document does not exist and nothing will refuse the submission for its absence.
  if (!pharmacyLicenseFillsTheIdentityGap(input)) return null;

  return input.hasLicenseOnFile
    ? "No distributor code — check the trade name on the licence against the name on the shop sign."
    : "No distributor code in any distributor. Attach the pharmacy licence (رخصة الصيدلية) so the trade name can be checked against the shop sign. It saves this pharmacy as not usable in requests yet, until a code is added or a Super Admin releases it.";
}

/**
 * How a licence verdict is SAID, everywhere it is read back.
 *
 * Three-valued, and the third value is the reason this function exists. `null` means nobody was
 * ever asked — no licence on file, or a venue last looked at before the check shipped — and it is
 * printed out loud as "Not checked yet" rather than left blank, because a blank cell beside a green
 * row reads as a pass. Anything that is not an explicit `false` is NOT a finding, and anything that
 * is not an explicit `true` is NOT a clearance.
 *
 * Shared by the approver's desk (where the verdict is recorded, and which disappears once the
 * request is decided) and the Customer Database register (where it has to still be readable a year
 * later). Those two must not drift: the person reading the register today is often the person who
 * recorded the verdict yesterday, and the same fact reworded reads as a different fact.
 */
export function pharmacyLicenseVerdictLabel(matchesSign: boolean | null | undefined): string {
  if (matchesSign === true) return "Confirmed to match";
  if (matchesSign === false) return "Does NOT match";
  return "Not checked yet";
}

/**
 * How a device is identified — its serial number and its IMEI — and how a register entry's pair is
 * corrected.
 *
 * PURE. Nothing here reads or writes the database, so Rep Tablets (which matches Google's device
 * list to the register) and the register's own correction share one meaning of "the same IMEI"
 * without the register service importing any Android Management code.
 *
 * THE DIGITS ARE THE IMEI, NOT THE TEXT. `uq_company_devices_imei` compares `lower(imei)`, so it
 * does not see "35-123456-789012-3" and "351234567890123" as one number — every comparison here is
 * on digits, and a register that dropped the final check digit still matches the full fifteen.
 */

/** Upper case, letters and digits only — a serial typed as "hs1 a-2b3" is the same as "HS1A2B3". */
export function normalizeSerial(value: string | null | undefined): string | null {
  const normalized = (value ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return normalized || null;
}

/** Digits only, and only when there are enough of them to be an IMEI at all. */
export function normalizeImei(value: string | null | undefined): string | null {
  const digits = (value ?? "").replace(/\D/g, "");
  return digits.length >= 14 ? digits : null;
}

/** Equal, or equal in the first 14 digits when one side left off the check digit. */
export function imeisMatch(left: string, right: string): boolean {
  if (left === right) return true;
  const short = left.length < right.length ? left : right;
  const long = short === left ? right : left;
  return short.length === 14 && long.length === 15 && long.startsWith(short);
}

// ---------------------------------------------------------------------------------------------
// Correcting an entry's serial number and IMEI
// ---------------------------------------------------------------------------------------------

/**
 * A correction the caller got wrong — a blank reason, a malformed IMEI, a number another entry
 * holds. The route answers these 400 with the sentence as written; anything else is a 500.
 */
export class DeviceIdentityCorrectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeviceIdentityCorrectionError";
  }
}

/** The same sentence `createDevice` refuses with, because it is the same rule. */
export const DEVICE_NEEDS_AN_IDENTITY =
  "A device needs a serial number or an IMEI. Without one it cannot be identified to the police, to an operator or to an insurer — which is what this register is for.";

/** The longest reason kept. Long enough for a sentence and a ticket number, short enough to read. */
export const IDENTITY_REASON_MAX_LENGTH = 500;

/** Digits and the separators people type between them: spaces, dashes, dots and slashes. */
const TYPED_IMEI = /^[0-9 .\-/]+$/;

/** Arabic-Indic and Persian digits read as the digits they are — an Arabic keyboard types "٣٥١…". */
function foldDigits(text: string): string {
  return text.replace(/[٠-٩۰-۹]/g, (digit) => String(digit.charCodeAt(0) & 0xf));
}

/** Every digit in a stored IMEI field, whatever else it holds — a label, a second SIM's IMEI. */
function imeiFieldDigits(value: string | null | undefined): string {
  return foldDigits(value ?? "").replace(/\D/g, "");
}

/**
 * Whether a register entry's IMEI field already holds this IMEI.
 *
 * The field is free text — the register form and the bulk import take what they are given — so it
 * can read "IMEI1: 351234567890123", or carry both of a dual-SIM phone's numbers
 * "351234567890123 / 351234567890131". Reducing that to one number misses it, so this asks whether
 * the field's digits CONTAIN the IMEI's first fourteen: the check digit left off either side still
 * matches, and a second IMEI in the same field is still seen. Refusing on a coincidence is the
 * safe way to be wrong — the refusal names the entry, and one IMEI on two entries is the thing
 * this check exists to stop.
 */
export function imeiFieldHolds(field: string | null | undefined, imei: string): boolean {
  const digits = imeiFieldDigits(field);
  const body = imeiFieldDigits(imei).slice(0, 14);
  return body.length === 14 && digits.includes(body);
}

export type IdentityEntry = {
  id: string;
  assetTag: string;
  serialNumber: string | null;
  imei: string | null;
};

export type IdentityCorrectionRequest = {
  serialNumber: string | null | undefined;
  imei: string | null | undefined;
  reason: string | null | undefined;
  /**
   * The serial number and IMEI the form showed when it was opened. A correction is refused when the
   * entry no longer holds them: Rep Tablets can copy an IMEI into the register while the editor is
   * open, and a save from the stale form would erase it without anybody seeing it.
   */
  shownSerialNumber: string | null | undefined;
  shownImei: string | null | undefined;
};

export type IdentityCorrectionPlan = {
  /** What the entry will hold, exactly as it will be stored. */
  serialNumber: string | null;
  imei: string | null;
  reason: string;
  serialChanged: boolean;
  imeiChanged: boolean;
};

function blankToNull(value: string | null | undefined): string | null {
  const text = String(value ?? "").trim();
  return text.length > 0 ? text : null;
}

/**
 * An IMEI as a person typed it, reduced to the digits the register stores.
 *
 * 15 digits is an IMEI; 14 is one whose check digit was left off, which the register has always
 * carried and Rep Tablets matches. There is no Luhn check on purpose: the number a tablet reports
 * about itself is the truth this correction exists to copy, and a checksum rule would refuse it
 * the day a manufacturer's number failed one.
 */
export function parseTypedImei(value: string | null | undefined): string | null {
  const text = blankToNull(value);
  if (!text) return null;
  if (!TYPED_IMEI.test(foldDigits(text))) {
    throw new DeviceIdentityCorrectionError(
      `"${text}" is not an IMEI. An IMEI is 15 digits (14 without the check digit); spaces and dashes between them are fine, letters are not.`,
    );
  }
  const digits = imeiFieldDigits(text);
  if (digits.length !== 14 && digits.length !== 15) {
    throw new DeviceIdentityCorrectionError(
      `"${text}" has ${digits.length} digits. An IMEI is 15 digits, or 14 without the check digit — dial *#06# on the device to read it.`,
    );
  }
  return digits;
}

/**
 * Decide what a correction writes, or refuse it with a sentence — before anything is written.
 *
 * - The entry must still hold what the form showed; a value saved since is never overwritten unseen.
 * - A written reason is required (owner decision, 2026-09-18). It goes into the audit row beside
 *   the old and new values, which is the only record of why a number the police may ask for changed.
 * - A serial number or an IMEI must remain: `company_devices_identifiable`, said as a sentence.
 * - An IMEI left exactly as stored is kept without being read as one number, so a dual-SIM pair
 *   or a labelled value survives a serial fix; and one whose digits are unchanged keeps the text
 *   already stored, so fixing a serial does not quietly rewrite a dashed IMEI into bare digits.
 * - A new serial or IMEI another entry already holds is refused, naming that entry — compared on
 *   serial letters and digits, and on IMEI digits wherever they sit in the other entry's field
 *   (`imeiFieldHolds`), which is more than the database's unique indexes see.
 * - Nothing changed is refused rather than written as an audit row recording no change.
 */
export function planIdentityCorrection(
  current: IdentityEntry,
  request: IdentityCorrectionRequest,
  others: readonly IdentityEntry[],
): IdentityCorrectionPlan {
  const currentSerial = blankToNull(current.serialNumber);
  const currentImei = blankToNull(current.imei);

  if (blankToNull(request.shownSerialNumber) !== currentSerial || blankToNull(request.shownImei) !== currentImei) {
    throw new DeviceIdentityCorrectionError(
      `${current.assetTag} changed after this form was opened — it now holds S/N ${currentSerial ?? "not recorded"} · IMEI ${currentImei ?? "not recorded"}. Nothing was saved. Reload the register and correct it again.`,
    );
  }

  const reason = blankToNull(request.reason);
  if (!reason) {
    throw new DeviceIdentityCorrectionError(
      "Say why the serial number or IMEI is being corrected. The reason is kept in the audit log with the old and new values.",
    );
  }
  if (reason.length > IDENTITY_REASON_MAX_LENGTH) {
    throw new DeviceIdentityCorrectionError(
      `Keep the reason under ${IDENTITY_REASON_MAX_LENGTH} characters.`,
    );
  }

  const serialNumber = blankToNull(request.serialNumber);
  const requestedImei = blankToNull(request.imei);
  let imei: string | null;
  if (requestedImei !== null && requestedImei === currentImei) {
    imei = currentImei;
  } else {
    const typedImei = parseTypedImei(requestedImei);
    imei = typedImei !== null && currentImei !== null && imeiFieldDigits(currentImei) === typedImei ? currentImei : typedImei;
  }

  if (!serialNumber && !imei) throw new DeviceIdentityCorrectionError(DEVICE_NEEDS_AN_IDENTITY);

  const serialChanged = serialNumber !== currentSerial;
  const imeiChanged = imei !== currentImei;
  if (!serialChanged && !imeiChanged) {
    throw new DeviceIdentityCorrectionError(
      `${current.assetTag} already holds this serial number and IMEI. There is nothing to correct.`,
    );
  }

  const elsewhere = others.filter((entry) => entry.id !== current.id);

  if (imeiChanged && imei) {
    const holder = elsewhere.find((entry) => imeiFieldHolds(entry.imei, imei));
    if (holder) {
      throw new DeviceIdentityCorrectionError(
        `${holder.assetTag} already holds the IMEI ${blankToNull(holder.imei) ?? imei}. One IMEI belongs to one device — correct ${holder.assetTag} first if its IMEI is the wrong one.`,
      );
    }
  }

  if (serialChanged && serialNumber) {
    const normalized = normalizeSerial(serialNumber);
    const holder = normalized
      ? elsewhere.find((entry) => normalizeSerial(entry.serialNumber) === normalized)
      : undefined;
    if (holder) {
      throw new DeviceIdentityCorrectionError(
        `${holder.assetTag} already holds the serial number ${blankToNull(holder.serialNumber) ?? serialNumber}. One serial number belongs to one device — correct ${holder.assetTag} first if its serial number is the wrong one.`,
      );
    }
  }

  return { serialNumber, imei, reason, serialChanged, imeiChanged };
}

// ---------------------------------------------------------------------------------------------
// Registering a NEW entry
// ---------------------------------------------------------------------------------------------

/**
 * The key a serial or IMEI is compared on when the register is checked for a repeat.
 *
 * An IMEI with at least 14 digits is its first 14 digits (the check digit left off either side still
 * matches, the same rule as everywhere above); anything shorter is compared as text, lowered —
 * exactly what `uq_company_devices_imei` sees, so a short value is never refused that the database
 * would have taken.
 */
export function imeiDuplicateKey(value: string | null | undefined): string | null {
  const text = blankToNull(value);
  if (!text) return null;
  const digits = imeiFieldDigits(text);
  return digits.length >= 14 ? digits.slice(0, 14) : text.toLowerCase();
}

/** A serial compared on its letters and digits, upper-cased — "hs1 a-2b3" is "HS1A2B3". */
export function serialDuplicateKey(value: string | null | undefined): string | null {
  return normalizeSerial(value);
}

/**
 * The entry a NEW device would repeat — its asset tag, serial number or IMEI — as the sentence that
 * refuses it, or null when it repeats nothing.
 *
 * The database's unique indexes compare `lower(serial_number)` and `lower(imei)`, the TEXT. So
 * "HA255LN1" and "ha255-ln1", or "351234567890123" and "35-123456-789012-3", went in as two
 * entries for one machine — and the register then answered "where is it" two ways, which is the
 * failure those indexes exist to stop. This compares the way the identity correction already does.
 * Every sentence starts "A device" so the route answers it 400, as the caller's mistake it is.
 */
export function findRegistrationClash(
  candidate: { assetTag: string | null | undefined; serialNumber: string | null | undefined; imei: string | null | undefined },
  entries: readonly IdentityEntry[],
): string | null {
  const tag = blankToNull(candidate.assetTag)?.toLowerCase() ?? null;
  if (tag) {
    const holder = entries.find((entry) => blankToNull(entry.assetTag)?.toLowerCase() === tag);
    if (holder) {
      return `A device tagged ${holder.assetTag} is already in the register. Every asset tag belongs to one device — use the next free number.`;
    }
  }

  const serial = serialDuplicateKey(candidate.serialNumber);
  if (serial) {
    const holder = entries.find((entry) => serialDuplicateKey(entry.serialNumber) === serial);
    if (holder) {
      return `A device with the serial number ${blankToNull(candidate.serialNumber)} is already in the register as ${holder.assetTag} (${blankToNull(holder.serialNumber)}). One serial number belongs to one device.`;
    }
  }

  const imei = blankToNull(candidate.imei);
  if (imei) {
    const key = imeiDuplicateKey(imei);
    const holder = entries.find((entry) => {
      const stored = blankToNull(entry.imei);
      if (!stored) return false;
      if (imeiFieldHolds(stored, imei) || imeiFieldHolds(imei, stored)) return true;
      return imeiDuplicateKey(stored) === key;
    });
    if (holder) {
      return `A device with the IMEI ${imei} is already in the register as ${holder.assetTag} (${blankToNull(holder.imei)}). One IMEI belongs to one device.`;
    }
  }

  return null;
}

/** "the IMEI", "the serial number", or "the serial number and IMEI" — for the audit summary. */
export function describeIdentityChange(plan: Pick<IdentityCorrectionPlan, "serialChanged" | "imeiChanged">): string {
  if (plan.serialChanged && plan.imeiChanged) return "the serial number and IMEI";
  return plan.serialChanged ? "the serial number" : "the IMEI";
}

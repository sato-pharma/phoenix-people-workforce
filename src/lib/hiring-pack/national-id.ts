/**
 * What an Egyptian national ID already tells us, so nobody types it a second time.
 *
 * ── Why this exists ──
 * `collectHiringPackGaps` reports date of birth and place of birth as BLOCKING on the contract, and
 * in production 103 of 108 active employees had no hiring profile at all — so every one of them was
 * blocked on two values the system was already holding, spelled differently. The 14-digit national
 * ID encodes both: digits 2-7 are the date of birth and digits 8-9 are the governorate the holder
 * was registered in. Measured on production the day this was written, all 94 stored IDs matched the
 * strict form below and none was malformed, so this is a derivation and not a heuristic.
 *
 * Digit 13 encodes sex, added 2026-09-03 so the papers can print مصري or مصرية — Arabic inflects
 * nationality for gender, and the masculine form was going onto every woman's contract. That decode
 * was checked against the 93 employees who carry BOTH a readable ID and a human-entered
 * `employees.gender`: they agreed in 93 of 93, in both directions.
 *
 * ── The one rule: fill a blank, never overwrite an answer ──
 * Everything here is a FALLBACK. A birth date somebody typed wins over a birth date read out of an
 * ID, always, even when they disagree — because the disagreement means one of the two is a typo and
 * this module cannot know which. `describeNationalIdConflict` names that case so the readiness board
 * can show it; what it must never do is quietly correct the stored value, because the paper it would
 * change is filed with the Social Insurance Authority under somebody's real identity.
 *
 * ── Why it refuses rather than guesses ──
 * A governorate is printed on the contract as محل الميلاد. A WRONG one is worse than a blank: blank
 * is visibly unfinished and gets chased, wrong is invisible and gets signed. So a parse returns null
 * on anything it cannot fully account for — a bad length, a century digit that is not 2 or 3, a date
 * that does not exist, a date in the future, or a governorate code outside the Authority's own list.
 * Partial credit is not on offer.
 */

import { resolveGovernorate } from "@/lib/geo/egypt-locations";

/**
 * The Authority's governorate codes, digits 8-9 of the ID.
 *
 * `en` IS NOT FREE TEXT. Each one is spelled exactly as `@/lib/geo/egypt-locations` spells it, and
 * `tests/hiring-pack-national-id.test.ts` asserts every entry round-trips through
 * `resolveGovernorate`. That pin is deliberate: the repo already carries one Egyptian place
 * vocabulary and the fastest way to end up with two that disagree is for a second table to invent
 * its own spelling of "Menoufia". This table owns the CODES; it borrows the NAMES.
 *
 * `ar` is the governorate as a legal document writes it — with ة and ي spelled out, not the
 * normalised match-keys that `egypt-locations` stores for aliasing (`الدقهليه` there, `الدقهلية`
 * here). Those keys are built for comparison and would print as misspelt Arabic on a contract.
 *
 * Code 88 is "born outside the Republic" and is VALID with no governorate — a real answer, not a
 * gap, so it maps to nulls rather than being rejected.
 */
const GOVERNORATE_BY_CODE: Readonly<Record<string, { en: string | null; ar: string }>> = {
  "01": { en: "Cairo", ar: "القاهرة" },
  "02": { en: "Alexandria", ar: "الإسكندرية" },
  "03": { en: "Port Said", ar: "بورسعيد" },
  "04": { en: "Suez", ar: "السويس" },
  "11": { en: "Damietta", ar: "دمياط" },
  "12": { en: "Dakahlia", ar: "الدقهلية" },
  "13": { en: "Sharqia", ar: "الشرقية" },
  "14": { en: "Qalyubia", ar: "القليوبية" },
  "15": { en: "Kafr El-Sheikh", ar: "كفر الشيخ" },
  "16": { en: "Gharbia", ar: "الغربية" },
  "17": { en: "Menoufia", ar: "المنوفية" },
  "18": { en: "Beheira", ar: "البحيرة" },
  "19": { en: "Ismailia", ar: "الإسماعيلية" },
  "21": { en: "Giza", ar: "الجيزة" },
  "22": { en: "Beni Suef", ar: "بني سويف" },
  "23": { en: "Fayoum", ar: "الفيوم" },
  "24": { en: "Minya", ar: "المنيا" },
  "25": { en: "Assiut", ar: "أسيوط" },
  "26": { en: "Sohag", ar: "سوهاج" },
  "27": { en: "Qena", ar: "قنا" },
  "28": { en: "Aswan", ar: "أسوان" },
  "29": { en: "Luxor", ar: "الأقصر" },
  "31": { en: "Red Sea", ar: "البحر الأحمر" },
  "32": { en: "New Valley", ar: "الوادي الجديد" },
  "33": { en: "Matrouh", ar: "مطروح" },
  "34": { en: "North Sinai", ar: "شمال سيناء" },
  "35": { en: "South Sinai", ar: "جنوب سيناء" },
  "88": { en: null, ar: "خارج الجمهورية" },
};

/** Every code above, for the test that pins this table to the place vocabulary. */
export const NATIONAL_ID_GOVERNORATE_CODES = Object.keys(GOVERNORATE_BY_CODE);

/** The English name a code resolves to, or null for "born abroad". Exposed for the pinning test. */
export function governorateEnglishForCode(code: string): string | null {
  return GOVERNORATE_BY_CODE[code]?.en ?? null;
}

/**
 * A place written any way the data writes it — `القاهره`, `cairo`, `El-Minia`, a full street
 * address — as the governorate a legal paper prints (`القاهرة`, `المنيا`), or null when no
 * governorate is confidently recognised.
 *
 * Recognition is `resolveGovernorate`'s, the system's one vocabulary; the Arabic spelling is this
 * table's, the same one محل الميلاد prints from a national ID, so the two never spell one
 * governorate two ways on the same form.
 */
export function governorateArForPlace(raw: string | null | undefined): string | null {
  const english = resolveGovernorate(raw);
  if (!english) return null;
  return Object.values(GOVERNORATE_BY_CODE).find((entry) => entry.en === english)?.ar ?? null;
}

/** What the ID encodes about sex. Not a gender identity — the Authority's own binary field. */
export type EgyptianSex = "male" | "female";

export type EgyptianNationalIdFacts = {
  /** ISO `yyyy-mm-dd`, read from digits 2-7 with the century digit applied. */
  birthDate: string;
  /** Digits 8-9, kept as the two characters so a leading zero survives. */
  governorateCode: string;
  /** Canonical English, as `@/lib/geo/egypt-locations` spells it. Null when born abroad. */
  governorateEn: string | null;
  /** How a legal document writes it — this is what reaches محل الميلاد. */
  governorateAr: string;
  /**
   * Digit 13, the sex digit: odd is male, even is female.
   *
   * Part of the serial the Authority issues, so this is a decode and not an inference — nothing
   * here reads a name, and `cv-field-schemas.ts` forbids exactly that guess for the same reason.
   * Read by `nationality.ts` to choose between مصري and مصرية, which Arabic inflects for gender.
   */
  sex: EgyptianSex;
};

/**
 * Arabic-Indic digits reach this field by copy-paste from a scanned card often enough to be worth
 * handling. Converting them is not leniency about FORMAT — the converted string still has to satisfy
 * the strict pattern below — it just stops a correct ID being reported as missing because of which
 * keyboard typed it.
 */
function toAsciiDigits(value: string): string {
  return value.replace(/[٠-٩۰-۹]/g, (char) => {
    const code = char.charCodeAt(0);
    const base = code >= 0x06f0 ? 0x06f0 : 0x0660;
    return String(code - base);
  });
}

/** `2001-02-30` is not a date. Round-tripping through Date is what catches it. */
function isRealDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

/**
 * Read what the ID encodes, or null if it does not fully account for itself.
 *
 * Null is the answer for every doubt — see the header. Callers treat null as "this tells us
 * nothing", which leaves the existing gap standing and sends HR to ask the person, which is correct.
 */
export function parseEgyptianNationalId(raw: string | null | undefined): EgyptianNationalIdFacts | null {
  const digits = toAsciiDigits(String(raw ?? "").trim());
  if (!/^[23][0-9]{13}$/.test(digits)) return null;

  const century = digits[0] === "2" ? 1900 : 2000;
  const year = century + Number(digits.slice(1, 3));
  const month = Number(digits.slice(3, 5));
  const day = Number(digits.slice(5, 7));
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (!isRealDate(year, month, day)) return null;

  // A birth date in the future is a typo, not a birth date. Compared against today in UTC rather
  // than Cairo on purpose: the question is only whether the date is absurd, and a timezone's worth
  // of slack cannot make a real ID look invalid.
  const birthDate = `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
  if (birthDate > new Date().toISOString().slice(0, 10)) return null;

  const governorateCode = digits.slice(7, 9);
  const governorate = GOVERNORATE_BY_CODE[governorateCode];
  if (!governorate) return null;

  // Digit 13 (1-indexed), i.e. index 12. Deliberately read only after everything above has passed:
  // if the string is not a well-formed ID then position 13 is not the sex digit, it is whatever
  // happened to be typed there, and a mis-sexed nationality prints onto a signed contract.
  const sex: EgyptianSex = Number(digits[12]) % 2 === 1 ? "male" : "female";

  return {
    birthDate,
    governorateCode,
    governorateEn: governorate.en,
    governorateAr: governorate.ar,
    sex,
  };
}

/**
 * The sex the ID encodes, when it can be derived at all.
 *
 * Null means "this tells us nothing" — no ID, or one that does not fully account for itself. It is
 * NOT a third value: callers fall back to a default rather than printing an empty nationality.
 */
export function derivedSexFromNationalId(nationalId: string | null | undefined): EgyptianSex | null {
  return parseEgyptianNationalId(nationalId)?.sex ?? null;
}

/**
 * The governorate name written the way the contract needs it, when it can be derived.
 *
 * Kept separate from the parse so a caller filling محل الميلاد does not have to know that "born
 * abroad" is a governorate-shaped answer with no governorate in it.
 */
export function derivedBirthPlaceAr(nationalId: string | null | undefined): string | null {
  return parseEgyptianNationalId(nationalId)?.governorateAr ?? null;
}

/** The birth date the ID encodes, when it can be derived. */
export function derivedBirthDate(nationalId: string | null | undefined): string | null {
  return parseEgyptianNationalId(nationalId)?.birthDate ?? null;
}

/**
 * Whether the stored birth date and the ID's own disagree — and by how much, in words.
 *
 * Returns null when there is nothing to say: no ID, an unreadable one, no stored date, or the two
 * agreeing. A non-null answer means somebody mistyped one of the two, and it is reported rather
 * than resolved. Both values reach a government form, so guessing which is right is exactly the
 * thing this module refuses to do.
 */
export function describeNationalIdConflict(
  nationalId: string | null | undefined,
  storedBirthDate: string | null | undefined,
): string | null {
  const facts = parseEgyptianNationalId(nationalId);
  if (!facts) return null;

  const stored = String(storedBirthDate ?? "").slice(0, 10);
  if (!stored) return null;
  if (stored === facts.birthDate) return null;

  return `The stored date of birth is ${stored}, but the national ID reads ${facts.birthDate}. One of the two is mistyped — check the card before printing.`;
}

/**
 * Fill blanks from the ID, leaving every answered value exactly as it was.
 *
 * The shape callers actually want: hand it what is stored, get back what should print. It never
 * returns a value in place of a stored one, so calling it twice, or on already-complete data,
 * changes nothing.
 */
export function fillFromNationalId(input: {
  nationalId: string | null | undefined;
  birthDate: string | null | undefined;
  birthPlace: string | null | undefined;
}): { birthDate: string | null; birthPlace: string | null; derived: ("birthDate" | "birthPlace")[] } {
  const facts = parseEgyptianNationalId(input.nationalId);
  const storedBirthDate = String(input.birthDate ?? "").trim() || null;
  const storedBirthPlace = String(input.birthPlace ?? "").trim() || null;
  const derived: ("birthDate" | "birthPlace")[] = [];

  if (!facts) return { birthDate: storedBirthDate, birthPlace: storedBirthPlace, derived };

  let birthDate = storedBirthDate;
  if (!birthDate) {
    birthDate = facts.birthDate;
    derived.push("birthDate");
  }

  let birthPlace = storedBirthPlace;
  // "Born abroad" carries no governorate, so there is nothing to fill — the person has to say where.
  if (!birthPlace && facts.governorateEn !== null) {
    birthPlace = facts.governorateAr;
    derived.push("birthPlace");
  }

  return { birthDate, birthPlace, derived };
}

/**
 * Does the canonical vocabulary still recognise every name this table borrows?
 *
 * Exported so the test asserts it rather than restating the list — a rename in `egypt-locations`
 * then fails here instead of silently printing a governorate the rest of the system cannot match.
 */
export function unrecognisedGovernorateNames(): string[] {
  return Object.values(GOVERNORATE_BY_CODE)
    .map((entry) => entry.en)
    .filter((en): en is string => en !== null)
    .filter((en) => resolveGovernorate(en) !== en);
}

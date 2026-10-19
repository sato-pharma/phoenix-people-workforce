// Recruitment / ATS — the deterministic patterns. Everything here is exact, not a guess.
//
// These are the rules that make the no-AI path worth having: an email address, a mobile number, a
// LinkedIn URL and a national ID have FIXED shapes, so a regex reads them at an accuracy no
// language model can beat, for nothing, in microseconds. Reading them with a paid model was always
// the wrong tool.

import { EGYPT_GOVERNORATES } from "@/lib/recruitment/rule-extraction/dictionaries";

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

/** Domains that belong to a job board or an employer's ATS, never to the candidate. */
const NON_CANDIDATE_EMAIL_DOMAINS: readonly string[] = [
  "wuzzuf.net", "linkedin.com", "indeed.com", "bayt.com", "forasna.com", "jobzella.com",
  "example.com", "domain.com", "email.com", "company.com",
];

/**
 * The shortest local part ("the bit before the @") this will believe.
 *
 * Found by OCR, which is exactly the kind of defect worth refusing. Tesseract read a real address,
 * "nermeenadel177@example.org", as "nermeenadel 1 77@example.org" — it inserted two spaces into the
 * name — and the address regex then matched the fragment after the last space and produced
 * "77@example.org". That is a VALID-LOOKING address for a different mailbox, so nothing downstream
 * would ever have questioned it, and the candidate would simply never have been reachable.
 *
 * A wrong address is worse than no address: an empty field is visibly empty and someone fills it,
 * while a plausible wrong one is silently trusted forever. Two characters is below any real local
 * part in this corpus, so refusing them costs nothing and closes the failure.
 */
const MIN_EMAIL_LOCAL_PART = 3;

export function findEmails(text: string): string[] {
  const seen = new Set<string>();
  for (const match of text.matchAll(EMAIL)) {
    // A trailing dot belongs to the sentence, not the address.
    const address = match[0].replace(/\.+$/, "").toLowerCase();
    const at = address.lastIndexOf("@");
    const domain = address.slice(at + 1);
    if (NON_CANDIDATE_EMAIL_DOMAINS.includes(domain)) continue;
    if (at < MIN_EMAIL_LOCAL_PART) continue;
    seen.add(address);
  }
  return [...seen];
}

/** ".com" as a CV misspells it. A closed list: Yahoo's real country domains must stay untouched. */
const MISSPELT_COM: ReadonlySet<string> = new Set(["om", "cm", "co", "con", "cpm", "xom", "vom", "cim", "ocm", "comm", "coom"]);

/**
 * A Gmail or Yahoo address whose ending the CV ITSELF misspells, put right — Aya Ali's CV prints
 * "ayamamdouh78@yahoo.om", the reader copied it faithfully at high confidence, and mail to it
 * fails (production, 2026-10-19; owner: "make the CV reader correct a misspelt Yahoo or Gmail
 * ending"). Gmail has exactly one domain, so any other ending after "gmail." is a typo. Yahoo also
 * runs real country domains (yahoo.fr, yahoo.co.uk), so only a misspelt ".com" is corrected there.
 * Every other address comes back exactly as given.
 */
export function correctWebmailEnding(address: string): string {
  const at = address.lastIndexOf("@");
  if (at < 1) return address;
  const local = address.slice(0, at);
  const domain = address.slice(at + 1).toLowerCase();
  const gmail = /^gmail\.([a-z]+)$/.exec(domain);
  if (gmail && gmail[1] !== "com") return `${local}@gmail.com`;
  const yahoo = /^yahoo\.([a-z]+)$/.exec(domain);
  if (yahoo && MISSPELT_COM.has(yahoo[1]!)) return `${local}@yahoo.com`;
  return address;
}

// ---------------------------------------------------------------------------
// Egyptian mobile numbers
// ---------------------------------------------------------------------------

// Any run that could be a phone number: digits with the separators a CV puts between them. A single
// regex that tries to validate at the same time is what produced the 79% hit rate the corpus
// measured — real CVs write "+20 12 3456 7890", "(+2) 01012345678" and "0100 123 4567", and each
// new layout needs another alternative. Scanning loosely and validating the DIGITS is both simpler
// and strictly more complete.
//
// The separator class must NOT contain \s. It did once, and \s matches a NEWLINE: a CV whose phone
// line is followed by an address ("01234567890\n3 El Salam, Giza") had the next line's leading "3"
// pulled into the number, making it 12 digits long and rejecting a perfectly valid mobile. Only
// spaces that a human would type INSIDE a number belong here.
const PHONE_CANDIDATE = /(?:\+|00)?\d[\d ().\- ]{7,24}\d/g;

// The core of an Egyptian mobile — prefix + 8 digits — optionally carrying its country code. Used
// to rescue numbers out of a run that failed to validate whole, which happens two ways in the
// corpus: two numbers printed back to back ("01234567890-01098765432") and a country code written
// as "(+02)" so the digits read "0201234567890".
const MOBILE_CORE = /(?:20)?0?1[0125]\d{8}/g;

/** Egyptian mobile prefixes: 010 Vodafone, 011 Etisalat, 012 Orange, 015 WE. */
const MOBILE_PREFIXES = new Set(["10", "11", "12", "15"]);

/**
 * Normalizes anything that IS an Egyptian mobile to the single canonical 01XXXXXXXXX form, and
 * returns null for anything that is not.
 *
 * Accepts, because all of these appear in the corpus:
 *   01012345678 · +201012345678 · 00201012345678 · 201012345678 · +20 10 1234 5678 · (+2) 010…
 */
export function normalizeEgyptianMobile(raw: string): string | null {
  // International prefixes are peeled one layer at a time, in the order they nest. Trying to
  // recognise each whole spelling with its own branch is what missed "(+02)01012345678" — a
  // country code written with a leading zero, wrapping a complete local number.
  let digits = raw.replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  // A leading 0 in front of something still too long to be a local number is part of the country
  // code ("(+02)…"), not the local trunk prefix.
  if (digits.length > 11 && digits.startsWith("0")) digits = digits.slice(1);
  if (digits.startsWith("20") && digits.length >= 12) digits = digits.slice(2);
  // "+2 01012345678" leaves a leading 2 in front of a complete local number.
  if (digits.length === 12 && digits.startsWith("2")) digits = digits.slice(1);
  if (digits.length === 10 && digits.startsWith("1")) digits = `0${digits}`;
  if (digits.length !== 11 || !digits.startsWith("0")) return null;
  if (!MOBILE_PREFIXES.has(digits.slice(1, 3))) return null;
  return digits;
}

export function findEgyptianMobiles(text: string): string[] {
  const seen = new Set<string>();
  for (const match of text.matchAll(PHONE_CANDIDATE)) {
    const whole = normalizeEgyptianMobile(match[0]);
    if (whole) {
      seen.add(whole);
      continue;
    }
    // The run as a whole is not one number. Rescue every mobile hiding inside it rather than
    // discarding the lot — "Phone: 01234567890-01098765432." is two real numbers, and a CV that
    // prints its country code as "(+02)" is one real number wearing an extra digit.
    //
    // The rescue must ACCOUNT FOR THE WHOLE RUN, or any long digit string contains a "mobile":
    // the 15-digit reference "123456789012345" happily yields 01234567890 from its first ten
    // digits. Allowing at most two leftover digits admits a stray country code while rejecting a
    // run that merely happens to contain a valid-looking prefix.
    const digits = match[0].replace(/\D/g, "");
    const cores = digits.match(MOBILE_CORE) ?? [];
    const consumed = cores.reduce((total, core) => total + core.length, 0);
    if (cores.length === 0 || digits.length - consumed > 2) continue;
    for (const core of cores) {
      const normalized = normalizeEgyptianMobile(core);
      if (normalized) seen.add(normalized);
    }
  }
  return [...seen];
}

// ---------------------------------------------------------------------------
// Profile links
// ---------------------------------------------------------------------------

// The matcher lives in linkedin-profile.ts so the screens can use it without this file's
// dictionaries. Re-exported here so the reader keeps importing every pattern from one place.
export { findLinkedInUrl } from "@/lib/recruitment/linkedin-profile";

// ---------------------------------------------------------------------------
// Egyptian national ID
// ---------------------------------------------------------------------------

const NATIONAL_ID = /\b([23]\d{13})\b/g;

// Position 8-9 of the ID. Same canonical names as EGYPT_GOVERNORATES so a decoded birthplace and a
// written address can never disagree about spelling.
const NATIONAL_ID_GOVERNORATES: Readonly<Record<string, string>> = {
  "01": "Cairo", "02": "Alexandria", "03": "Port Said", "04": "Suez",
  "11": "Damietta", "12": "Dakahlia", "13": "Sharqia", "14": "Qalyubia",
  "15": "Kafr El Sheikh", "16": "Gharbia", "17": "Monufia", "18": "Beheira",
  "19": "Ismailia", "21": "Giza", "22": "Beni Suef", "23": "Fayoum",
  "24": "Minya", "25": "Assiut", "26": "Sohag", "27": "Qena",
  "28": "Aswan", "29": "Luxor", "31": "Red Sea", "32": "New Valley",
  "33": "Matrouh", "34": "North Sinai", "35": "South Sinai", "88": "Born abroad",
};

export type DecodedNationalId = {
  readonly nationalId: string;
  /** YYYY-MM-DD. */
  readonly dateOfBirth: string;
  readonly gender: "Male" | "Female";
  readonly birthGovernorate: string | null;
};

/**
 * Decodes CYYMMDDGGSSSC — Egypt's national ID encodes birth date, birth governorate and sex.
 *
 * Worth having even though only 1% of the careers inbox prints one: when it IS there, three fields
 * come back exactly right, from the document, with no inference at all. The date is validated by
 * round-trip (a Date that rolls over to another month proves the digits were not a real date), so a
 * random 14-digit invoice number cannot masquerade as an identity.
 */
export function decodeEgyptianNationalId(raw: string): DecodedNationalId | null {
  const digits = raw.replace(/\D/g, "");
  if (!/^[23]\d{13}$/.test(digits)) return null;

  const century = digits[0] === "2" ? 1900 : 2000;
  const year = century + Number(digits.slice(1, 3));
  const month = Number(digits.slice(3, 5));
  const day = Number(digits.slice(5, 7));
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) return null;
  // A CV is not written by an unborn candidate, nor by a 100-year-old one.
  const age = new Date().getUTCFullYear() - year;
  if (age < 15 || age > 80) return null;

  return {
    birthGovernorate: NATIONAL_ID_GOVERNORATES[digits.slice(7, 9)] ?? null,
    dateOfBirth: `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    // The 13th digit is odd for men and even for women.
    gender: Number(digits[12]) % 2 === 1 ? "Male" : "Female",
    nationalId: digits,
  };
}

export function findNationalId(text: string): DecodedNationalId | null {
  for (const match of text.matchAll(NATIONAL_ID)) {
    const decoded = decodeEgyptianNationalId(match[1] ?? "");
    if (decoded) return decoded;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const MONTHS: Readonly<Record<string, number>> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
  sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

/** Words that mean "this job has not ended". */
export const PRESENT_WORDS: readonly string[] = ["present", "current", "currently", "now", "till now", "to date", "حتى الآن", "الآن"];

export function isPresentWord(value: string): boolean {
  const lower = value.trim().toLowerCase();
  return PRESENT_WORDS.some((word) => lower === word || lower.startsWith(word));
}

export type ParsedMonth = { readonly year: number; readonly month: number | null };

/**
 * Reads the date forms a CV uses for an employment period: "Jan 2026", "2019", "03/2023",
 * "2023-03". Returns the year, plus the month when one was actually written — a job that says only
 * "2019" must not silently become January 2019.
 */
export function parseCvDate(raw: string): ParsedMonth | null {
  const value = raw.trim().toLowerCase().replace(/\./g, "");

  const monthName = /^([a-z]{3,9})\s+(\d{4})$/.exec(value);
  if (monthName) {
    const month = MONTHS[monthName[1] ?? ""];
    const year = Number(monthName[2]);
    if (month && isPlausibleYear(year)) return { month, year };
  }

  const numericSlash = /^(\d{1,2})[/-](\d{4})$/.exec(value);
  if (numericSlash) {
    const month = Number(numericSlash[1]);
    const year = Number(numericSlash[2]);
    if (month >= 1 && month <= 12 && isPlausibleYear(year)) return { month, year };
  }

  const isoish = /^(\d{4})[/-](\d{1,2})$/.exec(value);
  if (isoish) {
    const year = Number(isoish[1]);
    const month = Number(isoish[2]);
    if (month >= 1 && month <= 12 && isPlausibleYear(year)) return { month, year };
  }

  const bareYear = /^(\d{4})$/.exec(value);
  if (bareYear && isPlausibleYear(Number(bareYear[1]))) return { month: null, year: Number(bareYear[1]) };

  return null;
}

function isPlausibleYear(year: number): boolean {
  return year >= 1960 && year <= new Date().getUTCFullYear() + 1;
}

/** Renders a parsed month as YYYY-MM-DD, defaulting an unstated month to January. */
export function toIsoDate(parsed: ParsedMonth): string {
  return `${String(parsed.year).padStart(4, "0")}-${String(parsed.month ?? 1).padStart(2, "0")}-01`;
}

// The two halves of an employment period, as one line writes them. Kept permissive on the
// separator ("-", "to", "–" already folded to "-") and anchored on the fact that BOTH sides parse.
const DATE_RANGE = /([A-Za-z]{3,9}\.?\s+\d{4}|\d{1,2}[/-]\d{4}|\d{4}[/-]\d{1,2}|\d{4})\s*(?:-|to|until|till)\s*([A-Za-z]{3,9}\.?\s+\d{4}|\d{1,2}[/-]\d{4}|\d{4}[/-]\d{1,2}|\d{4}|present|current|currently|now|to date)/i;

export type ParsedDateRange = {
  readonly from: ParsedMonth;
  /** null when the entry runs to the present. */
  readonly to: ParsedMonth | null;
  readonly isCurrent: boolean;
};

export function parseDateRange(line: string): ParsedDateRange | null {
  const match = DATE_RANGE.exec(line);
  if (!match) return null;
  const from = parseCvDate(match[1] ?? "");
  if (!from) return null;
  const rawTo = (match[2] ?? "").trim();
  if (isPresentWord(rawTo)) return { from, isCurrent: true, to: null };
  const to = parseCvDate(rawTo);
  if (!to) return null;
  // A range that runs backwards is a misread, not a job.
  if (to.year < from.year) return null;
  return { from, isCurrent: false, to };
}

/** The text of `line` with its date range removed — what is left is the title and employer. */
export function stripDateRange(line: string): string {
  return line.replace(DATE_RANGE, " ").replace(/\s{2,}/g, " ").replace(/^[\s|,·•\-—]+|[\s|,·•\-—]+$/g, "").trim();
}

// ---------------------------------------------------------------------------
// Dictionary matching
// ---------------------------------------------------------------------------

/** Whether `haystack` contains `needle` as a WHOLE word/phrase, not as part of a longer one. */
export function containsPhrase(haystack: string, needle: string): boolean {
  return indexOfPhrase(haystack, needle) >= 0;
}

/** As containsPhrase, but the string INDEX of the match (or -1) — for picking between several hits. */
export function indexOfPhrase(haystack: string, needle: string): number {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // \b does not work against Arabic, so the boundary is "not a letter/digit on either side".
  const match = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "iu").exec(haystack);
  return match ? match.index : -1;
}

/**
 * The canonical value of the first dictionary entry whose alias appears in `haystack`.
 *
 * Entry order is the priority order, which is why the dictionaries list their most specific
 * spellings first — "Excellent with Honours" has to beat the "Excellent" hiding inside it.
 */
export function matchDictionary(
  haystack: string,
  entries: ReadonlyArray<{ readonly canonical: string; readonly aliases: readonly string[] }>,
): string | null {
  for (const entry of entries) {
    for (const alias of entry.aliases) {
      if (containsPhrase(haystack, alias)) return entry.canonical;
    }
  }
  return null;
}

/** Every canonical value whose alias appears — for genuinely multi-valued facts like languages. */
export function matchDictionaryAll(
  haystack: string,
  entries: ReadonlyArray<{ readonly canonical: string; readonly aliases: readonly string[] }>,
): string[] {
  const found: string[] = [];
  for (const entry of entries) {
    if (entry.aliases.some((alias) => containsPhrase(haystack, alias))) found.push(entry.canonical);
  }
  return found;
}

/** The governorate a free-text address belongs to, by district first and governorate second. */
export function governorateFromText(text: string): string | null {
  return matchDictionary(
    text,
    EGYPT_GOVERNORATES.map((entry) => ({ aliases: entry.aliases, canonical: entry.canonical })),
  );
}

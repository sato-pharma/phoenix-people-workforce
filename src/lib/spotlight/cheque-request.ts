// Award cheque generator - reading a cheque off the wire.
//
// Pure and STRICT, like the Spotlight selection parser beside it. The generator's form holds every
// field as text (what the person typed, in whatever digits their keyboard makes), and this module is
// the ONE place that turns that text into an `AwardChequeRow`. A cheque prints an amount in figures,
// in Arabic words and in a machine line, so a coerced amount would look exactly as authoritative as a
// correct one - anything unreadable is refused by name instead.

import { MAX_SPELLABLE_AMOUNT } from "@/lib/hiring-pack/arabic-amount";

import type { AwardChequeRow } from "./award-cheque";

export const CHEQUE_MAX_PER_REQUEST = 30;
export const CHEQUE_DEFAULT_PROGRAM = "Semester Achievers Award — S1 2026";

const LIMITS = {
  recipientName: 120,
  positionTitle: 120,
  awardTitle: 200,
  programName: 120,
  serial: 40,
  signerTitle: 80,
  signerTitleAr: 80,
} as const;

/** One cheque as the form holds it: text for every field, so nothing is lost between keystrokes. */
export type ChequeInput = {
  recipientName: string;
  positionTitle: string;
  /** The "For / عن" memo line, printed when neither a rank nor an achievement is given. */
  awardTitle: string;
  rank: string;
  achievementPct: string;
  /** Pounds, with piastres after the point - "12,500" or "12,500.50", in Latin or Arabic-Indic digits. */
  amount: string;
  /** ISO `YYYY-MM-DD`, or empty. */
  transferDate: string;
  serial: string;
  programName: string;
  signerTitle: string;
  signerTitleAr: string;
  /** Print the CEO's stored signature on the signature line. */
  signed: boolean;
};

export type ChequeFormat = "pdf" | "html";

export type ParsedChequeRequest = {
  format: ChequeFormat;
  /** Which cheque of the list to render when previewing; a PDF always carries the whole list. */
  index: number;
  rows: Array<AwardChequeRow & { signed: boolean }>;
};

export class ChequeRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChequeRequestError";
  }
}

export function blankChequeInput(overrides: Partial<ChequeInput> = {}): ChequeInput {
  return {
    recipientName: "",
    positionTitle: "",
    awardTitle: "",
    rank: "",
    achievementPct: "",
    amount: "",
    transferDate: "",
    serial: "",
    programName: CHEQUE_DEFAULT_PROGRAM,
    signerTitle: "",
    signerTitleAr: "",
    signed: true,
    ...overrides,
  };
}

const ARABIC_INDIC = "٠١٢٣٤٥٦٧٨٩";
const EASTERN_INDIC = "۰۱۲۳۴۵۶۷۸۹";

/** Latin digits, whatever the keyboard produced; Arabic thousands and decimal marks become "," and ".". */
function latinDigits(value: string): string {
  return value
    .replace(/[٠-٩]/g, (d) => String(ARABIC_INDIC.indexOf(d)))
    .replace(/[۰-۹]/g, (d) => String(EASTERN_INDIC.indexOf(d)))
    .replace(/٬/g, ",")
    .replace(/٫/g, ".");
}

function field(value: unknown, name: string, max: number): string {
  if (value == null) return "";
  if (typeof value !== "string") throw new ChequeRequestError(`"${name}" must be text.`);
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (collapsed.length > max) throw new ChequeRequestError(`"${name}" is longer than ${max} characters.`);
  return collapsed;
}

/** "12,500.50" -> 12500.5. Null when empty; refuses a negative, a third decimal, or anything not a number. */
export function parseChequeAmount(raw: unknown): number | null {
  if (raw == null) return null;
  const text = typeof raw === "number" ? String(raw) : typeof raw === "string" ? latinDigits(raw) : null;
  if (text === null) throw new ChequeRequestError('"amount" must be a number.');
  const cleaned = text.replace(/[,\s]/g, "").replace(/^(?:EGP|LE|جنيه|ج\.م)/i, "");
  if (cleaned === "") return null;
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) {
    throw new ChequeRequestError('"amount" must be pounds with at most two decimals, like 12500 or 12500.50.');
  }
  const value = Number(cleaned);
  if (value > MAX_SPELLABLE_AMOUNT) {
    throw new ChequeRequestError(`"amount" is above the ${MAX_SPELLABLE_AMOUNT.toLocaleString("en-US")} the words can spell.`);
  }
  return Math.round(value * 100) / 100;
}

function parseRank(raw: unknown): number | null {
  const text = latinDigits(field(raw, "rank", 6));
  if (text === "") return null;
  if (!/^\d+$/.test(text) || Number(text) < 1) throw new ChequeRequestError('"rank" must be a whole number from 1.');
  return Number(text);
}

function parseAchievement(raw: unknown): number | null {
  const text = latinDigits(field(raw, "achievement", 10)).replace(/%$/, "").trim();
  if (text === "") return null;
  if (!/^\d+(\.\d+)?$/.test(text) || Number(text) > 1000) {
    throw new ChequeRequestError('"achievement" must be a percentage like 112.4.');
  }
  return Number(text);
}

/** A real calendar day, not just a well-shaped string ("2026-02-31" is refused). */
function parseDate(raw: unknown): string | null {
  const text = latinDigits(field(raw, "transfer date", 10));
  if (text === "") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!m) throw new ChequeRequestError('"transfer date" must be a date.');
  const probe = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (
    probe.getUTCFullYear() !== Number(m[1]) ||
    probe.getUTCMonth() !== Number(m[2]) - 1 ||
    probe.getUTCDate() !== Number(m[3])
  ) {
    throw new ChequeRequestError(`"${text}" is not a real calendar date.`);
  }
  return text;
}

/**
 * Reads one cheque. `strict` (a PDF) demands what a printed cheque cannot go without - a payee, an
 * amount, and a memo; a preview is lenient so a half-typed cheque still draws (the sheet already
 * prints placeholders for what is missing).
 */
export function parseChequeInput(raw: unknown, position: number, strict: boolean): AwardChequeRow & { signed: boolean } {
  const label = `Cheque ${position + 1}`;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ChequeRequestError(`${label} is not a cheque.`);
  }
  const r = raw as Record<string, unknown>;
  try {
    const recipientName = field(r.recipientName, "recipient name", LIMITS.recipientName);
    const awardTitle = field(r.awardTitle, "for", LIMITS.awardTitle);
    const rank = parseRank(r.rank);
    const achievementPct = parseAchievement(r.achievementPct);
    const amountEgp = parseChequeAmount(r.amount);

    if (strict) {
      if (recipientName === "") throw new ChequeRequestError("who the cheque is paid to is missing.");
      if (amountEgp === null || amountEgp <= 0) throw new ChequeRequestError("the amount is missing.");
      if (awardTitle === "" && rank === null && achievementPct === null) {
        throw new ChequeRequestError('either a rank or achievement, or the "For" line, is needed.');
      }
    }

    return {
      recipientName: recipientName || "[ RECIPIENT NAME ]",
      positionTitle: field(r.positionTitle, "position", LIMITS.positionTitle) || null,
      awardTitle: awardTitle || (strict ? "" : "[ WHAT THE CHEQUE IS FOR ]"),
      rank,
      achievementPct,
      programName: field(r.programName, "programme", LIMITS.programName) || CHEQUE_DEFAULT_PROGRAM,
      amountEgp: amountEgp !== null && amountEgp > 0 ? amountEgp : null,
      transferDate: parseDate(r.transferDate),
      serial: field(r.serial, "cheque number", LIMITS.serial) || String(position + 1).padStart(6, "0"),
      signerTitle: field(r.signerTitle, "signatory title", LIMITS.signerTitle) || null,
      signerTitleAr: field(r.signerTitleAr, "signatory title (Arabic)", LIMITS.signerTitleAr) || null,
      signed: r.signed !== false,
    };
  } catch (error) {
    if (error instanceof ChequeRequestError) throw new ChequeRequestError(`${label}: ${error.message}`);
    throw error;
  }
}

export function parseChequeRequest(body: unknown): ParsedChequeRequest {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new ChequeRequestError("The request must be an object.");
  }
  const b = body as Record<string, unknown>;
  const format = b.format === "html" ? "html" : b.format === "pdf" || b.format == null ? "pdf" : null;
  if (format === null) throw new ChequeRequestError('"format" must be "pdf" or "html".');
  if (!Array.isArray(b.cheques) || b.cheques.length === 0) throw new ChequeRequestError("Add at least one cheque.");
  if (b.cheques.length > CHEQUE_MAX_PER_REQUEST) {
    throw new ChequeRequestError(`At most ${CHEQUE_MAX_PER_REQUEST} cheques go in one run.`);
  }
  const index = typeof b.index === "number" && Number.isInteger(b.index) ? b.index : 0;
  if (format === "html") {
    if (index < 0 || index >= b.cheques.length) throw new ChequeRequestError("That cheque is not in the list.");
    // A preview draws ONE cheque: only that one is read, so a half-typed neighbour never blocks it.
    const row = parseChequeInput(b.cheques[index], index, false);
    return { format, index, rows: [row] };
  }
  return { format, index: 0, rows: b.cheques.map((entry, i) => parseChequeInput(entry, i, true)) };
}

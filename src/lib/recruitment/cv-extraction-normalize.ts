// Recruitment / ATS — deterministic (no-AI) cleanup of extracted CV field values.
//
// Applied to every extraction result before it is stored / used to build a candidate. Two goals:
//  1. Readability — a phone written on an Arabic CV as ٠١٠… becomes 010…, separators stripped.
//  2. Matching — candidate dedup keys off email → phone (candidate-matching.ts); feeding it clean,
//     canonical values means fewer missed matches and fewer wrong merges (the exact failure class
//     the WhatsApp bulk-import fix exists to avoid). Pure + unit-tested, no I/O.

// Arabic-Indic (U+0660–0669) and Eastern-Arabic/Persian (U+06F0–06F9) digits → ASCII 0–9.
const ARABIC_INDIC_DIGITS = "٠١٢٣٤٥٦٧٨٩";
const EASTERN_ARABIC_DIGITS = "۰۱۲۳۴۵۶۷۸۹";

export function arabicToWesternDigits(input: string): string {
  return input.replace(/[٠-٩۰-۹]/g, (ch) => {
    const ai = ARABIC_INDIC_DIGITS.indexOf(ch);
    if (ai >= 0) return String(ai);
    const ea = EASTERN_ARABIC_DIGITS.indexOf(ch);
    if (ea >= 0) return String(ea);
    return ch;
  });
}

// Lowercase, trim, and strip stray wrapping punctuation (angle brackets / quotes an AI sometimes
// keeps from a "Name <email>" header). Deliberately does NOT drop a value that fails a strict
// email regex — a slightly-off address is still a lead for a human to fix, never silently erased.
export function normalizeEmailValue(input: string): string {
  return arabicToWesternDigits(input).trim().replace(/^[<"'\s]+|[>"'\s]+$/g, "").toLowerCase();
}

// Convert Arabic digits, then keep a single leading "+" (if present) followed by digits only —
// spaces, dashes, parentheses and dots that CVs sprinkle through phone numbers are removed so the
// stored value is canonical for both display and matching. Non-phone junk collapses to "".
export function normalizePhoneValue(input: string): string {
  const western = arabicToWesternDigits(input).trim();
  const hasPlus = western.startsWith("+");
  const digits = western.replace(/\D/g, "");
  if (!digits) return "";
  return hasPlus ? `+${digits}` : digits;
}

// Per-field dispatch used by the extraction loop: email/phone get their dedicated cleanup, every
// other string field just gets Arabic→Western digits (safe for names, dates, universities — a name
// never legitimately contains Arabic-Indic digits, and dates/experience read cleaner as ASCII).
export function normalizeCvFieldValue(key: string, value: string): string {
  if (key === "email") return normalizeEmailValue(value);
  if (key === "phone") return normalizePhoneValue(value);
  return arabicToWesternDigits(value).trim();
}

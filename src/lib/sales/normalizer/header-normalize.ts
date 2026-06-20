// SINGLE source of header-key normalization for Source of Sales (PURE, no I/O, unit-tested).
//
// Every reader that matches a sheet's column titles against a distributor profile MUST key through
// normalizeHeaderKey so they can never disagree: the importer (engine.buildHeaderMap), the strict
// pre-flight gate (engine.validateSheetHeaders), and the auto-detector (detect-distributor.normalizeHeader
// + distributor-detection). A header recognized by one reader is then recognized by all of them.
//
// Conservative for ASCII (only lowercase + whitespace-collapse, so "ITEM_CODE" -> "item_code") while
// making Arabic headers robust to the encoding differences distributor exports vary on: NFKC, Arabic
// diacritics/harakat, tatweel, zero-width marks, alef/ya unification, and Arabic-Indic / Eastern-Arabic
// digit folding (so a header written with Arabic numerals matches its ASCII-numeral form). Implemented
// with code-point checks (no literal Unicode in source) so the rules are unambiguous and safe to edit.

// How many top rows a header search scans. Header rows can sit below a tall preamble/banner, so this is
// well past the old hard-coded 10. Scanning a few dozen rows is negligible vs. parsing the whole sheet.
export const HEADER_SCAN_ROWS = 30;

const ALEF = 0x0627; // bare alef
const YA = 0x064a; // ya
const ALEF_MAQSURA = 0x0649;
const TATWEEL = 0x0640;

// Arabic harakat/diacritics (U+064B..U+065F) + superscript alef (U+0670).
function isDiacritic(code: number): boolean {
  return (code >= 0x064b && code <= 0x065f) || code === 0x0670;
}

// Zero-width characters (U+200B..U+200F) + BOM / zero-width no-break space (U+FEFF).
function isZeroWidth(code: number): boolean {
  return (code >= 0x200b && code <= 0x200f) || code === 0xfeff;
}

// Fold Arabic-Indic (U+0660..0669) and Eastern-Arabic/Persian (U+06F0..06F9) digits to ASCII 0-9.
export function foldArabicDigits(value: string): string {
  let out = "";
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0x0660 && code <= 0x0669) out += String(code - 0x0660);
    else if (code >= 0x06f0 && code <= 0x06f9) out += String(code - 0x06f0);
    else out += ch;
  }
  return out;
}

export function normalizeHeaderKey(value: unknown): string {
  const src = foldArabicDigits(String(value ?? "").normalize("NFKC"));
  let out = "";
  for (const ch of src) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === TATWEEL || isDiacritic(code) || isZeroWidth(code)) continue;
    if (code === 0x0622 || code === 0x0623 || code === 0x0625 || code === ALEF) { out += String.fromCharCode(ALEF); continue; }
    if (code === ALEF_MAQSURA) { out += String.fromCharCode(YA); continue; }
    out += ch;
  }
  return out.replace(/\s+/g, " ").trim().toLowerCase();
}

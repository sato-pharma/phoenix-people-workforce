// Shared print plumbing for the hiring pack.
//
// Both documents are HTML printed by the browser, not PDFs built by a library. That is a deliberate
// choice and the single most important one in this feature: Arabic needs bidirectional layout and
// contextual letter-joining — the same letter has up to four shapes depending on its neighbours —
// and a browser does that correctly for free. `pdf-lib` and `pdfmake`, both already dependencies
// here, do NOT: they would emit the letters isolated and in the wrong order, producing a contract
// that is unreadable to the person signing it.
//
// The precedent is already in the codebase: the payslip route (app/api/payroll/[id]/payslips)
// serves print-styled HTML the same way. What "Print → Save as PDF" produces from these pages is a
// real PDF with selectable text, so nothing is lost by not generating one server-side.

/** HTML-escape a value that came from the database. */
export function escapeHtml(value: string | null | undefined): string {
  if (!value) return "";
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Hold a Latin or numeric value left-to-right inside Arabic prose.
 *
 * NOT DECORATION. A number written with separators — a tax card `477-108-318`, a date
 * `24 / 08 / 2026` — is not one number to the bidirectional algorithm. Inside Arabic text every
 * digit run resolves to an ARABIC number (rule W2: the nearest strong character before it is an
 * Arabic letter), and the rule that would fuse the runs back together across the separator applies
 * only to EUROPEAN numbers (W4). So three runs stay three, and a right-to-left paragraph lays them
 * out right to left.
 *
 * Measured in a browser on 2026-08-30, on this company's own recital and on a formatted date:
 *
 *     477-108-318       painted as   318-108-477
 *     24 / 08 / 2026    painted as   2026 / 08 / 24
 *
 * Nothing in this repository can see that. The HTML is correct, the string is correct, `escapeHtml`
 * is correct, and every test comparing strings passes. Only a real layout engine reorders the runs,
 * which is why the browser check on these documents is not a formality.
 *
 * CHANGING THE SEPARATOR DOES NOT FIX IT — also measured. `477-108-318` with a plain hyphen
 * reverses exactly as `10530-06000-82894` with a non-breaking one does. The hyphen is a red
 * herring; the direction of the paragraph is the cause.
 *
 * WHY ISOLATE CHARACTERS AND NOT AN ELEMENT. Most of these values are interpolated into a sentence
 * that is escaped as one whole string — the contract's articles are plain text carrying `{{TOKEN}}`
 * — so there is no element to hang `dir` on without restructuring the text. U+2066 LEFT-TO-RIGHT
 * ISOLATE and U+2069 POP DIRECTIONAL ISOLATE travel inside the string, survive `escapeHtml`
 * untouched, and are the same device the owner's own Word originals use for these values. They are
 * invisible and paired, so pinning a value that already reads correctly changes nothing.
 *
 * Where a value has an element of its own — a field span, a table cell — `dir="ltr"` on that
 * element is equivalent, and is what those renderers already do. Never `dir="auto"` on the
 * surrounding line: it reads only the first strong character, so an Arabic label turns the whole
 * line back to RTL and takes the number with it.
 */
export function pinLtr(value: string | null | undefined): string {
  if (!value) return "";
  return `\u2066${value}\u2069`;
}

const ARABIC_DAY_NAMES = [
  "الأحد",
  "الاثنين",
  "الثلاثاء",
  "الأربعاء",
  "الخميس",
  "الجمعة",
  "السبت",
] as const;

/** The Arabic weekday for an ISO date — the contract opens "إنه في يوم (...)". */
export function arabicDayName(iso: string | null | undefined): string {
  if (!iso) return "";
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  if (!match) return "";
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (Number.isNaN(date.getTime())) return "";
  return ARABIC_DAY_NAMES[date.getUTCDay()] ?? "";
}

/** dd / mm / yyyy — the form's own order, and how a date is written by hand in Egypt. */
export function formatDayMonthYear(iso: string | null | undefined): string {
  const parts = splitIsoDate(iso);
  if (!parts) return "";
  return `${parts.day} / ${parts.month} / ${parts.year}`;
}

/**
 * Today's date in Cairo, as YYYY-MM-DD.
 *
 * NOT `new Date().toISOString()`. That is UTC, and Cairo runs two or three hours ahead of it — so
 * anything printed after 22:00 local would be stamped with yesterday's date on a document the
 * employee is about to sign and date by hand. Every date this system reports is Cairo local time.
 */
export function todayInCairo(): string {
  // en-CA formats as YYYY-MM-DD, which is the shape the rest of this module parses.
  return new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "Africa/Cairo",
    year: "numeric",
  }).format(new Date());
}

export function splitIsoDate(
  iso: string | null | undefined,
): { day: string; month: string; year: string } | null {
  if (!iso) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  if (!match) return null;
  return { year: match[1], month: match[2], day: match[3] };
}

/**
 * A duration in months, written the way the contract's مادة (4) reads.
 *
 * Arabic counts differently either side of ten and again in the dual, so "12 شهر" would be wrong
 * on a legal document where "سنة واحدة" is what a reader expects. Whole years are named as years.
 */
export function describeDurationMonths(months: number | null | undefined): string {
  if (!months || !Number.isFinite(months) || months <= 0) return "";
  if (months === 12) return "سنة واحدة";
  if (months === 24) return "سنتان";
  if (months % 12 === 0) {
    const years = months / 12;
    if (years >= 3 && years <= 10) return `${years} سنوات`;
    return `${years} سنة`;
  }
  if (months === 1) return "شهر واحد";
  if (months === 2) return "شهران";
  if (months >= 3 && months <= 10) return `${months} أشهر`;
  return `${months} شهرًا`;
}

/**
 * The Arabic face stack used by both documents.
 *
 * Self-hosted webfonts were rejected on purpose. These pages are printed from HR's Windows desktops,
 * where every face below ships with the operating system, so the output is identical on every
 * machine with no network round-trip at print time — and a print that silently falls back because a
 * font request failed is a worse failure than one that never depended on the network. Tahoma leads
 * because its Arabic metrics are the most predictable at small sizes, which is what a 19-article
 * contract on four A4 pages needs.
 */
export const ARABIC_FONT_STACK =
  '"Tahoma", "Segoe UI", "Traditional Arabic", "Simplified Arabic", "Arial Unicode MS", Arial, sans-serif';

/**
 * The banner every printable page carries on screen and never on paper.
 *
 * It exists because a browser cannot set duplex, paper size or copy count from CSS — those live in
 * the print dialog, and the person pressing Ctrl+P is the only one who can set them. Form 1 MUST be
 * double-sided (its own back-page instructions are part of the document, and page 1 says "أنظر
 * خلفه" — see the back), so the requirement is stated where it cannot be missed rather than
 * assumed.
 */
export function printBanner(lines: string[]): string {
  const items = lines.map((line) => `<li>${escapeHtml(line)}</li>`).join("");
  return `<div class="print-banner no-print">
    <button type="button" class="print-banner__action" onclick="window.print()">Print</button>
    <ul class="print-banner__list">${items}</ul>
  </div>`;
}

export const PRINT_BANNER_CSS = `
  .print-banner {
    position: sticky; top: 0; z-index: 50;
    display: flex; gap: 16px; align-items: flex-start;
    padding: 14px 18px; margin-bottom: 18px;
    background: #0f172a; color: #f8fafc;
    font-family: "Segoe UI", system-ui, sans-serif; font-size: 13px; line-height: 1.55;
    direction: ltr; text-align: left;
  }
  .print-banner__action {
    flex: 0 0 auto; padding: 8px 18px; border: 0; border-radius: 4px;
    background: #f8fafc; color: #0f172a; font: inherit; font-weight: 600; cursor: pointer;
  }
  .print-banner__list { margin: 0; padding-inline-start: 18px; }
  .print-banner__list li { margin: 0 0 2px; }
  @media print { .no-print { display: none !important; } }
`;

/**
 * A tax registration number laid out across a form's three printed segments.
 *
 * Egyptian tax numbers are written in three groups — 123/456/789 — and both social-insurance forms
 * print the slashes themselves. Whatever separators HR types are discarded and the digits are
 * regrouped, so "123-456-789", "123/456/789" and "123456789" all land the same way.
 */
export function splitTaxRegistration(raw: string): [string, string, string] {
  const groups = raw.split(/[^0-9]+/u).filter(Boolean);
  if (groups.length >= 3) return [groups[0], groups[1], groups.slice(2).join("")];
  const digits = groups.join("");
  return [digits.slice(0, 3), digits.slice(3, 6), digits.slice(6, 9)];
}

/**
 * The permanent address as a document states it — prose, not codes.
 *
 * Form 1's قسم/مركز and محافظة fields are two-cell grids holding NUMERIC government codes, so
 * reusing them here would print something like "شارع كذا، 03، 01" on an instrument somebody signs.
 * The free-text residence address on the employee record is what prose wants; the structured parts
 * are only a fallback for when it is empty.
 *
 * SHARED ON PURPOSE. The contract and the custody receipt both print this person's address, they
 * are signed weeks apart, and a reader comparing the two reads a difference as one of them being
 * wrong. Two local copies of this logic would drift the first time either was improved.
 */
export function resolvePermanentAddress(input: {
  residenceAddress: string | null;
  residenceCity: string | null;
  addressStreet: string | null;
  addressBuilding: string | null;
}): string {
  const direct = input.residenceAddress?.trim();
  if (direct) return direct;

  return [
    input.addressStreet,
    input.addressBuilding ? `رقم ${input.addressBuilding}` : null,
    input.residenceCity,
  ]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part))
    .join("، ");
}

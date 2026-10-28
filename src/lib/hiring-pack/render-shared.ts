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
 * A money figure in the form these papers print it: digits only, the unit supplied by the prose.
 *
 * Piastres print as two digits or not at all. "12,750.5" on a salary clause is the kind of figure
 * that gets read as five piastres by one party and fifty by the other, and مادة (2) of the
 * contract prints the same amount again in words directly beside it, so the two have to agree
 * exactly.
 *
 * SHARED RATHER THAN COPIED. It began as a private helper in render-contract.ts; a company template
 * can carry a salary too, and a second implementation of this is how one paper comes to print
 * 12,750.50 beside another printing 12750.5 for the same person.
 */
export function formatMoney(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "";
  const hasPiastres = Math.round(value * 100) % 100 !== 0;
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: hasPiastres ? 2 : 0,
    maximumFractionDigits: 2,
  }).format(value);
}

/**
 * Today's date in Cairo, as YYYY-MM-DD.
 *
 * NOT `new Date().toISOString()`. That is UTC, and Cairo runs two or three hours ahead of it — so
 * anything printed after 22:00 local would be stamped with yesterday's date on a document the
 * employee is about to sign and date by hand. Every date this system reports is Cairo local time.
 */
export { todayInCairo } from "@/lib/date-only";

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

/** Arabic counts in three bands — one, two, and then either side of ten. One rule, three units. */
export function countedNoun(
  count: number,
  one: string,
  two: string,
  few: string,
  many: string,
): string {
  if (count === 1) return one;
  if (count === 2) return two;
  if (count >= 3 && count <= 10) return `${count} ${few}`;
  return `${count} ${many}`;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * How long somebody served, in years, months and days — the span a certificate of experience states.
 *
 * THE LAST WORKING DAY IS A DAY WORKED, which is the whole reason this is not a plain subtraction.
 * Somebody who started on 1 March and left on 31 August served six months, not five months and
 * thirty days, and a certificate that says the latter reads as though the company is shaving the
 * end of his service. So the end is advanced by one day and the calendar difference taken to that
 * exclusive bound, which lands whole periods on whole numbers and a single day on «يوم واحد».
 *
 * A zero component is omitted rather than printed: «3 سنوات» is what a reader expects, and
 * «3 سنوات و0 أشهر و0 يومًا» reads like a machine filled it in. An empty string comes back when
 * either end is missing or the order is reversed — a certificate rules that line for a human rather
 * than printing a negative span, the same answer every other blank on these papers gives.
 */
export function describeServiceDuration(
  fromIso: string | null | undefined,
  toIso: string | null | undefined,
): string {
  const span = serviceSpan(fromIso, toIso);
  if (!span) return "";

  const parts: string[] = [];
  if (span.years > 0) parts.push(countedNoun(span.years, "سنة واحدة", "سنتان", "سنوات", "سنة"));
  if (span.months > 0) parts.push(countedNoun(span.months, "شهر واحد", "شهران", "أشهر", "شهرًا"));
  if (span.days > 0) parts.push(countedNoun(span.days, "يوم واحد", "يومان", "أيام", "يومًا"));
  return parts.join(" و");
}

/**
 * The same span, for the English certificate.
 *
 * ONE ARITHMETIC, TWO WORDINGS — `serviceSpan` below is shared, so the two certificates cannot state
 * different lengths for the same employment. Two papers a man carries to the same embassy that
 * disagree about how long he worked here is worse than either being wrong on its own.
 */
export function describeServiceDurationEn(
  fromIso: string | null | undefined,
  toIso: string | null | undefined,
): string {
  const span = serviceSpan(fromIso, toIso);
  if (!span) return "";

  const parts: string[] = [];
  const unit = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;
  if (span.years > 0) parts.push(unit(span.years, "year"));
  if (span.months > 0) parts.push(unit(span.months, "month"));
  if (span.days > 0) parts.push(unit(span.days, "day"));
  // "3 years, 6 months and 12 days" — the serial comma is deliberately absent, which is the house
  // register for a British-English document read by an Egyptian ministry or a Gulf employer.
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/**
 * The calendar difference, as whole years, months and days. Null when it cannot be stated.
 *
 * THE LAST WORKING DAY IS A DAY WORKED, which is the whole reason this is not a plain subtraction.
 * Somebody who started on 1 March and left on 31 August served six months, not five months and
 * thirty days, and a certificate that says the latter reads as though the company is shaving the end
 * of his service. So the end is advanced by one day and the difference taken to that exclusive
 * bound, which lands whole periods on whole numbers and a single day on one day.
 *
 * Null — rather than a zero span — when either end is missing or the order is reversed. A
 * certificate rules that line for a human rather than printing a period it cannot stand behind, the
 * same answer every other blank on these papers gives.
 */
export function serviceSpan(
  fromIso: string | null | undefined,
  toIso: string | null | undefined,
): { years: number; months: number; days: number } | null {
  const from = splitIsoDate(fromIso);
  const to = splitIsoDate(toIso);
  if (!from || !to) return null;

  const start = Date.UTC(Number(from.year), Number(from.month) - 1, Number(from.day));
  // The exclusive bound: the day AFTER the last day worked. See the note above.
  const end = Date.UTC(Number(to.year), Number(to.month) - 1, Number(to.day) + 1);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;

  const endDate = new Date(end);
  let years = endDate.getUTCFullYear() - Number(from.year);
  let months = endDate.getUTCMonth() + 1 - Number(from.month);
  let days = endDate.getUTCDate() - Number(from.day);

  if (days < 0) {
    months -= 1;
    // The month that ran out — the one BEFORE the exclusive end, whose length is what those days
    // were borrowed from. `getUTCMonth()` is already zero-based, so this is that month's number.
    days += daysInMonth(endDate.getUTCFullYear(), endDate.getUTCMonth());
  }
  if (months < 0) {
    years -= 1;
    months += 12;
  }

  return { years, months, days };
}

/**
 * A date as an English document writes it: "31 August 2026".
 *
 * THE MONTH IS SPELLED OUT, and on this document that is a correctness decision rather than a
 * style one. The Arabic certificate prints `31 / 08 / 2026`, which an Egyptian reader parses
 * day-first without thinking; the English one is read at an embassy or by a Gulf employer, where
 * `08 / 09 / 2026` is September the eighth to half the world and the ninth of August to the other
 * half. A named month cannot be misread, and this paper exists to be believed by a stranger.
 *
 * `en-GB` with an explicit UTC zone, for the reason every date helper in this module pins one: the
 * value is a plain `YYYY-MM-DD` with no time in it, so letting the runtime localise it would move
 * the day backwards on a machine west of Greenwich.
 */
export function formatLongDateEn(iso: string | null | undefined): string {
  const parts = splitIsoDate(iso);
  if (!parts) return "";
  const date = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)));
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "long",
    timeZone: "UTC",
    year: "numeric",
  }).format(date);
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
 *
 * THE NOTO ENTRIES ARE FOR THE SERVER, and they are load-bearing. Every face before them is a
 * WINDOWS font and the container has none of them, so a filed or downloaded PDF fell through to
 * ttf-freefont — which carries Arabic codepoints but does NOT shape them. Chromium drew each letter
 * in its isolated form, so the words came apart into separate letters, and the wrong metrics turned
 * a three-page contract into sixteen. Neither symptom names a font, which is why it survived until
 * somebody opened a downloaded contract and said the font was wrong.
 *
 * DO NOT REMOVE THEM TO TIDY THE LIST. They are never reached on Windows, because Tahoma is first,
 * and they are the only shaping face the server has. Installed by the Dockerfile's
 * `font-noto-arabic`; the two must change together, which the print-banner test now pins.
 */
export const ARABIC_FONT_STACK =
  '"Tahoma", "Segoe UI", "Traditional Arabic", "Simplified Arabic", "Arial Unicode MS", ' +
  '"Noto Sans Arabic", "Noto Naskh Arabic", Arial, sans-serif';

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
    <button type="button" class="print-banner__action" id="phx-print">Print</button>
    <a class="print-banner__action print-banner__action--ghost" id="phx-pdf" hidden download>Download PDF</a>
    <ul class="print-banner__list">${items}</ul>
  </div>
  ${DOWNLOAD_LINK_SCRIPT}`;
}

/**
 * Point the Download PDF link at this same document, asked for as a file.
 *
 * THE HREF IS BUILT FROM `location`, not passed in, and that is the whole reason this works for
 * every paper including ones added later: the renderers do not know the employee, the document key
 * or the version being viewed — the ROUTE does, and the browser is already standing on that URL.
 * Threading those three values through nine renderers to rebuild a URL they are already inside is
 * how one of them ends up rebuilding it wrong.
 *
 * HIDDEN UNTIL PROVEN, because this banner is also served inside the fill screen's preview panel
 * and by `file://` when a paper is opened from disk, where there is no route behind it. A dead
 * button on a legal document reads as a broken system; an absent one reads as a screen that does
 * not offer downloads.
 *
 * `preview=1` is dropped deliberately. Downloading the paper is not previewing it, and carrying the
 * flag through would file the document as never printed.
 */
const DOWNLOAD_LINK_SCRIPT = `<script>
  (function () {
    // The Print button is wired here, never with an inline onclick: a paper framed inside a page
    // (the hand-typed paper) runs under the page policy, which blocks every inline event handler
    // even when the script itself carries the page nonce.
    var printButton = document.getElementById("phx-print");
    if (printButton) {
      printButton.addEventListener("click", function () {
        window.print();
      });
    }

    // "clearanceEmployee-A-12.pdf". Built from the URL rather than the document's Arabic title:
    // Windows rejects a colon, which every uploaded company template carries in its custom:<uuid>
    // key, and a browser that cannot read the name falls back to the last path segment — which
    // here would be the word "print" on every paper anyone ever saved.
    var fileName = function (url) {
      var parts = url.pathname.split("/").filter(Boolean);
      var hrId = parts.length > 1 ? parts[parts.length - 2] : "document";
      var doc = url.searchParams.get("document") || "document";
      var safe = function (value) {
        return value.replace(/[^A-Za-z0-9._-]+/g, "-");
      };
      return safe(doc) + "-" + safe(hrId) + ".pdf";
    };

    var link = document.getElementById("phx-pdf");
    if (!link) return;
    try {
      var here = new URL(window.location.href);
      if (here.protocol !== "https:" && here.protocol !== "http:") return;
      // NO REGEX HERE, DELIBERATELY. This script is authored inside a template literal, where a
      // backslash is an escape for the template and never reaches the browser: the first version
      // of this line was /\/print\/?$/ in the source and arrived as //print/?$/ — a line
      // comment — so the whole script died on a SyntaxError and the button stayed hidden on every
      // document. Plain string work has no escape to lose.
      var path = here.pathname;
      while (path.length > 1 && path.charAt(path.length - 1) === "/") path = path.slice(0, -1);
      if (path.slice(-6) !== "/print") return;
      here.searchParams.set("format", "pdf");
      here.searchParams.delete("preview");
      here.searchParams.delete("inventory");
      link.href = here.toString();
      link.hidden = false;

      // FETCHED RATHER THAN FOLLOWED, because the server spends ten to thirty seconds in Chromium
      // and a plain <a download> shows NOTHING for all of it — no tab, no spinner, no progress.
      // The button was reported as "appeared but not working" for exactly that reason: it was
      // working, silently, and silence on a click reads as a broken button.
      //
      // It also means a refusal can be SHOWN. Following the link would navigate the print tab to a
      // JSON error and lose the document; here the paper stays on screen and the reason is put on
      // the button itself.
      var idle = link.textContent;
      var busy = false;
      link.addEventListener("click", function (event) {
        if (!window.fetch || !window.URL || !window.URL.createObjectURL) return; // let the href work
        event.preventDefault();
        if (busy) return;
        busy = true;
        link.textContent = "Preparing PDF…";
        link.style.opacity = "0.65";

        var done = function (message) {
          busy = false;
          link.style.opacity = "";
          link.textContent = message || idle;
          if (message) {
            window.setTimeout(function () {
              link.textContent = idle;
            }, 6000);
          }
        };

        window
          .fetch(link.href, { credentials: "same-origin" })
          .then(function (response) {
            if (response.ok) return response.blob();
            return response
              .json()
              .catch(function () {
                return {};
              })
              .then(function (body) {
                throw new Error(body && body.message ? body.message : "The PDF could not be built.");
              });
          })
          .then(function (blob) {
            var href = window.URL.createObjectURL(blob);
            var save = document.createElement("a");
            save.href = href;
            save.download = fileName(here);
            document.body.appendChild(save);
            save.click();
            document.body.removeChild(save);
            window.setTimeout(function () {
              window.URL.revokeObjectURL(href);
            }, 30000);
            done();
          })
          .catch(function (error) {
            // The message is the server's own words where it sent any — a refusal names the file it
            // could not read, which is the difference between a fixable report and a mystery.
            done(String((error && error.message) || "Could not build the PDF"));
          });
      });
    } catch (error) {
      /* No link rather than a broken one. */
    }
  })();
</script>`;

export const PRINT_BANNER_CSS = `
  .print-banner {
    position: sticky; top: 0; z-index: 50;
    display: flex; gap: 16px; align-items: flex-start;
    padding: 14px 18px; margin-bottom: 18px;
    background: #0f172a; color: #f8fafc;
    font-family: "Segoe UI", system-ui, sans-serif; font-size: 13px; line-height: 1.55;
    direction: ltr; text-align: left;
  }
  /* Square, like every other edge in the house. The golden rule is "no round or semi-round
     corners, anywhere", and this banner sits on screen above all twelve papers, so a radius here
     is twelve breaches rather than one. tokens.css still ships --phx-radius-* and still calls 4px
     "the default for cards, inputs and buttons" — that default is the bug, not the house style. */
  .print-banner__action {
    flex: 0 0 auto; padding: 8px 18px; border: 0;
    background: #f8fafc; color: #0f172a; font: inherit; font-weight: 600; cursor: pointer;
    text-decoration: none; line-height: 1.35;
  }
  /* The second action is secondary: Print is still the normal way a paper reaches a signing table,
     and the download exists for the one thing printing cannot do — number the pages. */
  .print-banner__action--ghost {
    background: transparent; color: #f8fafc;
    box-shadow: inset 0 0 0 1px rgba(248, 250, 252, 0.55);
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
/** ٠-٩ and ۰-۹ folded to 0-9. Anything else is returned untouched. */
function toAsciiDigits(value: string): string {
  return value.replace(/[٠-٩۰-۹]/gu, (char) => {
    const code = char.charCodeAt(0);
    return String(code - (code >= 0x06f0 ? 0x06f0 : 0x0660));
  });
}

export function splitTaxRegistration(raw: string): [string, string, string] {
  // ARABIC-INDIC DIGITS FIRST, and this is not politeness. The owner supplied this number as
  // "٣١٨-١٠٨-٤٧٧", copied from the tax card. `[^0-9]` does not consider ٣ a digit, so the whole
  // string reads as one long separator, every group is empty, and Form 1 prints three BLANK runs
  // where the tax registration belongs — no error, no warning, a government form filed without it.
  const groups = toAsciiDigits(raw).split(/[^0-9]+/u).filter(Boolean);
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

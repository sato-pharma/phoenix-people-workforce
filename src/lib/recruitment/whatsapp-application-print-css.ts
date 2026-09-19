// Recruitment / ATS — the print rules for the page a WhatsApp application is printed from.
//
// PURE and in its own file so a test can hold the string up and a headless browser can print exactly
// it. The component (src/components/recruitment/whatsapp-application-print.tsx) draws each PDF page on a
// canvas inside a `.wa-print-page`, and these rules turn each one into exactly one sheet of paper.
//
// WHY THE SIZES ARE 296 mm AND 209 mm, NOT 297 AND 210. A box exactly the height of the paper spills a
// blank extra page whenever layout rounds up by a fraction of a millimetre. The width has no such
// problem, so the landscape sheet is 297 wide and 209 tall.
//
// A LANDSCAPE PDF PAGE GETS A LANDSCAPE SHEET (a named page, `wa-landscape`), so a wide CV is not
// shrunk to fit the width of a portrait sheet. Every other page, whatever its own paper size (US Letter
// is common in CVs written abroad), is fitted inside A4 portrait with nothing cropped.

/**
 * How sharp a page is drawn: 3x the PDF's 72-point grid is about 216 dpi, which keeps a 0.5 pt hairline
 * and small type crisp on paper. Capped by area so a very large page cannot exhaust a phone's memory.
 */
export const PRINT_SCALE = 3;
export const MAX_PIXELS_PER_PAGE = 6_000_000;

/** The class the component gives each drawn page, and the one it adds when the page is wider than tall. */
export const PRINT_PAGE_CLASS = "wa-print-page";
export const PRINT_PAGE_LANDSCAPE_CLASS = "wa-print-page wa-print-page--landscape";

/** Anything with this class is on the screen only and is hidden on the paper. */
export const SCREEN_ONLY_CLASS = "wa-screen-only";

export const PRINT_CSS = `
  .wa-print-page { display: flex; align-items: center; justify-content: center; width: 100%; max-width: 210mm; aspect-ratio: 210 / 296; margin: 0 auto 16px; border: 1px solid #cbd5e1; background: #fff; overflow: hidden; }
  .wa-print-page--landscape { max-width: 297mm; aspect-ratio: 297 / 209; }
  .wa-print-page canvas { display: block; width: 100%; height: 100%; object-fit: contain; }
  @page { size: A4 portrait; margin: 0; }
  @page wa-landscape { size: A4 landscape; margin: 0; }
  @media print {
    html, body { margin: 0 !important; padding: 0 !important; background: #fff !important; }
    .wa-screen-only { display: none !important; }
    .wa-print-stage { padding: 0 !important; background: #fff !important; }
    .wa-print-page { width: 210mm; max-width: none; height: 296mm; aspect-ratio: auto; margin: 0; border: 0; break-after: page; page-break-after: always; }
    .wa-print-page--landscape { page: wa-landscape; width: 297mm; height: 209mm; }
    .wa-print-page:last-child { break-after: auto; page-break-after: auto; }
  }
`;

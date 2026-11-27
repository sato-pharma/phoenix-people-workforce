// ONE COPY ON THE PAGE, AND THE PRINTER MAKES THE REST (owner, 2026-11-27): "I don't want the forms
// all after each other. I want one copy, and I will tell the printer to print this one copy 3 times."
//
// The print route draws a paper once (`renderHiringPaper({ singleCopy: true })`). Every renderer's
// on-screen banner used to say "N copies are already laid out below — leave the dialog's copy count
// at 1"; this rewrites that one line to "One copy is laid out below — set the print dialog's copies
// to N." One rewrite here rather than a flag threaded through twenty renderers, because every
// renderer words the line the same way. The banner is `no-print`: it never reaches paper.
//
// Pure, so `tests/hr-forms-wizard.test.ts` pins it against the banner each renderer really draws.

const COPY_BANNER =
  /\d+ (?:copy is|copies are|copies of all three pages are)(?: already)? laid out below — leave the dialog(&#39;|')s copy count at 1\./gu;

export function singleCopyBanner(html: string, copies: number): string {
  return html.replace(
    COPY_BANNER,
    (_whole, apostrophe: string) =>
      `One copy is laid out below — set the print dialog${apostrophe}s copies to ${copies}.`,
  );
}

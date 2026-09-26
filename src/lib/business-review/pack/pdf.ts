// The Sales Review pack — the PDF.
//
// Reads the pack model and draws it. It computes NO figure and names NO section, exactly as the
// workbook does not: the two files a manager exports a minute apart must not disagree in front of
// his own manager.
//
// CODE-BUILT, NOT HEADLESS CHROMIUM, and the choice is deliberate. `src/lib/offers/pdf.ts` uses
// Chromium because an offer letter's design IS css — grid, hairlines, break-inside — and re-drawing
// it in coordinates would drift from the HTML the approver saw. This pack has no HTML to match: it
// is a list of titled tables, which pdfmake draws natively, and the double-visit report already set
// that precedent in this repo. One fewer browser launch per export.
//
// ONE OF THE 14 STANDARD PDF FONTS, so no font file has to be bundled or traced into the runtime.
// The house identity's own face is not among them; the identity is carried by the PALETTE, the
// bands and the layout, which is what a reader recognises across a page anyway.
//
// THE HOUSE IDENTITY `SATO-DIS-2026-01 v1.0`, ink rule relaxed for the bands — the owner's decision
// on 2026-09-26, the same exemption the premium closing workbook and the spotlight sheet hold.
//
// 🔴 A TABLE IS CAPPED AND SAYS SO. A pack is a presentation, not a dataset: thirty rows of bricks
// is a slide nobody reads, and pdfmake paginates a long table badly. What is cut is stated on the
// page, with the workbook named as the place the whole of it lives — never silently truncated,
// which would let a reader believe a district has four bricks when it has forty.

import pdfMake from "pdfmake";
import type { Content } from "pdfmake";

import { HOUSE_COLORS } from "@/lib/hiring-pack/house-identity";

import type { PackSection, SalesReviewPack } from "./model";

pdfMake.setFonts({
  Helvetica: {
    bold: "Helvetica-Bold",
    bolditalics: "Helvetica-BoldOblique",
    italics: "Helvetica-Oblique",
    normal: "Helvetica",
  },
});

type PdfDocDefinition = Parameters<typeof pdfMake.createPdf>[0];

/** Rows drawn per section. Above this the pack names the workbook instead of going on. */
const ROW_CAP = 18;

const cell = (value: unknown) =>
  value == null ? "—" : typeof value === "number" ? value.toLocaleString("en-US") : String(value);

function sectionContent(section: PackSection): Content[] {
  const shown = section.rows.slice(0, ROW_CAP);
  const cut = section.rows.length - shown.length;

  const body = [
    section.columns.map((label, i) => ({
      alignment: section.align[i],
      color: "#FFFFFF",
      fillColor: HOUSE_COLORS.blue,
      style: "th",
      text: label,
    })),
    ...shown.map((row, r) =>
      row.map((value, i) => ({
        alignment: section.align[i],
        // The house zebra at 6%, and nothing else filled.
        fillColor: r % 2 === 1 ? HOUSE_COLORS.tint : undefined,
        style: "td",
        text: cell(value),
      })),
    ),
  ];

  const content: Content[] = [
    { style: "band", table: { body: [[{ fillColor: HOUSE_COLORS.deep, text: section.title, style: "bandText" }]], widths: ["*"] }, layout: "noBorders" },
    { style: "note", text: section.note },
    {
      layout: {
        hLineColor: () => HOUSE_COLORS.hair,
        hLineWidth: () => 0.5,
        vLineColor: () => HOUSE_COLORS.hair,
        vLineWidth: () => 0.5,
      },
      table: { body, headerRows: 1, widths: section.columns.map(() => "*") },
    },
  ];

  if (cut > 0) {
    content.push({
      style: "note",
      text: `${cut} more row${cut === 1 ? "" : "s"} are in the Excel version of this pack — a slide is a presentation, not the whole dataset.`,
    });
  }
  return content;
}

export async function renderPackPdf(pack: SalesReviewPack): Promise<Buffer> {
  const generated =
    new Intl.DateTimeFormat("en-GB", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "Africa/Cairo",
    }).format(new Date(pack.generatedAt)) + " Cairo";

  const content: Content[] = [
    {
      layout: "noBorders",
      style: "band",
      table: {
        body: [[{ fillColor: HOUSE_COLORS.deep, style: "coverText", text: "Sales Review" }]],
        widths: ["*"],
      },
    },
    { style: "subject", text: pack.subject.title },
    { style: "window", text: pack.subject.windowLabel },
    { style: "note", text: pack.coverageNote },
    { style: "note", text: `Generated ${generated}. Review, not a payout record.` },
  ];

  if (pack.sections.length === 0) {
    content.push({
      style: "note",
      text: "No metrics were chosen, so this pack has no sections. Tick what you want on the Business Review page and export again.",
    });
  }

  pack.sections.forEach((section, index) => {
    const parts = sectionContent(section);
    // Each section starts a page of its own — a pack is read a slide at a time, and a table split
    // across a page break loses its heading row for the half nobody scrolled back to.
    content.push(index === 0 ? parts[0] : ({ ...(parts[0] as object), pageBreak: "before" } as Content));
    content.push(...parts.slice(1));
  });

  const doc: PdfDocDefinition = {
    content,
    defaultStyle: { color: HOUSE_COLORS.body, font: "Helvetica", fontSize: 9 },
    // A4 landscape: these tables are wide, and a portrait page squeezes a five-column table into
    // something nobody can read from across a room.
    pageMargins: [28, 28, 28, 28],
    pageOrientation: "landscape",
    pageSize: "A4",
    styles: {
      band: { margin: [0, 0, 0, 6] },
      bandText: { bold: true, fontSize: 13, margin: [8, 6, 8, 6] },
      coverText: { bold: true, fontSize: 22, margin: [10, 14, 10, 14] },
      note: { color: HOUSE_COLORS.muted, fontSize: 8, italics: true, margin: [0, 0, 0, 8] },
      subject: { bold: true, fontSize: 14, margin: [0, 4, 0, 2] },
      td: { fontSize: 8.5, margin: [3, 3, 3, 3] },
      th: { bold: true, fontSize: 8.5, margin: [3, 4, 3, 4] },
      window: { color: HOUSE_COLORS.deep, bold: true, fontSize: 11, margin: [0, 0, 0, 8] },
    },
  };

  // `getBuffer()` rather than a stream, which is what the double-visit report already does here.
  return await pdfMake.createPdf(doc).getBuffer();
}

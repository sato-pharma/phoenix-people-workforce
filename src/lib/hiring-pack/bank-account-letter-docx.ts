import JSZip from "jszip";

import { HOUSE_COLORS } from "@/lib/hiring-pack/house-identity";

import { fitIdPicture, ID_SIDE_BOX_MM, type BankLetterIdPage, type IdPicture } from "./bank-letter-id-pages.ts";
import {
  BANK_LETTER_BANK_NAME_AR,
  BANK_LETTER_HEADINGS,
  bankLetterDateLine,
  type BankLetterRow,
} from "./bank-account-letter.ts";

// The bank account-opening letter as a Word file, written as OOXML by hand — the repo carries jszip
// and no Word library. The look is the one he approved on 2026-10-28 when the typed letter was put
// on the Sato letterhead (house identity SATO-DIS-2026-01):
//
//   A4, 15 mm sides, 36 mm top, 22 mm bottom, Tahoma throughout.
//   Header: the logo left (34 mm), "شركة ساتو فارما" over "Sato Pharma" right, the house band under.
//   Footer: a hairline, the head-office line, "صفحة N من M".
//   Body: the date (today in Cairo, passed in as `date`), the address to the bank, the greeting, the request, the table, "التوقيع" and a dotted line.
//   Table: right to left, fixed layout, deep bold headings over a blue rule, the 6% zebra, no grid,
//   the heading row repeats on every page and a row never splits across pages.
//
// NO SEAL — hiring documents never carry one.
//
// THEN ONE A4 PAGE PER CHOSEN PERSON (owner, 2026-11-27, `bank-letter-id-pages.ts`): the front of the
// national ID card in the top half, the back in the bottom half, in the letter's order. The pages are
// a section of their own with an EMPTY header and footer — a photocopy carries no letterhead — and the
// letter's "صفحة N من M" counts the letter's own pages (SECTIONPAGES), never the copies after it.

const W_NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';

const INK = "1A1A1A";
const DEEP = HOUSE_COLORS.deep.slice(1);
const BLUE = HOUSE_COLORS.blue.slice(1);
const TINT = HOUSE_COLORS.tint.slice(1);
const HAIR = HOUSE_COLORS.hair.slice(1);
const MUTED = HOUSE_COLORS.muted.slice(1);

/** Column widths in twentieths of a point — 4 / 21 / 15 / 12.5 / 27 / 13 / 7.5 % of the 180 mm line. */
export const BANK_LETTER_COLUMN_WIDTHS = [408, 2143, 1531, 1276, 2755, 1327, 765] as const;
const TABLE_WIDTH = BANK_LETTER_COLUMN_WIDTHS.reduce((sum, width) => sum + width, 0);
/** Serial, national ID, mobile and wage sit centred; the words read from the right. */
const COLUMN_ALIGN = ["center", "start", "center", "center", "start", "start", "center"] as const;

const LOGO_EMU = { cx: 1228725, cy: 485775 }; // 34 mm wide at the PNG's own 401 × 158 proportion
const BAND_EMU = { cx: 6477000, cy: 57150 }; // the full 180 mm line

export type BankLetterImages = {
  /** `public/brand/sato-pharma-logo-on-light.png`. */
  logoPng: Uint8Array;
  /** `public/brand/sato-house-band.png`. */
  bandPng: Uint8Array;
};

export type BankLetterDocxInput = {
  /** The day the letter is dated, `YYYY-MM-DD` in Cairo — the day it is exported. */
  date: string;
  rows: readonly BankLetterRow[];
  companyNameAr: string;
  companyNameEn: string;
  headOfficeAr: string;
  images: BankLetterImages;
  /** One page per chosen person, in the letter's order. None → the letter alone, as before. */
  idPages?: readonly BankLetterIdPage[];
};

function xml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function font(): string {
  return '<w:rFonts w:ascii="Tahoma" w:cs="Tahoma" w:eastAsia="Tahoma" w:hAnsi="Tahoma"/>';
}

function run(text: string, options: { bold?: boolean; color: string; size: number; rtl?: boolean }): string {
  const bold = options.bold ? "<w:b/><w:bCs/>" : "";
  const rtl = options.rtl === false ? "" : "<w:rtl/>";
  return `<w:r><w:rPr>${font()}${bold}<w:color w:val="${options.color}"/><w:sz w:val="${options.size}"/><w:szCs w:val="${options.size}"/>${rtl}</w:rPr><w:t xml:space="preserve">${xml(text)}</w:t></w:r>`;
}

function fieldRun(instruction: string): string {
  const rPr = `<w:rPr>${font()}<w:color w:val="${MUTED}"/><w:sz w:val="13"/><w:szCs w:val="13"/><w:rtl/></w:rPr>`;
  return (
    `<w:r>${rPr}<w:fldChar w:fldCharType="begin"/></w:r>` +
    `<w:r>${rPr}<w:instrText xml:space="preserve">${instruction}</w:instrText></w:r>` +
    `<w:r>${rPr}<w:fldChar w:fldCharType="separate"/></w:r>` +
    `<w:r>${rPr}<w:t>1</w:t></w:r>` +
    `<w:r>${rPr}<w:fldChar w:fldCharType="end"/></w:r>`
  );
}

function paragraph(
  runs: string,
  options: { after?: number; before?: number; line?: number; jc?: string; keepNext?: boolean; bidi?: boolean } = {},
): string {
  const keepNext = options.keepNext ? "<w:keepNext/>" : "";
  const bidi = options.bidi === false ? "" : "<w:bidi/>";
  return `<w:p><w:pPr>${keepNext}${bidi}<w:spacing w:after="${options.after ?? 0}" w:before="${options.before ?? 0}" w:line="${options.line ?? 300}"/><w:jc w:val="${options.jc ?? "start"}"/></w:pPr>${runs}</w:p>`;
}

function picture(relId: string, id: number, name: string, extent: { cx: number; cy: number }): string {
  return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${extent.cx}" cy="${extent.cy}"/><wp:effectExtent t="0" r="0" b="0" l="0"/><wp:docPr id="${id}" name="${xml(name)}" descr="${xml(name)}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${id}" name="${xml(name)}"/><pic:cNvPicPr><a:picLocks noChangeAspect="1" noChangeArrowheads="1"/></pic:cNvPicPr></pic:nvPicPr><pic:blipFill><a:blip r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr bwMode="auto"><a:xfrm><a:off x="0" y="0"/><a:ext cx="${extent.cx}" cy="${extent.cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
}

const NO_BORDER = 'w:val="none" w:color="FFFFFF" w:sz="0"';

function cell(text: string, column: number, options: { heading: boolean; zebra: boolean }): string {
  const width = BANK_LETTER_COLUMN_WIDTHS[column];
  const bottom = options.heading ? `w:val="single" w:color="${BLUE}" w:sz="8"` : NO_BORDER;
  const shade = options.zebra ? `<w:shd w:val="clear" w:color="auto" w:fill="${TINT}"/>` : "";
  const content = options.heading
    ? run(text, { bold: true, color: DEEP, size: 16 })
    : run(text, { color: INK, size: 15 });
  return `<w:tc><w:tcPr><w:tcW w:type="dxa" w:w="${width}"/><w:tcBorders><w:top ${NO_BORDER}/><w:left ${NO_BORDER}/><w:bottom ${bottom}/><w:right ${NO_BORDER}/></w:tcBorders>${shade}<w:tcMar><w:top w:type="dxa" w:w="50"/><w:left w:type="dxa" w:w="70"/><w:bottom w:type="dxa" w:w="50"/><w:right w:type="dxa" w:w="70"/></w:tcMar><w:vAlign w:val="center"/></w:tcPr>${paragraph(content, { line: 250, jc: COLUMN_ALIGN[column] })}</w:tc>`;
}

function tableRow(cells: readonly string[], options: { heading: boolean; zebra: boolean }): string {
  const header = options.heading ? "<w:tblHeader/>" : "";
  return `<w:tr><w:trPr><w:cantSplit/>${header}</w:trPr>${cells.map((text, column) => cell(text, column, options)).join("")}</w:tr>`;
}

function table(rows: readonly BankLetterRow[]): string {
  const grid = BANK_LETTER_COLUMN_WIDTHS.map((width) => `<w:gridCol w:w="${width}"/>`).join("");
  const body = rows.map((row, index) => tableRow(row, { heading: false, zebra: index % 2 === 1 })).join("");
  return `<w:tbl><w:tblPr><w:bidiVisual/><w:tblW w:type="dxa" w:w="${TABLE_WIDTH}"/><w:tblBorders><w:top ${NO_BORDER}/><w:left ${NO_BORDER}/><w:bottom w:val="single" w:color="${HAIR}" w:sz="4"/><w:right ${NO_BORDER}/><w:insideH ${NO_BORDER}/><w:insideV ${NO_BORDER}/></w:tblBorders><w:tblLayout w:type="fixed"/></w:tblPr><w:tblGrid>${grid}</w:tblGrid>${tableRow(BANK_LETTER_HEADINGS, { heading: true, zebra: false })}${body}</w:tbl>`;
}

/** The media a document carries beyond the letterhead: each ID picture, named by its relationship. */
type IdMedia = { relId: string; target: string; bytes: Uint8Array };

const ID_PAGE_MARGIN = 850; // 15 mm, every side
const ID_BOX_TWIPS = {
  height: Math.round((ID_SIDE_BOX_MM.height * 1440) / 25.4),
  width: Math.round((ID_SIDE_BOX_MM.width * 1440) / 25.4),
};

/** An empty box where a copy of that side goes, with a line saying why it is empty. */
function emptySideBox(note: string): string {
  const border = `w:val="dashed" w:color="${HAIR}" w:sz="6"`;
  return `<w:tbl><w:tblPr><w:jc w:val="center"/><w:tblW w:type="dxa" w:w="${ID_BOX_TWIPS.width}"/><w:tblBorders><w:top ${border}/><w:left ${border}/><w:bottom ${border}/><w:right ${border}/><w:insideH ${NO_BORDER}/><w:insideV ${NO_BORDER}/></w:tblBorders><w:tblLayout w:type="fixed"/></w:tblPr><w:tblGrid><w:gridCol w:w="${ID_BOX_TWIPS.width}"/></w:tblGrid><w:tr><w:trPr><w:cantSplit/><w:trHeight w:hRule="exact" w:val="${ID_BOX_TWIPS.height}"/></w:trPr><w:tc><w:tcPr><w:tcW w:type="dxa" w:w="${ID_BOX_TWIPS.width}"/><w:vAlign w:val="center"/></w:tcPr>${paragraph(run(note, { color: MUTED, size: 18 }), { jc: "center" })}</w:tc></w:tr></w:tbl>`;
}

const SIDE_CAPTIONS = { back: "ظهر البطاقة", front: "وجه البطاقة" } as const;

function missingSideNote(page: BankLetterIdPage, side: "front" | "back"): string {
  if (page.status === "scan") return "البطاقة محفوظة كملف PDF في مستندات التعيين — تُطبع من هناك";
  return side === "front" ? "لا توجد صورة لوجه البطاقة — تُلصق نسخة هنا" : "لا توجد صورة لظهر البطاقة — تُلصق نسخة هنا";
}

/** One person's page: the name and national ID, the front, then the back, each in its own half. */
function idPageXml(page: BankLetterIdPage, index: number, media: IdMedia[]): string {
  const side = (which: "front" | "back", image: IdPicture | null) => {
    let body: string;
    if (image) {
      const relId = `rIdIdCard${media.length + 1}`;
      const extension = image.contentType === "image/png" ? "png" : "jpeg";
      media.push({ bytes: image.bytes, relId, target: `media/id-card-${index + 1}-${which}.${extension}` });
      const extent = fitIdPicture(image.widthPx, image.heightPx);
      body = `<w:p><w:pPr><w:spacing w:after="0" w:before="0"/><w:jc w:val="center"/></w:pPr>${picture(relId, 100 + media.length, `${page.name} — ${SIDE_CAPTIONS[which]}`, extent)}</w:p>`;
    } else {
      body = emptySideBox(missingSideNote(page, which));
    }
    const caption = paragraph(run(SIDE_CAPTIONS[which], { color: MUTED, size: 16 }), {
      after: which === "front" ? 280 : 0,
      before: 60,
      jc: "center",
    });
    return body + caption;
  };
  const pageBreak = index > 0 ? "<w:pageBreakBefore/>" : "";
  const nameLine = `<w:p><w:pPr>${pageBreak}<w:bidi/><w:spacing w:after="40" w:before="0" w:line="300"/><w:jc w:val="start"/></w:pPr>${run(page.name, { bold: true, color: DEEP, size: 24 })}</w:p>`;
  const idLine = paragraph(run(`الرقم القومي: ${page.nationalId?.trim() || "—"}`, { color: INK, size: 20 }), { after: 240 });
  return nameLine + idLine + side("front", page.front) + side("back", page.back);
}

function documentXml(rows: readonly BankLetterRow[], date: string, idPages: readonly BankLetterIdPage[], media: IdMedia[]): string {
  const body = [
    paragraph(run(bankLetterDateLine(date), { color: INK, size: 22 }), { after: 200 }),
    paragraph(run(`السادة / ${BANK_LETTER_BANK_NAME_AR}`, { bold: true, color: DEEP, size: 24 }), { after: 120 }),
    paragraph(run("تحية طيبة وبعد،", { color: INK, size: 22 }), { after: 160 }),
    paragraph(
      run("برجاء التكرم بفتح حساب جاري للسادة التالي أسماؤهم، مع خصم المصاريف اللازمة من حساب الموظف.", {
        color: INK,
        size: 22,
      }),
      { after: 240, jc: "both" },
    ),
    table(rows),
    paragraph(run("التوقيع", { bold: true, color: DEEP, size: 22 }), { after: 360, before: 600, keepNext: true }),
    paragraph(run("……………………………………….", { color: "000000", size: 22 })),
  ].join("");
  const letterSection =
    '<w:sectPr><w:headerReference w:type="default" r:id="rIdHeader"/><w:footerReference w:type="default" r:id="rIdFooter"/><w:pgSz w:w="11906" w:h="16838" w:orient="portrait"/><w:pgMar w:top="2041" w:right="850" w:bottom="1247" w:left="850" w:header="680" w:footer="510" w:gutter="0"/><w:docGrid w:linePitch="360"/></w:sectPr>';
  if (idPages.length === 0) {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W_NS}><w:body>${body}${letterSection}</w:body></w:document>`;
  }
  // The letter's section closes on a paragraph of its own; the ID pages are the last section, on a
  // new page, under the empty header and footer.
  const closeLetter = `<w:p><w:pPr>${letterSection}</w:pPr></w:p>`;
  const pages = idPages.map((page, index) => idPageXml(page, index, media)).join("");
  const idSection = `<w:sectPr><w:headerReference w:type="default" r:id="rIdHeaderBlank"/><w:footerReference w:type="default" r:id="rIdFooterBlank"/><w:type w:val="nextPage"/><w:pgSz w:w="11906" w:h="16838" w:orient="portrait"/><w:pgMar w:top="${ID_PAGE_MARGIN}" w:right="${ID_PAGE_MARGIN}" w:bottom="${ID_PAGE_MARGIN}" w:left="${ID_PAGE_MARGIN}" w:header="0" w:footer="0" w:gutter="0"/><w:docGrid w:linePitch="360"/></w:sectPr>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W_NS}><w:body>${body}${closeLetter}${pages}${idSection}</w:body></w:document>`;
}

function headerXml(companyNameAr: string, companyNameEn: string): string {
  const cellPr = (width: number) =>
    `<w:tcPr><w:tcW w:type="dxa" w:w="${width}"/><w:tcBorders><w:top ${NO_BORDER}/><w:left ${NO_BORDER}/><w:bottom ${NO_BORDER}/><w:right ${NO_BORDER}/></w:tcBorders><w:tcMar><w:top w:type="dxa" w:w="0"/><w:left w:type="dxa" w:w="0"/><w:bottom w:type="dxa" w:w="0"/><w:right w:type="dxa" w:w="0"/></w:tcMar><w:vAlign w:val="bottom"/></w:tcPr>`;
  const logo = `<w:p>${picture("rIdLogo", 1, "Sato Pharma", LOGO_EMU)}</w:p>`;
  const names =
    paragraph(run(companyNameAr, { bold: true, color: DEEP, size: 16 }), { line: 240, jc: "right", bidi: false }) +
    paragraph(run(companyNameEn, { color: MUTED, size: 13, rtl: false }), { line: 240, jc: "right", bidi: false });
  const strip = `<w:tbl><w:tblPr><w:tblW w:type="dxa" w:w="${TABLE_WIDTH}"/><w:tblBorders><w:top ${NO_BORDER}/><w:left ${NO_BORDER}/><w:bottom ${NO_BORDER}/><w:right ${NO_BORDER}/><w:insideH ${NO_BORDER}/><w:insideV ${NO_BORDER}/></w:tblBorders><w:tblLayout w:type="fixed"/></w:tblPr><w:tblGrid><w:gridCol w:w="5103"/><w:gridCol w:w="5102"/></w:tblGrid><w:tr><w:tc>${cellPr(5103)}${logo}</w:tc><w:tc>${cellPr(5102)}${names}</w:tc></w:tr></w:tbl>`;
  const band = `<w:p><w:pPr><w:spacing w:after="0" w:before="125"/></w:pPr>${picture("rIdBand", 2, "Sato house band", BAND_EMU)}</w:p>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr ${W_NS}>${strip}${band}</w:hdr>`;
}

function footerXml(headOfficeAr: string): string {
  const muted = (text: string) => run(text, { color: MUTED, size: 13 });
  const address = `<w:p><w:pPr><w:pBdr><w:top w:val="single" w:color="${HAIR}" w:sz="4" w:space="4"/></w:pBdr><w:bidi/><w:spacing w:after="0" w:before="0" w:line="240"/><w:jc w:val="center"/></w:pPr>${muted(headOfficeAr)}</w:p>`;
  const pages = paragraph(`${muted("صفحة ")}${fieldRun("PAGE")}${muted(" من ")}${fieldRun("SECTIONPAGES")}`, {
    line: 240,
    jc: "center",
  });
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:ftr ${W_NS}>${address}${pages}</w:ftr>`;
}

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr>${font()}<w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-GB" w:bidi="ar-EG"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="0"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style><w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style></w:styles>`;

const SETTINGS_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:updateFields w:val="true"/><w:defaultTabStop w:val="720"/><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>';

const HEADER_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml";
const FOOTER_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml";

function contentTypesXml(withIdPages: boolean): string {
  const blank = withIdPages
    ? `<Override PartName="/word/header2.xml" ContentType="${HEADER_TYPE}"/><Override PartName="/word/footer2.xml" ContentType="${FOOTER_TYPE}"/>`
    : "";
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/><Override PartName="/word/header1.xml" ContentType="${HEADER_TYPE}"/><Override PartName="/word/footer1.xml" ContentType="${FOOTER_TYPE}"/>${blank}<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`;
}

const ROOT_RELS_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>';

const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

function documentRelsXml(withIdPages: boolean, media: readonly IdMedia[]): string {
  const blank = withIdPages
    ? `<Relationship Id="rIdHeaderBlank" Type="${REL}/header" Target="header2.xml"/><Relationship Id="rIdFooterBlank" Type="${REL}/footer" Target="footer2.xml"/>`
    : "";
  const pictures = media.map((item) => `<Relationship Id="${item.relId}" Type="${REL}/image" Target="${item.target}"/>`).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdStyles" Type="${REL}/styles" Target="styles.xml"/><Relationship Id="rIdSettings" Type="${REL}/settings" Target="settings.xml"/><Relationship Id="rIdHeader" Type="${REL}/header" Target="header1.xml"/><Relationship Id="rIdFooter" Type="${REL}/footer" Target="footer1.xml"/>${blank}${pictures}</Relationships>`;
}

/** The ID pages' header and footer: present and empty, so the letterhead is not carried over. */
const BLANK_HEADER_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr ${W_NS}><w:p/></w:hdr>`;
const BLANK_FOOTER_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:ftr ${W_NS}><w:p/></w:ftr>`;

const HEADER_RELS_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdLogo" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/sato-pharma-logo.png"/><Relationship Id="rIdBand" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/sato-house-band.png"/></Relationships>';

function coreXml(companyNameEn: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>فتح حسابات بنكية</dc:title><dc:creator>${xml(companyNameEn)}</dc:creator></cp:coreProperties>`;
}

const APP_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Phoenix Workforce</Application></Properties>';

export async function buildBankAccountLetterDocx(input: BankLetterDocxInput): Promise<Uint8Array> {
  const idPages = input.idPages ?? [];
  const withIdPages = idPages.length > 0;
  const media: IdMedia[] = [];
  const document = documentXml(input.rows, input.date, idPages, media);
  const zip = new JSZip();
  zip.file("[Content_Types].xml", contentTypesXml(withIdPages));
  zip.file("_rels/.rels", ROOT_RELS_XML);
  zip.file("docProps/core.xml", coreXml(input.companyNameEn));
  zip.file("docProps/app.xml", APP_XML);
  zip.file("word/document.xml", document);
  zip.file("word/_rels/document.xml.rels", documentRelsXml(withIdPages, media));
  zip.file("word/styles.xml", STYLES_XML);
  zip.file("word/settings.xml", SETTINGS_XML);
  zip.file("word/header1.xml", headerXml(input.companyNameAr, input.companyNameEn));
  zip.file("word/_rels/header1.xml.rels", HEADER_RELS_XML);
  zip.file("word/footer1.xml", footerXml(input.headOfficeAr));
  zip.file("word/media/sato-pharma-logo.png", input.images.logoPng);
  zip.file("word/media/sato-house-band.png", input.images.bandPng);
  if (withIdPages) {
    zip.file("word/header2.xml", BLANK_HEADER_XML);
    zip.file("word/footer2.xml", BLANK_FOOTER_XML);
    for (const item of media) zip.file(`word/${item.target}`, item.bytes);
  }
  return zip.generateAsync({ compression: "DEFLATE", type: "uint8array" });
}

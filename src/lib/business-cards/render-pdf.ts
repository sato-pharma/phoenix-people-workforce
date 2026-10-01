import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  beginText,
  endText,
  moveText,
  PDFDocument,
  PDFName,
  PDFObjectCopier,
  popGraphicsState,
  pushGraphicsState,
  setCharacterSpacing,
  setFillingCmykColor,
  setFontAndSize,
  showText,
} from "pdf-lib";
import type { PDFEmbeddedPage, PDFPage } from "pdf-lib";

import type { BusinessCardFields } from "./card-content.ts";
import {
  CARD_CONTACT_ROWS,
  CARD_ICON_BOX_MM,
  CARD_LINE_AREA_SLOT,
  CARD_NAME_SLOT,
  CARD_TITLE_SLOT,
  contactSlot,
  MM_TO_PT,
} from "./card-layout.ts";
import type { CardTextSlot } from "./card-layout.ts";
import { loadCardFont } from "./truetype.ts";
import type { CardFont } from "./truetype.ts";
import { storedZipStream } from "./zip-stream.ts";

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// PRINT-READY BUSINESS CARDS — ALL VECTOR, NOTHING RASTERISED.
//
// Each card is two pages, front then back, at the design's trimmed size plus a 3 mm bleed on every
// side, with TrimBox and BleedBox set so a print shop's software knows where to cut. The artwork is
// the owner's own PDF embedded as vector content; the text is real Montserrat outlines in the
// design's CMYK inks. Nothing passes through a browser or a bitmap on the way.
//
// The artwork is embedded ONCE per file and drawn on every page, so a file of a hundred cards
// carries one copy of the design, not a hundred.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export type BusinessCardAssets = { bold: Uint8Array; regular: Uint8Array; template: Uint8Array };

let cachedAssets: BusinessCardAssets | null = null;

/** Read from `assets/`, not `public/`: the design is never served over HTTP (next.config traces it). */
export function loadBusinessCardAssets(): BusinessCardAssets {
  if (!cachedAssets) {
    cachedAssets = {
      bold: readFileSync(join(process.cwd(), "assets", "business-cards", "Montserrat-Bold.ttf")),
      regular: readFileSync(join(process.cwd(), "assets", "business-cards", "Montserrat-Regular.ttf")),
      template: readFileSync(join(process.cwd(), "assets", "business-cards", "business-card-template.pdf")),
    };
  }
  return cachedAssets;
}

/**
 * The template, PARSED ONCE per template file (2026-10-01, "slow to transfer between page and page").
 * It is a static asset and a render only ever READS it: the OutputIntent and the embedded pages reach
 * the new file through PDFObjectCopier, which clones each object into the new document and leaves the
 * source untouched — so every render can share one parse of the design instead of re-parsing it on
 * each preview. Keyed by the bytes, so a caller passing its own assets gets its own parse; a failed
 * parse is not kept.
 *
 * Deliberately NOT shared: the fonts and the rendered bytes. A CardFont records the glyphs its
 * document used (truetype.ts), and that record decides the embedded subset — one shared across
 * renders would carry the previous card's glyphs into the next file. And the bytes carry the render's
 * own time (pdf-lib stamps CreationDate and ModDate on every new document), so the same card never
 * renders twice to the same bytes; a cache of them would serve a different file than a fresh render.
 */
const parsedTemplates = new WeakMap<Uint8Array, Promise<PDFDocument>>();

function loadParsedTemplate(bytes: Uint8Array): Promise<PDFDocument> {
  const cached = parsedTemplates.get(bytes);
  if (cached) return cached;
  const parsed = PDFDocument.load(bytes);
  parsedTemplates.set(bytes, parsed);
  // Dropped on failure so the next render parses again; this render still receives the failure.
  parsed.catch(() => {
    if (parsedTemplates.get(bytes) === parsed) parsedTemplates.delete(bytes);
  });
  return parsed;
}

/** A card whose text the font cannot draw. Refused rather than printed with blank boxes. */
export class BusinessCardCharacterError extends Error {
  characters: string[];
  person: string;

  constructor(person: string, characters: string[]) {
    super(`${person}'s card has characters the card font cannot print: ${characters.join(" ")}`);
    this.name = "BusinessCardCharacterError";
    this.characters = characters;
    this.person = person;
  }
}

function mm(value: number): number {
  return value * MM_TO_PT;
}

type Fonts = { bold: CardFont; regular: CardFont };

function assertPrintable(cards: BusinessCardFields[], fonts: Fonts) {
  for (const card of cards) {
    const missing = new Set<string>([
      ...fonts.bold.missingCharacters(`${card.name}${card.title}${card.lineArea}`),
      ...fonts.regular.missingCharacters(`${card.mobile}${card.email}${card.website}${card.address}`),
    ]);
    if (missing.size) throw new BusinessCardCharacterError(card.name || "A", [...missing]);
  }
}

/** The size a line is set at: the design's own, or smaller when that would overrun the margin. */
export function fittedSizePt(font: CardFont, text: string, slot: CardTextSlot): number {
  const width = font.widthOfText(text, slot.sizePt, slot.trackingEm * slot.sizePt);
  const limit = mm(slot.maxWidthMm);
  return width > limit ? slot.sizePt * (limit / width) : slot.sizePt;
}

/** Refuses, before anything is rendered, any card whose text the card font cannot draw. */
export function assertBusinessCardsPrintable(cards: BusinessCardFields[], options: { assets?: BusinessCardAssets } = {}) {
  const assets = options.assets ?? loadBusinessCardAssets();
  assertPrintable(cards, { bold: loadCardFont(assets.bold), regular: loadCardFont(assets.regular) });
}

export async function renderBusinessCardsPdf(
  cards: BusinessCardFields[],
  options: { assets?: BusinessCardAssets; title?: string } = {},
): Promise<Uint8Array> {
  if (cards.length === 0) throw new Error("Choose at least one employee.");
  const assets = options.assets ?? loadBusinessCardAssets();
  const fonts: Fonts = { bold: loadCardFont(assets.bold), regular: loadCardFont(assets.regular) };
  assertPrintable(cards, fonts);

  const doc = await PDFDocument.create();
  doc.setTitle(options.title ?? "Sato Pharma business cards");
  doc.setAuthor("Sato Pharma");
  doc.setCreator("Phoenix Workforce");
  doc.setProducer("Phoenix Workforce");

  const template = await loadParsedTemplate(assets.template);
  const [frontArt, backArt, iconArt] = template.getPages();
  if (!frontArt || !backArt || !iconArt) throw new Error("The business-card template is incomplete.");

  // THE DESIGN'S PRINTING CONDITION TRAVELS WITH EVERY FILE. Canva wrote an OutputIntent — the ICC
  // profile its CMYK inks are meant for. Without it the same ink numbers are converted differently:
  // measured on the back, every pixel moved by up to 34 levels. With it, the card converts exactly
  // as the owner's own PDF does.
  const outputIntents = template.catalog.get(PDFName.of("OutputIntents"));
  if (outputIntents) {
    doc.catalog.set(PDFName.of("OutputIntents"), PDFObjectCopier.for(template.context, doc.context).copy(outputIntents));
  }

  // The template's own boxes decide the geometry; nothing here assumes where its origin is.
  const media = frontArt.getMediaBox();
  const trim = frontArt.getTrimBox();
  const cardLeft = trim.x - media.x;
  const cardBottom = trim.y - media.y;
  const cardTop = cardBottom + trim.height;
  const artBox = { bottom: media.y, left: media.x, right: media.x + media.width, top: media.y + media.height };

  const iconMedia = iconArt.getMediaBox();
  const iconTop = iconMedia.y + iconMedia.height;
  const { heightMm, leftMm, paddingMm, rightMm, topsMm } = CARD_ICON_BOX_MM;
  const iconBoxes = topsMm.map((top) => ({
    bottom: iconTop - mm(top + heightMm + paddingMm),
    left: iconMedia.x + mm(leftMm - paddingMm),
    right: iconMedia.x + mm(rightMm + paddingMm),
    top: iconTop - mm(top - paddingMm),
  }));

  const embedded = await doc.embedPages(
    [frontArt, backArt, iconArt, iconArt, iconArt, iconArt],
    [artBox, artBox, ...iconBoxes],
  );
  const front = embedded[0] as PDFEmbeddedPage;
  const back = embedded[1] as PDFEmbeddedPage;
  const icons = embedded.slice(2);

  const boldRef = doc.context.nextRef();
  const regularRef = doc.context.nextRef();

  const addCardPage = (art: PDFEmbeddedPage): PDFPage => {
    const page = doc.addPage([media.width, media.height]);
    page.setBleedBox(0, 0, media.width, media.height);
    page.setTrimBox(cardLeft, cardBottom, trim.width, trim.height);
    page.drawPage(art, { x: 0, y: 0 });
    return page;
  };

  const drawLine = (page: PDFPage, fontKey: PDFName, font: CardFont, text: string, slot: CardTextSlot) => {
    if (!text) return;
    const size = fittedSizePt(font, text, slot);
    page.pushOperators(
      pushGraphicsState(),
      setFillingCmykColor(...slot.ink),
      beginText(),
      setFontAndSize(fontKey, size),
      setCharacterSpacing(slot.trackingEm * size),
      moveText(cardLeft + mm(slot.xMm), cardTop - mm(slot.baselineMm)),
      showText(font.encode(text)),
      endText(),
      popGraphicsState(),
    );
  };

  for (const card of cards) {
    const page = addCardPage(front);
    const boldKey = page.node.newFontDictionary("MontserratBold", boldRef);
    const regularKey = page.node.newFontDictionary("MontserratRegular", regularRef);

    drawLine(page, boldKey, fonts.bold, card.name, CARD_NAME_SLOT);
    drawLine(page, boldKey, fonts.bold, card.title, CARD_TITLE_SLOT);
    drawLine(page, boldKey, fonts.bold, card.lineArea, CARD_LINE_AREA_SLOT);

    // An empty contact line is left off with its icon, and the lines below close up so the card
    // never shows a gap — each moving line takes its own icon to the vacated row.
    const present = CARD_CONTACT_ROWS.map((row, natural) => ({ natural, text: card[row] })).filter((row) => row.text);
    present.forEach(({ natural, text }, slot) => {
      const icon = icons[natural] as PDFEmbeddedPage;
      const box = iconBoxes[natural];
      page.drawPage(icon, {
        x: cardLeft + (box.left - iconMedia.x),
        y: cardBottom + (box.bottom - iconMedia.y) - mm(topsMm[slot] - topsMm[natural]),
      });
      drawLine(page, regularKey, fonts.regular, text, contactSlot(slot));
    });

    addCardPage(back);
  }

  fonts.bold.embedInto(doc, boldRef);
  fonts.regular.embedInto(doc, regularRef);

  // Classic cross-reference tables rather than object streams: older print-shop RIPs still choke on
  // PDF 1.5 object streams, and the saving on a file this small is a few kilobytes.
  return doc.save({ useObjectStreams: false });
}

/** A filename a person can file by hand: ASCII, no spaces, never empty. */
export function cardFileName(name: string, fallback: string): string {
  const safe = name
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `business-card-${safe || fallback}.pdf`;
}

/**
 * One PDF per person, together in a ZIP that is written as it is rendered. Each PDF is complete on
 * its own: front, back, fonts and colour profile.
 *
 * Every card is checked for unprintable characters BEFORE the first byte is sent — once a streamed
 * download has started, a refusal can no longer be an HTTP status the screen can show.
 */
export function businessCardsZipStream(
  files: Array<{ card: BusinessCardFields; fileName: string }>,
  options: { assets?: BusinessCardAssets } = {},
): ReadableStream<Uint8Array> {
  if (files.length === 0) throw new Error("Choose at least one employee.");
  const assets = options.assets ?? loadBusinessCardAssets();
  assertBusinessCardsPrintable(files.map((file) => file.card), { assets });

  const taken = new Set<string>();
  const named = files.map(({ card, fileName }) => {
    let unique = fileName;
    for (let copy = 2; taken.has(unique.toLowerCase()); copy += 1) unique = fileName.replace(/\.pdf$/i, `-${copy}.pdf`);
    taken.add(unique.toLowerCase());
    return { card, name: unique };
  });

  async function* entries() {
    for (const { card, name } of named) {
      yield { bytes: await renderBusinessCardsPdf([card], { assets, title: `${card.name} — business card` }), name };
    }
  }
  return storedZipStream(entries());
}

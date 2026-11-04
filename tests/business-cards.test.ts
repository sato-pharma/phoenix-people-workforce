import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";

import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, PDFRef } from "pdf-lib";

import {
  applyCardEdits,
  applyRequestedCard,
  cardFieldsFor,
  fallbackCardEmail,
  latestRequestedCard,
  withDoctorTitle,
  formatCardLineArea,
  formatCardMobile,
} from "../src/lib/business-cards/card-content.ts";
import type { BusinessCardFields } from "../src/lib/business-cards/card-content.ts";
import { CARD_ADDRESS, CARD_WEBSITE, MM_TO_PT } from "../src/lib/business-cards/card-layout.ts";
import {
  formatHireDate,
  hireMonthKey,
  hireMonthLabel,
  hireMonthOptions,
  NO_HIRE_MONTH,
} from "../src/lib/business-cards/hire-month.ts";
import {
  assertBusinessCardsPrintable,
  BusinessCardCharacterError,
  businessCardsZipStream,
  cardFileName,
  renderBusinessCardsPdf,
} from "../src/lib/business-cards/render-pdf.ts";
import { crc32 } from "../src/lib/business-cards/zip-stream.ts";

// Business cards — the owner's own card design, printed for any employee.
//
// What this pins, because none of it throws when it goes wrong:
//   1. THE DESIGN IS HIS. The template is a byte-locked cut of the card he approved on 2026-09-12.
//      A "tidied" template is a redesigned card; the hash below is what notices.
//   2. PRINT-READY MEANS BOXES. Every page is the trimmed card plus 3 mm bleed, with TrimBox and
//      BleedBox saying so, and the design's OutputIntent (its CMYK printing condition) in the file.
//   3. NOTHING THE GENERATOR ADDS IS A PIXEL. The only images in the file are the two logos inside
//      the owner's template; every name, title and number is embedded TrueType text.
//   4. The record-to-card rules: phone format, line · area, blanks leave a line off.

// Re-pinned 2026-09-13 at the owner's request: the back logo gained a transparency mask so its
// baked-in dark JPEG background stops printing as a lighter box. The logo's own JPEG bytes and
// every page box are unchanged.
const TEMPLATE_SHA256 = "cabfe4334a74912a14652a1bd78783d784f7daf9f67648044093319f19e4b713";

function near(actual: number, expected: number, message: string) {
  assert.ok(Math.abs(actual - expected) < 0.01, `${message}: expected ${expected}, got ${actual}`);
}

async function streamBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

function dictsOf(pdf: PDFDocument): PDFDict[] {
  return pdf.context
    .enumerateIndirectObjects()
    .map(([, object]) => (object instanceof PDFRawStream ? object.dict : object))
    .filter((object): object is PDFDict => object instanceof PDFDict);
}

export async function runBusinessCardsTests() {
  // ── 1. The design is locked ─────────────────────────────────────────────────────────────────────
  const template = readFileSync(join(process.cwd(), "assets", "business-cards", "business-card-template.pdf"));
  assert.equal(
    createHash("sha256").update(template).digest("hex"),
    TEMPLATE_SHA256,
    "the business-card template changed — it is the owner's approved design and must not be redrawn",
  );

  // ── 4. Record → card ────────────────────────────────────────────────────────────────────────────
  assert.equal(formatCardMobile("1012345678"), "+20 10 1234 5678", "a mobile that lost its leading zero");
  assert.equal(formatCardMobile("01012345678"), "+20 10 1234 5678");
  assert.equal(formatCardMobile("201012345678"), "+20 10 1234 5678");
  assert.equal(formatCardMobile("010 123 45678"), "+20 10 1234 5678");
  assert.equal(formatCardMobile("01012345678-01298765432"), "+20 10 1234 5678", "two numbers: the first prints");
  assert.equal(formatCardMobile("1012345678 - 01298765432"), "+20 10 1234 5678");
  assert.equal(formatCardMobile("010-1234-5678"), "+20 10 1234 5678", "a hyphen-grouped number is one number, not '010'");
  assert.equal(formatCardMobile("+20-10-1234-5678"), "+20 10 1234 5678", "a hyphen-grouped +20 number is not '+20'");
  assert.equal(formatCardMobile("010-1234-5678, 012-9876-5432"), "+20 10 1234 5678", "two grouped numbers: the first prints");
  assert.equal(formatCardMobile("0223456789"), "0223456789", "not a mobile: printed as typed");
  assert.equal(formatCardMobile(null), "");

  assert.equal(formatCardLineArea("Pedia", "Cairo"), "Pedia · CAIRO", "the design's own format");
  assert.equal(formatCardLineArea("Head Office", "Head office"), "Head Office", "an area repeating the line");
  assert.equal(formatCardLineArea(null, "Giza"), "GIZA");
  assert.equal(formatCardLineArea("CNS", null), "CNS");

  const fields = cardFieldsFor({
    areaName: "Cairo",
    displayName: "  Aya   Elsawy ",
    jobTitle: "District Sales Manager",
    lineName: "Pedia",
    mobileNumber: "1012345678",
    workEmail: "Aya.Elsawy@SatoPharma.com",
  });
  assert.deepEqual(fields, {
    address: CARD_ADDRESS,
    email: "aya.elsawy@satopharma.com",
    lineArea: "Pedia · CAIRO",
    mobile: "+20 10 1234 5678",
    name: "Aya Elsawy",
    title: "District Sales Manager",
    website: CARD_WEBSITE,
  });

  const edited = applyCardEdits(fields, { email: "", mobile: "", name: "  Aya  M. Elsawy ", website: "example.com" } as never);
  assert.equal(edited.name, "Aya M. Elsawy");
  assert.equal(edited.mobile, "", "a blanked line stays blank — it is left off the card");
  assert.equal(edited.email, "aya.elsawy@satopharma.com", "the email is NEVER blanked — a cleared box keeps the card's own address");
  assert.equal(applyCardEdits(fields, { email: " New.Addr@satopharma.com " }).email, "New.Addr@satopharma.com", "a typed email prints");

  // ── The email is never empty (owner, 2026-11-04): first.second@satopharma.com from the full name ──
  const noEmail = cardFieldsFor({
    areaName: null,
    displayName: "Hagar",
    fullName: "  Hagar  Abu-zeid Mostafa ",
    jobTitle: null,
    lineName: null,
    mobileNumber: null,
    workEmail: "  ",
  });
  assert.equal(noEmail.email, "hagar.abuzeid@satopharma.com", "no work email: first name dot second name, English letters only");
  assert.equal(fallbackCardEmail(null, "Mahmoud Hosny"), "mahmoud.hosny@satopharma.com", "no full name: the display name");
  assert.equal(fallbackCardEmail("Aya", null), "aya@satopharma.com", "one word: that word alone");
  assert.equal(fallbackCardEmail("آية محمد", null), "", "no English letters: nothing honest to spell");

  // ── The employee's own card reaches HR's screen (owner, 2026-11-04) ─────────────────────────────
  const requests = [
    { cardMobile: "01011112222", cardName: "Aya Old", createdAt: "2026-10-01T09:00:00+00:00", status: "Printed" },
    { cardMobile: null, cardName: "Aya Newest", createdAt: "2026-11-03T09:00:00+00:00", status: "Cancelled" },
    { cardMobile: "01033334444", cardName: "Aya M. Elsawy", createdAt: "2026-11-02T09:00:00+00:00", status: "In Progress" },
  ];
  const latest = latestRequestedCard(requests);
  assert.equal(latest?.cardName, "Aya M. Elsawy", "the newest request that is not Cancelled stands for the card");
  const synced = applyRequestedCard(fields, latest);
  assert.equal(synced.name, "Aya M. Elsawy", "the name the employee set prints");
  assert.equal(synced.mobile, "01033334444", "the mobile the employee set prints");
  assert.equal(synced.email, fields.email, "the record's other lines stay");
  assert.equal(applyRequestedCard(fields, { ...requests[0], cardMobile: null, cardName: "" }).mobile, "", "a mobile they cleared stays off");
  assert.equal(applyRequestedCard(fields, { ...requests[0], cardName: "  " }).name, fields.name, "a request with no name keeps the record's name");
  assert.deepEqual(applyRequestedCard(fields, null), fields, "nobody asked: the record");

  // ── The Dr. toggle (owner, 2026-11-04) ───────────────────────────────────────────────────────────
  assert.equal(withDoctorTitle(" Aya  Elsawy "), "Dr. Aya Elsawy", "the toggle prints Dr. before the name");
  assert.equal(withDoctorTitle("Dr. Aya Elsawy"), "Dr. Aya Elsawy", "never Dr. Dr.");
  assert.equal(withDoctorTitle("dr Aya"), "dr Aya", "a title already typed is left as typed");
  assert.equal(withDoctorTitle("Drew Smith"), "Dr. Drew Smith", "a name that merely starts with Dr is still titled");
  // The production request that showed the gap (2026-11-04): "Dr/" was read as untitled.
  assert.equal(withDoctorTitle("Dr/ Mohamed Hamed Salem"), "Dr/ Mohamed Hamed Salem", "a Dr/ title is never doubled");
  assert.equal(withDoctorTitle("Dr/Mohamed Hamed"), "Dr/Mohamed Hamed", "nor with no space after it");
  assert.equal(withDoctorTitle("Dr.Aya Elsawy"), "Dr.Aya Elsawy", "nor Dr. with no space");
  assert.equal(withDoctorTitle("DR- Aya"), "DR- Aya", "nor Dr- in capitals");
  assert.equal(withDoctorTitle("Dr: Aya"), "Dr: Aya", "nor Dr:");
  assert.equal(withDoctorTitle("Doctor Aya"), "Doctor Aya", "nor the word Doctor");
  assert.equal(withDoctorTitle("Dr"), "Dr", "a bare Dr is left alone");
  assert.equal(withDoctorTitle("Doctorow Smith"), "Dr. Doctorow Smith", "a name that merely starts with Doctor is still titled");
  assert.equal(withDoctorTitle(""), "", "no name: nothing to title");
  assert.equal(edited.website, CARD_WEBSITE, "the company's website is not an editable line");

  assert.equal(cardFileName("Aya Elsawy", "card"), "business-card-Aya-Elsawy.pdf");
  assert.equal(cardFileName("آية", "card"), "business-card-card.pdf");

  // ── Hiring month: how HR finds the new hires who still need cards ───────────────────────────────
  assert.equal(hireMonthKey("2026-09-01"), "2026-09", "the 1st of a month stays in that month — never shifted a zone back");
  assert.equal(hireMonthKey("2026-08-31T23:30:00+00:00"), "2026-08", "a timestamp is read by its own digits");
  assert.equal(hireMonthKey(null), NO_HIRE_MONTH);
  assert.equal(hireMonthKey("03/09/2026"), NO_HIRE_MONTH, "an unreadable date is 'no hiring date', never a guessed month");
  assert.equal(hireMonthKey("2026-13-01"), NO_HIRE_MONTH);
  assert.equal(hireMonthLabel("2026-09"), "September 2026");
  assert.equal(hireMonthLabel(NO_HIRE_MONTH), "No hiring date");
  assert.equal(formatHireDate("2026-09-03"), "3 Sep 2026");
  assert.equal(formatHireDate(null), "");
  assert.deepEqual(
    hireMonthOptions([
      { hireDate: "2025-12-15" },
      { hireDate: null },
      { hireDate: "2026-09-01" },
      { hireDate: "2026-02-10" },
      { hireDate: "2026-09-20" },
    ]),
    [
      { count: 2, key: "2026-09", label: "September 2026" },
      { count: 1, key: "2026-02", label: "February 2026" },
      { count: 1, key: "2025-12", label: "December 2025" },
      { count: 1, key: NO_HIRE_MONTH, label: "No hiring date" },
    ],
    "newest month first, across years, with its head count; people with no date last",
  );

  // ── 2 & 3. The PDF ──────────────────────────────────────────────────────────────────────────────
  const cards: BusinessCardFields[] = [
    fields,
    { ...fields, mobile: "", name: "Mohamed Abdelrahman Abdelaziz Elsayed Mahmoud Ibrahim" },
  ];
  const pdf = await PDFDocument.load(await renderBusinessCardsPdf(cards));
  assert.equal(pdf.getPageCount(), 4, "front and back for each person");

  const bleed = 3 * MM_TO_PT;
  for (const page of pdf.getPages()) {
    const media = page.getMediaBox();
    const trim = page.getTrimBox();
    const bleedBox = page.getBleedBox();
    near(trim.x, bleed, "TrimBox left sits 3 mm in");
    near(trim.y, bleed, "TrimBox bottom sits 3 mm in");
    near(trim.width, 255, "the trimmed card is the design's 255 pt width");
    near(trim.height, 141.75, "the trimmed card is the design's 141.75 pt height");
    near(media.width, 255 + 2 * bleed, "3 mm bleed each side");
    near(bleedBox.width, media.width, "BleedBox covers the bleed");
  }

  assert.ok(pdf.catalog.get(PDFName.of("OutputIntents")) instanceof PDFArray, "the design's OutputIntent travels with the file");

  const dicts = dictsOf(pdf);
  const images = dicts.filter((dict) => dict.get(PDFName.of("Subtype")) === PDFName.of("Image"));
  const maskStreams = images
    .map((dict) => dict.get(PDFName.of("SMask")))
    .filter((ref): ref is PDFRef => ref instanceof PDFRef)
    .map((ref) => pdf.context.lookup(ref))
    .filter((mask): mask is PDFRawStream => mask instanceof PDFRawStream);
  const masks = new Set(maskStreams.map((mask) => mask.dict));
  const logos = images.filter((dict) => !masks.has(dict));
  assert.equal(logos.length, 2, "the only pictures are the two logos in the owner's template — the generator adds none");
  assert.equal(masks.size, 1, "plus exactly one transparency mask: the back logo's");

  // The back logo is a JPEG with its own dark background baked in, a few percent lighter than the
  // card's ink. Unmasked, that background prints as a visible box around the logo (owner, 2026-09-13).
  const backLogo = logos.find((dict) => dict.get(PDFName.of("Width"))?.toString() === "355");
  assert.ok(backLogo?.get(PDFName.of("SMask")) instanceof PDFRef, "the back logo is see-through around its letters — no box on the card's back");
  const [backMask] = maskStreams;
  const alpha = inflateSync(backMask.contents);
  assert.equal(alpha.length, 355 * 134, "the mask covers the logo pixel for pixel");
  const outerEdge = [...alpha.subarray(0, 355), ...alpha.subarray(alpha.length - 355)];
  for (let row = 0; row < 134; row += 1) outerEdge.push(alpha[row * 355], alpha[row * 355 + 354]);
  assert.equal(Math.max(...outerEdge), 0, "the logo's outer edge is fully transparent, so no outline of the old box remains");
  assert.ok(alpha.includes(255), "the letters stay fully opaque");

  // The generator's own fonts are the ones the card PAGE names (the template's fonts sit inside its
  // embedded artwork, one level down).
  const pageFonts = pdf.getPage(0).node.Resources()?.lookup(PDFName.of("Font"), PDFDict);
  assert.ok(pageFonts, "the card page names its fonts");
  const generated = pageFonts
    .entries()
    .filter(([key]) => /^Montserrat(Bold|Regular)/.test(key.decodeText()))
    .map(([, ref]) => pdf.context.lookup(ref, PDFDict));
  assert.equal(generated.length, 2, "the card text is embedded Montserrat Bold and Regular, as real text");
  const baseFonts = generated.map((font) => (font.get(PDFName.of("BaseFont")) as PDFName).decodeText());
  assert.ok(baseFonts.some((name) => /^[A-Z]{6}\+Montserrat-Bold$/.test(name)), `Montserrat Bold is embedded as a subset: ${baseFonts}`);
  assert.ok(baseFonts.some((name) => /^[A-Z]{6}\+Montserrat-Regular$/.test(name)), `Montserrat Regular is embedded as a subset: ${baseFonts}`);

  for (const font of generated) {
    assert.equal(font.get(PDFName.of("Subtype")), PDFName.of("Type0"));
    const descendant = pdf.context.lookup((font.get(PDFName.of("DescendantFonts")) as PDFArray).get(0) as PDFRef, PDFDict);
    const descriptor = pdf.context.lookup(descendant.get(PDFName.of("FontDescriptor")) as PDFRef, PDFDict);
    const program = pdf.context.lookup(descriptor.get(PDFName.of("FontFile2")) as PDFRef);
    assert.ok(program instanceof PDFRawStream, "the font program is an embedded stream");
    assert.ok(program.contents.length > 1_000, "the font's outlines are embedded");
    assert.ok(program.contents.length < 80_000, "the font is subset — not the whole 240 KB face per file");
    const toUnicode = pdf.context.lookup(font.get(PDFName.of("ToUnicode")) as PDFRef);
    assert.ok(toUnicode instanceof PDFRawStream, "the font carries a ToUnicode stream");
    const cmap = inflateSync(toUnicode.contents).toString("latin1");
    if ((font.get(PDFName.of("BaseFont")) as PDFName).decodeText().endsWith("Bold")) {
      assert.ok(cmap.includes("<00b7>"), "the middle dot of 'Pedia · CAIRO' maps back to text");
    }
  }

  await assert.rejects(
    renderBusinessCardsPdf([{ ...fields, name: "آية الصاوي" }]),
    BusinessCardCharacterError,
    "a name the card font cannot draw is refused, never printed as blank boxes",
  );
  // The screen's dry run (asked before a streamed ZIP starts) refuses exactly what the download would.
  assert.throws(
    () => assertBusinessCardsPrintable([{ ...fields, title: "مدير منطقة" }]),
    BusinessCardCharacterError,
    "the dry run refuses a card the download would refuse",
  );
  assertBusinessCardsPrintable(cards);

  // ── Separate PDFs, streamed as a ZIP ────────────────────────────────────────────────────────────
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926, "CRC-32 check value");
  const zip = await streamBytes(
    businessCardsZipStream(cards.map((card) => ({ card, fileName: cardFileName(card.name, "card") }))),
  );
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const end = zip.length - 22;
  assert.equal(view.getUint32(end, true), 0x06054b50, "the ZIP ends with its directory");
  assert.equal(view.getUint16(end + 10, true), 2, "one PDF per person");
  let at = 0;
  for (let entry = 0; entry < 2; entry += 1) {
    assert.equal(view.getUint32(at, true), 0x04034b50);
    const size = view.getUint32(at + 18, true);
    const nameLength = view.getUint16(at + 26, true);
    const data = zip.subarray(at + 30 + nameLength, at + 30 + nameLength + size);
    assert.equal(view.getUint32(at + 14, true), crc32(data), "each entry's CRC matches its bytes");
    assert.equal((await PDFDocument.load(data)).getPageCount(), 2, "each PDF is a whole card, front and back");
    at += 30 + nameLength + size;
  }

  assert.throws(
    () => businessCardsZipStream([{ card: { ...fields, name: "آية" }, fileName: "x.pdf" }]),
    BusinessCardCharacterError,
    "a ZIP refuses before its first byte, while the refusal can still be an HTTP status",
  );

  // ── Square edges on the picker, which the shells' sweep cannot reach ───────────────────────────
  // The employee picker's panel is portaled to <body>, outside `.admin-shell`, so its corners are
  // only square if the component itself draws none.
  const combobox = readFileSync(join(process.cwd(), "src", "components", "ui", "grouped-combobox.tsx"), "utf8");
  assert.deepEqual(
    [...combobox.matchAll(/(?<![\w-])rounded(?:-(?!none\b)[\w[\].]+)?(?![\w-])/g)].map((match) => match[0]),
    [],
    "the business-card picker draws no rounded corners — its portaled panel sits outside the square-corner sweep",
  );

  // ── Every file is an audited export ─────────────────────────────────────────────────────────────
  const route = readFileSync(join(process.cwd(), "app", "api", "business-cards", "route.ts"), "utf8");
  const auditAt = route.indexOf("await writeRequiredAuditLog(");
  assert.ok(auditAt > 0, "a business-card export writes a required audit row");
  assert.match(route.slice(auditAt, auditAt + 600), /entityType: "business_cards_export"/, "the audit row names the export");
  assert.ok(auditAt > route.indexOf("body?.check === true"), "the dry run returns before the audit — it hands back no file");
  assert.ok(auditAt < route.indexOf("renderBusinessCardsPdf("), "the audit row is written before any PDF is returned");
  assert.ok(auditAt < route.indexOf("businessCardsZipStream("), "the audit row is written before any ZIP is returned");
  const registry = readFileSync(join(process.cwd(), "src", "lib", "security", "access-registry.ts"), "utf8");
  assert.match(
    registry,
    /sessionApi\(\{ audit: \{ classification: "export", required: true \}[^\n]*pattern: "\/api\/business-cards"/,
    "the registry declares business cards an audited export",
  );
}

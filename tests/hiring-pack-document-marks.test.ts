import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  DOCUMENT_MARKS,
  marksPlacedOn,
  parseMarkSelection,
  resizeMarkFromCorner,
  MIN_MARK_PT,
  DOCUMENT_MARK_DEFAULT_SIZE,
  DOCUMENT_MARK_LABELS,
  isDocumentMark,
  layoutUsesMark,
  withMarkArtwork,
} from "@/lib/hiring-pack/document-marks";
import {
  fieldLiterals,
  isMarkFieldRow,
  isTextFieldRow,
  markValueKey,
  mergePagePlacements,
  renderFlowField,
  type DocumentFieldRow,
} from "@/lib/hiring-pack/field-layout";
import {
  documentFieldFromRecord,
  parseDocumentFieldWrite,
  type DocumentFieldWriteInput,
  type FieldRecord,
} from "@/lib/hiring-pack/field-layout-store";
import { keysInMarkup } from "@/lib/hiring-pack/document-inventory";
import { isPng } from "@/lib/hiring-pack/hr-signature";
import { renderPlacement } from "@/lib/hiring-pack/render-placement";

// The stamp and the signature an operator places by hand — owner, 2026-09-29: "in HR forms I want to
// have the option to add the Sato stamp seal and my signature and be able to move and drag them
// freely in any form."
//
// WHAT IS WORTH PINNING HERE is not that a picture renders. It is the two ways a mark can go wrong
// on paper that nobody would see in time:
//
//   1. ARTWORK THAT COULD NOT BE READ MUST PRINT NOTHING — never a box, never a broken image. A
//      document that looks stamped from across a desk and is not is worse than an unstamped one,
//      because the unstamped one gets stamped.
//   2. A MARK MUST NEVER BE AN OVERRIDE. An override keeps the compiled placement's own KIND, so a
//      mark pointed at a compiled key would be drawn as that key's text placement and print nothing
//      at all — the same silent failure, reached by a different route.
//
// Everything else below is the boundary: what the table accepts, what the reader drops, and the two
// screens that must not treat a picture as a value.

const SEAL = "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=";
const SIGNATURE = "data:image/png;base64,iVBORw0KGgo=";

function markRow(over: Partial<DocumentFieldRow> = {}): DocumentFieldRow {
  return {
    id: "mark-1",
    document: "form1",
    templateVersionId: "form1-v1",
    defaultKey: null,
    hidden: false,
    page: 1,
    anchor: null,
    x: 300,
    y: 640,
    w: 96,
    h: 96,
    align: "right",
    size: 9,
    source: { kind: "mark", mark: "stamp" },
    updatedAt: "2026-09-29T00:00:00.000Z",
    updatedByHrId: "B-10",
    ...over,
  };
}

function record(over: Partial<FieldRecord> = {}): FieldRecord {
  return {
    id: "mark-1",
    document: "form1",
    template_version_id: "form1-v1",
    employee_hr_id: null,
    default_key: null,
    hidden: false,
    page: 1,
    anchor_selector: null,
    anchor_dx: null,
    anchor_dy: null,
    x: "300",
    y: "640",
    w: "96",
    h: "96",
    align: "right",
    font_size: "9",
    source_kind: "mark",
    value_key: "stamp",
    literal_text: null,
    updated_at: "2026-09-29T00:00:00.000Z",
    updated_by_hr_id: "B-10",
    ...over,
  };
}

function write(over: Partial<DocumentFieldWriteInput> = {}): DocumentFieldWriteInput {
  return {
    document: "form1",
    templateVersionId: "form1-v1",
    defaultKey: null,
    hidden: false,
    page: 1,
    anchor: null,
    x: 300,
    y: 640,
    w: 96,
    h: 96,
    align: "right",
    size: 9,
    source: { kind: "mark", mark: "stamp" },
    ...over,
  };
}

/** The vocabulary is closed, and every mark in it has a label and a first size. */
function testEveryMarkIsDescribed() {
  assert.deepEqual([...DOCUMENT_MARKS], ["stamp", "signature"]);
  for (const mark of DOCUMENT_MARKS) {
    assert.ok(DOCUMENT_MARK_LABELS[mark], `${mark} needs a label — it is what the editor calls it`);
    const box = DOCUMENT_MARK_DEFAULT_SIZE[mark];
    assert.ok(box.w > 0 && box.h > 0, `${mark} must land at a size somebody can see and pick up`);
  }
  assert.equal(isDocumentMark("stamp"), true);
  assert.equal(isDocumentMark("seal"), false);
  assert.equal(isDocumentMark(null), false);
}

/**
 * A placed stamp draws its artwork, at the points it was dragged to.
 *
 * Asserted against the EMITTED HTML rather than the placement object, because the emitted HTML is
 * what a printer receives and three defects have shipped from this repo's renderers by checking the
 * source instead.
 */
function testAPlacedStampDrawsItsArtwork() {
  const rows = withMarkArtwork([markRow()], { signature: null, stamp: SEAL });
  const merged = mergePagePlacements([], rows, 1, {});
  assert.equal(merged.placements.length, 1);

  const html = renderPlacement(merged.placements[0]!, {});
  assert.ok(html.includes("<img"), "a mark is an image, not a run of text");
  assert.ok(html.includes(`src="${SEAL}"`), "the seal's own artwork has to reach the page");
  assert.ok(html.includes("left:300pt"), "it prints where it was dropped");
  assert.ok(html.includes("width:96pt"), "at the size it was dragged to");
  assert.ok(
    html.includes(`data-hp-key="${markValueKey("stamp")}"`),
    "it must be addressable, or the editor cannot pick it up again",
  );
  assert.ok(html.includes('data-hp-field="mark-1"'), "and addressable as THIS placed copy");
}

/**
 * ARTWORK THAT COULD NOT BE READ PRINTS NOTHING AT ALL.
 *
 * The case is real: the signature is removed from its private bucket while placements referring to
 * it survive on documents. The paper then has to come out UNSIGNED so a human signs it — a grey box
 * or a broken-image glyph reads as a signature at a glance and would be signed by nobody.
 */
function testArtworkThatCouldNotBeReadPrintsNothing() {
  const rows = withMarkArtwork([markRow({ source: { kind: "mark", mark: "signature" } })], {
    signature: null,
    stamp: SEAL,
  });
  const merged = mergePagePlacements([], rows, 1, {});
  assert.equal(renderPlacement(merged.placements[0]!, {}), "");

  // And the same answer on the other surface, where a different function makes the decision.
  const flow = renderFlowField(
    markRow({
      anchor: { dx: 12, dy: 4, selector: ".sig" },
      page: null,
      source: { kind: "mark", mark: "signature" },
    }),
    {},
  );
  assert.equal(flow, "");
}

/** A mark on a flowing document hangs off its clause, like every other added field. */
function testAMarkHangsOffItsAnchorOnAFlowDocument() {
  const [row] = withMarkArtwork(
    [
      markRow({
        anchor: { dx: 12, dy: 4, selector: "td.stamp-cell" },
        document: "contract",
        page: null,
      }),
    ],
    { signature: null, stamp: SEAL },
  );
  const html = renderFlowField(row!, {});
  assert.ok(html.includes('data-hp-anchor="td.stamp-cell"'), "it travels with the clause it was put on");
  assert.ok(html.includes("hp-added"), "the editor finds a flow field by this class — without it the mark is stuck");
  assert.ok(html.includes(`src="${SEAL}"`));
  assert.ok(html.includes("left:12pt"), "the anchor offset is the position, not x/y");
}

/**
 * A MARK IS NEVER AN OVERRIDE — refused at the API boundary, which mirrors the table's own CHECK.
 *
 * See the header: an override keeps the compiled placement's kind, so this would print nothing and
 * say nothing.
 */
function testAMarkCannotReplaceACompiledField() {
  const refused = parseDocumentFieldWrite(write({ defaultKey: "insuredName" }));
  assert.equal(refused.ok, false);
  assert.match(refused.ok === false ? refused.message : "", /never used to replace/);

  const accepted = parseDocumentFieldWrite(write());
  assert.equal(accepted.ok, true);
  assert.deepEqual(
    accepted.ok === true ? accepted.write.source : null,
    { kind: "mark", mark: "stamp" },
  );
}

/** An unknown mark is refused by name, so a typo cannot become a field that prints nothing. */
function testAnUnknownMarkIsRefused() {
  const refused = parseDocumentFieldWrite(write({ source: { kind: "mark", mark: "initials" } }));
  assert.equal(refused.ok, false);
  assert.match(refused.ok === false ? refused.message : "", /stamp, signature/);
}

/**
 * A mark round-trips through the row the database holds, and a hand-written row naming a mark this
 * build does not know is DROPPED rather than defaulted into something that prints.
 */
function testAMarkRowIsReadBackAndAnUnknownOneIsDropped() {
  const row = documentFieldFromRecord(record());
  assert.deepEqual(row?.source, { kind: "mark", mark: "stamp" });

  assert.equal(documentFieldFromRecord(record({ value_key: "initials" })), null);
  assert.equal(documentFieldFromRecord(record({ value_key: null })), null);
}

/**
 * A mark contributes NO literal and NO value.
 *
 * It matters because `fieldLiterals` merges into the values map every renderer reads: a mark leaking
 * a key there would put a base64 image under a data key, where the fill screen lists things people
 * are invited to retype.
 */
function testAMarkPutsNothingInTheValuesMap() {
  const rows = [markRow(), markRow({ id: "mark-2", source: { kind: "mark", mark: "signature" } })];
  assert.deepEqual(fieldLiterals(rows, {}), {});
  assert.deepEqual(mergePagePlacements([], rows, 1, {}).literals, {});
}

/** The two screens that ask a field what it prints never see a mark. */
function testNeitherFieldScreenTreatsAMarkAsAValue() {
  const rows = [markRow(), markRow({ id: "text-1", source: { kind: "literal", text: "مسلسل" } })];
  assert.deepEqual(rows.filter(isTextFieldRow).map((row) => row.id), ["text-1"]);
  assert.deepEqual(rows.filter(isMarkFieldRow).map((row) => row.id), ["mark-1"]);

  // The field table's rows are built from the `data-hp-key`s the rendered document carries, so a
  // mark's own key must not become one of them — it would list a field that is permanently empty,
  // on every paper anybody stamped, with nothing anyone could type into it.
  const html = renderPlacement(
    mergePagePlacements([], withMarkArtwork([markRow()], { signature: null, stamp: SEAL }), 1, {})
      .placements[0]!,
    {},
  );
  assert.ok(html.includes(`data-hp-key="${markValueKey("stamp")}"`), "the mark is addressable on the page");
  assert.deepEqual(keysInMarkup(html), [], "…and is still not a field anybody fills in");
  // A positive control, so the empty answer above is the filter doing its job rather than the
  // scanner failing to find anything at all.
  assert.deepEqual(keysInMarkup('<span data-hp-key="insuredName"></span>'), ["insuredName"]);
}

/** Which artwork a render has to fetch, and the read it is allowed to skip. */
function testOnlyAPlacedSignatureCostsABucketRead() {
  assert.equal(layoutUsesMark([markRow()], "signature"), false);
  assert.equal(layoutUsesMark([markRow()], "stamp"), true);

  const withSignature = [markRow({ source: { kind: "mark", mark: "signature" } })];
  assert.equal(layoutUsesMark(withSignature, "signature"), true);

  // A HIDDEN row does not count. Hiding is an override's verb and a mark is never an override, so
  // this cannot arise through the app — but a row that renders nothing must not cost a download.
  assert.equal(layoutUsesMark([markRow({ hidden: true })], "stamp"), false);

  // A text layout asks for no artwork at all, which is the overwhelmingly common case.
  assert.equal(
    layoutUsesMark([markRow({ source: { kind: "literal", text: "x" } })], "signature"),
    false,
  );
}

/**
 * `withMarkArtwork` resolves at RENDER time and stores nothing.
 *
 * The consequence worth pinning: replacing the stored signature changes every paper that carries
 * one, rather than leaving placements made earlier printing the old image.
 */
function testArtworkIsResolvedPerRenderAndNotStored() {
  const stored = markRow({ source: { kind: "mark", mark: "signature" } });
  const first = withMarkArtwork([stored], { signature: SIGNATURE, stamp: SEAL })[0]!;
  const second = withMarkArtwork([stored], { signature: "data:image/png;base64,QQ==", stamp: SEAL })[0]!;

  assert.equal(first.source.kind === "mark" ? first.source.src : null, SIGNATURE);
  assert.equal(
    second.source.kind === "mark" ? second.source.src : null,
    "data:image/png;base64,QQ==",
    "the same stored row prints whatever is in the bucket now",
  );
  assert.equal(
    stored.source.kind === "mark" ? (stored.source.src ?? null) : "not-a-mark",
    null,
    "the stored row itself is never given an image",
  );

  // A text row comes back untouched — this runs on every render of every paper.
  const text = markRow({ source: { kind: "literal", text: "مسلسل" } });
  assert.equal(withMarkArtwork([text], { signature: null, stamp: SEAL })[0], text);
}

/** The signature store accepts a PNG and nothing else, by the bytes rather than the declared type. */
function testTheSignatureStoreChecksTheBytes() {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
  assert.equal(isPng(png), true);
  assert.equal(isPng(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0])), false, "a JPEG is not a PNG");
  assert.equal(isPng(new Uint8Array(0)), false);
  // The magic alone is not a file: a body of exactly the signature bytes has no image in it.
  assert.equal(isPng(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), false);
}

/**
 * A PLACED MARK IS NOT A PRINTED MARK — the selection decides, and the default is NONE.
 *
 * The owner, 2026-09-29, after seeing the first version of this feature: "donot put the stamp
 * permanent, make able to add them freely as i want", and then, choosing between three designs, the
 * print dialog. A layout row says WHERE the seal sits on this paper; whether this run carries it is
 * ticked per print, in the box that already asks for the copy count and the address, and that box
 * opens unticked every time.
 *
 * SO THE DEFAULT PATH IS THE UNSTAMPED PAPER. Every link that predates the parameter - the automatic
 * print after a signature, a bookmark, the filing path - passes no selection and therefore prints
 * exactly what it printed before marks existed. That is the property worth pinning: it is what keeps
 * faith with the same day's earlier ruling that a document arriving pre-stamped is a document nobody
 * stamped.
 */
function testOnlyTheMarksThisPrintAskedForAreDrawn(): void {
  assert.deepEqual([...parseMarkSelection(null)], [], "no parameter means no marks");
  assert.deepEqual([...parseMarkSelection("")], [], "an empty parameter means no marks");
  assert.deepEqual([...parseMarkSelection("stamp")], ["stamp"]);
  assert.deepEqual([...parseMarkSelection(" stamp , signature ")].sort(), ["signature", "stamp"]);
  // An unknown name is dropped rather than refusing the print - see the function's own note.
  assert.deepEqual([...parseMarkSelection("stamp,initials")], ["stamp"]);

  const rows = [markRow(), markRow({ id: "m2", source: { kind: "mark", mark: "signature" } })];

  // Nothing ticked: both rows still exist, and NEITHER draws.
  const none = mergePagePlacements(
    [],
    withMarkArtwork(rows, { signature: SIGNATURE, stamp: SEAL }).map((row) =>
      row.source.kind === "mark" ? { ...row, source: { ...row.source, src: null } } : row,
    ),
    1,
    {},
  );
  assert.equal(none.placements.length, 2, "the rows are still placed - they are simply not drawn");
  assert.deepEqual(
    none.placements.map((placement) => renderPlacement(placement, {})),
    ["", ""],
    "an unticked mark must print NOTHING, the same answer as artwork that could not be read",
  );

  // Stamp ticked only: the seal draws, the signature does not.
  const stampOnly = mergePagePlacements(
    [],
    withMarkArtwork(rows, { signature: null, stamp: SEAL }),
    1,
    {},
  );
  const drawn = stampOnly.placements.map((placement) => renderPlacement(placement, {}));
  assert.ok(drawn[0]!.includes(SEAL), "the ticked stamp draws");
  assert.equal(drawn[1], "", "the unticked signature stays off the paper");
}

/** What the print dialog is allowed to offer: the marks this paper has a position for. */
function testTheDialogOffersOnlyWhatIsPlaced(): void {
  assert.deepEqual(marksPlacedOn([]), [], "a paper with no marks offers no tick-boxes at all");
  assert.deepEqual(marksPlacedOn([markRow()]), ["stamp"]);
  assert.deepEqual(
    marksPlacedOn([markRow(), markRow({ id: "m2", source: { kind: "mark", mark: "signature" } })]),
    ["stamp", "signature"],
  );
  // A hidden row is not an offer - there would be nothing to draw.
  assert.deepEqual(marksPlacedOn([markRow({ hidden: true })]), []);
  // Text rows are not marks.
  assert.deepEqual(marksPlacedOn([markRow({ source: { kind: "literal", text: "x" } })]), []);
}

/**
 * DRAGGING A CORNER RESIZES THE MARK, AND THE OPPOSITE CORNER STAYS PUT.
 *
 * The owner, 2026-09-29: "when I come to the corner of the square ... I have the option to extend or
 * make it smaller, as if I'm dragging its corners." The property that makes it feel like a corner
 * drag rather than scaling about the middle is that the corner you are NOT holding does not move -
 * which for the top-left and the two side corners means x or y has to change with the size, and
 * that is the half that is easy to get silently wrong.
 */
function testDraggingACornerResizesAroundTheOppositeCorner(): void {
  const origin = { x: 100, y: 200, w: 96, h: 96 };

  // South-east: the anchor is the top-left, so only the size changes.
  assert.deepEqual(resizeMarkFromCorner(origin, "se", 20, 10), { x: 100, y: 200, w: 116, h: 106 });

  // North-west: the anchor is the BOTTOM-RIGHT, so pulling up-and-left grows it AND moves x and y.
  assert.deepEqual(resizeMarkFromCorner(origin, "nw", -20, -10), { x: 80, y: 190, w: 116, h: 106 });
  // The bottom-right corner is unmoved by that drag - the whole point of the gesture.
  const nw = resizeMarkFromCorner(origin, "nw", -20, -10);
  assert.equal(nw.x + nw.w, origin.x + origin.w, "the right edge must not move");
  assert.equal(nw.y + nw.h, origin.y + origin.h, "nor the bottom edge");

  // North-east: x is anchored, y moves.
  const ne = resizeMarkFromCorner(origin, "ne", 10, -10);
  assert.equal(ne.x, origin.x, "the left edge is the anchor");
  assert.equal(ne.y + ne.h, origin.y + origin.h, "and the bottom edge does not move");

  // South-west: y is anchored, x moves.
  const sw = resizeMarkFromCorner(origin, "sw", -10, 10);
  assert.equal(sw.y, origin.y, "the top edge is the anchor");
  assert.equal(sw.x + sw.w, origin.x + origin.w, "and the right edge does not move");
}

/**
 * A MARK CANNOT BE DRAGGED DOWN TO NOTHING.
 *
 * A zero box prints nothing and cannot be grabbed again - the same dead end as a mark whose artwork
 * has gone, reached by the hand instead of by the bucket. The floor also has to hold the ANCHOR
 * still: clamping the size while letting x keep travelling would slide the mark across the page as
 * somebody kept pulling.
 */
function testAMarkCannotBeShrunkToNothing(): void {
  const origin = { x: 100, y: 200, w: 96, h: 96 };
  const tiny = resizeMarkFromCorner(origin, "se", -500, -500);
  assert.equal(tiny.w, MIN_MARK_PT);
  assert.equal(tiny.h, MIN_MARK_PT);
  assert.ok(tiny.w > 0 && tiny.h > 0, "still on the page and still grabbable");

  const clampedNw = resizeMarkFromCorner(origin, "nw", 500, 500);
  assert.equal(clampedNw.w, MIN_MARK_PT);
  assert.equal(
    clampedNw.x + clampedNw.w,
    origin.x + origin.w,
    "the anchored edge stays anchored even once the size has bottomed out",
  );
}

/**
 * Everyone who prints papers opens the editor, and the editor asks whether to draw the signature
 * panel. "Not yours" is an answer, not a refusal: as a 403 the screen capture photographed it as a
 * block the person met (HR Forms, 2 Nov 2026). The image and whether one exists stay unsaid, and the
 * writes keep their 403.
 */
function testAskingAboutTheSignaturePanelIsNotARefusal(): void {
  const route = readFileSync(new URL("../app/api/hiring-pack/signature/route.ts", import.meta.url), "utf8");
  const read = route.slice(route.indexOf("export async function GET"), route.indexOf("export async function PUT"));
  const writes = route.slice(route.indexOf("export async function PUT"));
  assert.match(
    read,
    /if \(isNotTheSuperAdmin\(error\)\) \{\s+return Response\.json\(\s+\{ canManage: false, present: false, dataUri: null \}/,
    "the read answers everyone else with no image and no word of whether one is stored",
  );
  assert.doesNotMatch(writes, /canManage|isNotTheSuperAdmin/, "a write by anyone else is still refused");
  assert.match(route, /if \(isForbiddenError\(error\) \|\| isNotTheSuperAdmin\(error\)\) \{\s+return Response\.json\(\s+\{\s+error: "forbidden"/);
  assert.match(
    readFileSync(new URL("../src/components/hiring-pack/paper-editor.tsx", import.meta.url), "utf8"),
    /if \(body\?\.canManage === false\) \{\s+return \{ error: null, state: \{ canManage: false, dataUri: null, loaded: true, present: false \} \};/,
    "the editor reads that answer as not managing, with nothing red on screen",
  );
}

export function runHiringPackDocumentMarkTests() {
  testAskingAboutTheSignaturePanelIsNotARefusal();
  testEveryMarkIsDescribed();
  testAPlacedStampDrawsItsArtwork();
  testArtworkThatCouldNotBeReadPrintsNothing();
  testAMarkHangsOffItsAnchorOnAFlowDocument();
  testAMarkCannotReplaceACompiledField();
  testAnUnknownMarkIsRefused();
  testAMarkRowIsReadBackAndAnUnknownOneIsDropped();
  testAMarkPutsNothingInTheValuesMap();
  testNeitherFieldScreenTreatsAMarkAsAValue();
  testOnlyAPlacedSignatureCostsABucketRead();
  testArtworkIsResolvedPerRenderAndNotStored();
  testOnlyTheMarksThisPrintAskedForAreDrawn();
  testTheDialogOffersOnlyWhatIsPlaced();
  testDraggingACornerResizesAroundTheOppositeCorner();
  testAMarkCannotBeShrunkToNothing();
  testTheSignatureStoreChecksTheBytes();
}

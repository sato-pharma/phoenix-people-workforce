import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

import {
  DOCUMENT_SURFACES,
  documentSurface,
  fieldLiterals,
  fieldPrintedValue,
  flowFieldLayer,
  literalValueKey,
  mergePagePlacements,
  renderFlowField,
  type DocumentFieldRow,
} from "@/lib/hiring-pack/field-layout";
import {
  carryForwardDocumentFields,
  documentFieldFromRecord,
  fieldHistoryFromRecord,
  isFieldLayerMissing,
  parseDocumentFieldWrite,
  pickCarryForwardSource,
  summariseHistoryRows,
  type DocumentFieldWriteInput,
  type FieldRecord,
  type VersionFieldCount,
} from "@/lib/hiring-pack/field-layout-store";
import { fieldWarnings, pageSizeFor } from "@/lib/hiring-pack/field-warnings";
import { PAPER_FIELD_BINDINGS } from "@/lib/hiring-pack/paper-fields";
import { isHiringPackSchemaMissing } from "@/lib/hiring-pack/service";
import type { Placement } from "@/lib/hiring-pack/render-placement";
import { HIRING_PACK_DOCUMENTS } from "@/lib/hiring-pack/types";

// The field layer, tested where it decides: the merge of a compiled default table with what an
// operator dragged. Everything downstream — the editor, the API, the print route — reads the result
// of this merge, so a wrong answer here prints wrongly on paper with nothing else able to catch it.

function row(over: Partial<DocumentFieldRow> = {}): DocumentFieldRow {
  return {
    id: "row-1",
    document: "form1",
    templateVersionId: "form1-v1",
    defaultKey: null,
    hidden: false,
    page: 1,
    anchor: null,
    x: 100,
    y: 200,
    w: 120,
    h: 13,
    align: "right",
    size: 9,
    source: { kind: "literal", text: "مسلسل" },
    updatedAt: "2026-09-03T00:00:00.000Z",
    updatedByHrId: "B-1",
    ...over,
  };
}

const TEXT_DEFAULT: Placement = {
  kind: "text",
  key: "insuredName",
  x: 10,
  y: 20,
  w: 200,
  h: 13,
  align: "right",
  size: 9,
};

const DIGITS_DEFAULT: Placement = {
  kind: "digits",
  key: "nationalId",
  x: 30,
  y: 40,
  pitch: 10,
  cells: 14,
  h: 19,
};

const TICK_DEFAULT: Placement = { kind: "tick", key: "categoryEmployee", x: 5, y: 6, w: 8, h: 9 };

/**
 * Every document must declare a surface, checked at RUNTIME rather than left to the compiler.
 *
 * An exhaustive `Record<HiringPackDocument, …>` does not gate the build in this repo — `next.config`
 * sets `ignoreBuildErrors`, so a missing key compiles, builds and deploys. What it does at run time
 * is return `undefined`, and `undefined` is neither "page" nor "flow": the document would fall
 * through whichever branch the caller wrote last, which is how a typeset contract ends up placing
 * fields at page coordinates that reflow invalidates.
 */
function testEveryDocumentDeclaresItsSurface() {
  for (const document of HIRING_PACK_DOCUMENTS) {
    const surface = documentSurface(document);
    assert.ok(
      surface === "page" || surface === "flow",
      `${document} has no declared surface — it would place fields by whichever branch ran last`,
    );
  }
  assert.equal(
    Object.keys(DOCUMENT_SURFACES).length,
    HIRING_PACK_DOCUMENTS.length,
    "the surface table and the document union have drifted apart",
  );

  // The four coordinate-placed government forms, named rather than counted. A form silently
  // reclassified as `flow` would lose the measured coordinates that are the only reason it prints
  // onto the Authority's boxes at all.
  const pageSurfaces = HIRING_PACK_DOCUMENTS.filter(
    (document) => documentSurface(document) === "page",
  );
  // TWELVE since 2026-09-13: the letters pack's eight government forms print their own artwork too.
  assert.deepEqual(
    [...pageSurfaces].sort(),
    [
      "carInsuranceCertificate",
      "form1",
      "form6",
      "insuranceForm2",
      "maternityCompensation",
      "mutualTermination",
      "officialHolidaysSheet",
      "penaltiesSheet",
      "penaltyRegulationsApproval",
      "resignation",
      "sickLeaveSheet",
      "wageProgressSheet",
    ],
    "only the artwork-backed government forms may place by absolute page coordinate",
  );
}

/** A document nobody has touched prints exactly its compiled table, in its compiled order. */
function testAnUntouchedDocumentIsUnchanged() {
  const merged = mergePagePlacements([TEXT_DEFAULT, DIGITS_DEFAULT], [], 1);
  assert.deepEqual(
    merged.placements,
    [TEXT_DEFAULT, DIGITS_DEFAULT],
    "with no stored rows the compiled table must pass through untouched",
  );
  assert.deepEqual(merged.literals, {}, "no rows means no literals");
}

/**
 * A dragged default keeps its KIND. Dragging a box grid must not turn it into a run of text: the
 * grid's whole job is one digit per printed box, and text would run them together on the rules.
 */
function testMovingADefaultKeepsWhatItIs() {
  const moved = mergePagePlacements(
    [TEXT_DEFAULT, DIGITS_DEFAULT, TICK_DEFAULT],
    [
      row({ id: "a", defaultKey: "insuredName", x: 50, y: 60, w: 300, h: 15, align: "center", size: 11 }),
      row({ id: "b", defaultKey: "nationalId", x: 70, y: 80, w: 280, h: 22 }),
      row({ id: "c", defaultKey: "categoryEmployee", x: 1, y: 2, w: 3, h: 4 }),
    ],
    1,
  );

  const [text, digits, tick] = moved.placements;
  assert.equal(text.kind, "text", "a text rule must stay a text rule when it is moved");
  assert.equal(digits.kind, "digits", "a box grid must stay a box grid when it is moved");
  assert.equal(tick.kind, "tick", "a tick must stay a tick when it is moved");

  if (text.kind !== "text" || digits.kind !== "digits" || tick.kind !== "tick") return;
  assert.deepEqual(
    [text.x, text.y, text.w, text.h, text.align, text.size],
    [50, 60, 300, 15, "center", 11],
    "a moved text rule must take every dimension the operator dragged",
  );

  // The pitch scales with the width, or the digits stop lining up with the boxes the moment the
  // grid is stretched — 14 cells at pitch 10 is 140pt wide, dragged to 280 is exactly double.
  assert.equal(digits.cells, 14, "stretching a grid must not change how many boxes it covers");
  assert.equal(digits.pitch, 20, "a stretched grid's cell pitch must scale with its new width");
  assert.deepEqual([tick.x, tick.y, tick.w, tick.h], [1, 2, 3, 4]);
}

/** Hiding a compiled default removes it from the page without deleting anything. */
function testHidingADefaultRemovesItFromThePage() {
  const merged = mergePagePlacements(
    [TEXT_DEFAULT, DIGITS_DEFAULT],
    [row({ id: "a", defaultKey: "insuredName", hidden: true })],
    1,
  );
  assert.deepEqual(
    merged.placements.map((placement) => placement.key),
    ["nationalId"],
    "a hidden default must not print",
  );
}

/**
 * An added field prints AFTER the defaults, and that order is load-bearing.
 *
 * Two absolutely positioned spans that overlap are resolved by document order. A correction dragged
 * on top of a wrong value has to win; render it first and it sits UNDERNEATH, so the page looks
 * exactly as it did before the operator dragged anything — an edit that appears to do nothing.
 */
function testAnAddedFieldPrintsOverTheDefaults() {
  const merged = mergePagePlacements(
    [TEXT_DEFAULT, DIGITS_DEFAULT],
    [row({ id: "added", source: { kind: "value", key: "jobTitleAr" } })],
    1,
  );
  assert.deepEqual(
    merged.placements.map((placement) => placement.key),
    ["insuredName", "nationalId", "jobTitleAr"],
    "an added field must be placed after the compiled defaults so it prints on top of them",
  );
}

/**
 * Two literals on one page keep two different values.
 *
 * A shared values-map key — `literal`, say — would make the second fixed string silently print the
 * first's text, on both fields, with no error. The row id in the key is what prevents it.
 */
function testTwoLiteralsOnOnePageDoNotCollide() {
  const merged = mergePagePlacements(
    [],
    [
      row({ id: "one", source: { kind: "literal", text: "أول" } }),
      row({ id: "two", source: { kind: "literal", text: "ثان" } }),
    ],
    1,
  );
  const keys = merged.placements.map((placement) => placement.key);
  assert.equal(new Set(keys).size, 2, "two literals must not share one values-map key");
  assert.deepEqual(
    keys.map((key) => merged.literals[key]),
    ["أول", "ثان"],
    "each literal must print its own text",
  );
}

/**
 * A literal can never shadow a real data key.
 *
 * `insuredName` means one person's Arabic name on every document in the pack. If a literal could
 * be stored under that key it would overwrite the name in the values map, and the employee's own
 * name would be replaced by fixed text on every field that reads it — including the ones nobody
 * touched.
 */
function testALiteralCannotShadowARealValue() {
  const key = fieldPrintedValue(row({ id: "x", source: { kind: "literal", text: "قيمة" } })).key;
  assert.equal(key, literalValueKey("x"));
  assert.ok(
    !Object.prototype.hasOwnProperty.call(PAPER_FIELD_BINDINGS, key),
    "a literal's values-map key must not be one the pack already binds to a stored column",
  );
  assert.ok(
    key.includes(":"),
    "a literal key must be namespaced — a bare word can collide with a renderer's own key",
  );

  // And a value field is looked up under its OWN key, or an added field would print nothing.
  const valueField = fieldPrintedValue(row({ source: { kind: "value", key: "insuredName" } }));
  assert.equal(valueField.key, "insuredName");
  assert.equal(valueField.literal, null, "a value field must not carry literal text");
}

/**
 * An override naming a placement the compiled table no longer has is IGNORED, not promoted.
 *
 * Rows outlive the table they were written against. Treating an orphan as a new field would print
 * a value at coordinates that no longer correspond to anything on the artwork — a number floating
 * in the middle of a government form, which reads as data.
 */
function testAnOrphanedOverrideIsIgnored() {
  const merged = mergePagePlacements(
    [TEXT_DEFAULT],
    [row({ id: "gone", defaultKey: "aKeyThatWasRemoved", x: 400, y: 900 })],
    1,
  );
  assert.deepEqual(
    merged.placements,
    [TEXT_DEFAULT],
    "an override for a placement that no longer exists must print nothing at all",
  );
}

/** Rows belonging to another printed side must not leak onto this one. */
function testRowsStayOnTheirOwnPage() {
  const rows = [
    row({ id: "front", page: 1, source: { kind: "literal", text: "أمام" } }),
    row({ id: "back", page: 2, source: { kind: "literal", text: "خلف" } }),
  ];
  const front = mergePagePlacements([], rows, 1);
  const back = mergePagePlacements([], rows, 2);
  assert.deepEqual(Object.values(front.literals), ["أمام"], "page 1 must carry only page 1's fields");
  assert.deepEqual(Object.values(back.literals), ["خلف"], "page 2 must carry only page 2's fields");
}

/** A flow field renders against its anchor, and renders nothing when it has no text to print. */
function testAFlowFieldHangsOffItsAnchor() {
  const anchored = row({
    id: "flow",
    document: "contract",
    page: null,
    anchor: { selector: "section.clauses > li:nth-of-type(7)", dx: 12, dy: 4 },
    source: { kind: "value", key: "EMPLOYEE_NAME" },
  });

  const html = renderFlowField(anchored, { EMPLOYEE_NAME: "غادة" });
  assert.ok(html.includes("left:12pt"), "a flow field must offset from its anchor, not from the page");
  assert.ok(html.includes("top:4pt"));
  assert.ok(html.includes('data-hp-key="EMPLOYEE_NAME"'), "a flow field must carry its key like any other value");
  assert.ok(html.includes("غادة"), "a flow field must print the value its key resolves to");

  assert.equal(
    renderFlowField(anchored, {}),
    "",
    "a field whose value is missing must print nothing rather than an empty outlined box",
  );
  assert.equal(
    renderFlowField(row({ ...anchored, anchor: null }), { EMPLOYEE_NAME: "غادة" }),
    "",
    "a flow field with no anchor has nowhere to hang and must not fall back to a page coordinate",
  );
}

/** Text is escaped on the way onto the page, literals included. */
function testFieldTextIsEscaped() {
  const html = renderFlowField(
    row({
      document: "contract",
      page: null,
      anchor: { selector: "section", dx: 0, dy: 0 },
      source: { kind: "literal", text: '<script>alert("x")</script>' },
    }),
    {},
  );
  assert.ok(!html.includes("<script>"), "a literal must be escaped before it reaches the page");
  assert.ok(html.includes("&lt;script&gt;"));
}

/** A hidden row contributes no literal — otherwise hiding a field would still cost a values entry. */
function testHiddenRowsContributeNoLiterals() {
  assert.deepEqual(
    fieldLiterals([row({ id: "h", hidden: true }), row({ id: "v", source: { kind: "literal", text: "ظاهر" } })]),
    { [literalValueKey("v")]: "ظاهر" },
    "a hidden field must not put its text into the values map",
  );
}


function record(over: Partial<FieldRecord> = {}): FieldRecord {
  return {
    id: "r1",
    document: "form1",
    template_version_id: "form1-v1",
    employee_hr_id: null,
    default_key: null,
    hidden: false,
    page: 1,
    anchor_selector: null,
    anchor_dx: null,
    anchor_dy: null,
    x: "10.50",
    y: "20.25",
    w: "120.00",
    h: "13.00",
    align: "right",
    font_size: "9.00",
    source_kind: "literal",
    literal_text: "نص",
    value_key: null,
    updated_at: "2026-09-03T00:00:00.000Z",
    updated_by_hr_id: "B-1",
    ...over,
  };
}

/**
 * A missing table must be recognised from a POSTGREST error, which is a plain object.
 *
 * This is the whole reason the store carries its own helper rather than reusing the module's
 * existing `isHiringPackSchemaMissing`. That one tests `error instanceof Error` before reading the
 * message — and a PostgREST error is `{ code, message, details, hint }`, not an Error — so it reads
 * the message as empty and answers false. The assertion below pins that difference deliberately: if
 * someone "simplifies" the store back onto the shared helper, the hiring pack starts 500ing the
 * moment the field table is absent, which is its state on every environment until the migration is
 * approved.
 */
function testAMissingFieldTableIsRecognised() {
  const postgrest = {
    code: "PGRST205",
    message: "Could not find the table 'public.hiring_pack_document_fields' in the schema cache",
    details: null,
    hint: null,
  };
  assert.ok(isFieldLayerMissing(postgrest), "PGRST205 is what a missing table answers, and it must be caught");
  assert.ok(
    isFieldLayerMissing({ code: "42P01", message: 'relation "x" does not exist' }),
    "the Postgres code must be caught too — both are one set",
  );
  assert.ok(
    isFieldLayerMissing({ message: "Could not find the table in the schema cache" }),
    "an error with no code at all must still be read from its message",
  );

  // The comparison that justifies this helper existing. Not a claim about what SHOULD be — a
  // measurement of what the shared helper does with the object PostgREST actually returns.
  assert.equal(
    isHiringPackSchemaMissing(postgrest),
    false,
    "the shared helper tests instanceof Error first, so it cannot see a PostgREST error — do not " +
      "replace the store's own check with it",
  );

  // And a real fault must NOT be swallowed, or a broken layout would read as an empty one.
  assert.equal(
    isFieldLayerMissing({ code: "42501", message: "permission denied for table hiring_pack_document_fields" }),
    false,
    "a permission error is a fault to surface, not a missing table to degrade past",
  );
  assert.equal(isFieldLayerMissing(null), false);
  assert.equal(isFieldLayerMissing("boom"), false);
}

/**
 * Postgres `numeric` arrives as a STRING through PostgREST, and a string coordinate is not a
 * coordinate: `"10.50" + 1` is `"10.501"`, and a width used in arithmetic silently concatenates.
 */
function testNumericColumnsArriveAsStringsAndAreParsed() {
  const row = documentFieldFromRecord(record());
  assert.ok(row, "a well-formed record must map");
  if (!row) return;
  assert.deepEqual(
    [row.x, row.y, row.w, row.h, row.size],
    [10.5, 20.25, 120, 13, 9],
    "every numeric column must be parsed to a number, not carried as a string",
  );
  for (const value of [row.x, row.y, row.w, row.h, row.size]) {
    assert.equal(typeof value, "number");
  }

  const anchored = documentFieldFromRecord(
    record({ page: null, anchor_selector: "section.clauses", anchor_dx: "6.5", anchor_dy: "-2.25" }),
  );
  assert.deepEqual(
    anchored?.anchor,
    { selector: "section.clauses", dx: 6.5, dy: -2.25 },
    "an anchor's offsets are numeric columns too",
  );
}

/** A record with an unknown source is DROPPED, never defaulted into printing something. */
function testAnUnknownSourceIsDropped() {
  assert.equal(
    documentFieldFromRecord(record({ source_kind: "formula", literal_text: null, value_key: null })),
    null,
    "a source this build does not understand must print nothing rather than guess",
  );
  assert.equal(
    documentFieldFromRecord(record({ source_kind: "value", value_key: null, literal_text: "نص" })),
    null,
    "a value field with no key names nothing and must be dropped",
  );
  assert.equal(
    documentFieldFromRecord(record({ align: "justify" }))?.align,
    "right",
    "an alignment this build does not understand falls back to the documents' own direction",
  );
}


/** A well-formed row for a page-surface document, ready to be mutated per test. */
function pageWrite(over: Partial<DocumentFieldWriteInput> = {}): DocumentFieldWriteInput {
  return {
    document: "form1",
    templateVersionId: "form1-v1",
    defaultKey: null,
    hidden: false,
    page: 2,
    anchor: null,
    x: 30,
    y: 640,
    w: 260,
    h: 14,
    align: "center",
    size: 11,
    source: { kind: "literal", text: "field added by drag and drop" },
    ...over,
  };
}

/** A well-formed row for a flow-surface document. */
function flowWrite(over: Partial<DocumentFieldWriteInput> = {}): DocumentFieldWriteInput {
  return {
    document: "contract",
    templateVersionId: "contract-v1",
    defaultKey: null,
    hidden: false,
    page: null,
    anchor: { selector: "section.clauses > li:nth-of-type(7)", dx: 12, dy: 4 },
    x: 0,
    y: 0,
    w: 200,
    h: 13,
    align: "right",
    size: 9,
    source: { kind: "value", key: "EMPLOYEE_NAME" },
    ...over,
  };
}

/**
 * The validator's job is to reject everything the table's own CHECK constraints would reject, and
 * accept everything they would accept. This proves the two agree on the two well-formed shapes a
 * client can actually send.
 */
function testTheWriteValidatorAcceptsAWellFormedRowOfEachSurface() {
  const page = parseDocumentFieldWrite(pageWrite());
  assert.equal(page.ok, true, "a well-formed page-surface row must be accepted");
  if (page.ok) {
    assert.equal(page.write.page, 2);
    assert.equal(page.write.anchor, null);
    assert.deepEqual(page.write.source, { kind: "literal", text: "field added by drag and drop" });
  }

  const flow = parseDocumentFieldWrite(flowWrite());
  assert.equal(flow.ok, true, "a well-formed flow-surface row must be accepted");
  if (flow.ok) {
    assert.equal(flow.write.page, null);
    assert.deepEqual(flow.write.anchor, { selector: "section.clauses > li:nth-of-type(7)", dx: 12, dy: 4 });
    assert.deepEqual(flow.write.source, { kind: "value", key: "EMPLOYEE_NAME" });
  }

  // A COMPANY TEMPLATE IS A PAGE SURFACE, and the validator has to admit one or the first box
  // dropped on an uploaded paper is refused — which is how this was found: the template printed
  // perfectly and only the SAVE failed, as a raw constraint violation from Postgres.
  const custom = parseDocumentFieldWrite(
    pageWrite({ document: "custom:1857bafe-d3f9-4576-a850-abe82f884f0d" }),
  );
  assert.equal(custom.ok, true, "a box on an uploaded company template must be accepted");
  if (custom.ok) {
    assert.equal(custom.write.document, "custom:1857bafe-d3f9-4576-a850-abe82f884f0d");
    assert.equal(custom.write.page, 2, "an uploaded template places by coordinate, like Form 1");
    assert.equal(custom.write.anchor, null, "nothing on a scanned image reflows, so nothing anchors");
  }

  const withId = parseDocumentFieldWrite(pageWrite({ id: "row-1" }));
  assert.equal(withId.ok && withId.write.id, "row-1");
  const withoutId = parseDocumentFieldWrite(pageWrite());
  assert.equal(withoutId.ok && withoutId.write.id, undefined);
}

/**
 * Every rejection here mirrors a named CHECK constraint on hiring_pack_document_fields. A row this
 * rejects must never reach saveDocumentField, because the alternative is finding out from a raw
 * Postgres constraint-violation message instead of a sentence someone dragging a box can act on.
 */
function testTheWriteValidatorRejectsEveryConstraintTheTableEnforces() {
  assert.equal(parseDocumentFieldWrite(pageWrite({ document: "timesheet" })).ok, false, "an unknown document must be rejected");
  // The widened half of the same constraint (20260904200000): `custom:<uuid>` and nothing looser.
  // A template's NAME typed where its key belongs would store a row the print route never asks
  // for — a box that silently appears on no paper, reported by nothing.
  assert.equal(
    parseDocumentFieldWrite(pageWrite({ document: "custom:not-a-uuid" })).ok,
    false,
    "a company template whose key is not a uuid must be rejected",
  );
  assert.equal(
    parseDocumentFieldWrite(pageWrite({ document: "custom:" })).ok,
    false,
    "a bare custom: prefix names no template",
  );
  assert.equal(parseDocumentFieldWrite(pageWrite({ templateVersionId: "" })).ok, false, "an empty template version must be rejected");
  assert.equal(parseDocumentFieldWrite(pageWrite({ align: "justify" })).ok, false, "an unknown alignment must be rejected");

  // placed-once
  assert.equal(parseDocumentFieldWrite(pageWrite({ page: null })).ok, false, "a page-surface row needs a page");
  assert.equal(
    parseDocumentFieldWrite(pageWrite({ anchor: { selector: "x", dx: 0, dy: 0 } })).ok,
    false,
    "a page-surface row must not also carry an anchor",
  );
  assert.equal(parseDocumentFieldWrite(flowWrite({ anchor: null })).ok, false, "a flow-surface row needs an anchor");
  assert.equal(parseDocumentFieldWrite(flowWrite({ page: 1 })).ok, false, "a flow-surface row must not also carry a page");
  assert.equal(
    parseDocumentFieldWrite(flowWrite({ anchor: { selector: "", dx: 0, dy: 0 } })).ok,
    false,
    "an anchor needs a non-empty selector",
  );
  assert.equal(
    parseDocumentFieldWrite(flowWrite({ anchor: { selector: "x", dx: "12", dy: 0 } })).ok,
    false,
    "an anchor's offsets must be numbers, not strings a client happened to send",
  );

  // page-positive
  assert.equal(parseDocumentFieldWrite(pageWrite({ page: 0 })).ok, false, "page must be 1 or more");
  assert.equal(parseDocumentFieldWrite(pageWrite({ page: 1.5 })).ok, false, "page must be a whole number");

  // box-real
  assert.equal(parseDocumentFieldWrite(pageWrite({ w: 0 })).ok, false, "w must be positive");
  assert.equal(parseDocumentFieldWrite(pageWrite({ h: -3 })).ok, false, "h must be positive");
  assert.equal(parseDocumentFieldWrite(pageWrite({ size: 0 })).ok, false, "size must be positive");

  // hide-is-an-override
  assert.equal(
    parseDocumentFieldWrite(pageWrite({ hidden: true, defaultKey: null })).ok,
    false,
    "an addition (no defaultKey) cannot be hidden, it has nothing to fall back to",
  );
  assert.equal(
    parseDocumentFieldWrite(pageWrite({ hidden: true, defaultKey: "companyName" })).ok,
    true,
    "an override CAN be hidden",
  );

  // source-paired
  assert.equal(
    parseDocumentFieldWrite(pageWrite({ source: { kind: "value", key: "" } })).ok,
    false,
    "a value source needs a non-empty key",
  );
  assert.equal(
    parseDocumentFieldWrite(pageWrite({ source: { kind: "literal", text: 5 } })).ok,
    false,
    "a literal source's text must be a string",
  );
  assert.equal(
    parseDocumentFieldWrite(pageWrite({ source: { kind: "formula", text: "x" } })).ok,
    false,
    "an unknown source kind must be rejected, not guessed at",
  );
  assert.equal(
    parseDocumentFieldWrite(pageWrite({ source: { kind: "literal", text: "" } })).ok,
    true,
    "an EMPTY literal is still a literal, clearing a field's text is not the same as deleting it",
  );

  // override-or-addition
  assert.equal(parseDocumentFieldWrite(pageWrite({ defaultKey: "" })).ok, false, "defaultKey must be non-empty when present, never a blank string");
}

async function testCarryingALayoutForwardToANewVersion() {
  // ── Carrying a layout forward to a new template version ──────────────────────────────────────
  //
  // Field rows are scoped to `template_version_id` so an archived contract reprints as the document
  // that was signed. The cost is that replacing a template — `contract-v1` to `contract-v2`, which
  // really happened on 2026-08-30 — silently strands every change made against the old one. These
  // pin the offer that answers that, and the two refusals that keep it from doing harm.
  {
    const counts = (
      entries: [id: string, version: number, fields: number][],
    ): VersionFieldCount[] =>
      entries.map(([templateVersionId, version, fields]) => ({
        fields,
        labelEn: `${templateVersionId} label`,
        status: fields > 0 ? "archived" : "current",
        templateVersionId,
        version,
      }));

    // THE NEWEST EARLIER VERSION WINS, not the oldest and not the fullest. v1 holding more rows than
    // v2 is the case that separates "most recent" from "most work": a layout is corrected forward,
    // so v2's four boxes supersede v1's nine rather than losing to them.
    const layered = counts([
      ["doc-v1", 1, 9],
      ["doc-v2", 2, 4],
      ["doc-v3", 3, 0],
    ]);
    const picked = pickCarryForwardSource(layered, 3, "doc-v3");
    assert.equal(
      picked?.templateVersionId,
      "doc-v2",
      "the most recent earlier version is the most correct one to carry",
    );

    // A version that already holds work is left alone. Merging produces a page that was never
    // either version's, and afterwards nothing can say which box came from where.
    assert.equal(
      pickCarryForwardSource(counts([["doc-v1", 1, 9], ["doc-v2", 2, 3]]), 2, "doc-v2"),
      null,
      "a version with its own fields must never be offered a merge",
    );

    // Nothing earlier holds anything: the ordinary case on a document nobody has edited.
    assert.equal(
      pickCarryForwardSource(counts([["doc-v1", 1, 0], ["doc-v2", 2, 0]]), 2, "doc-v2"),
      null,
    );

    // A LATER version is never a source. Carrying backwards would put work done on the current
    // template onto an archived one, changing how an already-signed document reprints.
    assert.equal(
      pickCarryForwardSource(counts([["doc-v1", 1, 0], ["doc-v2", 2, 7]]), 1, "doc-v1"),
      null,
      "a newer version is not a source — an archived layout must reprint as it was signed",
    );

    // An id that is not in the counts at all answers null rather than picking something.
    assert.equal(pickCarryForwardSource(counts([["doc-v1", 1, 5]]), 2, "doc-v2"), null);
  }

  // The two refusals in the copy itself, which both fire BEFORE any database client is created.
  {
    await assert.rejects(
      () => carryForwardDocumentFields("contract", "contract-v2", "contract-v2", "HR-001"),
      /cannot be carried onto the version it already belongs to/,
      "carrying a version onto itself must be refused, not silently duplicated",
    );

    // A version id from another document. The damage would be invisible until it printed: a
    // contract's coordinates land over a government form's own boxes.
    await assert.rejects(
      () => carryForwardDocumentFields("form1", "contract-v1", "form1-v1", "HR-001"),
      /Both versions must belong to form1/,
      "a version id belonging to another document must be refused",
    );
  }
}


/**
 * WHAT A FIELD USED TO SAY.
 *
 * A save overwrites, so before the history table there was no answer at all to "what did this field
 * print in September" — on papers people sign — and a reset deleted every row on a document without
 * leaving a trace of what it deleted. The recording is a database trigger, proved against staging by
 * inserting, editing and deleting a field and reading both states back; these pin the two decisions
 * that live in TypeScript and would fail silently rather than loudly.
 */
function testTheHistoryOfAField() {
  // ── The summary's one decision: which change is the LATEST ──────────────────────────────────
  //
  // The read asks for newest first, so taking the first sighting of each field would be correct
  // today and would keep LOOKING correct on the day the ordering changed — showing a field's oldest
  // state as its most recent change, "changed 3 Jan" beside a rule written last week. So the rows
  // here arrive deliberately OUT of order.
  const summary = summariseHistoryRows([
    { field_id: "a", changed_at: "2026-09-01T08:00:00Z" },
    { field_id: "b", changed_at: "2026-09-03T11:30:00Z" },
    { field_id: "a", changed_at: "2026-09-12T14:20:00Z" },
    { field_id: "a", changed_at: "2026-09-04T09:15:00Z" },
  ]);

  assert.equal(
    summary.a?.lastChangedAt,
    "2026-09-12T14:20:00Z",
    "the latest change must be found by comparing, not by trusting the query's order",
  );
  assert.equal(summary.a?.changes, 3, "every superseded state counts, not just the newest");
  assert.equal(summary.b?.changes, 1);
  assert.equal(summary.c, undefined, "a field nobody has rewritten gets no entry and no line");
  assert.deepEqual(summariseHistoryRows([]), {}, "an empty history is an empty summary, not a throw");

  // ── The entry's one decision: whose state this is ───────────────────────────────────────────
  //
  // A history row has TWO ids — its own, and the field's. The state must be built against
  // `field_id`, because the panel groups and matches on it. Reading the history row's own id
  // instead would give every entry a different field id, so the newest state would look like it
  // belonged to a field that has never existed — and the panel, which draws only the answer whose
  // id matches the row on screen, would render an empty history beside a "Changed" line.
  const record = {
    id: "history-row-1",
    field_id: "field-42",
    document: "form1",
    template_version_id: "form1-v1",
    employee_hr_id: null,
    default_key: "nationalId",
    action: "update",
    hidden: false,
    page: 1,
    anchor_selector: null,
    anchor_dx: null,
    anchor_dy: null,
    x: "100.00",
    y: "200.00",
    w: "80.00",
    h: "12.00",
    align: "right",
    font_size: "9.00",
    source_kind: "value",
    value_key: "nationalId",
    literal_text: null,
    updated_at: "2026-09-01T08:00:00Z",
    updated_by_hr_id: "HR-001",
    was_updated_at: "2026-09-01T08:00:00Z",
    was_updated_by_hr_id: "HR-001",
    changed_at: "2026-09-12T14:20:00Z",
    changed_by_hr_id: "HR-002",
  };

  const entry = fieldHistoryFromRecord(record as unknown as Parameters<typeof fieldHistoryFromRecord>[0]);
  assert.ok(entry, "a well-formed history record must produce an entry");
  assert.equal(entry.id, "history-row-1", "the entry keeps the history row's own id");
  assert.equal(
    entry.state.id,
    "field-42",
    "the state belongs to the FIELD, not to the history row that records it",
  );
  assert.equal(entry.fieldId, "field-42");
  // Numerics come back from PostgREST as strings, and "100" + 1 is "1001" — parsed, like a live row.
  assert.equal(entry.state.x, 100);
  assert.equal(entry.state.size, 9);

  // A DELETE records no actor, deliberately: there is no incoming row to read one off, and the
  // field's last editor is not the person who removed it. Proved against staging as well — the
  // delete row came back with changed_by_hr_id null while its update sibling carried HR-002.
  const removed = fieldHistoryFromRecord({
    ...record,
    action: "delete",
    changed_by_hr_id: null,
  } as unknown as Parameters<typeof fieldHistoryFromRecord>[0]);
  assert.equal(removed?.action, "delete");
  assert.equal(removed?.changedByHrId, null);

  // An action outside the two the CHECK constraint allows is refused rather than shown as one of
  // them. A hand-written row is the only way to get one, and guessing would put a state on screen
  // under a verb nobody wrote.
  assert.equal(
    fieldHistoryFromRecord({ ...record, action: "insert" } as unknown as Parameters<
      typeof fieldHistoryFromRecord
    >[0]),
    null,
    "an unknown action is refused, never displayed as an update",
  );

  // A state the renderer would refuse to draw is dropped here too — the same rule the live layout
  // follows. Answering "what did this print" with something that never printed is worse than
  // answering with nothing.
  assert.equal(
    fieldHistoryFromRecord({
      ...record,
      source_kind: "nonsense",
    } as unknown as Parameters<typeof fieldHistoryFromRecord>[0]),
    null,
    "a state nothing could have drawn is not a state this field used to print",
  );
}


/**
 * A BOX THAT WILL NOT PRINT, AND A BOX PRINTING ON TOP OF ANOTHER.
 *
 * The drag clamps at zero on the top and left and has NO upper bound, while `.sheet` is
 * `overflow: hidden`. So a box dragged past the right or bottom edge is clipped in silence: it looks
 * placed while it is being dragged, it saves, and it prints nothing — on a government form somebody
 * signs. It is invisible to the golden-rule scroll check too, for the same reason that check cannot
 * see a clipped band: clipped content adds nothing to `scrollWidth`.
 */
function testBoxesThatWillNotPrintAreNamed() {
  const box = (over: Partial<DocumentFieldRow> & { id: string }): DocumentFieldRow => ({
    align: "right",
    anchor: null,
    defaultKey: null,
    document: "form1",
    h: 12,
    hidden: false,
    page: 0,
    size: 9,
    source: { kind: "value", key: "nationalId" },
    templateVersionId: "form1-v1",
    updatedAt: "2026-09-04T00:00:00Z",
    updatedByHrId: null,
    w: 80,
    x: 10,
    y: 10,
    ...over,
  });

  const name = (row: DocumentFieldRow) => `field ${row.id}`;

  // Form 1 is 612.12 × 1008.12pt — the Authority's own artwork, neither A4 nor US Letter.
  const size = pageSizeFor("form1");
  assert.ok(size, "a page document must have a printed size to measure against");

  // ── The silent one: dragged off the right-hand edge ────────────────────────────────────────
  const offRight = fieldWarnings(size, [box({ id: "r", x: size.width - 10, w: 80 })], name);
  assert.equal(offRight.length, 1, "a box running past the right edge must be named");
  assert.equal(offRight[0].kind, "off-page");
  assert.match(offRight[0].message, /will not print/);
  assert.match(offRight[0].message, /right/);

  const offBottom = fieldWarnings(size, [box({ id: "b", y: size.height - 4, h: 12 })], name);
  assert.equal(offBottom[0]?.kind, "off-page", "a box running past the bottom edge must be named");

  // Reachable only through the fine-tune panel's number inputs, which take a typed value as given —
  // the drag itself clamps at zero.
  const negative = fieldWarnings(size, [box({ id: "n", x: -20 })], name);
  assert.match(negative[0]?.message ?? "", /left/, "a negative coordinate is off the page too");

  // A box that fits says nothing at all. A warning on a correct layout is worse than none, because
  // it teaches the operator to scroll past the row that matters.
  assert.deepEqual(fieldWarnings(size, [box({ id: "ok" })], name), []);

  // Exactly flush with the edge is ON the page, not off it. Half the compiled placements on a
  // government form sit against a printed rule by design.
  assert.deepEqual(
    fieldWarnings(size, [box({ id: "flush", w: 80, x: size.width - 80 })], name),
    [],
    "a box ending exactly at the edge is inside the page",
  );

  // ── Overlap, reported on BOTH rows ─────────────────────────────────────────────────────────
  //
  // A collision belongs to the PAIR. Naming it on only one of them would make the answer depend on
  // which row the operator happened to open.
  const collide = fieldWarnings(
    size,
    [box({ id: "a", x: 100, y: 100 }), box({ id: "b", x: 120, y: 100 })],
    name,
  );
  assert.equal(collide.length, 2, "an overlap is reported on both of the boxes involved");
  assert.deepEqual(
    collide.map((warning) => warning.rowId).sort(),
    ["a", "b"],
  );
  assert.match(collide[0].message, /field b/, "the warning names the OTHER box, not itself");

  // Boxes that merely touch are not overlapping. A row of digit cells on Form 1 abuts its neighbour
  // by design, so warning on contact would put a line under most of the table.
  assert.deepEqual(
    fieldWarnings(size, [box({ id: "a", x: 100 }), box({ id: "b", x: 180 })], name),
    [],
    "boxes that abut are not overlapping",
  );

  // Two sides of the same paper are not the same space.
  assert.deepEqual(
    fieldWarnings(size, [box({ id: "a", page: 0 }), box({ id: "b", page: 1 })], name),
    [],
    "boxes on different pages cannot overlap",
  );

  // A HIDDEN override renders no box at all — `mergePagePlacements` skips it outright — so it can
  // neither fall off the page nor collide. Warning about one would send the operator looking for a
  // box that is not there.
  assert.deepEqual(
    fieldWarnings(
      size,
      [box({ hidden: true, id: "a", x: 100 }), box({ id: "b", x: 120 })],
      name,
    ),
    [],
    "a hidden field renders nothing and so can neither run off the page nor overlap",
  );

  // ── The surface the check cannot examine says so, rather than reporting clean ───────────────
  //
  // A flow document has no page coordinates: its fields hang off a CSS anchor and land where the
  // browser puts them, after the text above has been laid out.
  assert.equal(pageSizeFor("contract"), null, "a flow document has no printed page size");
  assert.deepEqual(
    fieldWarnings(pageSizeFor("contract"), [box({ document: "contract", id: "a", page: null })], name),
    [],
  );

  // ── AN UPLOADED COMPANY TEMPLATE IS WARNED ABOUT TOO ───────────────────────────────────────
  //
  // THE REASON THIS FUNCTION TAKES A SIZE RATHER THAN A DOCUMENT. `pageSizeFor` reads a table of
  // the ten, so a `custom:<uuid>` document has no size in it and the honest lookup answers null —
  // which above means "flow document, nothing to warn about". That would have switched the off-page
  // warning off on precisely the papers that need it most: every box on an uploaded scan is placed
  // by hand against artwork nobody compiled, so running one off the edge is a click away, and the
  // failure prints as a blank space on a form somebody signs.
  //
  // A company template carries its own measured size on its row. Given that size, the same check
  // works on it unchanged.
  const uploaded = { height: 841.89, width: 595.28 }; // A4, as an uploaded PDF usually measures.
  const offUploaded = fieldWarnings(
    uploaded,
    [box({ id: "u", w: 80, x: uploaded.width - 10 })],
    name,
  );
  assert.equal(
    offUploaded.length,
    1,
    "a box off the edge of an UPLOADED template must be named, not silently exempt",
  );
  assert.equal(offUploaded[0].kind, "off-page");
  assert.deepEqual(
    fieldWarnings(uploaded, [box({ id: "u", w: 80, x: uploaded.width - 80 })], name),
    [],
    "and one that fits an uploaded page says nothing",
  );

  // ── The one that catches the NEXT page document ────────────────────────────────────────────
  //
  // `pageSizeFor` and `documentSurface` answer the same question two ways, and a new page document
  // added to the surface map but not to the size map would be UNWARNED — silently exempt from the
  // whole check, which is exactly the state this exists to end. An exhaustive `Record` would not
  // catch it: `ignoreBuildErrors` lets a missing key compile, build and deploy.
  for (const document of HIRING_PACK_DOCUMENTS) {
    const hasSize = pageSizeFor(document) !== null;
    assert.equal(
      hasSize,
      documentSurface(document) === "page",
      `${document}: a page document needs a printed size, and a flow document must not have one`,
    );
  }
}

/**
 * The table's document CHECK must name exactly `HIRING_PACK_DOCUMENTS`.
 *
 * It did not: the constraint still listed the first ten while the app had grown to 38, so a box
 * dropped on any of the other 28 passed `parseDocumentFieldWrite` and was then refused by Postgres
 * as a raw constraint violation. Nothing compares a CHECK constraint to a TypeScript list unless a
 * test does, so this reads the NEWEST migration that (re)adds the constraint and compares the two.
 * A built-in added without a migration fails here, in CI, instead of on somebody's first save.
 */
function testTheTableAdmitsEveryBuiltInDocument() {
  const dir = "supabase/migrations";
  const definers = readdirSync(dir)
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .filter((file) =>
      /add\s+constraint\s+hiring_pack_document_fields_document_known/i.test(readFileSync(`${dir}/${file}`, "utf8")),
    );
  assert.ok(definers.length > 0, "some migration must define hiring_pack_document_fields_document_known");
  const latest = definers[definers.length - 1];
  const sql = readFileSync(`${dir}/${latest}`, "utf8");
  const list = /add\s+constraint\s+hiring_pack_document_fields_document_known\s+check\s*\(\s*document\s+in\s*\(([^)]*)\)/i.exec(sql);
  assert.ok(list, `${latest}: the constraint must name its documents as document in (...)`);
  const admitted = [...list[1].matchAll(/'([^']+)'/g)].map((match) => match[1]).sort();

  assert.deepEqual(
    admitted,
    [...HIRING_PACK_DOCUMENTS].sort(),
    `${latest}: the table's document CHECK must name exactly HIRING_PACK_DOCUMENTS — add a migration for any new built-in`,
  );

  for (const document of HIRING_PACK_DOCUMENTS) {
    const write =
      documentSurface(document) === "page"
        ? pageWrite({ document })
        : flowWrite({ document });
    const parsed = parseDocumentFieldWrite(write);
    assert.equal(parsed.ok, true, `${document}: a box on a built-in paper must pass the write validator`);
  }
}

/**
 * THE FIELD LAYER PLACES INTO EVERY COPY, INCLUDING A DOCUMENT THAT HAS NO `.copy` WRAPPER.
 *
 * WHY THIS IS TESTED BY RUNNING THE SCRIPT AND NOT BY READING IT. The placement is a string of
 * browser JavaScript emitted inside `flowFieldLayer`, so nothing in this suite type-checks it and a
 * grep of the source proves only that a word is present. This repo has shipped three defects from
 * checking a generated string by reading it, which is why the rule is to verify the emitted
 * artifact — here that means compiling the emitted script and running it against a DOM stub.
 *
 * WHAT IT CAUGHT. The English certificate of experience prints TWO copies
 * (`experienceCertificateCopies`) as two `<article class="cert xc">` elements and carries no `.copy`
 * class at all, so the scope falls back to the document body. With a singular `querySelector` the
 * layer found the first article's anchor and stopped: the employee's copy was stamped and the
 * service file's copy was blank, with nothing on either page to say so.
 */
function testAFlowFieldReachesEveryCopyWithNoCopyWrapper(): void {
  const layer = flowFieldLayer(
    [row({ anchor: { dx: 4, dy: 2, selector: ".cert__signrow span" }, document: "experienceCertificateEn", page: null })],
    {},
  );
  const script = layer.slice(layer.indexOf("<script>") + 8, layer.indexOf("</script>"));

  // Two articles, each holding one element the selector matches - the English certificate's shape.
  const appended: string[] = [];
  const makeHost = (id: string) => ({
    classList: { add: () => {} },
    appendChild: () => appended.push(id),
  });
  const hosts = [makeHost("copy-1"), makeHost("copy-2")];

  const proto = {
    getAttribute: () => ".cert__signrow span",
    cloneNode: () => ({}),
  };
  const documentStub = {
    readyState: "complete",
    addEventListener: () => {},
    getElementById: () => ({ content: { querySelectorAll: () => [proto] } }),
    // No `.copy` anywhere, which is the whole point - the scope falls back to the body.
    querySelectorAll: (selector: string) => (selector === ".copy" ? [] : []),
    body: { querySelectorAll: () => hosts },
  };

  // The artifact under test IS a script, so running it is the only honest check of it.
  new Function("document", script)(documentStub);

  assert.deepEqual(
    appended,
    ["copy-1", "copy-2"],
    "both printed copies must carry the field - one stamped copy and one blank is the failure this exists to stop",
  );
}

export async function runHiringPackFieldLayoutTests() {
  testTheTableAdmitsEveryBuiltInDocument();
  testEveryDocumentDeclaresItsSurface();
  testAnUntouchedDocumentIsUnchanged();
  testMovingADefaultKeepsWhatItIs();
  testHidingADefaultRemovesItFromThePage();
  testAnAddedFieldPrintsOverTheDefaults();
  testTwoLiteralsOnOnePageDoNotCollide();
  testALiteralCannotShadowARealValue();
  testAnOrphanedOverrideIsIgnored();
  testRowsStayOnTheirOwnPage();
  testAFlowFieldHangsOffItsAnchor();
  testAFlowFieldReachesEveryCopyWithNoCopyWrapper();
  testFieldTextIsEscaped();
  testHiddenRowsContributeNoLiterals();
  testAMissingFieldTableIsRecognised();
  testNumericColumnsArriveAsStringsAndAreParsed();
  testAnUnknownSourceIsDropped();
  testTheWriteValidatorAcceptsAWellFormedRowOfEachSurface();
  testTheWriteValidatorRejectsEveryConstraintTheTableEnforces();
  await testCarryingALayoutForwardToANewVersion();
  testTheHistoryOfAField();
  testBoxesThatWillNotPrintAreNamed();
}

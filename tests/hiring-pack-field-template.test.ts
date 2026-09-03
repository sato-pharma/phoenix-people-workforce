// The placeholder engine behind the field table, and the two failures it exists to prevent.
//
// Both failures put wrong ink on paper somebody signs, and neither one announces itself:
//
//   1. A misspelt `{{jobTitlAr}}` printing its own braces in the middle of an employment contract.
//   2. A sentence quietly missing its middle — "يعمل لدى فاركو بوظيفة اعتباراً من" reads as a
//      finished sentence that says something false.
//
// So the assertions below are about what must NOT reach a page, not about the happy path. The
// happy path is one test; the rest are the guards.

import assert from "node:assert/strict";

import {
  fieldTemplateKeys,
  isFieldTemplate,
  resolveFieldTemplate,
  validateFieldTemplate,
} from "@/lib/hiring-pack/field-template";
import { fieldPrintedValue, literalValueKey, mergePagePlacements } from "@/lib/hiring-pack/field-layout";
import type { DocumentFieldRow } from "@/lib/hiring-pack/field-layout";
import type { Placement } from "@/lib/hiring-pack/render-placement";

const KNOWN = new Set(["employeeName", "jobTitleAr", "companyName"]);
const isKnownKey = (key: string) => KNOWN.has(key);

/** A stored row, with every geometry field filled so a test only has to say what it is testing. */
function row(overrides: Partial<DocumentFieldRow> = {}): DocumentFieldRow {
  return {
    align: "right",
    anchor: null,
    defaultKey: null,
    h: 14,
    hidden: false,
    id: "row-1",
    page: 0,
    size: 9,
    source: { kind: "literal", text: "" },
    w: 140,
    x: 10,
    y: 10,
    ...overrides,
  } as DocumentFieldRow;
}

export async function runHiringPackFieldTemplateTests() {
  // ── Recognising a template ────────────────────────────────────────────────────────────────
  assert.equal(isFieldTemplate("plain text"), false, "text with no braces is not a template");
  assert.equal(isFieldTemplate("hello {{employeeName}}"), true, "a placeholder makes it a template");
  // `PLACEHOLDER` carries the /g flag, so `test` advances `lastIndex` between calls. Asked twice in
  // a row about the same string it would answer true then false — the kind of defect that only
  // appears once a list is long enough for two rows to hold the same text.
  assert.equal(isFieldTemplate("hello {{employeeName}}"), true, "the answer does not depend on how often it is asked");

  assert.deepEqual(
    fieldTemplateKeys("{{employeeName}} — {{jobTitleAr}} — {{employeeName}}"),
    ["employeeName", "jobTitleAr"],
    "keys come back in order, without repeats",
  );

  // ── Validation refuses what would print wrongly ───────────────────────────────────────────
  assert.equal(validateFieldTemplate("no placeholders at all", isKnownKey), null, "plain text is fine");
  assert.equal(
    validateFieldTemplate("يعمل لدى {{companyName}} بوظيفة {{jobTitleAr}}", isKnownKey),
    null,
    "a bilingual sentence with two known keys is fine",
  );

  assert.match(
    validateFieldTemplate("{{jobTitlAr}}", isKnownKey) ?? "",
    /no field called/i,
    "a misspelt key is refused rather than printed",
  );
  assert.match(
    validateFieldTemplate("{{}}", isKnownKey) ?? "",
    /empty/i,
    "an empty placeholder is refused",
  );
  assert.match(
    validateFieldTemplate("{{job title}}", isKnownKey) ?? "",
    /not a field name/i,
    "a key with a space in it is refused",
  );
  assert.match(
    validateFieldTemplate("{{employeeName}", isKnownKey) ?? "",
    /unfinished/i,
    "a half-written placeholder is refused — it would print its own braces",
  );
  assert.match(
    validateFieldTemplate("{{employeeName}} and {{jobTitleAr}", isKnownKey) ?? "",
    /unfinished/i,
    "a good placeholder does not excuse a broken one beside it",
  );

  // THE ALLOW-LIST IS OPTIONAL, AND THAT IS THE LAYERING. The store cannot know which keys a
  // document has — a page document places camelCase record keys and a flow document fills
  // UPPER_SNAKE tokens that are in no binding table — so it checks shape only, and the editor,
  // which has the document's live inventory, checks the names.
  assert.equal(
    validateFieldTemplate("{{COMPANY_NAME}}"),
    null,
    "shape-only validation accepts a flow token the binding table has never heard of",
  );
  assert.match(
    validateFieldTemplate("{{COMPANY_NAME}}", isKnownKey) ?? "",
    /no field called/i,
    "the same text is refused once a document's own key list is supplied",
  );
  assert.match(
    validateFieldTemplate("{{employeeName}") ?? "",
    /unfinished/i,
    "shape-only still refuses a broken brace — that is the half that can print",
  );

  // ── Resolution, and the whole-field blank ─────────────────────────────────────────────────
  assert.equal(
    resolveFieldTemplate("Plain text", {}),
    "Plain text",
    "text with no placeholders comes back untouched — every literal stored before this still prints",
  );
  assert.equal(
    resolveFieldTemplate("يعمل لدى {{companyName}} بوظيفة {{jobTitleAr}}", {
      companyName: "فاركو",
      jobTitleAr: "مندوب دعاية",
    }),
    "يعمل لدى فاركو بوظيفة مندوب دعاية",
    "a filled sentence resolves in place",
  );

  // The headline assertion of this file: ONE missing value blanks the WHOLE field.
  assert.equal(
    resolveFieldTemplate("يعمل لدى {{companyName}} بوظيفة {{jobTitleAr}}", { companyName: "فاركو" }),
    null,
    "a placeholder with no value blanks the whole field rather than leaving a hole in the sentence",
  );
  assert.equal(
    resolveFieldTemplate("{{employeeName}}", { employeeName: "" }),
    null,
    "an empty string counts as no value — it would print a sentence with a gap",
  );
  assert.equal(
    resolveFieldTemplate("{{notAKeyAnywhere}}", { employeeName: "Ali" }),
    null,
    "an unknown key prints nothing, not its own braces — the last guard, needing nobody to have checked",
  );

  // A Latin key typed into an Arabic input collects an invisible direction mark at one end. It
  // must still resolve: a placeholder that stopped matching because of a character nobody can see
  // would look exactly like one somebody spelled wrong.
  assert.equal(
    resolveFieldTemplate("‏{{‎employeeName‏}}", { employeeName: "Ali" }),
    "‏Ali",
    "direction marks inside the braces are stripped from the key",
  );

  // ── The row's source is what prints ───────────────────────────────────────────────────────
  const literalRow = row({ id: "abc", source: { kind: "literal", text: "Hello {{employeeName}}" } });
  assert.deepEqual(
    fieldPrintedValue(literalRow, { employeeName: "Ali" }),
    { key: literalValueKey("abc"), literal: "Hello Ali" },
    "a literal row publishes its resolved text under its own collision-proof key",
  );
  assert.deepEqual(
    fieldPrintedValue(literalRow, {}),
    { key: literalValueKey("abc"), literal: null },
    "and publishes nothing when a placeholder cannot be filled",
  );

  // ── An override's source reaches the page ─────────────────────────────────────────────────
  //
  // This is the behaviour the field table depends on and the one that did not exist before it: an
  // override row used to be spread over its compiled placement, KEEPING the compiled key, so its
  // `source` was written and never read. Retyping a field would have saved and then printed the
  // old value, with nothing on screen to say so.
  const defaults: Placement[] = [
    { align: "right", h: 14, key: "employeeName", kind: "text", size: 9, w: 140, x: 20, y: 30 },
  ];

  const retyped = mergePagePlacements(
    defaults,
    [row({ defaultKey: "employeeName", id: "ov1", source: { kind: "literal", text: "Fixed instead" } })],
    0,
    { employeeName: "Ali" },
  );
  assert.equal(retyped.placements.length, 1, "the override replaces the default rather than joining it");
  assert.equal(
    retyped.placements[0]?.key,
    literalValueKey("ov1"),
    "the placement now looks its text up under the override's own key, not the compiled one",
  );
  assert.equal(
    retyped.literals[literalValueKey("ov1")],
    "Fixed instead",
    "and the text is published into the values map, or it would print blank",
  );

  const untouched = mergePagePlacements(
    defaults,
    [row({ defaultKey: "employeeName", id: "ov2", source: { kind: "value", key: "employeeName" }, x: 99 })],
    0,
    { employeeName: "Ali" },
  );
  assert.equal(
    untouched.placements[0]?.key,
    "employeeName",
    "a row that was only ever DRAGGED still reads the compiled value — every row stored before the table is unchanged",
  );
  assert.equal(untouched.placements[0]?.x, 99, "and keeps the position it was dragged to");
}

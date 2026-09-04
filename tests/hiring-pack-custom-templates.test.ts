import assert from "node:assert/strict";

import {
  buildCustomTemplatePagePath,
  CUSTOM_TEMPLATE_CONTENT_TYPES,
  CUSTOM_TEMPLATE_MAX_PAGE_BYTES,
  CUSTOM_TEMPLATE_MAX_PAGES,
  CUSTOM_TEMPLATE_MAX_PT,
  CUSTOM_TEMPLATE_MIN_PT,
  pagePresetFor,
  parseCustomTemplateDraft,
  roundPoints,
} from "@/lib/hiring-pack/custom-templates";
import { isCustomTemplateLayerMissing } from "@/lib/hiring-pack/custom-template-store";
import {
  CUSTOM_DOCUMENT_PREFIX,
  customDocumentFor,
  customTemplateKeyOf,
  HIRING_PACK_DOCUMENTS,
  isBuiltInDocument,
  isCustomDocument,
} from "@/lib/hiring-pack/types";

// Company templates — a document uploaded through the UI instead of written into the code.
//
// WHAT IS WORTH PINNING HERE IS THE GATE, not the storage. Everything between a dropped file and a
// paper the company prints passes through `parseCustomTemplateDraft`, and the failures it prevents
// are all of the same silent kind: a template that lists correctly, opens correctly, and prints
// nothing or prints at the wrong scale.

const KEY = "f72a4c1d-dbb8-45f3-a4fb-473ef05c7ba2";

function draft(over: Record<string, unknown> = {}) {
  return {
    name: "Medical insurance enrolment",
    pageHeightPt: 841.89,
    pages: [{ contentType: "image/png", heightPx: 2339, sizeBytes: 900_000, widthPx: 1654 }],
    pageWidthPt: 595.28,
    ...over,
  };
}

/**
 * A CUSTOM DOCUMENT IS A STRING THAT CANNOT COLLIDE WITH A BUILT-IN ONE, and the whole widening of
 * the document type rests on that. If `custom:<uuid>` could ever equal one of the ten, a company
 * template would silently take over a government form's field rules, its copy count and its
 * renderer.
 */
function testACustomDocumentCannotCollideWithABuiltIn() {
  const document = customDocumentFor(KEY);
  assert.equal(document, `${CUSTOM_DOCUMENT_PREFIX}${KEY}`);
  assert.equal(customTemplateKeyOf(document), KEY);
  assert.ok(isCustomDocument(document));
  assert.ok(!isBuiltInDocument(document));

  // No built-in contains a colon, so the prefix can never be reached from the other direction.
  for (const builtIn of HIRING_PACK_DOCUMENTS) {
    assert.ok(!builtIn.includes(":"), `${builtIn}: a built-in key must not contain a colon`);
    assert.ok(!isCustomDocument(builtIn), `${builtIn}: a built-in is not a company template`);
    assert.ok(isBuiltInDocument(builtIn));
    assert.equal(customTemplateKeyOf(builtIn), null);
  }
}

/**
 * The key is VALIDATED, not merely split off the prefix.
 *
 * The value that comes back is about to be used to look up a row. A caller's alternative to a null
 * here is a query built out of whatever followed the colon.
 */
function testAMalformedCustomKeyIsRefusedRatherThanTrusted() {
  assert.equal(customTemplateKeyOf("custom:"), null);
  assert.equal(customTemplateKeyOf("custom:not-a-uuid"), null);
  assert.equal(customTemplateKeyOf("custom:f72a4c1d-dbb8-45f3-a4fb"), null, "a truncated uuid is not a key");
  assert.equal(customTemplateKeyOf(`custom:${KEY} or 1=1`), null, "trailing text is not a key");
  assert.equal(customTemplateKeyOf(`prefix-custom:${KEY}`), null, "the prefix must start the string");
  // Upper case is the same uuid — Postgres writes them lower, but a hand-typed one is still valid.
  assert.equal(customTemplateKeyOf(`custom:${KEY.toUpperCase()}`), KEY.toUpperCase());
}

/** A well-formed upload survives the gate with its numbers intact. */
function testAWellFormedTemplateIsAccepted() {
  const parsed = parseCustomTemplateDraft(draft({ nameAr: "  استمارة  ", note: "  " }));
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.message);
  assert.equal(parsed.value.name, "Medical insurance enrolment");
  assert.equal(parsed.value.nameAr, "استمارة", "an Arabic name is trimmed, not dropped");
  assert.equal(parsed.value.note, null, "a note of only spaces is no note");
  assert.equal(parsed.value.pageWidthPt, 595.28);
  assert.equal(parsed.value.pages.length, 1);
  assert.equal(parsed.value.printableByRoles, null, "no role list means no extra restriction");
}

/**
 * A PAGE SIZE IN PIXELS IS THE MISTAKE THIS CATCHES, and it is not a hypothetical one: an A4 page
 * scanned at 300dpi is 2480 × 3508, and those two numbers land in a width and height box as
 * naturally as 595 × 842 do. Accepting them would make a template whose every coordinate is out by
 * a factor of four — which looks like a broken renderer, not like a typo.
 */
function testAPageMeasuredInPixelsIsRefused() {
  const pixels = parseCustomTemplateDraft(draft({ pageHeightPt: 3508, pageWidthPt: 2480 }));
  assert.ok(!pixels.ok, "an A4 page in pixels must not be accepted as points");
  assert.match(pixels.message, /points/);

  const tiny = parseCustomTemplateDraft(draft({ pageHeightPt: 20, pageWidthPt: 20 }));
  assert.ok(!tiny.ok, "a page smaller than an inch is not a page");

  // THE ONE A BOUND CANNOT CATCH. An A4 page at 200dpi is 1654 × 2339, which is a perfectly
  // plausible large sheet of paper — no range check separates it from a real one. What gives it
  // away is that the declared page size EQUALS the artwork's pixel count, which is only true at
  // screen resolution. That is what `looksLikePixels` is for, and it is the reason this test
  // exists rather than a bounds test alone.
  const at200dpi = parseCustomTemplateDraft(
    draft({
      pageHeightPt: 2339,
      pages: [{ contentType: "image/png", heightPx: 2339, sizeBytes: 900_000, widthPx: 1654 }],
      pageWidthPt: 1654,
    }),
  );
  assert.ok(!at200dpi.ok, "a page size equal to the artwork's pixel size must be refused");
  assert.match(at200dpi.message, /1654 × 2339/, "the refusal shows the numbers it is objecting to");
  assert.match(at200dpi.message, /595 × 842|200 dpi/, "and says what to do instead");

  // A real large-format page whose artwork is at a real print resolution is NOT refused — the
  // detector must not become a second, accidental size limit.
  assert.ok(
    parseCustomTemplateDraft(
      draft({
        pageHeightPt: 2384,
        pages: [{ contentType: "image/png", heightPx: 3311, sizeBytes: 900_000, widthPx: 2339 }],
        pageWidthPt: 1684,
      }),
    ).ok,
    "an A1 sheet with 100dpi artwork is a real template",
  );

  // Exactly on the bounds is inside them.
  assert.ok(
    parseCustomTemplateDraft(draft({ pageHeightPt: CUSTOM_TEMPLATE_MAX_PT, pageWidthPt: CUSTOM_TEMPLATE_MIN_PT })).ok,
    "the bounds themselves are allowed",
  );
}

/** Every refusal is a sentence somebody holding a scanner can act on. */
function testEveryRefusalNamesWhatToDo() {
  const cases: { input: Record<string, unknown>; expect: RegExp }[] = [
    { expect: /name/i, input: draft({ name: "   " }) },
    { expect: /at least one page/i, input: draft({ pages: [] }) },
    { expect: /page size|width|height/i, input: draft({ pageWidthPt: "not a number" }) },
    {
      expect: /PNG, JPG, WEBP or SVG/i,
      input: draft({ pages: [{ contentType: "application/pdf", heightPx: 10, sizeBytes: 10, widthPx: 10 }] }),
    },
    {
      expect: /15 MB/i,
      input: draft({
        pages: [
          {
            contentType: "image/png",
            heightPx: 10,
            sizeBytes: CUSTOM_TEMPLATE_MAX_PAGE_BYTES + 1,
            widthPx: 10,
          },
        ],
      }),
    },
    {
      expect: new RegExp(String(CUSTOM_TEMPLATE_MAX_PAGES)),
      input: draft({
        pages: Array.from({ length: CUSTOM_TEMPLATE_MAX_PAGES + 1 }, () => ({
          contentType: "image/png",
          heightPx: 10,
          sizeBytes: 10,
          widthPx: 10,
        })),
      }),
    },
  ];

  for (const entry of cases) {
    const parsed = parseCustomTemplateDraft(entry.input);
    assert.ok(!parsed.ok, `expected a refusal for ${JSON.stringify(entry.input.name ?? entry.input)}`);
    assert.match(parsed.message, entry.expect);
    // A message ending in a constraint name, an error code or a bare noun is not an instruction.
    assert.ok(parsed.message.length > 12, "a refusal must say something");
  }
}

/**
 * THE PAGE INDEX COMES FROM THE ARRAY POSITION, never from the payload.
 *
 * A client sending `pageIndex: 0` twice would otherwise insert two rows colliding on the table's
 * `(template_id, page_index)` unique constraint — a 23505 raised halfway through an upload, with
 * the first page's object already in the bucket.
 */
function testPageOrderComesFromThePositionNotThePayload() {
  const parsed = parseCustomTemplateDraft(
    draft({
      pages: [
        { contentType: "image/png", heightPx: 20, pageIndex: 7, sizeBytes: 10, widthPx: 10 },
        { contentType: "image/jpeg", heightPx: 20, pageIndex: 7, sizeBytes: 10, widthPx: 10 },
      ],
    }),
  );
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.message);
  assert.deepEqual(
    parsed.value.pages.map((page) => page.pageIndex),
    [0, 1],
  );
}

/**
 * NULL AND AN EMPTY LIST ARE DIFFERENT ANSWERS.
 *
 * Null is "no extra restriction beyond the printing permission" — the default. An empty list is
 * "nobody", which is a real thing to want for a template being prepared before it is ready. Folding
 * one into the other would silently publish a draft.
 */
function testNobodyAndEveryoneAreNotTheSameAnswer() {
  assert.equal(parseCustomTemplateDraft(draft()).ok && parseCustomTemplateDraft(draft()).ok, true);

  const absent = parseCustomTemplateDraft(draft());
  assert.ok(absent.ok);
  assert.equal(absent.value.printableByRoles, null);

  const nobody = parseCustomTemplateDraft(draft({ printableByRoles: [] }));
  assert.ok(nobody.ok);
  assert.deepEqual(nobody.value.printableByRoles, [], "an empty list means nobody, and stays empty");

  const someone = parseCustomTemplateDraft(
    draft({ printableByRoles: ["Super Admin", " HR Operations ", "Super Admin"] }),
  );
  assert.ok(someone.ok);
  assert.deepEqual(
    someone.value.printableByRoles,
    ["Super Admin", "HR Operations"],
    "roles are trimmed and de-duplicated",
  );
}

/**
 * A page's storage path is unique, and carries the version.
 *
 * REPLACING A TEMPLATE MUST WRITE BESIDE THE OLD ARTWORK, never over it — a superseded version stays
 * printable, and it cannot stay printable if its pages were overwritten by the ones that replaced
 * them. The version segment is what guarantees that, and the random segment is what lets
 * `storage_path` carry a UNIQUE constraint.
 */
function testArtworkPathsNeverCollideAcrossVersions() {
  const v1 = buildCustomTemplatePagePath({
    contentType: "image/png",
    pageIndex: 0,
    templateKey: KEY,
    unique: "aaaaaaaa",
    version: 1,
  });
  const v2 = buildCustomTemplatePagePath({
    contentType: "image/png",
    pageIndex: 0,
    templateKey: KEY,
    unique: "bbbbbbbb",
    version: 2,
  });

  assert.equal(v1, `${KEY}/v1/00-aaaaaaaa.png`);
  assert.notEqual(v1, v2, "a new version writes to a new path");
  assert.ok(v2.startsWith(`${KEY}/v2/`), "the version is in the path, so the old objects survive");

  // The extension follows the content type, so a JPEG is not filed as a .png.
  assert.match(
    buildCustomTemplatePagePath({
      contentType: "image/jpeg",
      pageIndex: 11,
      templateKey: KEY,
      unique: "c",
      version: 1,
    }),
    /\/11-c\.jpg$/,
  );

  // A path segment can never be built out of unsanitised text: everything but letters, digits and a
  // hyphen is stripped from the caller's unique segment.
  assert.equal(
    buildCustomTemplatePagePath({
      contentType: "image/png",
      pageIndex: 0,
      templateKey: KEY,
      unique: "../../etc/passwd",
      version: 1,
    }),
    `${KEY}/v1/00-etcpasswd.png`,
  );
}

/** Every content type this accepts is one the bucket accepts. Both lists, one meaning. */
function testTheAcceptedTypesMatchTheBucket() {
  assert.deepEqual(
    [...CUSTOM_TEMPLATE_CONTENT_TYPES].sort(),
    ["image/jpeg", "image/png", "image/svg+xml", "image/webp"],
    "these are the migration's allowed_mime_types, in one place",
  );
  assert.ok(
    !(CUSTOM_TEMPLATE_CONTENT_TYPES as readonly string[]).includes("application/pdf"),
    "a PDF is rasterised in the browser and never stored as one",
  );
}

/** A page size is recognised as a named one within half a point, and honestly named otherwise. */
function testAPresetIsRecognisedWithoutBeingExact() {
  assert.equal(pagePresetFor(595.28, 841.89), "a4");
  assert.equal(pagePresetFor(595.32, 841.92), "a4", "Word's own A4 is still A4");
  assert.equal(pagePresetFor(612, 792), "letter");
  assert.equal(pagePresetFor(612, 1008), "legal");
  // Form 1's real artwork measures 612.12 × 1008.12, and that IS US Legal: 0.12pt is four
  // hundredths of a millimetre, an artefact of measuring the Authority's scan rather than a
  // different sheet of paper. Refusing to name it would be precision standing in for accuracy.
  assert.equal(pagePresetFor(612.12, 1008.12), "legal");

  // A size that really is none of them says so, rather than being rounded into the nearest.
  assert.equal(pagePresetFor(600, 900), null);
  assert.equal(pagePresetFor(612, 1010), null, "two points is a different page, not a rounding");
  assert.equal(roundPoints(841.8898), 841.89);
}

/**
 * THE TABLES MAY NOT EXIST YET, because applying the migration is the owner's decision and the code
 * ships first. A missing table answers `PGRST205`, not `42P01` — PostgREST resolves through its
 * schema cache and reports a cache miss — so the obvious guard fires never and the screen 500s.
 */
function testAMissingTemplateTableIsRecognised() {
  assert.ok(isCustomTemplateLayerMissing({ code: "PGRST205" }));
  assert.ok(isCustomTemplateLayerMissing({ code: "42P01" }));
  assert.ok(
    isCustomTemplateLayerMissing({
      message: "Could not find the table 'public.hiring_pack_custom_templates' in the schema cache",
    }),
  );
  assert.ok(!isCustomTemplateLayerMissing({ code: "23505", message: "duplicate key value" }));
  assert.ok(!isCustomTemplateLayerMissing(null));
  assert.ok(!isCustomTemplateLayerMissing("boom"), "a string is not a PostgREST error");
}

export async function runHiringPackCustomTemplateTests() {
  testACustomDocumentCannotCollideWithABuiltIn();
  testAMalformedCustomKeyIsRefusedRatherThanTrusted();
  testAWellFormedTemplateIsAccepted();
  testAPageMeasuredInPixelsIsRefused();
  testEveryRefusalNamesWhatToDo();
  testPageOrderComesFromThePositionNotThePayload();
  testNobodyAndEveryoneAreNotTheSameAnswer();
  testArtworkPathsNeverCollideAcrossVersions();
  testTheAcceptedTypesMatchTheBucket();
  testAPresetIsRecognisedWithoutBeingExact();
  testAMissingTemplateTableIsRecognised();
}

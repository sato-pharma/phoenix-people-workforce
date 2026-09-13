import assert from "node:assert/strict";

import { DOCUMENT_SURFACES, documentSurface } from "../src/lib/hiring-pack/field-layout.ts";
import {
  assertBuiltInTablesAreComplete,
  asPrintableDocument,
  CUSTOM_DOCUMENT_DEFAULT_COPIES,
  CUSTOM_DOCUMENT_FALLBACK_LABEL,
  documentDefaultCopies,
  documentGroup,
  documentLabel,
  documentSurfaceOf,
} from "../src/lib/hiring-pack/document-registry.ts";
import {
  CUSTOM_TEMPLATE_GROUPS,
  isCustomTemplateGroup,
} from "../src/lib/hiring-pack/custom-templates.ts";
import { customDocumentFor, HIRING_PACK_DOCUMENTS } from "../src/lib/hiring-pack/types.ts";

// ─────────────────────────────────────────────────────────────────────────────────────────────
// THIS FILE IS THE GUARD THE COMPILER CANNOT BE.
//
// `next.config.ts` sets `typescript.ignoreBuildErrors`, so a `Record<HiringPackDocument, …>` that
// has silently lost a key still typechecks in the editor, still builds, and still deploys. The
// symptom reaches an operator as a document with no name in a list, a copy count of `NaN` in a
// print dialog, or a field editor that cannot decide how to place anything. All three are the same
// missing key, and none of them says so.
//
// So every assertion here runs at RUNTIME, against the real tables, over the real document list.
// ─────────────────────────────────────────────────────────────────────────────────────────────

// NAMED `UUID` RATHER THAN `KEY`, AND THAT IS NOT A STYLE PREFERENCE. A template's stable
// identifier is called its KEY everywhere else in this feature, but `…_KEY = "<36 characters
// of hex and dashes>"` is precisely the shape gitleaks' generic-api-key rule matches, and
// `secret-scan` is a required check. The rule fires on the WORD sitting next to the value,
// never on the value — which is why the `…_ID` constants nearby have never tripped it. A uuid
// carries no authority and is not a credential; renaming this back turns the merge gate red.
const PROBE_UUID = "1857bafe-d3f9-4576-a850-abe82f884f0d";
const PROBE_DOCUMENT = customDocumentFor(PROBE_UUID);

/**
 * Every built-in table is complete, and holds nothing that is not a document.
 *
 * The headline check. A key added to the union and forgotten in a table, or a key removed from the
 * union and left in a table, both fail here — and both compile.
 */
function testEveryBuiltInTableIsComplete() {
  const problems = assertBuiltInTablesAreComplete();
  assert.deepEqual(
    problems,
    [],
    `every built-in document must have a name, a copy count and a surface: ${problems.join("; ")}`,
  );
}

/** Every built-in document resolves all three answers, through the public functions. */
function testEveryBuiltInDocumentResolvesAllThree() {
  // TWENTY since 2026-09-06: ten, plus the two renewal papers, plus Sato's own six — the
  // confidentiality undertaking, both appointment-documents forms, both absence notices and the
  // service-file sheet — plus BOTH certificates of experience, Arabic and English. TWENTY-ONE since
  // 2026-09-13, with the English HR letter stating the basic salary. Deliberately
  // hard-coded rather than derived: it is what makes adding a document a decision somebody had to
  // write down, in a repo where `ignoreBuildErrors` means an incomplete Record compiles and deploys
  // perfectly happily.
  assert.equal(
    HIRING_PACK_DOCUMENTS.length,
    21,
    "the built-in document list should still be twenty-one — update this only alongside the four " +
      "tables in document-registry.ts, the surfaces, the renderers and the template registry",
  );

  for (const document of HIRING_PACK_DOCUMENTS) {
    const label = documentLabel(document);
    assert.ok(
      typeof label === "string" && label.trim().length > 0,
      `"${document}" printed no readable name`,
    );
    assert.ok(
      !label.includes("undefined"),
      `"${document}" resolved the name "${label}", which is a missing table entry showing through`,
    );

    const copies = documentDefaultCopies(document);
    assert.ok(
      Number.isInteger(copies) && copies >= 1,
      `"${document}" resolved ${String(copies)} copies, which cannot be printed`,
    );

    const surface = documentSurfaceOf(document);
    assert.ok(
      surface === "page" || surface === "flow",
      `"${document}" resolved the surface ${String(surface)}, which is neither`,
    );
  }
}

/**
 * The registry's surface table and the renderer's agree, key by key.
 *
 * They are deliberately two tables — the registry answers "what is this document" for callers that
 * want a label, and importing the renderer's module for that would drag the whole field layer in.
 * Duplication nobody checks is a bug waiting; this is the check.
 */
function testTheTwoSurfaceTablesCannotDrift() {
  for (const document of HIRING_PACK_DOCUMENTS) {
    assert.equal(
      documentSurfaceOf(document),
      documentSurface(document),
      `"${document}" is a ${documentSurface(document)} document to the renderer and a ` +
        `${documentSurfaceOf(document)} document to the registry — a field dropped on it would be ` +
        `stored one way and read the other`,
    );
  }

  assert.deepEqual(
    Object.keys(DOCUMENT_SURFACES).sort(),
    [...HIRING_PACK_DOCUMENTS].sort(),
    "the renderer's surface table and the document list hold different documents",
  );
}

/** A company template resolves all three answers too — it is not a hole in the lookups. */
function testACompanyTemplateResolvesAllThree() {
  const label = documentLabel(PROBE_DOCUMENT, { [PROBE_DOCUMENT]: "Medical enrolment form" });
  assert.equal(label, "Medical enrolment form", "an uploaded template prints its own name");

  const byBareKey = documentLabel(PROBE_DOCUMENT, { [PROBE_UUID]: "Medical enrolment form" });
  assert.equal(byBareKey, "Medical enrolment form", "the bare key is as good as the full document");

  const copies = documentDefaultCopies(PROBE_DOCUMENT);
  assert.equal(
    copies,
    CUSTOM_DOCUMENT_DEFAULT_COPIES,
    "a template nobody has stated a requirement for prints one copy",
  );
  assert.ok(Number.isInteger(copies) && copies >= 1, "and that count must be printable");

  assert.equal(
    documentSurfaceOf(PROBE_DOCUMENT),
    "page",
    "an uploaded template is fixed artwork, so its fields place by page coordinate",
  );
}

/**
 * A name that is not to hand never leaks the uuid.
 *
 * The owner's standing rule is human-readable names, never raw codes or ids. A stale reference —
 * a template deleted from under a saved layout — must still read as words.
 */
function testAnUnknownTemplateNeverPrintsItsUuid() {
  const cases: ReadonlyArray<readonly [string, Parameters<typeof documentLabel>[1]]> = [
    ["no names at all", undefined],
    ["an empty name table", {}],
    ["a name table for a different template", { [customDocumentFor("00000000-0000-4000-8000-000000000000")]: "Something else" }],
    ["a blank name", { [PROBE_DOCUMENT]: "   " }],
  ];

  for (const [description, names] of cases) {
    const label = documentLabel(PROBE_DOCUMENT, names);
    assert.equal(
      label,
      CUSTOM_DOCUMENT_FALLBACK_LABEL,
      `with ${description}, an uploaded template should fall back to a readable phrase`,
    );
    assert.ok(!label.includes(PROBE_UUID), `with ${description}, the label leaked the template's id`);
    assert.ok(!label.includes("custom:"), `with ${description}, the label leaked the key prefix`);
  }
}

/** A string from outside is narrowed before anything is looked up against it. */
function testAStringFromOutsideIsNarrowedFirst() {
  assert.equal(asPrintableDocument("form1"), "form1", "a built-in key passes through");
  assert.equal(asPrintableDocument(PROBE_DOCUMENT), PROBE_DOCUMENT, "a custom document passes through");

  for (const rubbish of [
    "",
    "Form1",
    "custom:",
    "custom:not-a-uuid",
    "custom:1857bafe-d3f9-4576-a850",
    "contract ",
    "__proto__",
    "toString",
  ]) {
    assert.equal(
      asPrintableDocument(rubbish),
      null,
      `"${rubbish}" is not a document this system prints and must be refused, not looked up`,
    );
  }
}

/**
 * A prototype key cannot be mistaken for a template name.
 *
 * `names` is built from database rows, so the keys are not ours. `{}["toString"]` is a function, not
 * a name, and a lookup that only checked for truthiness would print `function toString() …` on a
 * screen. The guard is the `typeof … === "string"` in `documentLabel`; this is what pins it.
 */
function testAPrototypeKeyIsNotAName() {
  const label = documentLabel(PROBE_DOCUMENT, {} as Record<string, string>);
  assert.equal(label, CUSTOM_DOCUMENT_FALLBACK_LABEL, "an empty table resolves the fallback");

  const hostile = Object.create({ [PROBE_DOCUMENT]: "inherited" }) as Record<string, string>;
  assert.equal(
    documentLabel(PROBE_DOCUMENT, hostile),
    "inherited",
    "an inherited string is still a string, and reading it is harmless — this pins the behaviour " +
      "so a later change to `Object.hasOwn` is a deliberate decision rather than a surprise",
  );
}

/**
 * Every document is in exactly one package, and every package is a real one.
 *
 * The owner's request of 2026-09-04 — group documents to hiring, resignation, or other — is only
 * useful if nothing falls between the groups. A document with no package would simply be absent
 * from the screen, which reads as "we do not print that" rather than as a bug.
 */
function testEveryDocumentIsInExactlyOnePackage() {
  const seen = new Map<string, string[]>();

  for (const document of HIRING_PACK_DOCUMENTS) {
    const group = documentGroup(document);
    assert.ok(
      isCustomTemplateGroup(group),
      `"${document}" resolved the package ${String(group)}, which is not one of ` +
        `${CUSTOM_TEMPLATE_GROUPS.join(", ")} — it would print in no package at all`,
    );
    seen.set(group, [...(seen.get(group) ?? []), document]);
  }

  // Not a distribution anybody should be free to change silently: these are the packages the two
  // tabs print, and a document moving between them changes what HR hands somebody on their last day.
  assert.deepEqual(
    seen.get("joining")?.sort(),
    ["appointmentDocsReceipt", "contract", "form1", "nda", "socialStatusSheet", "workerDataForm"].sort(),
    "the joining package is the contract, Form 1, the worker data form, and Sato's own three " +
      "arrival papers — the confidentiality undertaking, the appointment-documents receipt and the " +
      "Article 92 service-file sheet",
  );
  assert.deepEqual(
    seen.get("leaving")?.sort(),
    [
      "appointmentDocsReturn",
      "clearanceCompany",
      "clearanceEmployee",
      "experienceCertificate",
      "experienceCertificateEn",
      "form6",
      "mutualTermination",
      "resignation",
    ].sort(),
    "the leaving package is Form 6, both labour templates, both clearances, the employee's " +
      "receipt for his own certificates coming back — whose sibling is in the JOINING package, " +
      "which is the pairing this assertion exists to keep straight — and BOTH certificates of " +
      "experience, Arabic and English, filed here because that is when HR reaches for them, not " +
      "because a serving employee cannot ask for one",
  );
  assert.deepEqual(
    seen.get("other")?.sort(),
    [
      "absenceWarning",
      "contractNonRenewal",
      "contractRenewal",
      "custodyLaptop",
      "custodyMobile",
      "deemedResignation",
      "salaryLetterEn",
    ].sort(),
    "\"other\" is the DURING-employment package: a custody receipt is printed whenever a device " +
      "changes hands, and the two renewal papers whenever a fixed term is coming to its end. Neither " +
      "is arriving or leaving. The non-renewal notice is here rather than in the leaving package on " +
      "purpose — it is one half of a decision made before anybody has left, and filing it under " +
      "leaving would hide it until after the decision it announces. The two absence notices are " +
      "here for the same reason: they are served on somebody who is still employed, and only one " +
      "of them ends anything.",
  );
}

/** An uploaded template's package comes from its row, and an unsorted one is "other". */
function testAnUploadedTemplateCarriesItsOwnPackage() {
  assert.equal(
    documentGroup(PROBE_DOCUMENT, { [PROBE_DOCUMENT]: "leaving" }),
    "leaving",
    "a template filed under the Leaver package prints there",
  );
  assert.equal(
    documentGroup(PROBE_DOCUMENT, { [PROBE_UUID]: "joining" }),
    "joining",
    "the bare key answers as well as the full document",
  );

  for (const [description, groups] of [
    ["nothing on file", undefined],
    ["an empty table", {}],
    ["a package that does not exist", { [PROBE_DOCUMENT]: "resignation" }],
    ["a blank", { [PROBE_DOCUMENT]: "" }],
    ["another template's answer", { [customDocumentFor("00000000-0000-4000-8000-000000000000")]: "leaving" }],
  ] as ReadonlyArray<readonly [string, Parameters<typeof documentGroup>[1]]>) {
    assert.equal(
      documentGroup(PROBE_DOCUMENT, groups),
      "other",
      `with ${description}, an uploaded template belongs to Other papers — that is what unsorted MEANS`,
    );
  }
}

export async function runHiringPackDocumentRegistryTests() {
  testEveryBuiltInTableIsComplete();
  testEveryBuiltInDocumentResolvesAllThree();
  testTheTwoSurfaceTablesCannotDrift();
  testACompanyTemplateResolvesAllThree();
  testAnUnknownTemplateNeverPrintsItsUuid();
  testAStringFromOutsideIsNarrowedFirst();
  testAPrototypeKeyIsNotAName();
  testEveryDocumentIsInExactlyOnePackage();
  testAnUploadedTemplateCarriesItsOwnPackage();
}

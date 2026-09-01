import { strict as assert } from "node:assert";

import { renderWorkerFormHtml } from "../src/lib/hiring-pack/render-worker-form.ts";
import {
  collectHiringPackGaps,
  emptyOffboardingProfile,
  resolveContractTerms,
} from "../src/lib/hiring-pack/service.ts";
import {
  currentTemplateVersion,
  findTemplateVersion,
} from "../src/lib/hiring-pack/template-registry.ts";
import {
  HIRING_PACK_DOCUMENTS,
  ONBOARDING_FORM_DOCUMENTS,
  SIGNABLE_DOCUMENTS,
  isSignableDocument,
} from "../src/lib/hiring-pack/types.ts";
import type {
  HiringPackData,
  HiringPackEmployeeFacts,
  HiringPackProfile,
  OffboardingProfile,
} from "../src/lib/hiring-pack/types.ts";
import { WORKER_FORM_TEMPLATE_V1 } from "../src/lib/hiring-pack/worker-form-text.ts";

/**
 * THE WORKER-DATA FORM — استمارة بيانات العامل.
 *
 * The second paper the owner added to the hiring pack on 2026-09-01: a service-file intake sheet,
 * filled on the day of hire and kept in the personnel file. It reuses the contract's plumbing (HTML
 * printed by the browser so Arabic lays out correctly) and its banded look, but it is a FORM, not a
 * contract — a grid of labelled fields, filled from its own value bag.
 *
 * Every way of getting it wrong prints a form that looks right and gets filed:
 *
 *   - Let a Latin or numeric value — the national id, the phone, the insurance number — reorder under
 *     the bidirectional algorithm and the number in the drawer is not the number on the person. This
 *     company has already printed its own tax card `477-108-318` as `318-108-477`. Every such value
 *     sits in a cell pinned `dir="ltr"`, and the registry numbers in the company block are pinned
 *     with isolates — this test proves both, so a later edit that drops the pinning goes red here.
 *   - Fill a field Phoenix has no record of — marital status, military position, bank and IBAN, next
 *     of kin — and the paper asserts a fact nobody supplied. Those fields print a dotted rule for a
 *     pen ON PURPOSE; a test has to say so, or the next session reads the eight blanks as an
 *     oversight and "fixes" them into tokens that resolve to nothing.
 *   - Record a signed date against the person and the app grows a half-truth. The form carries a
 *     signature but is filed, not tracked — `isSignableDocument` must stay false for it, exactly as
 *     for the custody receipts, which is why adding it needed no migration.
 *   - Leave a `{{TOKEN}}` unsubstituted, or stamp a `data-hp-key` the paper editor cannot honour, and
 *     the form prints a marker or offers an edit that goes nowhere.
 */

// ---------------------------------------------------------------------------------------------
// Fixtures — the same shape the custody and clearance suites use, so one hire drives every paper.
// ---------------------------------------------------------------------------------------------

function employeeFixture(
  overrides: Partial<HiringPackEmployeeFacts> = {},
): HiringPackEmployeeFacts {
  return {
    hrId: "H-3003",
    fullName: "Nour Adel",
    nameAr: "نور عادل",
    nationalId: "29709091234567",
    socialInsuranceNumber: "123456789",
    socialInsuranceWage: 6000,
    baseSalary: 11000,
    grossSalary: 14300,
    birthDate: "1997-09-09",
    hireDate: "2026-08-01",
    jobTitle: "Medical Representative",
    departmentAr: "المبيعات",
    departmentId: 1,
    lineId: 1,
    residenceAddress: "5 شارع الجمهورية، وسط البلد",
    residenceCity: "القاهرة",
    mobileNumber: "01200000000",
    workEmail: "nour@example.com",
    employmentStatus: "active",
    lastWorkingDate: null,
    departed: false,
    ...overrides,
  };
}

function profileFixture(overrides: Partial<HiringPackProfile> = {}): HiringPackProfile {
  return {
    hrId: "H-3003",
    nationality: "مصرية",
    qualification: "بكالوريوس صيدلة",
    birthPlace: "القاهرة",
    jobTitleAr: "مندوب دعاية طبية",
    occupationCode: "123456",
    insuranceOffice: "وسط البلد",
    addressBuilding: "05",
    addressDistrict: "01",
    addressStreet: "شارع الجمهورية",
    addressMarkaz: "02",
    addressGovernorate: "01",
    contractDurationMonths: 12,
    contractStartDate: "2026-08-01",
    contractEndDate: "2027-07-31",
    underperformanceThresholdPct: 70,
    underperformanceMonths: 3,
    trainingBondMonths: 12,
    notes: null,
    contractSignedDate: null,
    form1SignedDate: null,
    contractPrintedAt: null,
    form1PrintedAt: null,
    contractTemplateVersion: null,
    updatedAt: null,
    ...overrides,
  };
}

function offboardingFixture(): OffboardingProfile {
  return emptyOffboardingProfile("H-3003");
}

function packFixture(
  employeeOverrides: Partial<HiringPackEmployeeFacts> = {},
  profileOverrides: Partial<HiringPackProfile> = {},
): HiringPackData {
  const employee = employeeFixture(employeeOverrides);
  const profile = profileFixture(profileOverrides);
  const offboarding = offboardingFixture();
  return {
    employee,
    profile,
    offboarding,
    exit: null,
    suggestedJobTitleAr: null,
    gaps: collectHiringPackGaps(employee, profile, offboarding, null),
    terms: resolveContractTerms(employee, profile, offboarding, null),
  };
}

/** Every `<article class="copy">` on the page — one per printed copy. */
function copyCount(html: string): number {
  return html.split('<article class="copy').length - 1;
}

// ---------------------------------------------------------------------------------------------
// It fills what Phoenix already knows
// ---------------------------------------------------------------------------------------------

function testTheFormFillsWhatPhoenixKnows(): void {
  const html = renderWorkerFormHtml(packFixture(), 1);

  // The name Phoenix holds in Arabic, on the amber highlight the source uses for a filled value —
  // once in the personal section, once again on the worker's signature row.
  assert.equal(
    (html.match(/<span class="wf-fill">نور عادل<\/span>/g) ?? []).length,
    2,
    "the Arabic name should fill both the personal-data cell and the worker's signature row",
  );

  // A value Phoenix knows fills; the amber highlight tells the reader which words the company typed.
  for (const filled of ["بكالوريوس صيدلة", "مندوب دعاية طبية", "المبيعات"]) {
    assert.ok(
      html.includes(`<span class="wf-fill">${filled}</span>`),
      `a known Arabic value must print as a filled cell, not a blank: ${filled}`,
    );
  }

  // An Arabic value is NOT dragged into a left-to-right cell — that reordering is only for Latin and
  // numeric runs. The nationality stays in a plain right-to-left value span.
  assert.ok(
    html.includes('<span class="wf-value"><span class="wf-fill">مصرية</span></span>'),
    "an Arabic value must render right-to-left, not pinned dir=ltr",
  );
}

// ---------------------------------------------------------------------------------------------
// It leaves for a pen exactly what it does not know
// ---------------------------------------------------------------------------------------------

function testUnknownFieldsPrintTheDottedRule(): void {
  const html = renderWorkerFormHtml(packFixture(), 1);

  // The bank field is one Phoenix holds no record of. It must print the dotted rule, not a token and
  // not an empty cell that reads as "nothing to fill".
  assert.match(
    html,
    /البنك والفرع<\/span>\s*<span class="wf-value"><span class="wf-fill wf-fill--blank">/,
    "a field Phoenix cannot fill must print the dotted rule for a pen",
  );

  // There are exactly eight such fields on the form — marital status, military position, the
  // line/geography, and the four pay-and-emergency fields (bank, account holder, IBAN, next of kin,
  // relation). Every known field is filled by this fixture, so a count above eight means a value
  // Phoenix does know silently printed blank, and below eight means a hand-filled field grew a token.
  const blanks = (html.match(/<span class="wf-fill wf-fill--blank">/g) ?? []).length;
  assert.equal(
    blanks,
    8,
    `expected the eight always-blank fields to print a dotted rule, saw ${blanks} — ` +
      "a different count means a known value blanked, or a blank field grew a token",
  );
}

// ---------------------------------------------------------------------------------------------
// Latin and numeric values are arranged left to right
// ---------------------------------------------------------------------------------------------

function testLatinAndNumericValuesAreArrangedLeftToRight(): void {
  const html = renderWorkerFormHtml(packFixture(), 1);

  // Each of these carries digits or Latin letters that would reorder inside an Arabic cell. Every one
  // sits in a value span the renderer marks `wf-value--ltr` and `dir="ltr"`, with the value straight
  // after — so the number in the drawer reads the way it reads on the card.
  const ltrValues: Array<[string, RegExp]> = [
    ["national id", /wf-value--ltr" dir="ltr"><span class="wf-fill">29709091234567<\/span>/],
    ["mobile number", /wf-value--ltr" dir="ltr"><span class="wf-fill">01200000000<\/span>/],
    ["work email", /wf-value--ltr" dir="ltr"><span class="wf-fill">nour@example\.com<\/span>/],
    ["insurance number", /wf-value--ltr" dir="ltr"><span class="wf-fill">123456789<\/span>/],
    ["employee number", /wf-value--ltr" dir="ltr"><span class="wf-fill">H-3003<\/span>/],
  ];
  for (const [label, pattern] of ltrValues) {
    assert.match(html, pattern, `${label} must sit in a dir=ltr cell so its digits do not reorder`);
  }

  // The hire date is pinned too; its exact day/month/year format is the renderer's business, but it
  // must land in the left-to-right cell carrying the year.
  assert.match(
    html,
    /wf-value--ltr" dir="ltr"><span class="wf-fill">[^<]*2026[^<]*<\/span>/,
    "the hire date must sit in a dir=ltr cell",
  );

  // The company registry numbers sit inside an Arabic sentence and are pinned with directional
  // isolates (U+2066 … U+2069), exactly as the contract recital pins them.
  assert.ok(
    html.includes("⁦"),
    "the company registry numbers must be pinned left-to-right with isolate characters",
  );
}

// ---------------------------------------------------------------------------------------------
// Nothing that belongs in the code reaches the paper
// ---------------------------------------------------------------------------------------------

function testNoTokenAndNoEditorKeyReachThePaper(): void {
  const html = renderWorkerFormHtml(packFixture(), 1);

  assert.doesNotMatch(
    html,
    /\{\{[A-Z_]+\}\}/,
    "every {{TOKEN}} in the company block and footer must be substituted before it prints",
  );

  // Unlike the contract, the worker form carries no paper-editor keys: the editor is keyed on the
  // contract's tokens, and a key it does not recognise would offer an edit that goes nowhere.
  assert.ok(
    !html.includes("data-hp-key"),
    "the worker form must carry no data-hp-key — its fields are not paper-editable",
  );
}

// ---------------------------------------------------------------------------------------------
// It prints the copies asked for, and never zero
// ---------------------------------------------------------------------------------------------

function testItPrintsTheRequestedCopies(): void {
  assert.equal(copyCount(renderWorkerFormHtml(packFixture(), 3)), 3, "three copies means three");
  assert.equal(
    copyCount(renderWorkerFormHtml(packFixture(), 0)),
    1,
    "a zero count still prints one copy — a form filed with none is a form that was not filed",
  );
}

// ---------------------------------------------------------------------------------------------
// It carries its transcribed text, whole
// ---------------------------------------------------------------------------------------------

function testItCarriesItsTranscribedText(): void {
  const html = renderWorkerFormHtml(packFixture(), 1);

  assert.ok(html.startsWith("<!doctype html>"), "the form is a full printable HTML document");
  assert.ok(html.includes('dir="rtl"'), "the document is right-to-left");

  assert.ok(
    html.includes("<title>استمارة بيانات العامل — نور عادل</title>"),
    "the browser tab names the form and the person it is for",
  );
  assert.ok(
    html.includes("تُستوفى يوم التعيين وتُحفظ بملف الخدمة · لا تُرفق بصور العقد"),
    "the instruction note under the masthead must print verbatim",
  );

  // Every data section heading, in order, plus the worker's declaration.
  for (const heading of [
    "أولًا — البيانات الشخصية",
    "ثانيًا — بيانات الاتصال والعنوان",
    "ثالثًا — البيانات الوظيفية والتأمينية",
    "رابعًا — بيانات صرف الأجر وحالة الطوارئ",
    "خامسًا — إقرار العامل",
  ]) {
    assert.ok(html.includes(heading), `the section heading must print: ${heading}`);
  }

  // The declaration is transcribed whole, down to the data-protection law it names — not a stub.
  assert.ok(
    html.includes("أقر بأن البيانات المدونة أعلاه صحيحة"),
    "the worker's declaration must print",
  );
  assert.ok(
    html.includes("رقم 151 لسنة 2020"),
    "the declaration must keep the data-protection law it cites — proof it is the whole text",
  );
}

// ---------------------------------------------------------------------------------------------
// It is filed, not signature-tracked, and it is a registered document
// ---------------------------------------------------------------------------------------------

function testItIsFiledNotSigned(): void {
  // The form is part of the hiring pack and is the sole onboarding form.
  assert.ok(
    HIRING_PACK_DOCUMENTS.includes("workerDataForm"),
    "the worker form must be one of the hiring-pack documents",
  );
  assert.ok(
    ONBOARDING_FORM_DOCUMENTS.includes("workerDataForm"),
    "the worker form must be classed as an onboarding form",
  );

  // It carries a signature but records none against the person — like the custody receipts, and for
  // the same reason. Were it signable, the app would need a migration and a column for a date that
  // means nothing.
  assert.equal(
    isSignableDocument("workerDataForm"),
    false,
    "the worker form must not be signature-tracked — it is filed in a drawer",
  );
  assert.ok(
    !SIGNABLE_DOCUMENTS.includes("workerDataForm"),
    "the worker form must be absent from the signable set",
  );

  // Exactly one current registry version, and it is worker-form-v1.
  const current = currentTemplateVersion("workerDataForm");
  assert.equal(current.id, "worker-form-v1", "the current worker-form version is worker-form-v1");
  assert.equal(current.status, "current", "worker-form-v1 must be the current version");
  assert.equal(current.document, "workerDataForm", "the version must belong to the worker form");

  // The template constant the renderer prints from and the registry row must agree on identity and
  // version, or a reprint would resolve one thing and print another.
  assert.equal(WORKER_FORM_TEMPLATE_V1.id, "worker-form-v1", "the template's id must match its row");
  assert.equal(
    WORKER_FORM_TEMPLATE_V1.version,
    current.version,
    "the template and its registry row must agree on the version number",
  );
  const found = findTemplateVersion("worker-form-v1");
  assert.ok(found, "worker-form-v1 must resolve through the registry");
  assert.equal(found?.document, "workerDataForm", "the id must resolve to the worker form");
}

export function runHrFormsWorkerDataTests(): void {
  testTheFormFillsWhatPhoenixKnows();
  testUnknownFieldsPrintTheDottedRule();
  testLatinAndNumericValuesAreArrangedLeftToRight();
  testNoTokenAndNoEditorKeyReachThePaper();
  testItPrintsTheRequestedCopies();
  testItCarriesItsTranscribedText();
  testItIsFiledNotSigned();
}

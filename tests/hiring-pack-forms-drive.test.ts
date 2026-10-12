import assert from "node:assert/strict";

import { COMPANY_DETAILS_DEFAULT } from "../src/lib/hiring-pack/company-details.ts";
import {
  buildFormsDrive,
  candidatesForDocument,
  documentAudience,
  folderOfDocument,
  paperReferencePrintsOnFace,
} from "../src/lib/hiring-pack/forms-drive.ts";
import { insuranceWageFromBase } from "../src/lib/hiring-pack/insurance-wage.ts";
import {
  buildManualHiringPack,
  manualPaperInputs,
  manualSubjectName,
  sanitizeManualValues,
} from "../src/lib/hiring-pack/manual-pack.ts";
import { isPaperReference, stampPaperReference } from "../src/lib/hiring-pack/paper-reference.ts";
import {
  HIRING_PACK_DOCUMENTS,
  OFFICIAL_PACK_FORM_DOCUMENTS,
  type HiringPackCandidate,
} from "../src/lib/hiring-pack/types.ts";

// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE HR FORMS DRIVE (the owner, 2026-09-13): folders of papers, an employee list that follows the
// paper — "if i choose a document related to resignations the drop list of employees who resigned
// appear bec now this is a bug" — a paper typed in by hand, and a number on every print.
// ─────────────────────────────────────────────────────────────────────────────────────────────

const CUSTOM_OTHER = "custom:3f1c2a4e-1b2c-4d5e-8f90-123456789abc";
const CUSTOM_LEAVING = "custom:9a8b7c6d-5e4f-4a3b-9c2d-1e0f98765432";

function candidate(hrId: string, departed: boolean): HiringPackCandidate {
  return {
    departed,
    fullName: `Person ${hrId}`,
    hrId,
    jobTitle: "Medical Rep",
    lastWorkingDate: departed ? "2026-08-31" : null,
    nameAr: null,
  } as unknown as HiringPackCandidate;
}

function testEveryPaperIsInExactlyOneFolder() {
  const folders = buildFormsDrive();
  const seen = new Map<string, number>();
  for (const folder of folders) {
    for (const entry of folder.entries) seen.set(entry.document, (seen.get(entry.document) ?? 0) + 1);
  }
  for (const document of HIRING_PACK_DOCUMENTS) {
    assert.equal(seen.get(document), 1, `"${document}" must sit in exactly one folder`);
  }
  assert.equal(seen.size, HIRING_PACK_DOCUMENTS.length, "the drive holds nothing that is not a paper");
  assert.equal(folderOfDocument(folders, "form6")?.id, "leaving");
  assert.equal(folderOfDocument(folders, "contract")?.id, "joining");
  assert.equal(folderOfDocument(folders, "custodyLaptop")?.id, "devices");
  assert.deepEqual(folders.find((folder) => folder.id === "company")?.entries, []);
}

/** The owner's letters pack of 2026-09-13: every file in it has a folder, and a named one. */
function testTheLettersPackIsFiled() {
  const folders = buildFormsDrive();
  const documentsIn = (id: string) =>
    (folders.find((folder) => folder.id === id)?.entries ?? []).map((entry) => entry.document).sort();

  assert.deepEqual(
    documentsIn("decisions"),
    ["disciplinaryPenalty", "disciplinaryWarning", "salaryAdjustment", "transferDecision"],
  );
  assert.deepEqual(
    documentsIn("insurance"),
    [
      "carInsuranceCertificate",
      "healthInsuranceAuthorization",
      "insuranceForm2",
      "insurancePrintLetter",
      "maternityCompensation",
      "socialInsuranceAuthorization",
    ],
  );
  assert.deepEqual(
    documentsIn("labourOffice"),
    ["officialHolidaysSheet", "penaltiesSheet", "penaltyRegulationsApproval", "sickLeaveSheet", "wageProgressSheet"],
  );
  assert.equal(folderOfDocument(folders, "handoverRecord")?.id, "leaving");
  assert.equal(folderOfDocument(folders, "exitInterview")?.id, "leaving");

  // "governmental leave as is": nothing Phoenix writes lands on an office's form, and the company's
  // own papers carry their number like every other house paper.
  for (const document of OFFICIAL_PACK_FORM_DOCUMENTS) {
    assert.equal(paperReferencePrintsOnFace(document), false, `${document} prints as issued`);
  }
  assert.equal(paperReferencePrintsOnFace("disciplinaryWarning"), true);
  assert.equal(paperReferencePrintsOnFace("handoverRecord"), true);
}

function testUploadedTemplatesAreFiledByTheirPackage() {
  const folders = buildFormsDrive([
    { document: CUSTOM_OTHER, group: "other", id: "row-1", name: "Car allowance letter", status: "current" },
    { document: CUSTOM_LEAVING, group: "leaving", id: "row-2", name: "Handover minutes", status: "current" },
    { document: CUSTOM_LEAVING, group: "leaving", id: "row-0", name: "Handover minutes (old)", status: "archived" },
  ]);
  const company = folders.find((folder) => folder.id === "company");
  assert.deepEqual(company?.entries.map((entry) => [entry.label, entry.versionId]), [["Car allowance letter", "row-1"]]);
  const leaving = folders.find((folder) => folder.id === "leaving");
  const handover = leaving?.entries.filter((entry) => entry.document === CUSTOM_LEAVING) ?? [];
  assert.equal(handover.length, 1, "an archived edition is never listed beside the current one");
  assert.equal(handover[0]?.versionId, "row-2");
  assert.equal(handover[0]?.audience, "departed", "an uploaded leaving paper lists leavers too");
}

function testLeavingPapersListLeaversOnly() {
  const people = [candidate("A-1", false), candidate("A-2", true), candidate("A-3", false), candidate("A-4", true)];

  for (const document of ["resignation", "mutualTermination", "form6", "clearanceEmployee", "clearanceCompany"] as const) {
    assert.equal(documentAudience(document), "departed", `${document} is a leaving paper`);
    assert.deepEqual(
      candidatesForDocument(people, document).map((person) => person.hrId),
      ["A-2", "A-4"],
      `${document} must offer only people who have left`,
    );
  }

  // The deliberate exceptions: a certificate of experience is issued to current staff on request.
  for (const document of ["experienceCertificate", "experienceCertificateEn"] as const) {
    assert.equal(documentAudience(document), "everyone");
    assert.equal(candidatesForDocument(people, document).length, 4);
  }
  assert.equal(candidatesForDocument(people, "contract").length, 4, "a joining paper lists everyone");

  // The person already chosen stays chosen when the caller asks for that.
  assert.deepEqual(
    candidatesForDocument(people, "resignation", undefined, "A-1").map((person) => person.hrId),
    ["A-1", "A-2", "A-4"],
  );
  assert.equal(documentAudience(CUSTOM_LEAVING, { [CUSTOM_LEAVING]: "leaving" }), "departed");
  assert.equal(documentAudience(CUSTOM_OTHER), "everyone");
}

const LETTERHEAD =
  '<html><head><title>x</title></head><body><div class="lh__id"><strong>Sato Pharma</strong><span dir="ltr">Cairo</span></div><p>body</p></body></html>';
const MAST =
  '<html><head></head><body><table><thead><tr><th><span class="doc-mast__side doc-mast__id"><strong>ساتو فارما</strong><span dir="ltr">Sato Pharma</span></span></th></tr></thead></table></body></html>';
const PREMIUM =
  '<html><head></head><body><article class="copy"><header class="pm-mast"><div class="pm-mast__mid"><div class="pm-mast__names"><span class="pm-mast__name" dir="rtl" lang="ar">شركة ساتو فارما</span><span class="pm-mast__ref" dir="rtl"></span></div><h1 class="pm-mast__t">عقد عمل</h1></div></header></article></body></html>';
const CONTRACT_TITLE =
  '<html><head></head><body><div class="masthead__title"><h1>عقد عمل</h1><p>محدد المدة</p></div></body></html>';
const ARTWORK = '<html><head></head><body><img src="page-1.png"></body></html>';

function testReferenceStamping() {
  const reference = "HR-2026-000123";
  assert.ok(isPaperReference(reference));
  assert.equal(isPaperReference("HR-26-1"), false);

  const letterhead = stampPaperReference(LETTERHEAD, reference, "workerDataForm");
  assert.match(letterhead, /<span dir="ltr">Cairo<\/span><span class="hp-ref" data-hp-ref="HR-2026-000123">رقم المرجع: <bdi>HR-2026-000123<\/bdi><\/span><\/div>/);
  assert.match(letterhead, /<style data-hp-ref-style>[\s\S]*<\/style><\/head>/);
  assert.doesNotMatch(letterhead, /hp-ref--fixed"/, "a paper with a letterhead is not also stamped in the corner");

  const mast = stampPaperReference(MAST, reference, "clearanceEmployee");
  assert.match(mast, /<span dir="ltr">Sato Pharma<\/span><span class="hp-ref" data-hp-ref="HR-2026-000123">/);

  // The HR premium masthead (2026-10-12): the number goes INTO the empty slot at the end of the name
  // line, and the slot's own direction keeps the colon on the Arabic label's side.
  const premium = stampPaperReference(PREMIUM, reference, "nda");
  assert.match(premium, /<span class="pm-mast__ref" dir="rtl"><span class="hp-ref" data-hp-ref="HR-2026-000123">رقم المرجع: <bdi>HR-2026-000123<\/bdi><\/span><\/span>/);
  assert.doesNotMatch(premium, /hp-ref--fixed"/, "a premium paper is not also stamped in the corner");

  const contract = stampPaperReference(CONTRACT_TITLE, reference, "contract");
  assert.match(contract, /<p>محدد المدة<\/p><p class="hp-ref" data-hp-ref="HR-2026-000123">/);

  const artwork = stampPaperReference(ARTWORK, reference, CUSTOM_OTHER);
  assert.match(artwork, /<div class="hp-ref hp-ref--fixed" data-hp-ref="HR-2026-000123">رقم المرجع: <bdi>HR-2026-000123<\/bdi><\/div><\/body>/);

  // Stamping is idempotent: a reprint of a stamped page never prints two numbers.
  assert.equal(stampPaperReference(letterhead, "HR-2026-000124", "workerDataForm"), letterhead);

  // The Authority's and the Ministry's own forms are never written on.
  for (const document of ["form1", "form6", "resignation", "mutualTermination"] as const) {
    assert.equal(paperReferencePrintsOnFace(document), false);
    assert.equal(stampPaperReference(ARTWORK, reference, document), ARTWORK, `${document} prints as issued`);
  }
  assert.equal(stampPaperReference(LETTERHEAD, null, "workerDataForm"), LETTERHEAD, "no register, no stamp");
  assert.equal(stampPaperReference(LETTERHEAD, "<script>", "workerDataForm"), LETTERHEAD, "a malformed number is refused");
}

function testManualPack() {
  const values = sanitizeManualValues({
    "company.nameAr": "Somebody Else Ltd",
    "employee.baseSalary": "18,000",
    "employee.departed": "true",
    "employee.hireDate": "13/01/2026",
    "employee.nameAr": "  أحمد محمد  ",
    "employee.nationalId": 29801011234567,
    "profile.jobTitleAr": "مندوب طبي",
  });
  assert.deepEqual(
    Object.keys(values).sort(),
    ["employee.baseSalary", "employee.hireDate", "employee.nameAr", "profile.jobTitleAr"],
    "only the closed list of typed values survives — never a company value, a flag, or a non-string",
  );

  const current = buildManualHiringPack(values, COMPANY_DETAILS_DEFAULT);
  assert.equal(current.employee.nameAr, "أحمد محمد");
  assert.equal(current.employee.baseSalary, 18000);
  assert.equal(current.employee.socialInsuranceWage, insuranceWageFromBase(18000));
  assert.equal(current.employee.hireDate, null, "a date that is not YYYY-MM-DD prints blank, never garbled");
  assert.equal(current.profile.jobTitleAr, "مندوب طبي");
  assert.equal(current.employee.departed, false);
  assert.equal(current.company, COMPANY_DETAILS_DEFAULT, "the fixed data is the company record itself");
  assert.equal(manualSubjectName(values), "أحمد محمد");

  const leaver = buildManualHiringPack(
    sanitizeManualValues({ "employee.nameAr": "منى", "offboarding.lastWorkingDate": "2026-08-31" }),
    COMPANY_DETAILS_DEFAULT,
  );
  assert.equal(leaver.employee.departed, true);
  assert.equal(leaver.offboarding.lastWorkingDate, "2026-08-31");
  assert.equal(leaver.employee.lastWorkingDate, "2026-08-31");

  const inputs = manualPaperInputs("resignation", leaver, "", true).map((input) => input.key);
  assert.deepEqual(inputs.slice(0, 6), [
    "employee.nameAr",
    "employee.nationalId",
    "profile.jobTitleAr",
    "employee.departmentAr",
    "employee.hireDate",
    "offboarding.lastWorkingDate",
  ]);
  assert.equal(new Set(inputs).size, inputs.length, "no box is offered twice");
  assert.ok(inputs.every((key) => !key.startsWith("company.")), "company values are never a box");
}

export function runHiringPackFormsDriveTests() {
  testEveryPaperIsInExactlyOneFolder();
  testTheLettersPackIsFiled();
  testUploadedTemplatesAreFiledByTheirPackage();
  testLeavingPapersListLeaversOnly();
  testReferenceStamping();
  testManualPack();
}

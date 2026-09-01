import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";

import { systemLegalEntity } from "../src/config/system-settings.ts";
import {
  CONTRACT_BLANK_RULE,
  contractTemplateStrings,
  contractTemplateTokens,
  fillContractTokens,
} from "../src/lib/hiring-pack/contract-template.ts";
import {
  CONTRACT_TEMPLATES,
  contractTemplateById,
  currentContractTemplate,
} from "../src/lib/hiring-pack/contract-text.ts";
import { renderContractHtml } from "../src/lib/hiring-pack/render-contract.ts";
import {
  collectHiringPackGaps,
  emptyOffboardingProfile,
  resolveContractTerms,
} from "../src/lib/hiring-pack/service.ts";
import {
  DOCUMENT_TEMPLATE_VERSIONS,
  archivedTemplateVersions,
  currentTemplateVersion,
  findTemplateVersion,
  resolveTemplateVersion,
  templateVersionsFor,
} from "../src/lib/hiring-pack/template-registry.ts";
import { HIRING_PACK_DOCUMENTS } from "../src/lib/hiring-pack/types.ts";
import type {
  HiringPackData,
  HiringPackEmployeeFacts,
  HiringPackProfile,
  OffboardingProfile,
} from "../src/lib/hiring-pack/types.ts";

/**
 * THE ARCHIVE, and the two contract texts it holds.
 *
 * The owner replaced the employment contract on 2026-08-30 and asked for the old one to be kept:
 * "make the other contract go to archived instead of removing it from system. Make a thing called
 * archived … and any paper I replace, it goes to the archive."
 *
 * What makes that instruction worth a test file rather than a code comment is the failure mode. A
 * contract is a paper somebody SIGNED, and every way of getting this wrong produces a document that
 * looks perfectly correct:
 *
 *   - Delete version 1, and reprinting an August contract silently yields today's text. Nineteen
 *     clauses the employee never read, over their real signature date, and nothing says so.
 *   - Leave both versions marked current, and printing picks one. Both look right on screen; only a
 *     side-by-side of two contracts printed the same afternoon would ever show it.
 *   - Edit version 1's Arabic to "fix a typo", and every contract ever signed against it is
 *     retroactively a different document.
 *
 * None of those raises an error, and none is visible from the screen that prints them. So the
 * invariants are pinned here instead: exactly one current version per document, nothing ever
 * removed, and both texts fixed by content hash, so that changing one is a decision somebody had to
 * make on purpose rather than a diff nobody noticed.
 */

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

function employeeFixture(): HiringPackEmployeeFacts {
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
    // The department, not the line.
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

/**
 * An exit nobody has started.
 *
 * Spread from the app's own `emptyOffboardingProfile` rather than written out here. Four test files
 * used to hold their own copy of this literal, so adding a document to the module meant editing all
 * four — and the only thing that caught a miss was the type checker failing four files at once.
 */
function offboardingFixture(): OffboardingProfile {
  return emptyOffboardingProfile("H-3003");
}

function packFixture(profileOverrides: Partial<HiringPackProfile> = {}): HiringPackData {
  const employee = employeeFixture();
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

// ---------------------------------------------------------------------------------------------
// The registry — what is current, what is archived, what may never disappear
// ---------------------------------------------------------------------------------------------

function testEveryDocumentHasExactlyOneCurrentVersion() {
  for (const document of HIRING_PACK_DOCUMENTS) {
    // Throws rather than guessing when there are two — the point being that a second current
    // version cannot be resolved by anybody, from code or from a screen.
    const current = currentTemplateVersion(document);
    assert.equal(current.document, document);
    assert.equal(current.status, "current");
    assert.equal(
      current.supersededOn,
      null,
      `${current.id} is current and yet carries a supersession date`,
    );
    assert.equal(
      current.supersededBy,
      null,
      `${current.id} is current and yet points at a successor`,
    );
  }

  // THE OTHER DIRECTION, which the loop above cannot see: a registry entry for a document that is
  // not in the module at all. That is how a paper ends up filed in the Archive, reprintable, and
  // reachable from nowhere else — the loop only walks the documents that exist, so it would pass.
  //
  // This replaced `assert.equal(HIRING_PACK_DOCUMENTS.length, 5)`, which pinned the SIZE of the
  // module and went red the moment a document was added — twice. The size grows by design; what
  // must hold is that the module and the registry name the same set, which is what these two
  // checks together say.
  const known = new Set<string>(HIRING_PACK_DOCUMENTS);
  for (const entry of DOCUMENT_TEMPLATE_VERSIONS) {
    assert.ok(
      known.has(entry.document),
      `${entry.id} is registered against "${entry.document}", which is not a document this module prints`,
    );
  }
  assert.ok(
    HIRING_PACK_DOCUMENTS.length > 0,
    "the document list is empty — the loop above proved nothing",
  );
}

function testEveryVersionIdIsUniqueAcrossEveryDocument() {
  const ids = DOCUMENT_TEMPLATE_VERSIONS.map((entry) => entry.id);
  assert.equal(
    new Set(ids).size,
    ids.length,
    "two versions share an id — the id is what gets stamped on a signed row, so a duplicate "
      + "reprints one employee's contract as another document entirely",
  );
}

function testNothingIsEverRemovedFromTheArchive() {
  // Every id that has ever existed. APPEND to this list when a document is replaced; never delete
  // from it. A deletion here is the same mistake as a deletion from the registry, one step removed.
  const everKnown = [
    "contract-v1",
    "contract-v2",
    "form1-v1",
    "form6-v1",
    "resignation-v1",
    "mutualTermination-v1",
  ];
  const live = new Set(DOCUMENT_TEMPLATE_VERSIONS.map((entry) => entry.id));
  for (const id of everKnown) {
    assert.ok(
      live.has(id),
      `${id} has disappeared from the registry. An archived version is not dead weight: somebody `
        + "signed it, and a reprint of their contract has to reproduce the document they signed.",
    );
  }

  const v1 = findTemplateVersion("contract-v1");
  assert.ok(v1, "contract-v1 must remain findable");
  assert.equal(v1.status, "archived");
  assert.equal(v1.supersededBy, "contract-v2");
  assert.equal(v1.supersededOn, "2026-08-30");
}

function testASupersessionPointsAtARealLaterVersionOfTheSameDocument() {
  for (const entry of DOCUMENT_TEMPLATE_VERSIONS) {
    if (entry.status !== "archived") continue;
    assert.ok(entry.supersededOn, `${entry.id} is archived with no date it stopped being used`);
    assert.ok(entry.supersededBy, `${entry.id} is archived with nothing named as its replacement`);
    const successor = findTemplateVersion(entry.supersededBy ?? "");
    assert.ok(successor, `${entry.id} points at ${entry.supersededBy}, which does not exist`);
    assert.equal(
      successor.document,
      entry.document,
      `${entry.id} claims to have been replaced by a version of a different document`,
    );
    assert.ok(
      successor.version > entry.version,
      `${entry.id} claims to have been replaced by an earlier version of itself`,
    );
    assert.ok(
      entry.effectiveFrom <= (entry.supersededOn ?? ""),
      `${entry.id} stopped being used before it started`,
    );
  }
}

function testTheArchiveListIsWhatTheScreenShows() {
  const archived = archivedTemplateVersions();
  assert.deepEqual(
    archived.map((entry) => entry.id),
    ["contract-v2", "contract-v1"],
    "the Archive screen lists exactly the superseded versions, newest supersession first",
  );
  for (const entry of archived) {
    assert.notEqual(entry.status, "current");
    assert.ok(entry.note.length > 0, `${entry.id} is archived with no explanation of why`);
    assert.ok(entry.labelEn.length > 0 && entry.labelAr.length > 0);
  }

  // Every version of the contract, newest first — what the Archive pages through.
  assert.deepEqual(
    templateVersionsFor("contract").map((entry) => entry.id),
    ["contract-v3", "contract-v2", "contract-v1"],
  );
}

function testResolveReproducesTheVersionThatWasSigned() {
  const unsigned = resolveTemplateVersion("contract", null);
  assert.equal(unsigned.version.id, "contract-v3");
  assert.equal(unsigned.reproducedFromSignature, false);

  const signedAgainstV1 = resolveTemplateVersion("contract", "contract-v1");
  assert.equal(signedAgainstV1.version.id, "contract-v1");
  assert.equal(
    signedAgainstV1.reproducedFromSignature,
    true,
    "a contract signed against version 1 reprints as version 1, not as today's text",
  );

  // An id from a branch that never shipped must not make an employee's file unprintable — it falls
  // back to the current version and SAYS it did, so the screen can explain itself.
  const unknown = resolveTemplateVersion("contract", "contract-v99");
  assert.equal(unknown.version.id, "contract-v3");
  assert.equal(unknown.reproducedFromSignature, false);

  // A stored id belonging to another document is the same case, and the cross-check matters: a
  // lookup by id alone would happily hand back the Form 1 entry for a contract.
  const crossed = resolveTemplateVersion("contract", "form1-v1");
  assert.equal(crossed.version.id, "contract-v3");
  assert.equal(crossed.reproducedFromSignature, false);
}

function testTheRegistryAndTheContractTextsAgree() {
  const registryIds = templateVersionsFor("contract")
    .map((entry) => entry.id)
    .sort();
  const textIds = CONTRACT_TEMPLATES.map((template) => template.id).sort();
  assert.deepEqual(
    registryIds,
    textIds,
    "the registry and the contract texts disagree about which versions exist — one of them lists a "
      + "version the other cannot print",
  );

  for (const template of CONTRACT_TEMPLATES) {
    const entry = findTemplateVersion(template.id);
    assert.ok(entry, `${template.id} has text but no registry entry — invisible to the Archive`);
    assert.equal(entry.document, "contract");
    assert.equal(
      entry.version,
      template.version,
      `${template.id} is version ${template.version} in its text and ${entry.version} in the registry`,
    );
  }

  assert.equal(currentContractTemplate().id, currentTemplateVersion("contract").id);
}

// ---------------------------------------------------------------------------------------------
// The texts themselves
// ---------------------------------------------------------------------------------------------

/**
 * A version's whole text as one string, hashed.
 *
 * Hashed over the STRUCTURED strings rather than the source file, deliberately. A file-byte pin
 * false-fails the first time somebody reflows a comment or the formatter moves a brace, and a test
 * that cries wolf gets its expected value re-pinned by hand — which is precisely the edit it exists
 * to catch. This hash moves only when the printed words move.
 */
function textFingerprint(id: string): string {
  const template = contractTemplateById(id);
  assert.ok(template, `${id} has no text`);
  return createHash("sha256")
    .update(contractTemplateStrings(template).join("\n"), "utf8")
    .digest("hex");
}

function testEveryContractTextIsPinned() {
  assert.equal(
    textFingerprint("contract-v1"),
    "4bb91f57b38d36c372ae28ae682a598251739d6d10fae5c739d21befe694b801",
    "VERSION 1'S ARABIC HAS CHANGED. This text has been signed. Editing it rewrites contracts that "
      + "already exist, retroactively and silently. If the contract genuinely needs to change, that "
      + "is a NEW version: archive this one and append the new text — never edit in place.",
  );
  assert.equal(
    textFingerprint("contract-v2"),
    "5cefbac9fddf4981fde2806d413e38adabdec6017462b1db4dcfb9d0dc640286",
    "VERSION 2'S ARABIC HAS CHANGED. This version has been signed and is now archived. If the owner "
      + "supplied a new draft, that is a further version: archive this one and append the new text — "
      + "never edit this text in place.",
  );
  assert.equal(
    textFingerprint("contract-v3"),
    "d52db4746a92a72c71d50c1bc9ee9461adfcc30e3bd3140557ec89c26223b735",
    "VERSION 3'S ARABIC HAS CHANGED. This is the contract Phoenix prints today. If the owner "
      + "supplied a new draft, archive this version and append the new one; do not edit this text.",
  );
}

function testTheStructureOfEveryVersionHoldsUp() {
  const v1 = contractTemplateById("contract-v1");
  const v2 = contractTemplateById("contract-v2");
  const v3 = contractTemplateById("contract-v3");
  assert.ok(v1 && v2 && v3);

  assert.equal(v1.articles.length, 19, "version 1 lost or gained an article");
  assert.equal(v2.articles.length, 19, "version 2 lost or gained an article");
  assert.equal(v1.articles[0].number, "مادة (1)");
  assert.equal(v1.articles[18].number, "مادة (19)");
  assert.equal(v2.articles[0].number, "مادة (1)");
  assert.equal(v2.articles[18].number, "مادة (19)");

  // The layouts are genuinely different documents, not a restyling: version 1 runs as untitled
  // prose; version 2 titles every article and bands the parties; version 3 keeps version 2's banded,
  // titled layout but consolidates the same subject matter into thirteen articles. All three must
  // stay printable, so each is asserted in its own right.
  assert.equal(v1.layout, "prose");
  assert.equal(v2.layout, "banded");
  assert.equal(
    v1.articles.filter((article) => article.titleAr !== null).length,
    0,
    "version 1's articles are numbered and untitled — that is what was signed",
  );
  assert.equal(
    v2.articles.filter((article) => article.titleAr !== null).length,
    19,
    "version 2 titles all nineteen articles; a null title prints an empty heading cell",
  );
  assert.equal(v2.articles[0].titleAr, "التمهيد واللوائح");
  assert.equal(v2.articles[18].titleAr, "تحرير العقد والإقرارات");
  assert.equal(
    v2.subtitleAr,
    "محرر طبقًا لأحكام قانون العمل المصري رقم 14 لسنة 2025 ولائحته التنفيذية",
  );

  assert.equal(v3.articles.length, 13, "version 3 lost or gained an article");
  assert.equal(v3.articles[0].number, "مادة (1)");
  assert.equal(v3.articles[12].number, "مادة (13)");
  assert.equal(v3.layout, "banded");
  assert.equal(
    v3.articles.filter((article) => article.titleAr !== null).length,
    13,
    "version 3 titles all thirteen articles; a null title prints an empty heading cell",
  );
  assert.equal(v3.articles[0].titleAr, "التمهيد واللوائح والملاحق");
  assert.equal(v3.articles[12].titleAr, "الإخطارات والاختصاص وأحكام عامة");
  assert.equal(
    v3.subtitleAr,
    "محرر طبقًا لقانون العمل المصري رقم 14 لسنة 2025 والقرارات المنفذة له",
  );
}

function testEveryTokenAVersionUsesIsOneTheRendererFills() {
  // The `ContractToken` union is a TYPE, and a type cannot see a token that exists only inside a
  // string. So the token set of each version is pinned here as data. A new `{{SOMETHING}}` in the
  // Arabic compiles perfectly and prints literal braces onto a signature page; this catches it.
  const v1 = contractTemplateById("contract-v1");
  const v2 = contractTemplateById("contract-v2");
  const v3 = contractTemplateById("contract-v3");
  assert.ok(v1 && v2 && v3);

  assert.deepEqual(contractTemplateTokens(v1), [
    "ADDRESS",
    "BIRTH_DATE",
    "BIRTH_PLACE",
    "COMPANY_CITY",
    "COMPANY_HEAD_OFFICE",
    "COMPANY_NAME",
    "CONTRACT_DATE",
    "DAY_NAME",
    "DEPARTMENT",
    "DURATION",
    "EMAIL",
    "EMPLOYEE_NAME",
    "INSURANCE_NUMBER",
    "INSURANCE_WAGE",
    "JOB_TITLE",
    "NATIONALITY",
    "NATIONAL_ID",
    "PHONE",
    "QUALIFICATION",
    "RESPONSIBLE_MANAGER",
    "RESPONSIBLE_MANAGER_TITLE",
    "SALARY_FIGURES",
    "SALARY_WORDS",
    "START_DATE",
    "TRAINING_BOND",
    "UNDERPERFORMANCE_MONTHS",
    "UNDERPERFORMANCE_PCT",
  ]);
  assert.deepEqual(contractTemplateTokens(v2), [
    "ADDRESS",
    "BIRTH_DATE",
    "BIRTH_PLACE",
    "COMMERCIAL_REGISTER",
    "COMMERCIAL_REGISTER_OFFICE",
    "COMPANY_BRANCH_REGISTRY",
    "COMPANY_CITY",
    "COMPANY_HEAD_OFFICE_FULL",
    "COMPANY_LEGAL_FORM",
    "COMPANY_NAME",
    "CONTRACT_DATE",
    "CONTRACT_SIGNATORY",
    "CONTRACT_SIGNATORY_TITLE",
    "DEPARTMENT",
    "DURATION",
    "EMAIL",
    "EMPLOYEE_NAME",
    "INSURANCE_NUMBER",
    "INSURANCE_WAGE",
    "JOB_TITLE",
    "NATIONALITY",
    "NATIONAL_ID",
    "PHONE",
    "QUALIFICATION",
    "SALARY_FIGURES",
    "SALARY_WORDS",
    "START_DATE",
    "TAX_CARD",
    "TRAINING_BOND",
    "UNDERPERFORMANCE_MONTHS",
    "UNDERPERFORMANCE_PCT",
    "UNIFIED_REGISTER",
  ]);
  // Version 3 references a strict subset of version 2's blanks: it no longer states an insurance-wage
  // figure, an underperformance threshold or a training-bond duration, so INSURANCE_WAGE, TRAINING_BOND,
  // UNDERPERFORMANCE_MONTHS and UNDERPERFORMANCE_PCT are gone. A stray {{TOKEN}} the renderer cannot
  // fill would print literal braces onto a signature page; this pins the set that survived.
  assert.deepEqual(contractTemplateTokens(v3), [
    "ADDRESS",
    "BIRTH_DATE",
    "BIRTH_PLACE",
    "COMMERCIAL_REGISTER",
    "COMMERCIAL_REGISTER_OFFICE",
    "COMPANY_BRANCH_REGISTRY",
    "COMPANY_CITY",
    "COMPANY_HEAD_OFFICE_FULL",
    "COMPANY_LEGAL_FORM",
    "COMPANY_NAME",
    "CONTRACT_DATE",
    "CONTRACT_SIGNATORY",
    "CONTRACT_SIGNATORY_TITLE",
    "DEPARTMENT",
    "DURATION",
    "EMAIL",
    "EMPLOYEE_NAME",
    "INSURANCE_NUMBER",
    "JOB_TITLE",
    "NATIONALITY",
    "NATIONAL_ID",
    "PHONE",
    "QUALIFICATION",
    "SALARY_FIGURES",
    "SALARY_WORDS",
    "START_DATE",
    "TAX_CARD",
    "UNIFIED_REGISTER",
  ]);
}

function testAMissingValuePrintsADottedRuleAndNotAnEmptyGap() {
  const filled = fillContractTokens("الأجر {{SALARY_FIGURES}} جنيهًا", {
    SALARY_FIGURES: "11000",
  });
  assert.equal(filled, "الأجر 11000 جنيهًا");

  // A contract that closes up around a missing salary reads as complete. The dotted rule is the
  // paper form's own signal, and it survives a photocopy.
  for (const missing of [undefined, null, "", "   "]) {
    assert.equal(
      fillContractTokens("الأجر {{SALARY_FIGURES}} جنيهًا", { SALARY_FIGURES: missing }),
      `الأجر ${CONTRACT_BLANK_RULE} جنيهًا`,
      "a missing value must print as a visible rule, never as nothing at all",
    );
  }
}

// ---------------------------------------------------------------------------------------------
// Printing — which version comes out, and what it says
// ---------------------------------------------------------------------------------------------

function testPrintingLeavesNoTokenOnThePage() {
  for (const template of CONTRACT_TEMPLATES) {
    const html = renderContractHtml(packFixture(), 1, template.id);
    assert.ok(
      !html.includes("{{"),
      `${template.id} printed an unsubstituted token — the literal braces reach the signature page`,
    );
  }
}

function testASignedContractReprintsItsOwnVersion() {
  const current = renderContractHtml(packFixture(), 1);
  assert.ok(
    current.includes("محرر طبقًا لقانون العمل المصري رقم 14 لسنة 2025 والقرارات المنفذة له"),
    "an unsigned contract prints the current version",
  );

  const signedOnV1 = renderContractHtml(
    packFixture({ contractTemplateVersion: "contract-v1", contractSignedDate: "2026-08-25" }),
    1,
  );
  assert.ok(
    signedOnV1.includes("طبقًا لأحكام قانون العمل المصري رقم 14 لسنة 2025."),
    "a contract signed against version 1 must reprint version 1's own subtitle",
  );
  assert.ok(
    !signedOnV1.includes("محرر طبقًا لأحكام قانون العمل المصري رقم 14 لسنة 2025 ولائحته التنفيذية"),
    "version 1's reprint has picked up version 2's subtitle",
  );
  assert.ok(
    !signedOnV1.includes("التمهيد واللوائح"),
    "version 1's reprint has picked up version 2's article titles",
  );
}

function testPrintingAnArchivedTextSaysSoOnScreenAndNeverOnPaper() {
  const archived = renderContractHtml(packFixture(), 1, "contract-v1");
  assert.ok(
    archived.includes("ARCHIVED TEXT (contract-v1)"),
    "printing a superseded contract must say so — it is legitimate, and dangerous by accident",
  );
  // The warning lives in the print banner, which the shared stylesheet hides at print time. It is
  // for the person pressing Print, and it must not appear on a document anybody signs.
  assert.ok(archived.includes("no-print"), "the banner must carry the print-hidden class");
  assert.ok(archived.includes("@media print { .no-print { display: none !important; } }"));

  const current = renderContractHtml(packFixture(), 1);
  assert.ok(!current.includes("ARCHIVED TEXT"), "the current contract must not be labelled archived");
}

function testTheBannerOnlyClaimsAReproductionWhenTheFileSaysSo() {
  // Two ways to end up printing version 1, and they are DIFFERENT claims about the employee.
  //
  // The banner is the only thing that distinguishes them, so it must read the file rather than
  // infer from how the version was chosen. Getting it wrong prints "this reproduces the contract
  // this employee actually signed" over a document nobody signed — a false statement about a legal
  // record, on the screen of the person about to hand it to them.
  const browsingTheArchive = renderContractHtml(packFixture(), 1, "contract-v1");
  assert.ok(
    browsingTheArchive.includes("a superseded version was asked for"),
    "an archived version printed for somebody who signed nothing must not claim to reproduce their "
      + "contract — nobody signed this",
  );
  assert.ok(!browsingTheArchive.includes("this employee actually signed"));

  const reprintingASignedContract = renderContractHtml(
    packFixture({ contractTemplateVersion: "contract-v1", contractSignedDate: "2026-08-25" }),
    1,
    "contract-v1",
  );
  assert.ok(
    reprintingASignedContract.includes("this employee actually signed"),
    "asking for the version this employee DID sign is still a faithful reproduction",
  );

  // And the same holds without the explicit request — the stored id alone is enough.
  const fromTheFileAlone = renderContractHtml(
    packFixture({ contractTemplateVersion: "contract-v1", contractSignedDate: "2026-08-25" }),
    1,
  );
  assert.ok(fromTheFileAlone.includes("this employee actually signed"));
}

function testVersionTwoPrintsTheFullCompanyRecital() {
  const html = renderContractHtml(packFixture(), 1, "contract-v2");
  const recital = systemLegalEntity.contractRecital;
  for (const value of [
    recital.legalFormAr,
    recital.commercialRegisterNumber,
    recital.commercialRegisterOfficeAr,
    recital.unifiedRegisterNumber,
    recital.taxCardNumber,
    recital.headOfficeAr,
    recital.branchRegistryAr,
    recital.signatoryNameAr,
    recital.signatoryTitleAr,
  ]) {
    assert.ok(
      html.includes(value),
      `version 2's recital is missing ${value} — part of the clause establishing who can bind the company`,
    );
  }
}

function testEachVersionKeepsItsOwnWording() {
  // THE FIDELITY TEST, and the reason four tokens exist in pairs that look redundant.
  //
  // Both versions name the head office and the person who signs. They do NOT say the same thing:
  // version 1 gives the short address and the social-insurance designation "المدير المسئول";
  // version 2 gives the full unit-and-building address and the company office "المدير العام
  // والممثل القانوني للشركة". Collapsing the pairs is the obvious simplification, and it would
  // reprint a contract signed against version 1 carrying wording that was never on the page.
  const v1 = renderContractHtml(packFixture(), 1, "contract-v1");
  const v2 = renderContractHtml(packFixture(), 1, "contract-v2");
  const recital = systemLegalEntity.contractRecital;

  assert.ok(
    v1.includes(systemLegalEntity.responsibleManagerTitleAr),
    "version 1 must name the signatory by his social-insurance designation, as it was signed",
  );
  assert.ok(
    v1.includes(systemLegalEntity.headOfficeAr),
    "version 1 must print the short head-office address, as it was signed",
  );
  assert.ok(
    !v1.includes(recital.signatoryTitleAr),
    "version 1 has picked up version 2's title for the signatory",
  );
  assert.ok(
    !v1.includes(recital.headOfficeAr),
    "version 1 has picked up version 2's head office wording",
  );

  assert.ok(
    v2.includes(recital.signatoryTitleAr),
    "version 2 must name the signatory by his company office — the clause that binds the company",
  );
  assert.ok(
    v2.includes(recital.headOfficeAr),
    "version 2 must print the full unit-and-building address its own recital gives",
  );
}

/** How many copies a rendered document actually contains, whichever layout drew it. */
function copyCount(html: string): number {
  return html.split('<article class="copy').length - 1;
}

function testEveryCopyRequestedIsPrinted() {
  // Both layouts, because the copy loop lives above the layout split and a regression there would
  // otherwise be caught on one version and missed on the other.
  for (const template of CONTRACT_TEMPLATES) {
    assert.equal(
      copyCount(renderContractHtml(packFixture(), 3, template.id)),
      3,
      `three copies of ${template.id} were asked for and a different number came out`,
    );
    assert.equal(
      copyCount(renderContractHtml(packFixture(), 0, template.id)),
      1,
      "a copy count of zero must still print one — nobody presses Print for nothing",
    );
  }
}

/**
 * An identity field must never wrap between its label and its value — in EITHER layout.
 *
 * This is not a styling preference. The party block is where a reader checks a national ID or an
 * insurance number against a passport, and a break that leaves "الرقم التأميني:" at the end of one
 * line and its digits at the start of the next makes them join the two by eye, on the copy that is
 * filed at the labour office. v1 bound these pairs from the day it shipped; v2 arrived as a new
 * layout with its own party renderer and did NOT, and nothing on screen shows it — only a printed
 * page at a particular column width does. So it is pinned per version, not once for "the contract".
 */
function testEveryVersionBindsAnIdentityFieldToItsValue(): void {
  for (const template of CONTRACT_TEMPLATES) {
    const html = renderContractHtml(packFixture(), 1, template.id);
    assert.ok(
      html.includes('<span class="field">'),
      `${template.id} must keep its party field pairs unbreakable`,
    );
    // The insurance number specifically: the longest label in the block, so the first to wrap.
    // The fill spans are stripped first — they sit INSIDE the binding span in the banded layout.
    assert.ok(
      /<span class="field">[^<]*الرقم التأميني/u.test(
        html.replace(/<\/?span class="fill[^>]*>/g, "").replace(/<\/span>/g, "</span>"),
      ),
      `${template.id} must bind الرقم التأميني to the number that follows it`,
    );
  }
}

export function runHrFormsContractArchiveTests(): void {
  testEveryDocumentHasExactlyOneCurrentVersion();
  testEveryVersionIdIsUniqueAcrossEveryDocument();
  testNothingIsEverRemovedFromTheArchive();
  testASupersessionPointsAtARealLaterVersionOfTheSameDocument();
  testTheArchiveListIsWhatTheScreenShows();
  testResolveReproducesTheVersionThatWasSigned();
  testTheRegistryAndTheContractTextsAgree();
  testEveryContractTextIsPinned();
  testTheStructureOfEveryVersionHoldsUp();
  testEveryTokenAVersionUsesIsOneTheRendererFills();
  testAMissingValuePrintsADottedRuleAndNotAnEmptyGap();
  testPrintingLeavesNoTokenOnThePage();
  testASignedContractReprintsItsOwnVersion();
  testPrintingAnArchivedTextSaysSoOnScreenAndNeverOnPaper();
  testTheBannerOnlyClaimsAReproductionWhenTheFileSaysSo();
  testVersionTwoPrintsTheFullCompanyRecital();
  testEachVersionKeepsItsOwnWording();
  testEveryCopyRequestedIsPrinted();
  testEveryVersionBindsAnIdentityFieldToItsValue();
}

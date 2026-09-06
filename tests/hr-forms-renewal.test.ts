import { strict as assert } from "node:assert";

import { systemContractDefaults } from "../src/config/system-settings.ts";
import { COMPANY_DETAILS_DEFAULT } from "../src/lib/hiring-pack/company-details.ts";
import { currentContractTemplate } from "../src/lib/hiring-pack/contract-text.ts";
import { renderContractHtml } from "../src/lib/hiring-pack/render-contract.ts";
import {
  buildRenewalValues,
  renderContractNonRenewalHtml,
  renderContractRenewalHtml,
} from "../src/lib/hiring-pack/render-renewal.ts";
import {
  RENEWAL_OBJECTIVE_REASONS,
  isRenewalObjectiveReasonCode,
  renewalObjectiveReasonClause,
} from "../src/lib/hiring-pack/renewal-reasons.ts";
import {
  RENEWAL_BLANK_RULE,
  renewalTemplateStrings,
  renewalTemplateTokens,
} from "../src/lib/hiring-pack/renewal-template.ts";
import type { RenewalTemplate, RenewalToken } from "../src/lib/hiring-pack/renewal-template.ts";
import {
  NON_RENEWAL_NOTICE_V1,
  RENEWAL_ANNEX_V1,
  RENEWAL_TEMPLATES,
  renewalTemplateById,
} from "../src/lib/hiring-pack/renewal-text.ts";
import {
  collectHiringPackGaps,
  emptyOffboardingProfile,
  resolveContractTerms,
} from "../src/lib/hiring-pack/service.ts";
import { currentTemplateVersion } from "../src/lib/hiring-pack/template-registry.ts";
import {
  HIRING_PACK_DOCUMENTS,
  RENEWAL_DOCUMENTS,
  SIGNABLE_DOCUMENTS,
  isSignableDocument,
} from "../src/lib/hiring-pack/types.ts";
import type {
  ContractRenewalFacts,
  HiringPackData,
  HiringPackEmployeeFacts,
  HiringPackProfile,
  OffboardingProfile,
} from "../src/lib/hiring-pack/types.ts";

/**
 * THE TWO RENEWAL PAPERS — ملحق تجديد سنوي and إخطار بعدم تجديد.
 *
 * WHAT MAKES THESE WORTH PINNING is that the way they go wrong is by printing something that reads
 * as entirely correct, and then getting signed.
 *
 *   - THE CROSS-REFERENCES ARE THE MAIN EVENT. The owner drafted both papers on 2026-08-19 against
 *     the contract that was current that week — `contract-text-v2.ts`, nineteen articles — and the
 *     contract has since been redrafted twice, down to thirteen. Every article number in his draft
 *     was right then and wrong now, and the WORST of them is مادة (15): the notice cited it for
 *     custody and handover, and v4 HAS a مادة (15)… no it does not, it has thirteen — but it did
 *     have one under v2 and v3's numbering habits, and the near-miss is the point. A reference that
 *     lands on a real article about a different subject is invisible to every reader except the one
 *     arguing against you. `testEveryContractReferenceResolves` is the guard, and it is written to
 *     fire on the NEXT redraft rather than on this one.
 *   - THE ANNEX MUST BE SIGNED BEFORE THE OLD TERM EXPIRES, or مادة (88) of Law 14/2025 makes the
 *     contract indefinite from the day it was made — not from the expiry, from inception. That is
 *     the entire reason the instrument exists, so the paper states it and this file pins that it
 *     still does.
 *   - THE NOTICE'S LAST WORKING DAY IS THE CONTRACT'S END DATE AND NOTHING ELSE. Reading it from
 *     the exit machinery instead would print a resignation's date on a paper whose third paragraph
 *     says nobody resigned.
 *   - TWO VALUES MUST STAY BLANK. The annex number comes from a paper register and the objective
 *     reason for the fixed term is a legal judgement about the post. A filled guess in either would
 *     be signed.
 */

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

function employeeFixture(
  overrides: Partial<HiringPackEmployeeFacts> = {},
): HiringPackEmployeeFacts {
  return {
    hrId: "H-3003",
    fullName: "Nour Adel",
    nameAr: "نور عادل",
    nationalId: "29709091234567",
    gender: null,
    socialInsuranceNumber: "123456789",
    socialInsuranceWage: 6000,
    baseSalary: 11000,
    grossSalary: 14300,
    birthDate: "1997-09-09",
    hireDate: "2025-08-01",
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
    // The term being renewed: a year from 2026-08-01, so it ends 2027-07-31 and the NEW term must
    // begin 2027-08-01. Those three dates are what `testTheNewTermIsDerivedFromTheOldOne` checks.
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
    contractSignatoryNameAr: null,
    contractSignatoryTitleAr: null,
    // Nothing chosen, which is the ordinary case and the one that must keep printing a blank. The
    // tests that exercise a chosen ground override it.
    contractObjectiveReasonCode: null,
    ndaSignedDate: null,
    ndaPrintedAt: null,
    updatedAt: null,
    ...overrides,
  };
}

function offboardingFixture(overrides: Partial<OffboardingProfile> = {}): OffboardingProfile {
  return { ...emptyOffboardingProfile("H-3003"), ...overrides };
}

function packFixture(
  overrides: {
    employee?: Partial<HiringPackEmployeeFacts>;
    profile?: Partial<HiringPackProfile>;
    offboarding?: Partial<OffboardingProfile>;
    renewal?: ContractRenewalFacts | null;
  } = {},
): HiringPackData {
  const employee = employeeFixture(overrides.employee);
  const profile = profileFixture(overrides.profile);
  const offboarding = offboardingFixture(overrides.offboarding);
  return {
    employee,
    profile,
    offboarding,
    exit: null,
    renewal: overrides.renewal ?? null,
    company: COMPANY_DETAILS_DEFAULT,
    suggestedJobTitleAr: null,
    gaps: collectHiringPackGaps(employee, profile, offboarding, null),
    terms: resolveContractTerms(employee, profile, offboarding, null),
  };
}

/**
 * A value with its bidirectional isolates stripped, for comparison against a plain string.
 *
 * `pinLtr` wraps every date and registry number in U+2066 LEFT-TO-RIGHT ISOLATE and U+2069 POP
 * DIRECTIONAL ISOLATE — invisible, paired, and load-bearing: without them the bidirectional
 * algorithm reorders the groups of `01 / 08 / 2026` on a right-to-left page. They are part of the
 * value and must stay in it, so the test strips them rather than asking the renderer not to add
 * them. `testTheIsolatesSurviveOntoThePage` below pins that they are actually there.
 */
function bare(value: string | undefined): string {
  return (value ?? "").replace(/[\u2066-\u2069\u202A-\u202E]/gu, "");
}

/** Every `<article class="copy">` on the page — one per printed copy. */
function copyCount(html: string): number {
  return html.split('<article class="copy').length - 1;
}

// ---------------------------------------------------------------------------------------------
// The cross-references — the reason this file exists
// ---------------------------------------------------------------------------------------------

/**
 * Every article of the CONTRACT that either renewal paper points at, and what it has to be about.
 *
 * `mustContain` is checked against the contract article's own title AND body, so a redraft that
 * renumbers or re-scopes an article turns this red instead of leaving the papers citing a real
 * article about something else. The fragments are deliberately short and central to the clause —
 * long enough to be unambiguous, short enough that reworded surrounding prose does not false-fail.
 */
const CONTRACT_REFERENCES: ReadonlyArray<{
  article: number;
  citedBy: string;
  mustContain: readonly string[];
  why: string;
}> = [
  {
    article: 1,
    citedBy: "annex مادة (3)",
    mustContain: ["التمهيد", "جز"],
    why: "the annex binds itself to the contract through the article that makes annexes part of it",
  },
  {
    article: 3,
    citedBy: "annex مادة (7) and the notice's second paragraph",
    mustContain: ["المدة", "دون حاجة إلى تنبيه"],
    why: "both papers rest on the article saying the term expires with no notice and no implied renewal",
  },
  {
    article: 8,
    citedBy: "the notice's witness protocol",
    mustContain: ["موصى عليه بعلم الوصول"],
    why: "service on a refusing employee is by registered letter to the address this article names",
  },
  {
    article: 10,
    citedBy: "the notice's fourth paragraph",
    mustContain: ["العهد"],
    why: "the notice asks for custody back under the article that governs custody",
  },
  {
    article: 12,
    citedBy: "the notice's fourth paragraph",
    mustContain: ["تسليم مهامه"],
    why: "handover on the way out is that article's obligation, not the custody article's",
  },
  {
    article: 13,
    citedBy: "annex مادة (3) بند (5), and the notice's witness protocol بند (1)",
    mustContain: ["لا يكون أي تعديل صحي", "الإخطارات كتابية"],
    why: "an annex is only valid because بند (5) allows a written amendment; بند (1) is where notices go",
  },
];

/** The literal citation phrases, so a reword cannot quietly drop one. */
const CITATION_PHRASES: ReadonlyArray<{ template: RenewalTemplate; phrase: string }> = [
  { template: RENEWAL_ANNEX_V1, phrase: "للمادة (1) والمادة (13) بند (5) منه" },
  { template: RENEWAL_ANNEX_V1, phrase: "إعمالًا للمادة (3) من العقد الأصلي" },
  { template: NON_RENEWAL_NOTICE_V1, phrase: "إعمالًا للمادة (3) منه" },
  { template: NON_RENEWAL_NOTICE_V1, phrase: "للمادتين (10) و(12) من العقد" },
  { template: NON_RENEWAL_NOTICE_V1, phrase: "للمادة (8) والمادة (13) بند (1) من العقد" },
];

function testEveryContractReferenceResolves(): void {
  const contract = currentContractTemplate();

  for (const reference of CONTRACT_REFERENCES) {
    const article = contract.articles[reference.article - 1];
    assert.ok(
      article,
      `the renewal papers cite مادة (${reference.article}) of the contract (${reference.citedBy}), ` +
        `but the current contract "${contract.id}" has only ${contract.articles.length} articles`,
    );
    assert.equal(
      article.number,
      `مادة (${reference.article})`,
      "contract articles must be in numeric order for an index lookup to name the right one",
    );
    const text = `${article.titleAr ?? ""} ${article.body}`;
    for (const fragment of reference.mustContain) {
      assert.ok(
        text.includes(fragment),
        `مادة (${reference.article}) of contract "${contract.id}" no longer contains "${fragment}". ` +
          `${reference.citedBy} points at it because ${reference.why} — re-resolve the reference by ` +
          "SUBJECT against the new contract and update renewal-text.ts, never this table alone",
      );
    }
  }
}

function testEveryCitationPhraseIsStillOnThePaper(): void {
  for (const { template, phrase } of CITATION_PHRASES) {
    const found = renewalTemplateStrings(template).some((text) => text.includes(phrase));
    assert.ok(
      found,
      `"${template.id}" no longer contains the citation "${phrase}". If the wording changed, ` +
        "CONTRACT_REFERENCES above must be re-checked against it — a paper citing an article of a " +
        "contract that has been renumbered is the exact defect this file exists to catch",
    );
  }
}

/**
 * No citation anywhere on either paper names an article that does not exist.
 *
 * A SWEEP RATHER THAN A LIST, because the list above only covers references somebody remembered to
 * write down. This walks every «مادة (N)» in either document and classifies it by what stands
 * around it: a law citation is bounded by the law, a self citation by the paper's own articles, and
 * everything else is a reference to the contract. It is the half that survives a reword.
 */
function testNoCitationPointsPastTheEndOfItsSource(): void {
  const contractArticles = currentContractTemplate().articles.length;

  for (const template of RENEWAL_TEMPLATES) {
    const ownArticles = template.articles.length;
    // The article's own `number` field is its heading, not a citation — swept out by looking only
    // at bodies, paragraphs and the preamble.
    const prose = [
      template.preambleAr ?? "",
      ...template.articles.map((article) => article.body),
      ...template.bodyParagraphsAr,
      template.witnessNoteAr ?? "",
      template.bindingLineAr ?? "",
    ].join("\n");

    for (const match of prose.matchAll(/الماد(?:ة|تين) \((\d+)\)(?: و\((\d+)\))?/gu)) {
      const around = prose.slice(
        Math.max(0, match.index - 20),
        match.index + match[0].length + 60,
      );
      const numbers = [match[1], match[2]].filter(Boolean).map(Number);
      const isLaw = around.includes("قانون العمل");
      const isSelf = around.includes("هذا الملحق");
      const limit = isLaw ? Number.POSITIVE_INFINITY : isSelf ? ownArticles : contractArticles;
      const source = isLaw ? "Law 14/2025" : isSelf ? `"${template.id}" itself` : "the contract";

      for (const number of numbers) {
        assert.ok(
          number <= limit,
          `"${template.id}" cites مادة (${number}) of ${source}, which has only ${limit} articles. ` +
            "This is the version-drift failure: the citation was correct against an older text.",
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Registration — two documents, both current, neither signable
// ---------------------------------------------------------------------------------------------

function testBothPapersAreRegisteredAndCurrent(): void {
  for (const document of RENEWAL_DOCUMENTS) {
    assert.ok(
      HIRING_PACK_DOCUMENTS.includes(document),
      `${document} must be in HIRING_PACK_DOCUMENTS or nothing can print it`,
    );
  }

  const annex = currentTemplateVersion("contractRenewal");
  const notice = currentTemplateVersion("contractNonRenewal");
  assert.equal(annex.id, RENEWAL_ANNEX_V1.id, "the registry's current annex must be the text that exists");
  assert.equal(
    notice.id,
    NON_RENEWAL_NOTICE_V1.id,
    "the registry's current notice must be the text that exists",
  );
  assert.equal(renewalTemplateById(annex.id)?.variant, "renewal");
  assert.equal(renewalTemplateById(notice.id)?.variant, "nonRenewal");
  assert.equal(renewalTemplateById("contract-v4"), null, "a contract id is not a renewal template");
}

function testNeitherPaperRecordsASignatureAgainstThePerson(): void {
  for (const document of RENEWAL_DOCUMENTS) {
    assert.ok(
      !SIGNABLE_DOCUMENTS.includes(document),
      `${document} must NOT be signable: a contract is renewed every year, so one date on the ` +
        "employee row could record only the newest of them. contract_renewal_requests is the register.",
    );
    assert.equal(isSignableDocument(document), false);
  }
}

function testTheTwoPapersAreAlternativesNotAPair(): void {
  assert.equal(
    RENEWAL_ANNEX_V1.variant === NON_RENEWAL_NOTICE_V1.variant,
    false,
    "the annex and the notice assert incompatible facts and must never resolve to one another",
  );
  // A print of one carrying the other's version id falls back to the paper that was ASKED for.
  // Getting this wrong would hand somebody a non-renewal notice when they asked to renew.
  const html = renderContractRenewalHtml(packFixture(), 1, NON_RENEWAL_NOTICE_V1.id);
  assert.ok(
    html.includes(RENEWAL_ANNEX_V1.titleAr),
    "asking for the annex must print the annex even when a foreign version id is passed",
  );
  assert.ok(
    !html.includes(NON_RENEWAL_NOTICE_V1.titleAr),
    "the notice's title must never appear on an annex",
  );
}

// ---------------------------------------------------------------------------------------------
// The term arithmetic
// ---------------------------------------------------------------------------------------------

function testTheNewTermIsDerivedFromTheOldOne(): void {
  const values = buildRenewalValues(packFixture(), RENEWAL_ANNEX_V1);

  assert.equal(bare(values.CONTRACT_START_DATE), "01 / 08 / 2026");
  assert.equal(bare(values.CONTRACT_END_DATE), "31 / 07 / 2027");
  assert.equal(
    bare(values.RENEWAL_START_DATE),
    "01 / 08 / 2027",
    "the new term begins the DAY AFTER the old one ends — a one-day gap is a break in service",
  );
  assert.equal(
    bare(values.RENEWAL_END_DATE),
    "31 / 07 / 2028",
    "a twelve-month term beginning 01/08/2027 ends 31/07/2028, not 01/08/2028: the end date is the " +
      "last day the contract RUNS, and stating the following day gives away a day of service",
  );
  assert.equal(values.RENEWAL_DURATION, "سنة واحدة");
  assert.equal(
    bare(values.ORIGINAL_HIRE_DATE),
    "01 / 08 / 2025",
    "seniority runs from the ORIGINAL hire date, not from the term being renewed — that is the " +
      "whole point of مادة (5)",
  );
}

function testAnApprovedRenewalRequestOutranksTheDerivation(): void {
  const renewal: ContractRenewalFacts = {
    id: "11111111-1111-4111-8111-111111111111",
    status: "renewed",
    // Deliberately NOT the derived dates: an eighteen-month term starting a week late is exactly
    // the kind of thing a manager negotiates, and it is what the annex must print.
    proposedStartDate: "2027-08-08",
    proposedEndDate: "2029-02-07",
    areaName: "Cairo 3",
    signedAt: null,
  };
  const values = buildRenewalValues(packFixture({ renewal }), RENEWAL_ANNEX_V1);

  assert.equal(
    bare(values.RENEWAL_START_DATE),
    "08 / 08 / 2027",
    "an approved request is a RECORD; the day-after derivation is only a suggestion",
  );
  assert.equal(bare(values.RENEWAL_END_DATE), "07 / 02 / 2029");
  assert.equal(
    values.TERRITORY,
    "Cairo 3",
    "النطاق الجغرافي comes from the request, never from employees.line_id — the line is not the territory",
  );
}

function testTheTerritoryIsBlankRatherThanTheProductLine(): void {
  const values = buildRenewalValues(packFixture(), RENEWAL_ANNEX_V1);
  assert.equal(
    values.TERRITORY,
    "",
    "with no renewal request there is no recorded territory, and the product line is a different " +
      "thing — printing one under the other's label puts a wrong territory on a signed instrument",
  );
}

function testTheNoticeDatesTheLastDayFromTheContractNotTheExit(): void {
  // Somebody has typed a last working day into the exit screen — a different date entirely. The
  // notice must ignore it: its own third paragraph says nobody resigned and nobody was dismissed.
  const pack = packFixture({ offboarding: { lastWorkingDate: "2027-03-15" } });
  assert.equal(
    pack.terms.lastWorkingDate,
    "2027-03-15",
    "the exit machinery still resolves its own date — this test is only meaningful if it does",
  );

  const values = buildRenewalValues(pack, NON_RENEWAL_NOTICE_V1);
  assert.equal(
    bare(values.LAST_WORKING_DATE),
    "31 / 07 / 2027",
    "the notice's last working day is the CONTRACT'S end date. Reading terms.lastWorkingDate would " +
      "print a resignation's date on a paper that denies there was a resignation.",
  );
}

// ---------------------------------------------------------------------------------------------
// What must stay blank, and what must be filled
// ---------------------------------------------------------------------------------------------

function testTheTwoJudgementFieldsPrintBlank(): void {
  // Both still rule when nothing has been chosen. The objective reason became a dropdown on
  // 2026-09-05, which changed where its value comes from and NOT what an unanswered one looks like:
  // an unanswered legal ground must look unanswered, because the alternative is a guess that gets
  // signed. The annex number has no source at all — it comes from a paper register.
  const values = buildRenewalValues(packFixture(), RENEWAL_ANNEX_V1);
  for (const token of ["ANNEX_NUMBER", "OBJECTIVE_REASON"] as RenewalToken[]) {
    const value = values[token];
    assert.ok(
      value === undefined || value === "",
      `${token} must never be filled by Phoenix. The annex number comes from a paper register and ` +
        "the objective reason for a fixed term is a legal judgement about the post — a guess in " +
        "either is signed.",
    );
  }

  const html = renderContractRenewalHtml(packFixture(), 1);
  for (const token of ["ANNEX_NUMBER", "OBJECTIVE_REASON"]) {
    assert.ok(
      html.includes(`<span class="rule-line" data-hp-key="${token}">`),
      `${token} must render as a dotted rule carrying its key, so the fill screen can complete it`,
    );
  }
}

function testTheJobTitleIsArabicOnlyWithNoEnglishFallback(): void {
  const values = buildRenewalValues(
    packFixture({ profile: { jobTitleAr: null } }),
    RENEWAL_ANNEX_V1,
  );
  assert.equal(
    values.JOB_TITLE,
    "",
    "no fallback to employees.job_title. An English title on an Arabic instrument is the job the " +
      "paper binds him to, written in the language the paper says does not govern.",
  );

  const html = renderContractRenewalHtml(packFixture({ profile: { jobTitleAr: null } }), 1);
  assert.ok(
    !html.includes("Medical Representative"),
    "the English job title must not reach the page by any route",
  );
}

function testThePayFiguresAreTheBaseSalaryAndItsDerivedInsuranceWage(): void {
  const values = buildRenewalValues(packFixture(), RENEWAL_ANNEX_V1);
  assert.equal(
    values.SALARY_FIGURES,
    "11,000",
    "the BASE salary, not the gross — the same figure مادة (4) of the contract states. An annex " +
      "renewing on a different number would read as a pay change nobody agreed.",
  );
  assert.ok(
    !JSON.stringify(values).includes("14,300"),
    "the gross salary must not appear anywhere on the annex",
  );
  assert.equal(
    values.INSURANCE_WAGE,
    "8,462",
    "the insurance wage is derived from base through insuranceWageFromBase, never read off the row",
  );
  assert.ok(
    (values.SALARY_WORDS ?? "").includes("جنيه"),
    "the amount is spelled out in words beside the figures, as the contract does",
  );
}

// ---------------------------------------------------------------------------------------------
// The emitted artifact — never the source
// ---------------------------------------------------------------------------------------------

/**
 * The annex's masthead is the CONTRACT's masthead, and stays that way.
 *
 * `render-renewal.ts` carries its own copy of the contract's `.doc-mast` furniture on purpose: an
 * annex is read stapled to the contract it amends, and a reader turning from page 3 of the contract
 * to page 1 of the annex must not be able to tell that different code drew it. That file names the
 * cost of the duplication — silent drift — and says this test defends it.
 *
 * IT DID NOT. Until 2026-09-05 this file had no reference to the contract renderer at all. The
 * checks above pin the brand rule and the mark as LITERALS, which catches the annex moving; nothing
 * caught the CONTRACT moving. Change the contract's masthead and every assertion here still passes
 * while the two papers quietly stop matching — the exact failure the duplication was accepted for.
 *
 * So this renders BOTH and compares them. On the emitted HTML rather than the two source files,
 * because the source is not what a reader gets and a shared constant could be interpolated
 * differently in each.
 */
function testTheMastheadStillMatchesTheContractItAmends(): void {
  const pack = packFixture();
  const contract = renderContractHtml(pack, 1);
  const annex = renderContractRenewalHtml(pack, 1);

  /**
   * Every `.doc-mast*` CSS rule the document emits — DECLARATIONS ONLY, ordered.
   *
   * CSS comments are stripped before comparing. The two files explain the brand rule in their own
   * words, and comparing raw text made this fail over prose while every declaration matched — which
   * would have taught the next person to resolve it by copying a comment across, and made the check
   * noise rather than a guard. What must not drift is what the paper LOOKS like.
   */
  const mastheadRules = (html: string): string[] =>
    [...html.matchAll(/\.doc-mast[a-zA-Z_-]*[^{}]*\{[^}]*\}/g)]
      .map((match) => match[0].replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\s+/g, " ").trim())
      .sort();

  const contractRules = mastheadRules(contract);
  const annexRules = mastheadRules(annex);

  // A positive control first. If the extraction silently matched nothing, two empty arrays would
  // compare equal and this test would pass while checking absolutely nothing — which is how a
  // comparison test ends up defending the thing it was written to defend in name only.
  assert.ok(
    contractRules.length >= 6,
    `the contract must emit its masthead rules for this comparison to mean anything — found ${contractRules.length}`,
  );

  assert.deepEqual(
    annexRules,
    contractRules,
    "the annex's masthead must be byte-identical to the contract's: it is read stapled to that "
      + "contract, and the duplication in render-renewal.ts was accepted only because this check "
      + "exists. If the contract's masthead moved, move the annex's with it.",
  );

  // The structure, not only the styling: a class removed from one header and not the other changes
  // what is drawn even when every surviving rule still matches.
  const mastheadClasses = (html: string): string[] => {
    const header = /<header class="doc-mast">[\s\S]*?<\/header>/.exec(html)?.[0] ?? "";
    return [...header.matchAll(/class="([^"]+)"/g)].map((match) => match[1]).sort();
  };
  const contractClasses = mastheadClasses(contract);
  assert.ok(contractClasses.length >= 3, "the contract's masthead markup must be found to compare against");
  assert.deepEqual(
    mastheadClasses(annex),
    contractClasses,
    "the annex's masthead must be built from the same elements as the contract's, not merely styled alike",
  );
}

function testBothPapersRenderCompletely(): void {
  const pack = packFixture();
  const annex = renderContractRenewalHtml(pack, systemContractDefaults.contractRenewalCopies);
  const notice = renderContractNonRenewalHtml(pack, systemContractDefaults.contractNonRenewalCopies);

  for (const [name, html] of [["annex", annex], ["notice", notice]] as const) {
    assert.ok(
      !html.includes("{{"),
      `${name}: an unsubstituted {{TOKEN}} reached the page — every token must resolve to a value ` +
        "or to a dotted rule",
    );
    assert.ok(html.includes('<html lang="ar" dir="rtl">'), `${name}: the page is Arabic and RTL`);
    assert.ok(html.includes("نور عادل"), `${name}: the Arabic name governs, as it does on the contract`);
    assert.ok(!html.includes("Nour Adel"), `${name}: the Latin name must not appear as the party`);
    // THE BRAND RULE — the one element the house identity puts on every document without exception.
    assert.ok(
      html.includes("border-bottom: 0.7mm solid #0A6BA6"),
      `${name}: the 0.7 mm Brand Blue rule is what makes a house document recognisable at arm's length`,
    );
    assert.ok(
      html.includes("/brand/sato-pharma-logo-on-light.svg"),
      `${name}: ALWAYS the on-light mark. The stock file sets "SATO" in white, which vanishes on paper.`,
    );
    // THE SQUARE-EDGE GOLDEN RULE, measured on the WHOLE page rather than on the document alone.
    // This used to subtract `PRINT_BANNER_CSS` — the on-screen banner every hiring paper carries —
    // because that shared chrome rounded its own buttons at 4px and the radius was not this
    // instrument's to answer for. The radius is gone, so nothing has to be carved out: the page
    // now answers for every corner it draws, chrome included, which is the stronger claim.
    assert.ok(
      !html.includes("border-radius"),
      `${name}: the square-edge golden rule — no round or semi-round corners anywhere on the page`,
    );
  }

  assert.equal(
    copyCount(annex),
    4,
    "four copies, matching the contract it amends: employee, file, labour office, insurance",
  );
  assert.equal(
    copyCount(notice),
    2,
    "two copies — one handed over, one filed with the acknowledgment. Nothing is deposited, " +
      "because nothing has been agreed.",
  );
}

function testTheLatinRunsArePinnedLeftToRight(): void {
  const html = renderContractRenewalHtml(packFixture(), 1);
  // The national ID, the employee code and the money figures are runs of Latin digits on a
  // right-to-left page. This company has already printed its own tax card 477-108-318 as
  // 318-108-477 by letting the bidirectional algorithm reorder one.
  for (const value of ["29709091234567", "H-3003", "11,000"]) {
    const at = html.indexOf(value);
    assert.ok(at > 0, `${value} must appear on the page`);
    const before = html.slice(Math.max(0, at - 160), at);
    assert.ok(
      before.includes('dir="ltr"'),
      `${value} must sit inside dir="ltr" or the bidirectional algorithm can reorder its groups`,
    );
  }
}

function testTheIsolatesSurviveOntoThePage(): void {
  // The dates are interpolated into escaped Arabic prose, where there is no element to hang a
  // `dir` attribute on — so they carry U+2066/U+2069 inside the string instead. `escapeHtml` must
  // leave them alone, or every date on the instrument is free to reorder.
  const html = renderContractRenewalHtml(packFixture(), 1);
  assert.ok(
    html.includes("\u2066"),
    "the LEFT-TO-RIGHT ISOLATE must reach the rendered page. Without it the bidirectional " +
      "algorithm reorders the groups of a date on a right-to-left page — this company has already " +
      "printed its own tax card 477-108-318 as 318-108-477.",
  );
  assert.equal(
    (html.match(/\u2066/gu) ?? []).length,
    (html.match(/\u2069/gu) ?? []).length,
    "isolates are paired: an unclosed one leaks its direction over the rest of the paragraph",
  );
}

function testTheAnnexStatesTheArticle88Warning(): void {
  const annex = renderContractRenewalHtml(packFixture(), 1);
  assert.ok(
    annex.includes("المادة (88)"),
    "مادة (2) must name Article 88 of Law 14/2025: continuing to perform a fixed-term contract " +
      "after expiry with no written agreement makes it indefinite FROM INCEPTION. That risk is the " +
      "only reason this instrument exists, so the paper says so on its own face.",
  );
  assert.ok(
    annex.includes("للمادة (90)"),
    "مادة (5) must name Article 90 behind 'no new probation' — it is the law, not a concession",
  );
  assert.ok(
    annex.includes("للمادة (87)"),
    "the preamble must name Article 87, which is what permits renewal for a similar period at all",
  );
}

function testTheNoticeSaysItIsNotADismissal(): void {
  const notice = renderContractNonRenewalHtml(packFixture(), 1);
  assert.ok(
    notice.includes("ولا يُعد هذا الإخطار فصلًا من الخدمة"),
    "the sentence denying this is a dismissal is the most load-bearing one on the page: an expiry " +
      "and a termination are different things in law, and one is far more expensive",
  );
  assert.ok(
    notice.includes("شاهد أول") && notice.includes("شاهد ثانٍ"),
    "the witness block is the record when an employee refuses to sign for the notice",
  );
}

// ---------------------------------------------------------------------------------------------
// The shape itself
// ---------------------------------------------------------------------------------------------

function testEveryTokenEitherPaperUsesIsInTheUnion(): void {
  // The union is declared in renewal-template.ts; a token used in the text but missing from it
  // would print the literal {{SOMETHING}} onto a signature page.
  const known = new Set<string>([
    "ANNEX_NUMBER",
    "ANNEX_DAY_NAME",
    "ANNEX_DATE",
    "COMPANY_NAME",
    "COMPANY_LEGAL_FORM",
    "COMPANY_HEAD_OFFICE_FULL",
    "COMPANY_CITY",
    "COMMERCIAL_REGISTER",
    "COMMERCIAL_REGISTER_OFFICE",
    "UNIFIED_REGISTER",
    "TAX_CARD",
    "CONTRACT_SIGNATORY",
    "CONTRACT_SIGNATORY_TITLE",
    "EMPLOYEE_NAME",
    "HR_ID",
    "NATIONAL_ID",
    "JOB_TITLE",
    "DEPARTMENT",
    "TERRITORY",
    "CONTRACT_DATE",
    "CONTRACT_START_DATE",
    "CONTRACT_END_DATE",
    "ORIGINAL_HIRE_DATE",
    "RENEWAL_DURATION",
    "RENEWAL_START_DATE",
    "RENEWAL_END_DATE",
    "OBJECTIVE_REASON",
    "SALARY_FIGURES",
    "SALARY_WORDS",
    "INSURANCE_WAGE",
    "NOTICE_DATE",
    "LAST_WORKING_DATE",
  ]);

  for (const template of RENEWAL_TEMPLATES) {
    for (const token of renewalTemplateTokens(template)) {
      assert.ok(
        known.has(token),
        `"${template.id}" uses {{${token}}}, which is not a RenewalToken — it would print literally`,
      );
    }
  }
}

function testTheBlankRuleIsWhatAnAbsentValueLooksLike(): void {
  // A missing date must never close up silently: a reader has no way to see that something was
  // dropped, and the instrument reads as complete.
  const bare = packFixture({
    employee: { hireDate: null },
    profile: { contractStartDate: null, contractEndDate: null },
  });
  const html = renderContractRenewalHtml(bare, 1);
  assert.ok(
    html.includes(RENEWAL_BLANK_RULE),
    "an absent value prints a visible run of dots, exactly as the paper form does",
  );
  assert.ok(!html.includes("{{"), "and still no raw token survives");
}

// ---------------------------------------------------------------------------------------------
// The objective reason — a dropdown of standard grounds, owner's instruction 2026-09-05
// ---------------------------------------------------------------------------------------------

/**
 * Every clause, pinned VERBATIM.
 *
 * THIS IS THE LOAD-BEARING TEST FOR THE DROPDOWN. The profile stores a CODE and the sentence is
 * resolved at print time, so rewording a clause in the catalogue silently changes what an
 * ALREADY-SIGNED annex reproduces when it is reprinted — on every annex that ever used that code,
 * with nothing on the page to say so. The catalogue is append-only for exactly that reason; this
 * table is what makes the rule enforceable rather than aspirational.
 *
 * To change a ground: ADD a code and leave the old one in place.
 */
const PINNED_CLAUSES: ReadonlyArray<readonly [string, string]> = [
  [
    "annual_promotional_plan",
    "ارتباط الوظيفة بخطة الترويج السنوية المعتمدة، التي يُعاد وضع مستهدفاتها وخطوط منتجاتها ونطاقاتها الجغرافية في مطلع كل سنة",
  ],
  [
    "territory_coverage_cycle",
    "ارتباط الوظيفة بتغطية نطاق جغرافي محدد ضمن دورة تغطية سنوية يُعاد في نهايتها تقسيم النطاقات وتوزيع العملاء",
  ],
  [
    "product_line_term",
    "ارتباط الوظيفة بخط منتجات أو مجموعة أصناف يقوم تسويقها على تسجيل أو اتفاق توزيع محدد المدة، فتتحدد مدة العمل بمدته",
  ],
  [
    "defined_project",
    "ارتباط الوظيفة بمشروع أو حملة محددة المدة والنطاق، تنتهي الحاجة إلى العمل بانتهائها",
  ],
  [
    "third_party_contract",
    "ارتباط الوظيفة بتنفيذ عقد أو اتفاق محدد المدة مبرم مع الغير، فتتحدد مدة العمل بمدة ذلك العقد",
  ],
  [
    "temporary_cover",
    "تغطية مؤقتة لوظيفة شاغرة أو لغياب مؤقت لأحد العاملين، وتنتهي الحاجة إلى العمل بزوال سببها",
  ],
  [
    "seasonal_demand",
    "مواجهة زيادة مؤقتة أو موسمية في حجم العمل لا تستلزم شغل الوظيفة بصفة دائمة",
  ],
  [
    "new_structure_under_review",
    "ارتباط الوظيفة بوحدة تنظيمية مستحدثة ما زالت قيد التقييم ولم يستقر بعد إدراجها بالهيكل التنظيمي الدائم",
  ],
];

function testEveryObjectiveReasonClauseIsPinned(): void {
  for (const [code, clause] of PINNED_CLAUSES) {
    assert.equal(
      renewalObjectiveReasonClause(code),
      clause,
      `the clause for "${code}" changed. A stored code resolves to this sentence at PRINT time, so ` +
        "rewording it rewrites what an already-signed annex reproduces. Add a new code instead.",
    );
  }
  assert.equal(
    RENEWAL_OBJECTIVE_REASONS.length,
    PINNED_CLAUSES.length,
    "a ground was added or removed without pinning it here — every clause that can reach a signed " +
      "instrument must be in this table",
  );
}

function testTheCatalogueHasNoDuplicateOrEmptyCodes(): void {
  const codes = RENEWAL_OBJECTIVE_REASONS.map((reason) => reason.code);
  assert.equal(
    new Set(codes).size,
    codes.length,
    "two grounds sharing a code means one of them can never be selected, and which one wins is " +
      "array order",
  );
  for (const reason of RENEWAL_OBJECTIVE_REASONS) {
    assert.ok(reason.code.trim(), "a ground with no code cannot be stored");
    assert.ok(reason.labelAr.trim() && reason.labelEn.trim(), `"${reason.code}" has no menu label`);
    assert.ok(
      reason.labelAr.length <= 30,
      `"${reason.code}" has a ${reason.labelAr.length}-character Arabic menu label. A native ` +
        "<select> is the one control the fits-the-screen rule cannot narrow, so labels stay short " +
        "and the full sentence prints on the annex instead.",
    );
  }
}

function testAChosenReasonPrintsItsClause(): void {
  const pack = packFixture({ profile: { contractObjectiveReasonCode: "annual_promotional_plan" } });
  const values = buildRenewalValues(pack, RENEWAL_ANNEX_V1);
  assert.equal(values.OBJECTIVE_REASON, PINNED_CLAUSES[0][1]);

  const html = renderContractRenewalHtml(pack, 1);
  assert.ok(
    html.includes(PINNED_CLAUSES[0][1]),
    "the chosen ground must reach the printed preamble, not just the values map",
  );
  assert.ok(
    !html.includes("annual_promotional_plan"),
    "the CODE must never reach the page. A raw identifier on an Arabic legal instrument is worse " +
      "than the blank it replaced.",
  );
}

function testAnUnknownCodePrintsBlankRatherThanItself(): void {
  // The column has no CHECK — the catalogue lives in code — so a hand-written or newer-build value
  // can be in there. It must read as "nothing chosen", never be passed through.
  const pack = packFixture({ profile: { contractObjectiveReasonCode: "something_else_entirely" } });
  const values = buildRenewalValues(pack, RENEWAL_ANNEX_V1);
  assert.equal(
    values.OBJECTIVE_REASON,
    "",
    "an unrecognised ground resolves to nothing, which prints the dotted rule",
  );

  const html = renderContractRenewalHtml(pack, 1);
  assert.ok(
    !html.includes("something_else_entirely"),
    "an unknown code must not be printed onto the instrument",
  );
  assert.ok(
    html.includes('<span class="rule-line" data-hp-key="OBJECTIVE_REASON">'),
    "it prints the same blank an unanswered ground has always printed",
  );

  assert.equal(isRenewalObjectiveReasonCode("something_else_entirely"), false);
  assert.equal(isRenewalObjectiveReasonCode(null), false);
  assert.equal(isRenewalObjectiveReasonCode("annual_promotional_plan"), true);
}

function testTheReasonIsAbsentFromTheNonRenewalNotice(): void {
  // The notice does not renew anything, so it states no ground for a term. A reason leaking onto it
  // would be an assertion about why the contract WAS fixed-term, printed on the paper that ends it.
  const pack = packFixture({ profile: { contractObjectiveReasonCode: "annual_promotional_plan" } });
  const notice = renderContractNonRenewalHtml(pack, 1);
  assert.ok(
    !notice.includes(PINNED_CLAUSES[0][1]),
    "the objective reason belongs to the annex only",
  );
}

export function runHrFormsRenewalTests(): void {
  testEveryContractReferenceResolves();
  testEveryCitationPhraseIsStillOnThePaper();
  testNoCitationPointsPastTheEndOfItsSource();
  testBothPapersAreRegisteredAndCurrent();
  testNeitherPaperRecordsASignatureAgainstThePerson();
  testTheTwoPapersAreAlternativesNotAPair();
  testTheNewTermIsDerivedFromTheOldOne();
  testAnApprovedRenewalRequestOutranksTheDerivation();
  testTheTerritoryIsBlankRatherThanTheProductLine();
  testTheNoticeDatesTheLastDayFromTheContractNotTheExit();
  testTheTwoJudgementFieldsPrintBlank();
  testTheJobTitleIsArabicOnlyWithNoEnglishFallback();
  testThePayFiguresAreTheBaseSalaryAndItsDerivedInsuranceWage();
  testBothPapersRenderCompletely();
  testTheMastheadStillMatchesTheContractItAmends();
  testTheLatinRunsArePinnedLeftToRight();
  testTheIsolatesSurviveOntoThePage();
  testTheAnnexStatesTheArticle88Warning();
  testTheNoticeSaysItIsNotADismissal();
  testEveryTokenEitherPaperUsesIsInTheUnion();
  testTheBlankRuleIsWhatAnAbsentValueLooksLike();
  testEveryObjectiveReasonClauseIsPinned();
  testTheCatalogueHasNoDuplicateOrEmptyCodes();
  testAChosenReasonPrintsItsClause();
  testAnUnknownCodePrintsBlankRatherThanItself();
  testTheReasonIsAbsentFromTheNonRenewalNotice();
}

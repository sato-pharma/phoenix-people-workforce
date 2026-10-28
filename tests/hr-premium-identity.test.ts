import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";
import { COMPANY_DETAILS_DEFAULT } from "../src/lib/hiring-pack/company-details.ts";
import { CONTRACT_TEMPLATES, currentContractTemplate } from "../src/lib/hiring-pack/contract-text.ts";
import { renderExperienceCertificateArHtml } from "../src/lib/hiring-pack/experience-certificate-ar.ts";
import { renderExperienceCertificateEnHtml } from "../src/lib/hiring-pack/experience-certificate-en.ts";
import { houseLetterhead } from "../src/lib/hiring-pack/house-identity.ts";
import {
  HR_PAPER_ABSENCE_WARNING_V1,
  HR_PAPER_ABSENCE_WARNING_V2,
  HR_PAPER_EXIT_INTERVIEW_V1,
  HR_PAPER_NDA_V1,
  HR_PAPER_SALARY_LETTER_AR_V1,
  HR_PAPERS,
} from "../src/lib/hiring-pack/hr-paper-text.ts";
import { inlineLocalAssets } from "../src/lib/hiring-pack/paper-artwork.ts";
import { isPremiumPaper } from "../src/lib/hiring-pack/paper-pdf.ts";
import { stampPaperReference } from "../src/lib/hiring-pack/paper-reference.ts";
import {
  PREMIUM_DOCUMENT_CSS,
  PREMIUM_DRESS,
  PREMIUM_IDENTITY_CODE,
  PREMIUM_IDENTITY_CSS,
  PREMIUM_LANDSCAPE_COLUMN_MM,
  PREMIUM_LANDSCAPE_MM,
  PREMIUM_PAGE_MM,
  PREMIUM_PAGE_NUMBER_SLOT,
  premiumFrameSvg,
  premiumLetterhead,
  premiumMasthead,
  premiumPageChrome,
  premiumSheetCss,
} from "../src/lib/hiring-pack/premium-identity.ts";
import {
  renderClearanceCompanyHtml,
  renderClearanceEmployeeHtml,
} from "../src/lib/hiring-pack/render-clearance.ts";
import { renderContractHtml } from "../src/lib/hiring-pack/render-contract.ts";
import {
  renderCustodyLaptopHtml,
  renderCustodyMobileHtml,
} from "../src/lib/hiring-pack/render-custody.ts";
import { renderForm1Html } from "../src/lib/hiring-pack/render-form1.ts";
import { renderForm6Html } from "../src/lib/hiring-pack/render-form6.ts";
import { renderHrPaperHtml } from "../src/lib/hiring-pack/render-hr-paper.ts";
import {
  renderMutualTerminationHtml,
  renderResignationHtml,
} from "../src/lib/hiring-pack/render-labour-exit.ts";
import {
  renderContractNonRenewalHtml,
  renderContractRenewalHtml,
} from "../src/lib/hiring-pack/render-renewal.ts";
import { renderWorkerFormHtml } from "../src/lib/hiring-pack/render-worker-form.ts";
import { renderSalaryLetterArHtml } from "../src/lib/hiring-pack/salary-letter-ar.ts";
import { renderSalaryLetterEnHtml } from "../src/lib/hiring-pack/salary-letter-en.ts";
import {
  collectHiringPackGaps,
  emptyOffboardingProfile,
  resolveContractTerms,
} from "../src/lib/hiring-pack/service.ts";
import type {
  HiringPackData,
  HiringPackEmployeeFacts,
  HiringPackProfile,
} from "../src/lib/hiring-pack/types.ts";

/**
 * THE HR PREMIUM IDENTITY — the owner's template for every normal Sato paper (2026-10-12): "make all
 * the normal templates or forms in Sato Pharma follow this perfect template. But not the
 * governmental, the governmental as they are."
 *
 * What is pinned here is what a reader of the PAPER would notice going wrong, checked on the
 * rendered HTML rather than on the module:
 *
 *   - the papers the owner answered "change" on his review page (2026-10-13, about 00:40 Cairo) wear
 *     the chrome — the frame, the watermark, the premium masthead with the band drawn as an inline
 *     vector, and the Phoenix running foot carrying the identity code — and the papers he answered
 *     "keep" print as they did before the identity existed (`PREMIUM_DRESS`, one line each to flip);
 *   - every premium branch still renders when its switch is on, so a changed mind costs one line;
 *   - an ARCHIVED version keeps the dress it was signed in, so a reprint from the Archive screen
 *     still matches the paper on file;
 *   - the employment contract keeps its corporate dress (the owner, the same evening: "the contract
 *     keep corporate as it was"), and so do the renewal annex — read stapled to the contract, with a
 *     masthead pinned identical to it — and the non-renewal notice drawn by the same renderer;
 *   - the Authority's forms never wear it;
 *   - the chrome is appended LAST in each copy, which is what keeps the owner's hand-placed stamps
 *     and signatures on their anchors;
 *   - no seal, no filled area, no rounded corner, and nothing the PDF path cannot inline.
 */

function packFixture(departed = false): HiringPackData {
  const employee: HiringPackEmployeeFacts = {
    hrId: "H-3003",
    fullName: "Nour Adel",
    nameAr: "نور عادل",
    nationalId: "29709091234567",
    gender: "female",
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
    employmentStatus: departed ? "resigned" : "active",
    lastWorkingDate: departed ? "2026-08-31" : null,
    departed,
  };
  const profile: HiringPackProfile = {
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
    contractStartDate: "2025-08-01",
    contractEndDate: "2026-07-31",
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
    contractObjectiveReasonCode: null,
    ndaSignedDate: null,
    ndaPrintedAt: null,
    updatedAt: null,
  };
  const offboarding = emptyOffboardingProfile("H-3003");
  return {
    employee,
    profile,
    offboarding,
    exit: null,
    custodyDevice: null,
    renewal: null,
    company: COMPANY_DETAILS_DEFAULT,
    suggestedJobTitleAr: null,
    gaps: collectHiringPackGaps(employee, profile, offboarding, null),
    terms: resolveContractTerms(employee, profile, offboarding, null),
  };
}

/** The engine-turned band as an inline vector element under the masthead. */
const PREMIUM_BAND = /<svg class="pm-band"[^>]*>[\s\S]*?<path d="M[^"]*Q[\s\S]*?<\/svg>/;

/**
 * THE PAPERS THE OWNER ANSWERED "CHANGE" ON — his review page, 2026-10-13 about 00:40 Cairo. The
 * English certificate of experience and the English salary letter wear it outright; the exit interview
 * is the one HR paper that does. Every other paper the pack prints is a "keep" — except two he had
 * ticked "keep" and moved to the certificate's own design on 2026-10-28: the Arabic certificate of
 * experience ("make this the certificate of experience in the hr forms module") and the Arabic salary
 * letter ("Make it the HR letter", both languages). They wear the identity through their own renderers
 * (`experience-certificate-ar.ts`, `salary-letter-ar.ts`) rather than through a switch.
 */
const CHANGED_PAPERS = [
  "certificate of experience (English)",
  "certificate of experience (Arabic)",
  "salary letter (English)",
  "salary letter (Arabic)",
  "exit-interview-v1",
];

/**
 * Renders under every paper's premium switch ON, then puts the owner's answers back. The switches
 * exist so a changed mind is one line — this is what proves the branch behind each one still draws.
 */
function withEveryPaperPremium<T>(run: () => T): T {
  const saved = {
    clearance: PREMIUM_DRESS.clearance,
    custody: PREMIUM_DRESS.custody,
    workerForm: PREMIUM_DRESS.workerForm,
    hrPapers: new Set(PREMIUM_DRESS.hrPapers),
  };
  PREMIUM_DRESS.clearance = true;
  PREMIUM_DRESS.custody = true;
  PREMIUM_DRESS.workerForm = true;
  for (const paper of HR_PAPERS) PREMIUM_DRESS.hrPapers.add(paper.id.replace(/-v\d+$/, ""));
  try {
    return run();
  } finally {
    PREMIUM_DRESS.clearance = saved.clearance;
    PREMIUM_DRESS.custody = saved.custody;
    PREMIUM_DRESS.workerForm = saved.workerForm;
    PREMIUM_DRESS.hrPapers.clear();
    for (const family of saved.hrPapers) PREMIUM_DRESS.hrPapers.add(family);
  }
}

function assertPremiumPaper(name: string, html: string): void {
  assert.ok(isPremiumPaper(html), `${name}: the premium page chrome is missing`);
  assert.ok(/<header class="pm-mast[ "]/.test(html), `${name}: the premium masthead is missing`);
  assert.ok(PREMIUM_BAND.test(html), `${name}: the band must be drawn as an inline vector, never a CSS tile`);
  assert.ok(html.includes('<svg class="pm-frame"'), `${name}: the security frame is missing`);
  assert.ok(html.includes('class="pm-watermark"'), `${name}: the watermark is missing`);
  // THE ARABIC LOGO IS THE WATERMARK AND NOTHING ELSE — never the masthead (owner, 2026-10-12:
  // "make the arabic sato logo only as water mark … everywhere", then "watermark and footer only").
  const mastheads = html.match(/<header class="pm-mast[ "][\s\S]*?<\/header>/g) ?? [];
  assert.ok(mastheads.length > 0, `${name}: the masthead was read, so the next check tests something`);
  for (const mast of mastheads) {
    assert.ok(!mast.includes("sato-pharma-arabic"), `${name}: the Arabic logo is never in the masthead`);
  }
  // Its empty right column MIRRORS the left, so the title sits on the page's centre line — and the
  // fixed widths still add up to what they were with the mark there (66 mm, 58 mm compact), so the
  // title column is exactly as wide and wraps on the same words: no paper can grow a line.
  for (const [rule, fixed] of [[/\.pm-mast \{[^}]*\}/, 66], [/\.pm-mast--compact \{[^}]*\}/, 58]] as const) {
    const css = rule.exec(html)?.[0] ?? "";
    const cols = /grid-template-columns:\s*([\d.]+)mm 1fr ([\d.]+)mm/.exec(css);
    const gap = Number(/column-gap:\s*([\d.]+)mm/.exec(/\.pm-mast \{[^}]*\}/.exec(html)?.[0] ?? "")?.[1]);
    assert.ok(cols && Number.isFinite(gap), `${name}: the masthead grid was read, so the next checks test something`);
    assert.equal(cols[1], cols[2], `${name}: the masthead's right column mirrors the left, so the title is centred on the page`);
    assert.equal(Number(cols[1]) + Number(cols[2]) + 2 * gap, fixed, `${name}: the title column keeps its old width, so no title rewraps`);
  }
  assert.equal(
    (html.match(/sato-pharma-arabic/g) ?? []).length,
    (html.match(/<img class="pm-watermark" src="\/brand\/sato-pharma-arabic-on-light\.png"/g) ?? []).length,
    `${name}: every Arabic logo on the paper is a watermark`,
  );
  assert.ok(html.includes(PREMIUM_IDENTITY_CODE), `${name}: the running foot must carry the identity code`);
  assert.ok(html.includes("/brand/phoenix-login-emblem.png"), `${name}: the Phoenix emblem leads the foot`);
  assert.ok(html.includes("/brand/sato-pharma-logo-on-light.svg"), `${name}: always the on-light mark`);
  assert.ok(html.includes("@page { size: A4; margin: 0; }"), `${name}: the sheet draws its own frame edge to edge`);
  assert.equal((html.match(/class="phx-seal"/g) ?? []).length, 0, `${name}: no seal on a hiring paper`);
  assert.ok(!html.includes("sato-hr-seal"), `${name}: not even a reference to the seal artwork`);
  // A `border-radius: 0` reset is square-keeping (the English certificate carries one); any other value is not.
  assert.ok(!/border-radius\s*:(?!\s*0(?:px|mm)?\s*(?:!important)?\s*[;}])/.test(html), `${name}: square corners only`);
  assert.deepEqual(inlineLocalAssets(html).missing, [], `${name}: the PDF path must be able to inline every image`);
}

/** Every paper the pack prints TODAY, rendered the way the print route renders it, under the dress now set. */
function currentNormalPapers(): ReadonlyArray<readonly [string, string]> {
  const live = packFixture();
  const left = packFixture(true);
  const papers: Array<readonly [string, string]> = [
    ["employee clearance", renderClearanceEmployeeHtml(left, 2)],
    ["company clearance", renderClearanceCompanyHtml(left, 2)],
    ["laptop custody receipt", renderCustodyLaptopHtml(live, 2)],
    ["phone custody receipt", renderCustodyMobileHtml(live, 2)],
    ["worker data form", renderWorkerFormHtml(live, 2)],
    ["certificate of experience (English)", renderExperienceCertificateEnHtml(left, 2)],
    ["salary letter (English)", renderSalaryLetterEnHtml(live, 2)],
  ];
  // The highest version of each HR paper is the one the print route passes as the paper asked for —
  // an archived one only ever arrives as a requested id beside it. (`kind` is the paper's LAYOUT, so
  // the family is the id without its version.)
  const currentByFamily = new Map<string, (typeof HR_PAPERS)[number]>();
  for (const paper of HR_PAPERS) {
    const family = paper.id.replace(/-v\d+$/, "");
    const held = currentByFamily.get(family);
    if (!held || held.version < paper.version) currentByFamily.set(family, paper);
  }
  for (const paper of currentByFamily.values()) {
    // The certificate of experience and the salary letter are the two HR papers the print route hands
    // to their own renderers (`render-paper.ts`), in the certificate's design since 2026-10-28.
    if (paper.kind === "certificate") {
      papers.push(["certificate of experience (Arabic)", renderExperienceCertificateArHtml(left, 2)]);
      continue;
    }
    if (paper.kind === "salaryLetter") {
      papers.push(["salary letter (Arabic)", renderSalaryLetterArHtml(live, 2)]);
      continue;
    }
    papers.push([paper.id, renderHrPaperHtml(live, 2, paper)]);
  }
  return papers;
}

function testThePapersTheOwnerSaidChangeWearThePremiumIdentity(): void {
  const worn = currentNormalPapers().filter(([, html]) => isPremiumPaper(html));
  assert.deepEqual(
    worn.map(([name]) => name).sort(),
    [...CHANGED_PAPERS].sort(),
    "exactly the papers he answered 'change' wear the premium identity — no more, no fewer",
  );
  for (const [name, html] of worn) assertPremiumPaper(name, html);
}

/**
 * THE PAPERS HE ANSWERED "KEEP" PRINT AS THEY DID BEFORE THE IDENTITY (13 October 2026). The switch
 * table is his answers, pinned: flipping an entry is a decision of his, never a tidy-up.
 */
function testThePapersTheOwnerSaidKeepPrintAsToday(): void {
  assert.deepEqual(
    { clearance: PREMIUM_DRESS.clearance, custody: PREMIUM_DRESS.custody, workerForm: PREMIUM_DRESS.workerForm },
    { clearance: false, custody: false, workerForm: false },
    "the clearance forms, the custody receipts and the worker data form were answered 'keep'",
  );
  assert.deepEqual([...PREMIUM_DRESS.hrPapers], ["exit-interview"], "of the HR papers only the exit interview was answered 'change'");

  const papers = currentNormalPapers();
  assert.equal(papers.length, 24, "seven pack papers and the seventeen current HR papers (nineteen less two archived versions)");
  const kept = papers.filter(([name]) => !CHANGED_PAPERS.includes(name));
  assert.equal(kept.length, 19, "twenty-four papers less the five that wear the identity");
  for (const [name, html] of kept) {
    assert.ok(!isPremiumPaper(html), `${name}: he said keep, so it carries no premium page chrome`);
    assert.ok(!/\bpm-[a-z]/.test(html), `${name}: he said keep, so no premium class is on it`);
    assert.ok(!html.includes(PREMIUM_IDENTITY_CODE + "</div>"), `${name}: he said keep, so no premium running foot`);
  }
}

/** Every renderer's premium branch still draws when its switch is on — a changed mind is one line. */
function testEveryPremiumBranchStillRendersWhenItsSwitchIsOn(): void {
  withEveryPaperPremium(() => {
    const papers = currentNormalPapers();
    assert.equal(papers.length, 24);
    for (const [name, html] of papers) assertPremiumPaper(name, html);
  });
  assert.equal(PREMIUM_DRESS.clearance, false, "the owner's answers are put back after the proof");
  assert.deepEqual([...PREMIUM_DRESS.hrPapers], ["exit-interview"]);
}

/**
 * THE CHROME IS THE LAST CHILD OF EVERY COPY.
 *
 * Hand-placed stamps and signatures are anchored by positional paths measured inside a copy —
 * `article:nth-of-type(1) > section:nth-of-type(2)` on the English certificate (live on 2026-10-12),
 * `section:nth-of-type(2) > div:nth-of-type(1) > span:nth-of-type(3)` — the stamp box — on both
 * certificates of experience since their shared design, and `… > span:nth-of-type(2)` — the signature
 * box — on the Arabic salary letter in the same design (both 2026-10-28). Chrome added in front of
 * them would move every one. So in each copy, nothing the paper says may follow it.
 */
function testTheChromeIsAppendedLastInEveryCopy(): void {
  withEveryPaperPremium(() => {
    for (const [name, html] of currentNormalPapers()) {
      const copies = html.split(/<article class="/).slice(1);
      assert.ok(copies.length >= 2, `${name}: two copies were asked for`);
      for (const copy of copies) {
        const body = copy.slice(0, copy.indexOf("</article>"));
        const chrome = body.indexOf('<div class="pm-chrome"');
        assert.ok(chrome > 0, `${name}: every copy carries the chrome`);
        const after = body.slice(chrome);
        assert.ok(
          !/<(?:table|section|p|h1|h2)[\s>]/.test(after),
          `${name}: the paper's own content follows the chrome — a placed stamp's anchor would move`,
        );
      }
      // On paper only the first copy's chrome is shown: it is fixed, and Chrome repeats it on every page.
      assert.ok(/~ [.a-z-]+ \.pm-chrome \{ display: none; \}/.test(html), `${name}: one frame per printed page, not one per copy`);
    }
  });
}

function testAnArchivedVersionKeepsTheDressItWasSignedIn(): void {
  const live = packFixture();
  // The first absence warning was answered 'keep' — its switch goes on for this proof only.
  withEveryPaperPremium(() => {
    const warning = renderHrPaperHtml(live, 1, HR_PAPER_ABSENCE_WARNING_V2, HR_PAPER_ABSENCE_WARNING_V1.id);
    assert.ok(warning.includes(HR_PAPER_ABSENCE_WARNING_V1.titleAr), "the archived warning is the one printed");
    assert.ok(!warning.includes("pm-"), "an archived HR paper keeps its house dress");
    assert.ok(isPremiumPaper(renderHrPaperHtml(live, 1, HR_PAPER_ABSENCE_WARNING_V2)), "the current one wears the premium identity");
  });
}

/**
 * THE CONTRACT KEEPS ITS CORPORATE DRESS — the owner, 2026-10-12, while the premium identity was being
 * rolled out: "the contract keep corporate as it was". Every version of it, current and archived.
 *
 * The renewal annex goes with it: it is read stapled to the contract it amends, and
 * `tests/hr-forms-renewal.test.ts` pins its masthead byte-identical to the contract's. The
 * non-renewal notice is drawn by the same renderer from the same furniture, so it stays with them.
 */
function testTheContractKeepsItsCorporateDress(): void {
  const live = packFixture();
  const papers: Array<readonly [string, string]> = [
    ["renewal annex", renderContractRenewalHtml(live, 2)],
    ["non-renewal notice", renderContractNonRenewalHtml(live, 2)],
  ];
  assert.ok(CONTRACT_TEMPLATES.some((template) => template.id === currentContractTemplate().id));
  for (const template of CONTRACT_TEMPLATES) {
    papers.push([`contract ${template.id}`, renderContractHtml(live, 2, template.id)]);
  }
  for (const [name, html] of papers) {
    assert.ok(!html.includes("pm-"), `${name} keeps the corporate dress — no premium chrome or masthead`);
    assert.ok(!html.includes(PREMIUM_IDENTITY_CODE + "</div>"), `${name} carries no premium running foot`);
  }
  for (const file of ["render-contract.ts", "render-renewal.ts"]) {
    const source = stripComments(readFileSync(`src/lib/hiring-pack/${file}`, "utf8"));
    assert.ok(!source.includes("premium-identity"), `${file} must not import the premium identity while the contract stays corporate`);
  }
}

function testTheAuthoritysFormsNeverWearIt(): void {
  const live = packFixture();
  const left = packFixture(true);
  const forms: ReadonlyArray<readonly [string, string]> = [
    ["Form 1", renderForm1Html(live, 1)],
    ["Form 6", renderForm6Html(left, 1)],
    ["resignation request", renderResignationHtml(left, 1)],
    ["mutual termination", renderMutualTerminationHtml(left, 1)],
  ];
  for (const [name, html] of forms) {
    assert.ok(!html.includes("pm-"), `${name} prints as the Authority issues it — no premium chrome`);
    assert.ok(!html.includes(PREMIUM_IDENTITY_CODE), `${name} carries no Sato identity code`);
  }
  for (const file of [
    "render-form1.ts",
    "render-form6.ts",
    "render-labour-exit.ts",
    "render-official-form.ts",
    "render-placement.ts",
  ]) {
    const source = stripComments(readFileSync(`src/lib/hiring-pack/${file}`, "utf8"));
    assert.ok(!source.includes("premium-identity"), `${file} must never import the premium identity`);
  }
}

/** THE INK RULE: rules and type only. The watermark is an image and the corner tiles a knock-out. */
function testThePremiumStylesheetsPaintNoArea(): void {
  for (const [name, css] of [
    ["PREMIUM_IDENTITY_CSS", PREMIUM_IDENTITY_CSS],
    ["PREMIUM_DOCUMENT_CSS", PREMIUM_DOCUMENT_CSS],
  ] as const) {
    assert.ok(!/background/.test(css), `${name} paints a background — the ink rule allows none`);
    assert.ok(!/radius/.test(css), `${name} mentions a radius — square by absence`);
    assert.ok(!/box-shadow|gradient/.test(css), `${name} draws depth the identity does not have`);
  }
}

/**
 * THE FRAME'S MICROTEXT IS LATIN AND LEFT-TO-RIGHT. `textLength` spaces letters to the side's length,
 * which would break Arabic joins, and on a right-to-left paper an SVG text run without `direction`
 * anchors its END at x — the microtext ran off the sheet and the frame printed with empty channels.
 */
function testTheFrameMicrotextIsLatinAndPinned(): void {
  const frame = premiumFrameSvg();
  assert.ok(frame.includes('direction="ltr"'), "the microtext group must be pinned left-to-right");
  assert.ok(!/[؀-ۿ]/.test(frame), "no Arabic in the frame's microtext");
  assert.equal((frame.match(/<text /g) ?? []).length, 4, "one run down each of the four sides");
  assert.equal((frame.match(/textLength=/g) ?? []).length, 4, "each run fitted to its side");
  // A fixed element's transformed children paint on the FIRST printed page only: rotated side runs and
  // turned pips left page two of every multi-page paper with empty channels and hollow corners.
  assert.ok(!frame.includes("transform"), "nothing in the frame may be transformed — it would vanish after page one");
  assert.equal((frame.match(/<textPath href="#pm-frame-(?:left|right)">/g) ?? []).length, 2, "the side runs lie on paths");
  assert.equal((frame.match(/<polygon /g) ?? []).length, 4, "one diamond pip per corner tile");
}

function testTheReferenceNumberGoesIntoTheSlot(): void {
  const html = renderHrPaperHtml(packFixture(), 1, HR_PAPER_EXIT_INTERVIEW_V1);
  const numbered = stampPaperReference(html, "HR-2026-000123", "exitInterview");
  assert.match(
    numbered,
    /<span class="pm-mast__ref" dir="rtl"><span class="hp-ref" data-hp-ref="HR-2026-000123">/,
    "the number is written into the premium masthead's slot",
  );
  assert.ok(!numbered.includes('class="hp-ref hp-ref--fixed"'), "never as a loose line in the corner, which sits on the frame");
}

/**
 * The letterhead papers keep every word the house letterhead gave them — the title, the subtitle and
 * the "who keeps this copy" band — and the house letterhead itself is untouched (its bytes are pinned
 * by `tests/payslip-document.test.ts`, and the payslip still wears it).
 */
function testThePremiumLetterheadKeepsEveryWord(): void {
  const input = {
    titleAr: "إخلاء طرف",
    subtitleAr: "محرر طبقاً لقانون العمل",
    purposeAr: "نسخة العامل",
    legalNameAr: "شركة ساتو فارما",
    legalNameEn: "Sato Pharma",
  };
  const premium = premiumLetterhead(input);
  for (const words of [input.titleAr, input.subtitleAr, input.legalNameAr, input.legalNameEn]) {
    assert.ok(premium.includes(words), `the premium letterhead dropped "${words}"`);
  }
  assert.ok(premium.includes(`<p class="lh__purpose">${input.purposeAr}</p>`), "the purpose band keeps its exact markup");
  assert.ok(houseLetterhead(input).includes('<header class="lh">'), "the house letterhead is unchanged");

  const english = premiumLetterhead({ ...input, titleEn: "Clearance", subtitleEn: "Issued today", purposeEn: "Employee copy" });
  assert.ok(english.includes('<h1 class="pm-mast__t pm-mast__t--en" dir="ltr" lang="en">Clearance</h1>'), "an English title leads");
  assert.ok(english.includes('<p class="pm-mast__tar" dir="rtl" lang="ar">إخلاء طرف</p>'), "with the Arabic name under it");
}

/**
 * THE ARABIC SALARY LETTER'S OLD DRESS STILL FITS ONE SHEET UNDER THE PREMIUM SWITCH. The current
 * letter is drawn in the certificate's design (`salary-letter-ar.ts`, 2026-10-28); the house papers'
 * renderer still draws an archived version in the dress it was signed in, and that dress's sheet is
 * stretched to the printable height (the owner, 2026-09-20). Under the premium sheet that height is
 * 297 mm less the 12.5 mm top and 19.5 mm bottom insets. One millimetre over prints a second, empty page.
 */
function testTheSalaryLetterSheetFitsThePremiumPage(): void {
  // The branch behind the house renderer's switch, for this letter.
  const html = withEveryPaperPremium(() => renderHrPaperHtml(packFixture(), 1, HR_PAPER_SALARY_LETTER_AR_V1));
  const heights = [...html.matchAll(/\.copy--salaryLetter \.doc-sheet \{ height: (\d+(?:\.\d+)?)mm; \}/g)].map(
    (match) => Number(match[1]),
  );
  assert.ok(heights.length >= 2, "the premium sheet height must be stated after the house one");
  const premium = heights[heights.length - 1];
  const printable = PREMIUM_PAGE_MM.height - PREMIUM_PAGE_MM.top - PREMIUM_PAGE_MM.bottom;
  assert.ok(premium <= printable - 1, `${premium}mm must sit inside the ${printable}mm printable height`);
  assert.ok(premium >= printable - 6, `${premium}mm must still fill the page — the lower half was empty once`);
}

/** The filed PDF writes "N / M" where the foot's diamond stands — at the right edge of the column. */
function testThePageNumberSlotIsTheFootsRightEnd(): void {
  assert.equal(PREMIUM_PAGE_NUMBER_SLOT.rightMm, PREMIUM_PAGE_MM.side);
  assert.ok(PREMIUM_PAGE_NUMBER_SLOT.centreFromBottomMm > 8.8, "above the frame's inner keyline");
  assert.ok(
    PREMIUM_PAGE_NUMBER_SLOT.centreFromBottomMm < PREMIUM_PAGE_MM.bottom,
    "below the last line of the paper's own content",
  );
  assert.ok(
    PREMIUM_IDENTITY_CSS.includes("html[data-pm-numbered] .pm-foot__dia { visibility: hidden; }"),
    "on a filed PDF the foot's diamond must step aside, or the number is written over it",
  );
}

/**
 * THE CHROME CAN TURN ON ITS SIDE AND CAN LEAVE PHOENIX OUT — the two options the interview calendar,
 * the field-activity report, the payslip, the organogram record and the job offer need. The default
 * call is the portrait, Phoenix-footed chrome every HR paper prints, unchanged.
 */
function testThePremiumChromeTurnsOnItsSideAndCanLeavePhoenixOut(): void {
  const portrait = premiumPageChrome();
  assert.ok(portrait.includes('viewBox="0 0 210 297"'), "the default frame is the portrait sheet");
  assert.ok(portrait.includes("Phoenix Workforce") && portrait.includes("/brand/phoenix-login-emblem.png"), "the default foot is the approved Phoenix one");
  assert.ok(!portrait.includes("pm-chrome--landscape"));

  const landscape = premiumPageChrome({ orientation: "landscape", brand: "sato" });
  assert.ok(landscape.includes('<div class="pm-chrome pm-chrome--landscape"'), "the chrome says it is landscape");
  assert.ok(landscape.includes(`viewBox="0 0 ${PREMIUM_LANDSCAPE_MM.width} ${PREMIUM_LANDSCAPE_MM.height}"`), "the frame is drawn on the turned sheet");
  assert.equal(PREMIUM_LANDSCAPE_MM.width, PREMIUM_PAGE_MM.height, "the same sheet, turned");
  assert.ok(!/phoenix/i.test(landscape), "a Sato-only foot says nothing of Phoenix — not the label, the emblem or the microtext");
  assert.ok(landscape.includes(PREMIUM_IDENTITY_CODE), "it still carries the identity code");
  assert.ok(/pm-chrome--landscape \.pm-frame \{ width: 297mm; height: 210mm; \}/.test(PREMIUM_IDENTITY_CSS), "the stylesheet sizes the turned frame");
  assert.ok(premiumFrameSvg(undefined, "landscape").includes('viewBox="0 0 297 210"'));

  const mast = premiumMasthead({
    legalNameAr: "شركة ساتو فارما", title: "Field Activity", titleLang: "en", slim: true, orientation: "landscape",
  });
  assert.ok(mast.includes('class="pm-mast pm-mast--compact pm-mast--slim"'), "slim is the tightest masthead");
  assert.ok(mast.includes(`viewBox="0 0 ${PREMIUM_LANDSCAPE_COLUMN_MM} `), "the band runs the wider column of the turned sheet");
  assert.ok(!mast.includes("sato-pharma-arabic"), "the Arabic logo is still never in a masthead");

  assert.ok(premiumSheetCss(".x", "landscape").includes("@page { size: A4 landscape; margin: 0; }"));
  assert.ok(premiumSheetCss(".x").includes("@page { size: A4; margin: 0; }"), "portrait stays the default");
}

export function runHrPremiumIdentityTests(): void {
  testThePremiumChromeTurnsOnItsSideAndCanLeavePhoenixOut();
  testThePapersTheOwnerSaidChangeWearThePremiumIdentity();
  testThePapersTheOwnerSaidKeepPrintAsToday();
  testEveryPremiumBranchStillRendersWhenItsSwitchIsOn();
  testTheChromeIsAppendedLastInEveryCopy();
  testAnArchivedVersionKeepsTheDressItWasSignedIn();
  testTheContractKeepsItsCorporateDress();
  testTheAuthoritysFormsNeverWearIt();
  testThePremiumStylesheetsPaintNoArea();
  testTheFrameMicrotextIsLatinAndPinned();
  testTheReferenceNumberGoesIntoTheSlot();
  testThePremiumLetterheadKeepsEveryWord();
  testTheSalaryLetterSheetFitsThePremiumPage();
  testThePageNumberSlotIsTheFootsRightEnd();
}

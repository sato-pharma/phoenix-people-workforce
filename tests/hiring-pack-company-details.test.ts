import { strict as assert } from "node:assert";

import { systemLegalEntity } from "../src/config/system-settings.ts";
import {
  COMPANY_DETAIL_FIELDS,
  COMPANY_DETAIL_KEYS,
  COMPANY_DETAILS_DEFAULT,
  companyDetailDefaults,
  flattenCompanyDetails,
  isCompanyDetailKey,
  resolveCompanyDetails,
  type CompanyDetailKey,
  type CompanyDetails,
} from "../src/lib/hiring-pack/company-details.ts";
import {
  PAPER_FIELD_BINDINGS,
  paperFieldBinding,
  paperFieldCurrentValue,
  paperStoreUrl,
} from "../src/lib/hiring-pack/paper-fields.ts";
import { renderContractHtml } from "../src/lib/hiring-pack/render-contract.ts";
import { renderForm1Html } from "../src/lib/hiring-pack/render-form1.ts";
import {
  renderMutualTerminationHtml,
  renderResignationHtml,
} from "../src/lib/hiring-pack/render-labour-exit.ts";
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
 * THE COMPANY'S OWN DETAILS, EDITABLE ON THE PAPER.
 *
 * The owner's instruction, 2026-09-06: the head office address on the HR forms must be editable, and
 * "every single thing should be editable". Until then `systemLegalEntity` was a compiled constant
 * that nine renderers imported directly, so the only way to correct the address on a signed contract
 * was a code change, a PR and a deploy.
 *
 * Every way of getting this wrong prints a paper that looks right:
 *
 *   - RESOLVE IT AND FORGET TO PRINT IT. A stored override that reaches the pack but not the page is
 *     the original defect back again — "I edit and save, and printing shows the old value". So the
 *     load-bearing checks below render the ACTUAL HTML and read the address out of it, rather than
 *     asserting on the resolver that produced it. This repository has shipped three defects in one
 *     night from testing the source instead of the emitted artifact.
 *   - SAVE IT TO THE WRONG SCOPE. Pointing the head office at the employee record would compile,
 *     save, return 200, and leave two employees' contracts naming different addresses for one
 *     company. Nothing on screen would show it.
 *   - SAVE IT TO THE WRONG PLACE ENTIRELY. `paperStoreEndpoint` answered `""` for any store it did
 *     not recognise, which for the company store means POSTing the company's address to the
 *     employee's own profile endpoint: accepted, 200, stored nowhere.
 *   - COLLAPSE THE TWO HEAD OFFICES. The short form and the contract recital's written-out form are
 *     two different registered facts, and merging them is the obvious tidy-up.
 *   - LOSE THE DEFAULT. With nothing stored, every paper must print exactly what it printed before
 *     this feature existed — the table is absent in production until a migration is applied.
 */

// ---------------------------------------------------------------------------------------------
// Fixtures — the same hire the rest of the HR Forms suites use.
// ---------------------------------------------------------------------------------------------

function employeeFixture(
  overrides: Partial<HiringPackEmployeeFacts> = {},
): HiringPackEmployeeFacts {
  return {
    hrId: "H-2001",
    fullName: "Omar Sample",
    nameAr: "عمر عينة",
    nationalId: "29001011200123",
    gender: null,
    socialInsuranceNumber: "123456789",
    socialInsuranceWage: 4500,
    baseSalary: 12750,
    grossSalary: 16000,
    birthDate: "1990-01-01",
    hireDate: "2026-03-01",
    jobTitle: "Medical Rep",
    departmentAr: "المبيعات",
    departmentId: 1,
    lineId: 3,
    residenceAddress: "12 شارع النيل، المعادي",
    residenceCity: "القاهرة",
    mobileNumber: "01001234567",
    workEmail: "omar@satopharma.com",
    employmentStatus: "active",
    departed: false,
    lastWorkingDate: null,
    ...overrides,
  };
}

function profileFixture(overrides: Partial<HiringPackProfile> = {}): HiringPackProfile {
  return {
    hrId: "H-2001",
    nationality: "مصرية",
    qualification: "بكالوريوس صيدلة",
    birthPlace: "القاهرة",
    jobTitleAr: "مندوب دعاية طبية",
    occupationCode: "123456",
    insuranceOffice: "المعادي",
    addressBuilding: "12",
    addressDistrict: "01",
    addressStreet: "شارع النيل",
    addressMarkaz: "02",
    addressGovernorate: "01",
    contractDurationMonths: null,
    contractStartDate: "2026-03-01",
    contractEndDate: null,
    underperformanceThresholdPct: null,
    underperformanceMonths: null,
    trainingBondMonths: null,
    notes: "internal only",
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
    ...overrides,
  };
}

function packWith(company: CompanyDetails): HiringPackData {
  const employee = employeeFixture();
  const profile = profileFixture();
  const offboarding = {
    ...emptyOffboardingProfile("H-2001"),
    lastWorkingDate: "2026-09-30",
    endReasonAr: "استقالة",
  };
  return {
    employee,
    profile,
    offboarding,
    company,
    exit: null,
    renewal: null,
    suggestedJobTitleAr: null,
    gaps: collectHiringPackGaps(employee, profile, offboarding, null, company),
    terms: resolveContractTerms(employee, profile, offboarding, null, company),
  };
}

/** The address the owner asked to be able to change, and a replacement nothing else could produce. */
const EDITED_HEAD_OFFICE = "الجيزة – 42 ش التحرير، الدقي – قسم الدقي – الجيزة";

export function runHiringPackCompanyDetailsTests() {
  // ── 1. Nothing stored prints exactly what the code ships ─────────────────────────────────────
  //
  // The table does not exist in production until a migration is applied, and `loadCompanyDetails`
  // answers `{}` in that window rather than throwing. This is what that window prints.
  {
    const defaults = companyDetailDefaults();
    assert.equal(defaults.headOfficeAr, systemLegalEntity.headOfficeAr);
    assert.equal(defaults.legalNameAr, systemLegalEntity.legalNameAr);
    assert.equal(defaults.legalNameEn, systemLegalEntity.legalNameEn);
    assert.equal(defaults.contractCityAr, systemLegalEntity.contractCityAr);
    assert.equal(defaults.responsibleManagerAr, systemLegalEntity.responsibleManagerAr);
    assert.equal(
      defaults.insuranceEstablishmentNumber,
      systemLegalEntity.registration.insuranceEstablishmentNumber,
    );
    assert.equal(
      defaults.taxRegistrationNumber,
      systemLegalEntity.registration.taxRegistrationNumber,
    );
    assert.equal(
      defaults.recitalHeadOfficeAr,
      systemLegalEntity.contractRecital.headOfficeAr,
      "the recital's written-out address is its own value and must not resolve to the short one",
    );
    assert.equal(
      defaults.unifiedRegisterNumber,
      systemLegalEntity.contractRecital.unifiedRegisterNumber,
    );

    // Every key, not just the ones spelled out above — a key added to the catalogue with a fallback
    // pointing at the wrong constant would print another company value under the wrong label.
    assert.equal(
      COMPANY_DETAIL_KEYS.length,
      Object.keys(defaults).length,
      "companyDetailDefaults must answer for every key in the catalogue",
    );
    for (const key of COMPANY_DETAIL_KEYS) {
      assert.equal(
        defaults[key],
        COMPANY_DETAIL_FIELDS[key].fallback,
        `${key} must default to its own compiled constant`,
      );
      assert.ok(COMPANY_DETAIL_FIELDS[key].labelEn, `${key} needs an English label`);
      assert.ok(
        COMPANY_DETAIL_FIELDS[key].alsoOn,
        `${key} changes every employee's papers and must say so — the editor reports scope from alsoOn`,
      );
    }
  }

  // ── 2. Resolve and flatten are inverses ──────────────────────────────────────────────────────
  //
  // NOT A TAUTOLOGY. The editor reads a key's current value by FLATTENING the pack it already holds,
  // while the paper prints from the NESTED record the resolver built. If the two ever disagree about
  // where a key lives, clicking a value opens the edit box showing something other than what is on
  // the page — which is the defect this whole screen exists to remove.
  {
    const overrides: Partial<Record<CompanyDetailKey, string>> = {};
    for (const key of COMPANY_DETAIL_KEYS) overrides[key] = `probe:${key}`;

    const flat = flattenCompanyDetails(resolveCompanyDetails(overrides));
    for (const key of COMPANY_DETAIL_KEYS) {
      assert.equal(flat[key], `probe:${key}`, `${key} does not survive resolve → flatten`);
    }

    // And with nothing overridden the round trip still names every key.
    const bare = flattenCompanyDetails(COMPANY_DETAILS_DEFAULT);
    assert.deepEqual(
      Object.keys(bare).sort(),
      [...COMPANY_DETAIL_KEYS].sort(),
      "flattenCompanyDetails must answer for exactly the catalogue's keys",
    );
  }

  // ── 3. An empty string is a deliberate blank, a missing key is the default ───────────────────
  //
  // The distinction carries the reset path. `registration.defaultInsuranceOffice` ships blank on
  // purpose so Form 1 prints a visible gap for the clerk; if `""` were treated as "no answer" that
  // gap could never be reproduced, and resetting a value would be impossible to express.
  {
    const blanked = resolveCompanyDetails({ headOfficeAr: "" });
    assert.equal(blanked.headOfficeAr, "", "an empty override must print as a blank, not as the default");

    const untouched = resolveCompanyDetails({ legalNameAr: "شركة أخرى" });
    assert.equal(
      untouched.headOfficeAr,
      systemLegalEntity.headOfficeAr,
      "a key with no override must fall back to the compiled constant",
    );
    assert.equal(untouched.legalNameAr, "شركة أخرى");
  }

  // ── 4. THE EDIT REACHES THE PRINTED PAGE ─────────────────────────────────────────────────────
  //
  // The one that matters. Read out of the rendered HTML of three different papers — the contract
  // (typeset prose), Form 1 (values placed over artwork by coordinate) and the Ministry of Labour
  // resignation (a third mechanism again) — because a resolver that is right and a renderer that
  // still imports the constant look identical from anywhere else.
  {
    // WHICH PAPER PRINTS WHICH ADDRESS IS NOT INTERCHANGEABLE, and this test found that out the
    // hard way: the CURRENT contract (v4) states the registered address written out in full
    // (`COMPANY_HEAD_OFFICE_FULL`), and only the archived v1 ever printed the short form. The
    // government forms print the short one. So each is asserted on the paper that actually carries
    // it — an assertion pointed at the wrong paper fails whether or not the feature works, and the
    // obvious "fix" is to weaken it.
    const shortEdited = packWith(resolveCompanyDetails({ headOfficeAr: EDITED_HEAD_OFFICE }));

    const form1 = renderForm1Html(shortEdited, 1);
    assert.ok(
      form1.includes(EDITED_HEAD_OFFICE),
      "Form 1's back-page إقرار must print the edited head office",
    );
    assert.ok(
      !form1.includes(systemLegalEntity.headOfficeAr),
      "Form 1 must NOT still carry the compiled head office — that is the renderer reading the constant",
    );

    const mutual = renderMutualTerminationHtml(shortEdited, 1);
    assert.ok(
      mutual.includes(EDITED_HEAD_OFFICE),
      "the Ministry of Labour mutual-termination agreement must print the edited head office",
    );

    // The resignation prints NEITHER the company's name nor its address — it is addressed to a
    // person. What it does carry from the company record is the responsible manager, who is the
    // default addressee when the offboarding record names nobody. Asserting an address it never
    // prints would pin a fiction, and pinning the value it DOES carry is the point of naming three
    // different papers here: three mechanisms, three separate chances for one to keep reading the
    // module constant.
    const resignation = renderResignationHtml(
      packWith(resolveCompanyDetails({ responsibleManagerAr: "الدكتور/ مدير مختلف" })),
      1,
    );
    assert.ok(
      resignation.includes("الدكتور/ مدير مختلف"),
      "the resignation must be addressed to the edited responsible manager",
    );

    const recitalEdited = packWith(
      resolveCompanyDetails({ recitalHeadOfficeAr: "وحدة رقم 9، عمارة رقم 3، شارع مختلف تمامًا" }),
    );
    const contract = renderContractHtml(recitalEdited, 1);
    assert.ok(
      contract.includes("وحدة رقم 9، عمارة رقم 3، شارع مختلف تمامًا"),
      "the contract's recital must print the edited registered address",
    );
    assert.ok(
      !contract.includes(systemLegalEntity.contractRecital.headOfficeAr),
      "the contract must NOT still carry the compiled registered address",
    );

    // The company NAME travels the same way, and it reaches the letterhead as well as the prose —
    // the masthead is not a click target, but it must follow the record like everything else.
    const renamed = packWith(resolveCompanyDetails({ legalNameAr: "شركة ساتو فارما (تجريبي)" }));
    const renamedContract = renderContractHtml(renamed, 1);
    assert.ok(
      renamedContract.includes("شركة ساتو فارما (تجريبي)"),
      "the contract's masthead and recital must both follow an edited company name",
    );
  }

  // ── 5. A company edit is saved company-wide, and to the company's own endpoint ───────────────
  {
    for (const [key, binding] of Object.entries(PAPER_FIELD_BINDINGS)) {
      if (binding.store !== "company") continue;
      assert.ok(
        isCompanyDetailKey(binding.field),
        `${key} names company value "${binding.field}", which the catalogue does not carry`,
      );
    }

    // THE ROUTE IS NOT UNDER THE EMPLOYEE'S PATH. A company value posted to `/api/hiring-pack/H-2001`
    // is accepted by the profile endpoint, returns 200, and stores nothing at all.
    assert.equal(paperStoreUrl("company", "H-2001"), "/api/hiring-pack/company-details");
    assert.equal(paperStoreUrl("employee", "H-2001"), "/api/hiring-pack/H-2001/facts");
    assert.equal(paperStoreUrl("profile", "H-2001"), "/api/hiring-pack/H-2001");
    assert.equal(paperStoreUrl("offboarding", "H-2001"), "/api/hiring-pack/H-2001/offboarding");
  }

  // ── 6. Clicking a company value opens the box showing what the paper prints ──────────────────
  //
  // The read side of section 2, exercised through the function the editor actually calls. The three
  // head-office spellings must all read the edited address, and the recital's must read its own.
  {
    const pack = packWith(resolveCompanyDetails({ headOfficeAr: EDITED_HEAD_OFFICE }));

    for (const key of ["COMPANY_HEAD_OFFICE", "companyAddress", "companyHeadOffice"]) {
      const binding = paperFieldBinding(key);
      assert.ok(binding, `${key} must be bound`);
      assert.equal(
        paperFieldCurrentValue(pack, binding),
        EDITED_HEAD_OFFICE,
        `${key} must open showing the address the paper is printing`,
      );
    }

    const recital = paperFieldBinding("COMPANY_HEAD_OFFICE_FULL");
    assert.ok(recital);
    assert.equal(
      paperFieldCurrentValue(pack, recital),
      systemLegalEntity.contractRecital.headOfficeAr,
      "editing the short address must not have moved the recital's written-out one",
    );
  }

  // ── 7. The insurance office still falls back to the company default when nobody chose one ────
  //
  // `render-form1.ts` fills that rule as `profile.insuranceOffice ?? registration.defaultInsuranceOffice`.
  // The binding declares the same fallback, so the edit box seeds from what is on the page — and the
  // WRITE still lands on this employee's profile, because choosing an office for one person is not
  // choosing it for everybody.
  {
    const company = resolveCompanyDetails({ defaultInsuranceOffice: "مكتب مدينة نصر" });
    const employee = employeeFixture();
    const profile = profileFixture({ insuranceOffice: null });
    const offboarding = emptyOffboardingProfile("H-2001");
    const pack: HiringPackData = {
      employee,
      profile,
      offboarding,
      company,
      exit: null,
      renewal: null,
      suggestedJobTitleAr: null,
      gaps: collectHiringPackGaps(employee, profile, offboarding, null, company),
      terms: resolveContractTerms(employee, profile, offboarding, null, company),
    };

    const binding = paperFieldBinding("insuranceOffice");
    assert.ok(binding);
    assert.equal(binding.store, "profile", "an office is chosen per employee, never company-wide");
    assert.equal(
      paperFieldCurrentValue(pack, binding),
      "مكتب مدينة نصر",
      "with no office of their own the edit box must show the company default the form prints",
    );
  }
}

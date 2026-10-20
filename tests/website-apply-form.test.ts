import assert from "node:assert/strict";

import type { SavedAudiences } from "../src/lib/recruitment/inbound/whatsapp-question-audience.ts";
import type { ScreeningQuestion } from "../src/lib/recruitment/inbound/whatsapp-screening-questions.ts";
import {
  assembleWebsiteApplyForm,
  resolveWebsiteApplyRole,
  validateWebsiteApplication,
  websiteApplyRoleKeys,
  websiteExtraFieldKey,
  type WebsiteApplyRawAnswers,
} from "../src/lib/recruitment/inbound/website-apply.ts";

/**
 * The PURE half of the public careers-site application form: the role registry, the form assembly
 * that reuses the WhatsApp bot's own audience rules, and the answer validator that stores an option's
 * TITLE exactly as screening_extra_answers holds it. No database — the audiences and extra questions
 * are passed in, which is what keeps `websiteApplyFormFor` the ONLY thing that has to read live state.
 */

// The saved built-in audiences as production holds them (verified 2026-09-21): region, area and
// background are all scoped to the sales/field families and NOT to the HR families (human_resources,
// and talent_acquisition, which the careers form's Talent Acquisition seat maps to since 2026-10-20),
// while experience and salary carry no override and so are asked to everyone. An HR applicant is
// therefore asked exactly experience + salary of the six.
const HR_AUDIENCES: SavedAudiences = new Map<string, readonly string[]>([
  ["area", ["medical_rep", "district_manager", "area_regional_manager", "national_sales_manager", "sales"]],
  [
    "background",
    [
      "district_manager",
      "area_regional_manager",
      "national_sales_manager",
      "medical_rep",
      "product_manager",
      "sales",
      "pharmacist",
      "finance",
      "office_coordinator",
      "other",
    ],
  ],
  ["region", ["medical_rep", "district_manager", "area_regional_manager", "national_sales_manager", "sales"]],
]);

const ATS_EXTRA: ScreeningQuestion = {
  appliesToRoleFamilies: ["human_resources", "talent_acquisition"],
  bodyText: "Have you used an ATS before?",
  id: "q-ats",
  isActive: true,
  kind: "tappable",
  options: [
    { description: null, title: "Yes", value: "yes" },
    { description: null, title: "No", value: "no" },
  ],
  questionKey: "hr_ats_experience",
  sortOrder: 12,
};

const NOTE_EXTRA: ScreeningQuestion = {
  appliesToRoleFamilies: ["human_resources", "talent_acquisition"],
  bodyText: "Anything else you would like us to know?",
  id: "q-note",
  isActive: true,
  kind: "free_text",
  options: null,
  questionKey: "hr_note",
  sortOrder: 20,
};

// The active area names per region, as areaNamesForRegion would return them. Deliberately small, and
// D3 is EMPTY on purpose — Delta (3) is a live region whose areas are not drawn yet, so its only
// answer is the typed escape, exactly the case the bot handles by sending area down its free-text path.
const AREAS_BY_REGION = new Map<string, string[]>([
  ["CA", ["Cairo 1", "Cairo 2"]],
  ["GZ", ["Giza 1"]],
  ["D3", []],
]);

export function runWebsiteApplyFormTests() {
  // ── The role registry ─────────────────────────────────────────────────────────────────────────
  assert.deepEqual(websiteApplyRoleKeys(), [
    "talent_acquisition_specialist",
    "national_sales_manager",
    "medical_representative",
    "district_manager",
    "hr_section_head",
    "regulatory_affairs_specialist",
    "quality_control_analyst",
    "office_coordinator",
    "product_manager",
  ]);
  const ocRole = resolveWebsiteApplyRole("office_coordinator");
  assert.ok(ocRole, "the Office Coordinator position must resolve on the careers form");
  assert.equal(ocRole.roleFamily, "office_coordinator", "it is asked the office_coordinator family's own questions");
  assert.equal(ocRole.jobTitle, "Office Coordinator");
  const role =resolveWebsiteApplyRole("talent_acquisition_specialist");
  assert.ok(role, "the launch role must resolve");
  assert.equal(role.jobTitle, "Talent Acquisition Specialist");
  // Its own family since 2026-10-20 (owner: a Talent Acquisition tab). `human_resources` is the menu
  // row retired on 6 Oct and files nobody — every careers applicant for this seat would wait in Needs
  // placing.
  assert.equal(role.roleFamily, "talent_acquisition");
  assert.equal(resolveWebsiteApplyRole("nope"), null);
  assert.equal(resolveWebsiteApplyRole(null), null);
  // The two office families ride "other" — the bot asks them neither region nor area.
  assert.equal(resolveWebsiteApplyRole("regulatory_affairs_specialist")?.roleFamily, "other");
  assert.equal(resolveWebsiteApplyRole("quality_control_analyst")?.roleFamily, "other");
  // District Manager is a field-force family, so it is asked region + area like a Medical Rep, plus
  // its own screening extra (dm_team_leadership); it carries the district_manager screening family.
  assert.equal(resolveWebsiteApplyRole("district_manager")?.roleFamily, "district_manager");

  assert.equal(websiteExtraFieldKey("hr_ats_experience"), "extra:hr_ats_experience");

  // ── HR form assembly: identity + CV, then experience + salary, then the extras in sort order ────
  const form = assembleWebsiteApplyForm(role, HR_AUDIENCES, [ATS_EXTRA, NOTE_EXTRA], AREAS_BY_REGION);
  assert.deepEqual(
    form.fields.map((field) => field.key),
    ["full_name", "email", "phone", "cv", "experience", "salary", "extra:hr_ats_experience", "extra:hr_note"],
    "HR is asked experience + salary of the six, then its two extras — region/area/background are scoped out",
  );

  const experience = form.fields.find((field) => field.key === "experience");
  assert.ok(experience);
  assert.equal(experience.kind, "select");
  assert.deepEqual(
    experience.options?.map((option) => option.value),
    ["fresh", "lt_1", "1_3", "3_5", "gt_5"],
    "experience options are the fixed bands, verbatim",
  );
  // The extras are optional — a blank answer must never block an application.
  assert.equal(form.fields.find((field) => field.key === "extra:hr_ats_experience")?.required, false);

  // ── The office family ("other"): background + experience + salary, NO region/area, NO extras ─────
  const officeRole = resolveWebsiteApplyRole("regulatory_affairs_specialist");
  assert.ok(officeRole);
  const officeForm = assembleWebsiteApplyForm(officeRole, HR_AUDIENCES, [], AREAS_BY_REGION);
  assert.deepEqual(
    officeForm.fields.map((field) => field.key),
    ["full_name", "email", "phone", "cv", "background", "experience", "salary"],
    "Regulatory Affairs is asked background (the office families are in that audience) but not region/area",
  );

  // ── The field-force family (NSM): background + region + area + experience + salary ───────────────
  const nsmRole = resolveWebsiteApplyRole("national_sales_manager");
  assert.ok(nsmRole);
  const nsmForm = assembleWebsiteApplyForm(nsmRole, HR_AUDIENCES, [], AREAS_BY_REGION);
  assert.deepEqual(
    nsmForm.fields.map((field) => field.key),
    ["full_name", "email", "phone", "cv", "background", "region", "area", "experience", "salary"],
    "the field-force families are asked the full geographic set in the bot's own order",
  );

  const background = nsmForm.fields.find((field) => field.key === "background");
  assert.ok(background);
  assert.equal(background.otherTextKey, "background_other");
  assert.deepEqual(
    background.options?.map((option) => option.value),
    ["pharmacy", "science", "vet", "medicine", "dentistry", "other"],
    "background offers the five degrees then the typed Other escape, last",
  );

  const region = nsmForm.fields.find((field) => field.key === "region");
  assert.ok(region);
  assert.equal(region.otherTextKey, "region_other");
  assert.deepEqual(
    region.options?.map((option) => option.value),
    ["CA", "GZ", "AB", "D1", "D2", "D3", "UE", "OT", "other"],
    "region offers the reviewed codes then the 'not listed' escape",
  );

  const area = nsmForm.fields.find((field) => field.key === "area");
  assert.ok(area);
  assert.equal(area.dependsOnKey, "region", "area's options depend on the chosen region");
  assert.equal(area.otherTextKey, "area_other");
  assert.deepEqual(
    area.optionsByRegion?.CA.map((option) => option.value),
    ["Cairo 1", "Cairo 2", "other"],
    "a region with areas lists them, then the typed escape",
  );
  assert.deepEqual(
    area.optionsByRegion?.D3.map((option) => option.value),
    ["other"],
    "Delta (3) has no areas drawn yet, so only the typed escape is offered — never a dead end",
  );

  // ── HR validation: a good submission produces the exact classification the bot would write ───────
  const good: WebsiteApplyRawAnswers = {
    answers: {
      experience: "3_5",
      "extra:hr_ats_experience": "yes",
      "extra:hr_note": "  I am relocating to Cairo.  ",
      salary: "15000",
    },
    email: "sara@example.com",
    fullName: "  Sara Ali  ",
    phone: "01000000000",
  };
  const validated = validateWebsiteApplication(role, form, good);
  assert.ok(validated.ok, "a complete, valid submission is accepted");
  assert.equal(validated.classification.jobTitle, "Talent Acquisition Specialist");
  assert.equal(validated.classification.experienceLabel, "3 - 5 years");
  assert.equal(validated.classification.expectedSalary, "15000");
  assert.equal(validated.classification.expectedSalaryFigure, 15000);
  // The stored answer is the option TITLE, never the wire value — exactly screening_extra_answers.
  assert.deepEqual(validated.classification.extraAnswers, {
    hr_ats_experience: "Yes",
    hr_note: "I am relocating to Cairo.",
  });
  // HR is asked none of the geographic three, so all three classification columns stay null.
  assert.equal(validated.classification.declaredBackground, null);
  assert.equal(validated.classification.regionCode, null);
  assert.equal(validated.classification.areaName, null);

  // A verbatim, non-numeric salary is kept as words and never coerced to a number.
  const negotiable = validateWebsiteApplication(role, form, { ...good, answers: { ...good.answers, salary: "negotiable" } });
  assert.ok(negotiable.ok);
  assert.equal(negotiable.classification.expectedSalary, "negotiable");
  assert.equal(negotiable.classification.expectedSalaryFigure, null);

  // A tappable answer that is not one the question offers is rejected — a stale or forged value can
  // never become a stored TITLE.
  const forged = validateWebsiteApplication(role, form, {
    ...good,
    answers: { ...good.answers, "extra:hr_ats_experience": "maybe" },
  });
  assert.equal(forged.ok, false);

  // Required fields: a missing experience, and a malformed email, each fail.
  const noExperience = validateWebsiteApplication(role, form, { ...good, answers: { ...good.answers, experience: "" } });
  assert.equal(noExperience.ok, false);
  const badEmail = validateWebsiteApplication(role, form, { ...good, email: "not-an-email" });
  assert.equal(badEmail.ok, false);

  // An unanswered optional extra writes NOTHING — the silent-erase trap: an optional column left out
  // of the payload, never blanked.
  const noExtras = validateWebsiteApplication(role, form, {
    ...good,
    answers: { experience: "3_5", salary: "15000" },
  });
  assert.ok(noExtras.ok);
  assert.deepEqual(noExtras.classification.extraAnswers, {});

  // ── Geographic validation on the NSM form ────────────────────────────────────────────────────
  const nsmBase: WebsiteApplyRawAnswers = {
    answers: { area: "Cairo 1", background: "pharmacy", experience: "gt_5", region: "CA", salary: "40000" },
    email: "omar@example.com",
    fullName: "Omar Nabil",
    phone: "01111111111",
  };
  const nsm = validateWebsiteApplication(nsmRole, nsmForm, nsmBase);
  assert.ok(nsm.ok, "a full field-force submission is accepted");
  assert.equal(nsm.classification.declaredBackground, "Pharmacy", "a tapped background stores its label");
  assert.equal(nsm.classification.regionCode, "CA", "a tapped region stores its CODE, not its label");
  assert.equal(nsm.classification.regionOtherText, null);
  assert.equal(nsm.classification.areaName, "Cairo 1", "a picked area stores its name");

  // A picked area that does not belong to the chosen region is rejected — the region/area pair is
  // validated against the schema's own per-region list, so a stale or cross-region value cannot land.
  const wrongArea = validateWebsiteApplication(nsmRole, nsmForm, {
    ...nsmBase,
    answers: { ...nsmBase.answers, area: "Giza 1", region: "CA" },
  });
  assert.equal(wrongArea.ok, false, "an area from another region is refused");

  // The typed "Other" escapes: a typed region goes to the NAME column (never the code column), and a
  // typed area rides through with it — the exact split writeClassification enforces.
  const typedGeo = validateWebsiteApplication(nsmRole, nsmForm, {
    ...nsmBase,
    answers: {
      area: "other",
      area_other: "  Mansoura  ",
      background: "other",
      background_other: "  Commerce  ",
      experience: "gt_5",
      region: "other",
      region_other: "  Delta (3)  ",
      salary: "40000",
    },
  });
  assert.ok(typedGeo.ok, "typed-Other answers on all three are accepted");
  assert.equal(typedGeo.classification.declaredBackground, "Commerce");
  assert.equal(typedGeo.classification.regionCode, null, "a typed region never lands in the code column");
  assert.equal(typedGeo.classification.regionOtherText, "Delta (3)");
  assert.equal(typedGeo.classification.areaName, "Mansoura");

  // "Other" chosen but nothing typed is a real error, not a silent skip — the field is required.
  const emptyOther = validateWebsiteApplication(nsmRole, nsmForm, {
    ...nsmBase,
    answers: { ...nsmBase.answers, region: "other", region_other: "   " },
  });
  assert.equal(emptyOther.ok, false, "choosing Other for the region without typing it fails");

  // A missing background on a role that asks it fails — background is required where it applies.
  const noBackground = validateWebsiteApplication(nsmRole, nsmForm, {
    ...nsmBase,
    answers: { ...nsmBase.answers, background: "" },
  });
  assert.equal(noBackground.ok, false);

  // ── HR Section Head: conditional questions and an answer that ends the application ──────────────
  const hrshRole = resolveWebsiteApplyRole("hr_section_head");
  assert.ok(hrshRole, "the HR Section Head position must resolve on the careers form");
  assert.equal(hrshRole.roleFamily, "hr_section_head");
  assert.equal(hrshRole.jobTitle, "HR Section Head");

  const everyoneButHrsh = [
    "district_manager", "area_regional_manager", "national_sales_manager", "medical_rep", "product_manager",
    "sales", "pharmacist", "human_resources", "talent_acquisition", "finance", "office_coordinator", "other",
  ];
  const hrshAudiences: SavedAudiences = new Map<string, readonly string[]>([
    ["area", ["medical_rep", "district_manager", "area_regional_manager", "national_sales_manager", "sales"]],
    ["background", ["medical_rep", "other", "hr_section_head"]],
    ["experience", everyoneButHrsh],
    ["region", ["medical_rep", "district_manager", "area_regional_manager", "national_sales_manager", "sales"]],
    ["salary", everyoneButHrsh],
  ]);
  const yesNo = [
    { description: null, title: "Yes", value: "yes" },
    { description: null, title: "No", value: "no" },
  ];
  const hq = (questionKey: string, overrides: Partial<ScreeningQuestion> = {}): ScreeningQuestion => ({
    appliesToRoleFamilies: ["hr_section_head"],
    bodyText: `${questionKey}?`,
    endOn: null,
    id: questionKey,
    isActive: true,
    kind: "tappable",
    options: yesNo,
    questionKey,
    showIf: null,
    sortOrder: 1,
    ...overrides,
  });
  const STOP = "Thank you for your interest in Sato Pharma. This role is based at our Cairo office.";
  const hrshExtras: ScreeningQuestion[] = [
    hq("hrsh_cairo", { endOn: { message: STOP, values: ["no"] } }),
    hq("hrsh_residence", { showIf: { questionKey: "hrsh_cairo", values: ["yes"] } }),
    hq("hrsh_pharma"),
    hq("hrsh_medrep", { showIf: { questionKey: "hrsh_pharma", values: ["yes"] } }),
    hq("hrsh_salary", { kind: "free_text", options: null }),
  ];
  const hrshForm = assembleWebsiteApplyForm(hrshRole, hrshAudiences, hrshExtras, AREAS_BY_REGION);
  assert.deepEqual(
    hrshForm.fields.map((field) => field.key),
    [
      "full_name", "email", "phone", "cv", "background",
      "extra:hrsh_cairo", "extra:hrsh_residence", "extra:hrsh_pharma", "extra:hrsh_medrep", "extra:hrsh_salary",
    ],
    "the HR Section Head is asked background, then its own questions — NOT experience, salary, region or area",
  );
  const cairoField = hrshForm.fields.find((field) => field.key === "extra:hrsh_cairo");
  assert.equal(cairoField?.required, true, "the question that can end the application is required — it gates the rest");
  assert.deepEqual(cairoField?.endOn, { message: STOP, values: ["no"] }, "the schema tells the page what ends it, and what to say");
  assert.deepEqual(
    hrshForm.fields.find((field) => field.key === "extra:hrsh_residence")?.showIf,
    { fieldKey: "extra:hrsh_cairo", values: ["yes"] },
    "a follow-up names the FIELD it waits on, in the form's own vocabulary",
  );

  const hrshBase: WebsiteApplyRawAnswers = {
    answers: {
      background: "pharmacy",
      "extra:hrsh_cairo": "yes",
      "extra:hrsh_medrep": "yes",
      "extra:hrsh_pharma": "yes",
      "extra:hrsh_residence": "yes",
      "extra:hrsh_salary": "  30000  ",
    },
    email: "hala@example.com",
    fullName: "Hala Samy",
    phone: "01222222222",
  };
  const hrshOk = validateWebsiteApplication(hrshRole, hrshForm, hrshBase);
  assert.ok(hrshOk.ok, "a complete HR Section Head application is accepted without experience or salary fields");
  assert.equal(hrshOk.classification.endedMessage, null);
  assert.equal(hrshOk.classification.experienceLabel, null, "experience is not asked of this seat");
  assert.equal(hrshOk.classification.expectedSalary, null, "the built-in expected-salary is not asked of this seat");
  assert.deepEqual(hrshOk.classification.extraAnswers, {
    hrsh_cairo: "Yes",
    hrsh_medrep: "Yes",
    hrsh_pharma: "Yes",
    hrsh_residence: "Yes",
    hrsh_salary: "30000",
  });

  // THE HEADLINE: a non-Cairo applicant's application ENDS at that answer, with the owner's message,
  // and nothing after it is read — a forged answer to a later question is never stored.
  const notCairo = validateWebsiteApplication(hrshRole, hrshForm, {
    ...hrshBase,
    answers: { ...hrshBase.answers, "extra:hrsh_cairo": "no" },
  });
  assert.ok(notCairo.ok, "a non-Cairo applicant is still recorded — their CV stays on file");
  assert.equal(notCairo.classification.endedMessage, STOP, "and gets the owner's message");
  assert.deepEqual(notCairo.classification.extraAnswers, { hrsh_cairo: "No" }, "nothing after the ending answer is stored");

  // The pharma follow-up is read only when pharma was answered Yes — a forged follow-up is dropped.
  const noPharma = validateWebsiteApplication(hrshRole, hrshForm, {
    ...hrshBase,
    answers: { ...hrshBase.answers, "extra:hrsh_pharma": "no" },
  });
  assert.ok(noPharma.ok);
  assert.equal(noPharma.classification.extraAnswers.hrsh_medrep, undefined, "a follow-up to a No is never stored");

  // The ending question cannot be skipped, or an applicant outside the requirement slips through.
  const skippedCairo = validateWebsiteApplication(hrshRole, hrshForm, {
    ...hrshBase,
    answers: { ...hrshBase.answers, "extra:hrsh_cairo": "" },
  });
  assert.equal(skippedCairo.ok, false, "leaving the Cairo question blank is refused");

  // Every other role still requires experience and salary — the new rule is read from the form, so it
  // can only relax a role whose form genuinely does not carry them.
  const stillRequired = validateWebsiteApplication(role, form, { ...good, answers: { ...good.answers, salary: "" } });
  assert.equal(stillRequired.ok, false, "a role asked salary still has to answer it");

  // ── The Product Manager seat: the experience question is a real GATE ──────────────────────────
  // Owner, 2026-10-16: "no pass if more than 1 year make him continue". So the years-as-a-Product-
  // Manager question carries an `end_on` over BOTH answers under a year, and this seat keeps the
  // built-in expected salary and the shared start-date question ("ask about expexcted salary and
  // when will be able to join if accwpted"). There is deliberately NO English question — he excluded
  // it — and none of the wording is pinned here, because every word is his to reword on the
  // Screening Questions screen.
  const pmRole = resolveWebsiteApplyRole("product_manager");
  assert.ok(pmRole, "the Product Manager position must resolve on the careers form");
  assert.equal(pmRole.roleFamily, "product_manager", "it is asked the product_manager family's own questions");
  assert.equal(pmRole.jobTitle, "Product Manager", "the stored job title matches what the WhatsApp bot writes");

  const PM_STOP = "Thank you for your interest in Sato Pharma. This role needs more than a year as a Product Manager.";
  const pmYears = [
    { description: "I work in another role", title: "Not a Product Manager", value: "not_yet" },
    { description: null, title: "Less than 1 year", value: "lt_1" },
    { description: null, title: "1 - 3 years", value: "1_3" },
    { description: null, title: "3 - 5 years", value: "3_5" },
    { description: null, title: "More than 5 years", value: "gt_5" },
  ];
  const pmq = (questionKey: string, sortOrder: number, overrides: Partial<ScreeningQuestion> = {}): ScreeningQuestion => ({
    appliesToRoleFamilies: ["product_manager"],
    bodyText: `${questionKey}?`,
    endOn: null,
    id: questionKey,
    isActive: true,
    kind: "tappable",
    options: yesNo,
    questionKey,
    showIf: null,
    sortOrder,
    ...overrides,
  });
  const pmExtras: ScreeningQuestion[] = [
    pmq("pm_experience", 200, { endOn: { message: PM_STOP, values: ["not_yet", "lt_1"] }, options: pmYears }),
    pmq("pm_launch", 201),
    pmq("pm_greater_cairo", 202),
    pmq("pm_specialities", 203),
    pmq("pm_ms_office", 204),
    // The start-date question is the EXISTING shared row, widened to this family rather than copied.
    pmq("oc_start_date", 300, { appliesToRoleFamilies: ["office_coordinator", "medical_rep", "district_manager", "human_resources", "product_manager"] }),
  ];
  const pmForm = assembleWebsiteApplyForm(pmRole, HR_AUDIENCES, pmExtras, AREAS_BY_REGION);
  assert.deepEqual(
    pmForm.fields.map((field) => field.key),
    [
      "full_name", "email", "phone", "cv", "background", "experience", "salary",
      "extra:pm_experience", "extra:pm_launch", "extra:pm_greater_cairo", "extra:pm_specialities",
      "extra:pm_ms_office", "extra:oc_start_date",
    ],
    "the Product Manager is asked background, experience and the expected salary, then its five questions, then when they could join",
  );

  const pmGate = pmForm.fields.find((field) => field.key === "extra:pm_experience");
  assert.equal(pmGate?.required, true, "the question that can end the application is required — it gates the rest");
  assert.deepEqual(
    pmGate?.endOn,
    { message: PM_STOP, values: ["not_yet", "lt_1"] },
    "BOTH answers under a year end it — a gate that listed only one would pass a sub-year applicant",
  );

  const pmBase: WebsiteApplyRawAnswers = {
    answers: {
      background: "pharmacy",
      experience: "3_5",
      "extra:oc_start_date": "yes",
      "extra:pm_experience": "1_3",
      "extra:pm_greater_cairo": "yes",
      "extra:pm_launch": "yes",
      "extra:pm_ms_office": "yes",
      "extra:pm_specialities": "yes",
      salary: "45000",
    },
    email: "nour@example.com",
    fullName: "Nour Adel",
    phone: "01233333333",
  };
  const pmOk = validateWebsiteApplication(pmRole, pmForm, pmBase);
  assert.ok(pmOk.ok, "a Product Manager of one to three years is accepted and carries on");
  assert.equal(pmOk.classification.endedMessage, null);
  assert.equal(pmOk.classification.expectedSalary, "45000", "the expected salary is asked of this seat");
  assert.equal(pmOk.classification.extraAnswers.pm_experience, "1 - 3 years", "the answer is stored as its TITLE");
  assert.equal(pmOk.classification.extraAnswers.oc_start_date, "Yes", "when they could join is stored with the rest");

  // THE HEADLINE: under a year as a Product Manager ends the application at that answer, with his
  // message, and nothing after it is read — a forged answer to a later question is never stored.
  for (const under of ["not_yet", "lt_1"]) {
    const ended = validateWebsiteApplication(pmRole, pmForm, {
      ...pmBase,
      answers: { ...pmBase.answers, "extra:pm_experience": under },
    });
    assert.ok(ended.ok, `a ${under} applicant is still recorded — their CV stays on file`);
    assert.equal(ended.classification.endedMessage, PM_STOP, `and ${under} gets the owner's message`);
    assert.deepEqual(
      Object.keys(ended.classification.extraAnswers),
      ["pm_experience"],
      "nothing after the ending answer is stored",
    );
  }

  const pmSkipped = validateWebsiteApplication(pmRole, pmForm, {
    ...pmBase,
    answers: { ...pmBase.answers, "extra:pm_experience": "" },
  });
  assert.equal(pmSkipped.ok, false, "leaving the gate question blank is refused");
}

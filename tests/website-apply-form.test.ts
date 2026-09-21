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
// background are all scoped to the sales/field families and NOT to human_resources, while experience
// and salary carry no override and so are asked to everyone. An HR applicant is therefore asked
// exactly experience + salary of the six.
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
  appliesToRoleFamilies: ["human_resources"],
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
  appliesToRoleFamilies: ["human_resources"],
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
    "regulatory_affairs_specialist",
    "quality_control_analyst",
  ]);
  const role = resolveWebsiteApplyRole("talent_acquisition_specialist");
  assert.ok(role, "the launch role must resolve");
  assert.equal(role.jobTitle, "Talent Acquisition Specialist");
  assert.equal(role.roleFamily, "human_resources");
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
}

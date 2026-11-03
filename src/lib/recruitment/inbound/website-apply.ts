// Recruitment / ATS — the public careers-site application form.
//
// A person applies from www.satopharma.com/careers. The browser POSTs their CV plus the same
// answers the WhatsApp self-classification bot collects, and this module turns that into a
// candidate in the EXACT same pipeline: one call to ingestInboundCv (channel "website"), then the
// same classification columns and screening_extra_answers the WhatsApp path writes.
//
// WHY IT REUSES THE BOT'S OWN RESOLVERS RATHER THAN LISTING THE QUESTIONS ITSELF. "Same as
// WhatsApp" has to stay true after the owner edits a question or rescopes one on
// /admin/screening-questions — otherwise the careers form silently drifts from the bot the day he
// changes anything. So the built-in six's audiences come from `loadSavedAudiences` +
// `builtInQuestionAppliesToRole`, and the extra questions from `listActiveScreeningQuestions` — the
// same two reads the bot makes. The form this returns is therefore whatever the bot would ask an
// applicant of that role at that moment, with nothing to keep in step by hand.
//
// SPLIT LIKE whatsapp-classify-menus.ts vs -session.ts: everything above `submitWebsiteApplication`
// is PURE (no I/O), so the role registry, the form assembly and the answer validation are
// unit-testable without a database, and the route handler stays thin.

import { randomUUID } from "node:crypto";

import { logError } from "@/lib/observability/log";
import { sendWebsiteApplyConfirmation } from "@/lib/recruitment/inbound/website-apply-confirmation-email";
import { consumePublicApplyAiRead } from "@/lib/recruitment/inbound/public-apply-ai-budget";
import { candidateRegionCodes, candidateRegionLabels } from "@/lib/recruitment/candidate-region";
import type { CandidateRoleFamily } from "@/lib/recruitment/candidate-role-family";
import { recruitmentDb } from "@/lib/recruitment/db";
import {
  ingestInboundCv,
  maxInboundCvBytes,
  type InboundCvAttachment,
  type InboundCvIntakeResult,
} from "@/lib/recruitment/inbound/cv-intake-service";
import {
  areaNamesForRegion,
  loadSavedAudiences,
} from "@/lib/recruitment/inbound/whatsapp-classify-session";
import {
  AREA_OTHER_MAX,
  BACKGROUND_OTHER_MAX,
  candidateBackgroundCodes,
  candidateBackgroundLabels,
  candidateExperienceCodes,
  candidateExperienceLabels,
  cleanTypedAnswer,
  EXPECTED_SALARY_MAX,
  isOfferedBackground,
  isOfferedExperience,
  isOfferedRegion,
  OTHER_ROW_VALUE,
  parseDeclaredSalaryFigure,
  REGION_OTHER_MAX,
} from "@/lib/recruitment/inbound/whatsapp-classify-menus";
import { mergeExtraAnswers } from "@/lib/recruitment/inbound/whatsapp-answer-sync";
import { regionPlaceHint } from "@/lib/recruitment/inbound/whatsapp-classify-place-hints";
import {
  builtInQuestionAppliesToRole,
  builtInQuestionKeys,
  type BuiltInQuestionKey,
  type SavedAudiences,
} from "@/lib/recruitment/inbound/whatsapp-question-audience";
import {
  cleanExtraAnswerText,
  type ScreeningQuestion,
} from "@/lib/recruitment/inbound/whatsapp-screening-questions";
import { listActiveScreeningQuestions } from "@/lib/recruitment/inbound/whatsapp-screening-questions-session";
import { recomputeCompleteness } from "@/lib/recruitment/workspace/completeness";
import { placeFromAnswers } from "@/lib/recruitment/workspace/placements-db";

// ── The role registry ────────────────────────────────────────────────────────────────────────────
// One row per position the careers form is opened for. Written generically so a second position is a
// data change here, never new form code: a role's whole form is derived from its `roleFamily` — the
// built-in six it is asked come from that family's saved audiences and the extras from
// `listActiveScreeningQuestions`, so registering a position is a matter of naming its family, never
// listing its questions. The web form renders the fields the WhatsApp bot would ask that family
// today (see SUPPORTED_BUILT_INS for the ones it can draw), so the two channels can never drift.

export type WebsiteApplyRoleKey =
  | "talent_acquisition_specialist"
  | "national_sales_manager"
  | "medical_representative"
  | "district_manager"
  | "hr_section_head"
  | "regulatory_affairs_specialist"
  | "quality_control_analyst"
  | "office_coordinator"
  | "product_manager"
  | "personnel";

export type WebsiteApplyRole = {
  key: WebsiteApplyRoleKey;
  /** The public heading the careers page shows. */
  title: string;
  /** The exact free-text job title stored on the candidate as `applied_for_job_title` — the same
   *  shape the WhatsApp bot writes through `sessionRoleLabel`. */
  jobTitle: string;
  /** Which screening family this role belongs to — decides which built-in six the applicant is asked
   *  (via the saved audiences) and which admin-defined extras (`listActiveScreeningQuestions`). */
  roleFamily: CandidateRoleFamily;
};

const WEBSITE_APPLY_ROLES: Readonly<Record<WebsiteApplyRoleKey, WebsiteApplyRole>> = {
  // Its own family since 20 Oct 2026 (owner: a Talent Acquisition tab of its own). It was
  // `human_resources`, the WhatsApp menu row retired on 6 Oct, which files nobody: the workspace would
  // have put every careers-form applicant for this seat in Needs placing. The questions scoped to
  // `human_resources` were widened to `talent_acquisition` the same day, so the form asks what it did.
  talent_acquisition_specialist: {
    jobTitle: "Talent Acquisition Specialist",
    key: "talent_acquisition_specialist",
    roleFamily: "talent_acquisition",
    title: "Talent Acquisition Specialist",
  },
  national_sales_manager: {
    jobTitle: "National Sales Manager",
    key: "national_sales_manager",
    roleFamily: "national_sales_manager",
    title: "National Sales Manager",
  },
  medical_representative: {
    jobTitle: "Medical Representative",
    key: "medical_representative",
    roleFamily: "medical_rep",
    title: "Medical Representative",
  },
  district_manager: {
    jobTitle: "District Manager",
    key: "district_manager",
    roleFamily: "district_manager",
    title: "District Manager",
  },
  // The HR Section Head seat (Sheraton, Cairo). Its form is whatever the WhatsApp bot asks this family:
  // background, then the eight `hrsh_*` questions — Cairo (a "No" ends the application with a thank-you
  // message), residence, age, pharma experience with its two follow-ups, current salary and start date.
  hr_section_head: {
    jobTitle: "HR Section Head",
    key: "hr_section_head",
    roleFamily: "hr_section_head",
    title: "HR Section Head",
  },
  // Regulatory Affairs and Quality Control are not field-force families, so the bot asks them neither
  // region nor area — their tailored form is background + experience + salary. They ride the "other"
  // family, which is exactly where `candidateRoleFamily` files these titles off a CV.
  regulatory_affairs_specialist: {
    jobTitle: "Regulatory Affairs Specialist",
    key: "regulatory_affairs_specialist",
    roleFamily: "other",
    title: "Regulatory Affairs Specialist",
  },
  quality_control_analyst: {
    jobTitle: "Quality Control Analyst",
    key: "quality_control_analyst",
    roleFamily: "other",
    title: "Quality Control Analyst",
  },
  // The Office Coordinator seat (Sheraton, Cairo). Registered by family only, like every other row: the
  // form is whatever the WhatsApp bot asks the office_coordinator family today, so nothing is listed
  // twice and the bot's own question set is left exactly as the owner has it.
  office_coordinator: {
    jobTitle: "Office Coordinator",
    key: "office_coordinator",
    roleFamily: "office_coordinator",
    title: "Office Coordinator",
  },
  // The Product Manager seat (Sheraton, Cairo). Registered by family only, like every row above it: the
  // form is whatever the WhatsApp bot asks the `product_manager` family — the built-in background,
  // experience and expected salary, then the five `pm_*` questions and the shared start-date question.
  // The experience question carries an `end_on`, so an applicant with under a year as a Product Manager
  // is thanked and the application stops here exactly as it does on WhatsApp (owner, 2026-10-16: "no
  // pass if more than 1 year make him continue").
  product_manager: {
    jobTitle: "Product Manager",
    key: "product_manager",
    roleFamily: "product_manager",
    title: "Product Manager",
  },
  // The Personnel Specialist / Senior Personnel Specialist seat (Sheraton, Cairo), added 2026-10-31.
  // Registered by family only, like every row above: the form is whatever the WhatsApp bot asks the
  // `personnel` family — the built-in expected salary, then the `pers_*` questions (the first asks
  // which of the two grades) and the shared ones widened to it. One key covers both grades, so the
  // careers card titled "Personnel Specialist / Senior Personnel Specialist" routes here on /personnel/.
  personnel: {
    jobTitle: "Personnel Specialist",
    key: "personnel",
    roleFamily: "personnel",
    title: "Personnel Specialist / Senior Personnel Specialist",
  },
};

export function resolveWebsiteApplyRole(key: string | null | undefined): WebsiteApplyRole | null {
  if (!key) return null;
  return WEBSITE_APPLY_ROLES[key as WebsiteApplyRoleKey] ?? null;
}

export function websiteApplyRoleKeys(): WebsiteApplyRoleKey[] {
  return Object.keys(WEBSITE_APPLY_ROLES) as WebsiteApplyRoleKey[];
}

// ── The form schema (what the GET endpoint returns and the website renders) ────────────────────────

export type WebsiteApplyFieldKind = "text" | "email" | "tel" | "file" | "select";

export type WebsiteApplyFieldOption = { value: string; title: string; description: string | null };

export type WebsiteApplyField = {
  /** The form-data key the browser posts back under. Built-ins use their WhatsApp step name
   *  ("experience", "salary"); extras use `extra:<questionKey>` so the two namespaces never collide. */
  key: string;
  label: string;
  kind: WebsiteApplyFieldKind;
  required: boolean;
  /** One line of guidance under the field. Null for fields that need none. */
  helpText: string | null;
  /** Present for kind "select" with a static option list (experience, background, region, extras). The
   *  area field carries `optionsByRegion` instead, because its choices depend on the chosen region. */
  options?: WebsiteApplyFieldOption[];
  /** Present for text-like kinds — the character ceiling the server also enforces. */
  maxLength?: number;
  /** Present for kind "file" only. */
  accept?: string[];
  maxBytes?: number;
  /** Present on a select that carries a typed "Other" escape (background, region, area). When the
   *  applicant picks the OTHER_ROW_VALUE option, the browser posts their free text under this key and
   *  the server reads it from there. `otherMaxLength` is the ceiling both ends enforce. */
  otherTextKey?: string;
  otherMaxLength?: number;
  /** Present on the area field only. Its options depend on the value picked for this other field (the
   *  region), so the browser swaps `optionsByRegion[<that value>]` in as the region changes, and a
   *  typed-Other region (no code) leaves only the typed area escape. */
  dependsOnKey?: string;
  /** Present on the area field only — the option list to offer for each region code the applicant may
   *  pick. Every list already ends with the OTHER_ROW_VALUE escape, and a region with no areas drawn
   *  yet (Delta (3) on 2026-08-28) is just the escape on its own. */
  optionsByRegion?: Record<string, WebsiteApplyFieldOption[]>;
  /** Present on a conditional question: show it only when the field `fieldKey` holds one of `values`
   *  (option codes). The server enforces this too — an answer to a field that is not shown is ignored —
   *  so a renderer that draws every field still posts a form the server reads correctly. */
  showIf?: { fieldKey: string; values: string[] };
  /** Present on a question where some answers end the application: when the field holds one of
   *  `values`, nothing further is asked and `message` is shown to the applicant. The server ends the
   *  application at that field either way, whatever a later field was posted holding. */
  endOn?: { values: string[]; message: string };
};

export type WebsiteApplyForm = {
  role: WebsiteApplyRoleKey;
  title: string;
  fields: WebsiteApplyField[];
};

// The applicant's own name is what a recruiter reads first, so it is generous; the CV usually
// carries the authoritative version anyway (candidateIdentityFromCvFields).
export const WEBSITE_APPLY_NAME_MAX = 120;
export const WEBSITE_APPLY_EMAIL_MAX = 160;
export const WEBSITE_APPLY_PHONE_MAX = 40;

// Which of the six built-ins the web form can render. Experience is a fixed tappable band and salary
// is free text; background and region are fixed lists with a typed "Other" escape; area's options
// depend on the region just chosen (a dependent select). `job_title` is never rendered — the careers
// form already knows the position. A built-in outside this set asked of a registered role is refused
// at build time (see assembleWebsiteApplyForm) rather than shipping a form that would drop its answer.
const SUPPORTED_BUILT_INS: ReadonlySet<BuiltInQuestionKey> = new Set([
  "experience",
  "salary",
  "background",
  "region",
  "area",
]);

function experienceField(): WebsiteApplyField {
  return {
    helpText: null,
    key: "experience",
    kind: "select",
    label: "How many years of experience do you have?",
    options: candidateExperienceCodes.map((code) => ({
      description: null,
      title: candidateExperienceLabels[code],
      value: code,
    })),
    required: true,
  };
}

function salaryField(): WebsiteApplyField {
  return {
    helpText: 'In EGP. You can write a number, a range, or "negotiable".',
    key: "salary",
    kind: "text",
    label: "Expected monthly net salary",
    maxLength: EXPECTED_SALARY_MAX,
    required: true,
  };
}

// The OTHER escape row, worded to match the WhatsApp menu the applicant would otherwise see. Region
// reads "not listed" rather than "Other" on purpose: `OT` is already a real selling region labelled
// "Others", so two rows reading Other/Others would be a coin flip (see regionMenu in the bot).
const OTHER_OPTION_LABELS = {
  area: "My area is not listed",
  background: "Other",
  region: "My region is not listed",
} as const;

function otherOption(kind: keyof typeof OTHER_OPTION_LABELS): WebsiteApplyFieldOption {
  return { description: null, title: OTHER_OPTION_LABELS[kind], value: OTHER_ROW_VALUE };
}

function backgroundField(): WebsiteApplyField {
  return {
    helpText: null,
    key: "background",
    kind: "select",
    label: "What did you graduate in?",
    options: [
      ...candidateBackgroundCodes.map((code) => ({
        description: null,
        title: candidateBackgroundLabels[code],
        value: code,
      })),
      otherOption("background"),
    ],
    otherMaxLength: BACKGROUND_OTHER_MAX,
    otherTextKey: "background_other",
    required: true,
  };
}

function regionField(): WebsiteApplyField {
  return {
    helpText: null,
    key: "region",
    kind: "select",
    label: "Which region would you like to work in?",
    options: [
      // The description is the same Arabic place hint the bot shows under each region row — the line
      // that makes "Delta (1)" answerable by someone who has never worked here.
      ...candidateRegionCodes.map((code) => ({
        description: regionPlaceHint(code),
        title: candidateRegionLabels[code],
        value: code,
      })),
      otherOption("region"),
    ],
    otherMaxLength: REGION_OTHER_MAX,
    otherTextKey: "region_other",
    required: true,
  };
}

/** The area field's options are built per region, so the browser can swap the list in when the region
 *  changes. A typed-Other region has no code and therefore no list, which is what leaves only the
 *  typed area escape — mirroring the bot, where a typed region sends area down its free-text path. */
function areaField(areasByRegion: ReadonlyMap<string, readonly string[]>): WebsiteApplyField {
  const optionsByRegion: Record<string, WebsiteApplyFieldOption[]> = {};
  for (const code of candidateRegionCodes) {
    const names = areasByRegion.get(code) ?? [];
    optionsByRegion[code] = [
      ...names.map((name) => ({ description: null, title: name, value: name })),
      otherOption("area"),
    ];
  }
  return {
    dependsOnKey: "region",
    helpText: null,
    key: "area",
    kind: "select",
    label: "Which area would you like to work in?",
    optionsByRegion,
    otherMaxLength: AREA_OTHER_MAX,
    otherTextKey: "area_other",
    required: true,
  };
}

/** The form-data key an extra question posts back under. */
export function websiteExtraFieldKey(questionKey: string): string {
  return `extra:${questionKey}`;
}

/** The conditional rules of an extra question, in the form's own vocabulary (field keys, not question
 *  keys). Empty for the usual question that has neither. */
function conditionalHints(question: ScreeningQuestion): Pick<WebsiteApplyField, "showIf" | "endOn"> {
  return {
    ...(question.showIf
      ? { showIf: { fieldKey: websiteExtraFieldKey(question.showIf.questionKey), values: question.showIf.values } }
      : {}),
    ...(question.endOn ? { endOn: { message: question.endOn.message, values: question.endOn.values } } : {}),
  };
}

/** A free-text question is worded for WhatsApp, where the applicant must be told to type rather than
 *  tap ("Send it as a normal message, in EGP."). A form has a box to type in, so that instruction is
 *  dropped here and whatever it added ("in EGP") becomes the hint. Any other wording is left whole, and
 *  the stored question, which the bot still asks in full, is not touched. */
function freeTextCopy(bodyText: string): Pick<WebsiteApplyField, "helpText" | "label"> {
  const paragraphs = bodyText.split(/\n\s*\n/);
  const instruction = paragraphs.at(-1)?.trim().match(/^send it as a normal message(?:,\s*(.+?))?\.?$/is);
  if (paragraphs.length < 2 || !instruction) return { helpText: null, label: bodyText };
  const hint = instruction[1]?.trim();
  return {
    helpText: hint ? `${hint.charAt(0).toUpperCase()}${hint.slice(1)}.` : null,
    label: paragraphs.slice(0, -1).join("\n\n").trim(),
  };
}

function extraField(question: ScreeningQuestion): WebsiteApplyField {
  if (question.kind === "free_text") {
    return {
      ...freeTextCopy(question.bodyText),
      key: websiteExtraFieldKey(question.questionKey),
      kind: "text",
      // Extras are optional on WhatsApp (the loop can be abandoned), so they are optional here too —
      // a missing answer must never block an application.
      maxLength: 200,
      required: false,
      ...conditionalHints(question),
    };
  }
  return {
    helpText: null,
    key: websiteExtraFieldKey(question.questionKey),
    kind: "select",
    label: question.bodyText,
    options: (question.options ?? []).map((option) => ({
      description: option.description,
      title: option.title,
      value: option.value,
    })),
    // A question whose answer can END the application is the gate for everything after it, so it is
    // required: left optional, an applicant outside the seat's requirement could skip it and slip
    // through. Every other extra stays optional.
    required: Boolean(question.endOn),
    ...conditionalHints(question),
  };
}

function cvFileField(): WebsiteApplyField {
  return {
    accept: [".pdf", ".doc", ".docx"],
    helpText: "PDF or Word document.",
    key: "cv",
    kind: "file",
    label: "Your CV",
    maxBytes: maxInboundCvBytes(),
    required: true,
  };
}

function identityFields(): WebsiteApplyField[] {
  return [
    { helpText: null, key: "full_name", kind: "text", label: "Full name", maxLength: WEBSITE_APPLY_NAME_MAX, required: true },
    { helpText: null, key: "email", kind: "email", label: "Email", maxLength: WEBSITE_APPLY_EMAIL_MAX, required: true },
    { helpText: null, key: "phone", kind: "tel", label: "Mobile number", maxLength: WEBSITE_APPLY_PHONE_MAX, required: true },
  ];
}

/**
 * The PURE assembly: identity + CV, then the built-in six this role is asked (in the bot's own
 * order), then the active extras (already scoped to the role and sorted by `listActiveScreeningQuestions`).
 *
 * Throws only if a role is registered whose flow includes an unsupported built-in — a code-level
 * misconfiguration, never anything an applicant can trigger.
 */
export function assembleWebsiteApplyForm(
  role: WebsiteApplyRole,
  savedAudiences: SavedAudiences,
  extraQuestions: readonly ScreeningQuestion[],
  areasByRegion: ReadonlyMap<string, readonly string[]>,
): WebsiteApplyForm {
  const fields: WebsiteApplyField[] = [...identityFields(), cvFileField()];

  for (const key of builtInQuestionKeys) {
    // Question one establishes the role, which the careers form already knows — never asked.
    if (key === "job_title") continue;
    if (!builtInQuestionAppliesToRole(key, savedAudiences.get(key), role.roleFamily)) continue;
    if (!SUPPORTED_BUILT_INS.has(key)) {
      throw new Error(
        `website apply form cannot render the built-in "${key}" asked of role "${role.key}"`,
      );
    }
    fields.push(builtInField(key, areasByRegion));
  }

  for (const question of extraQuestions) fields.push(extraField(question));

  return { fields, role: role.key, title: role.title };
}

/** The field for a supported built-in. Its caller has already checked SUPPORTED_BUILT_INS, so the
 *  final `job_title` branch is unreachable and exists only to keep the switch total. */
function builtInField(
  key: BuiltInQuestionKey,
  areasByRegion: ReadonlyMap<string, readonly string[]>,
): WebsiteApplyField {
  switch (key) {
    case "experience":
      return experienceField();
    case "salary":
      return salaryField();
    case "background":
      return backgroundField();
    case "region":
      return regionField();
    case "area":
      return areaField(areasByRegion);
    default:
      throw new Error(`website apply form cannot render the built-in "${key}"`);
  }
}

/** Every offered region's active area names, keyed by code — one read (loadAreasByRegion caches), so
 *  the eight lookups cost a single database round-trip. Passed into the pure assembly so the area
 *  field can embed its per-region options without the assembly itself touching the database. */
async function loadAreasByRegionForForm(): Promise<Map<string, string[]>> {
  const entries = await Promise.all(
    candidateRegionCodes.map(async (code) => [code, await areaNamesForRegion(code)] as const),
  );
  return new Map(entries);
}

/** The full form for a role, reading the same live audiences and extra questions the bot reads. */
export async function websiteApplyFormFor(role: WebsiteApplyRole): Promise<WebsiteApplyForm> {
  const [savedAudiences, extraQuestions, areasByRegion] = await Promise.all([
    loadSavedAudiences(),
    listActiveScreeningQuestions(role.roleFamily),
    loadAreasByRegionForForm(),
  ]);
  return assembleWebsiteApplyForm(role, savedAudiences, extraQuestions, areasByRegion);
}

// ── Validating a submission against a role's live form ─────────────────────────────────────────────

/** A raw browser submission: the string fields only. The CV file is handled apart (it has bytes). */
export type WebsiteApplyRawAnswers = {
  fullName: string;
  email: string;
  phone: string;
  /** Every non-file form-data value, keyed as the field posts it ("experience", "salary",
   *  "extra:<questionKey>"). */
  answers: Record<string, string>;
};

/** The classification the bot's writeClassification + finishExtraQuestionLoop would record, derived
 *  from a valid submission. Every column is optional-by-presence, exactly as the WhatsApp path: an
 *  unanswered optional extra writes nothing, never a blank. */
export type WebsiteApplyClassification = {
  jobTitle: string;
  /** Null when the role is not asked the experience band (the HR Section Head). */
  experienceLabel: string | null;
  /** Null when the role is not asked the salary question this form carries. */
  expectedSalary: string | null;
  expectedSalaryFigure: number | null;
  /** The owner's message when an answer ended the application early (the Cairo question); null for a
   *  complete one. The application is recorded either way — see submitWebsiteApplication. */
  endedMessage: string | null;
  /** The graduation background as a single read-back label — a code's label for a tapped answer, the
   *  applicant's own words for "Other". Null when the role is not asked background. Same column and
   *  shape as the WhatsApp path's `declared_background`. */
  declaredBackground: string | null;
  /** A real region CODE for a tapped region; null for a typed-Other region or a role not asked region.
   *  The code column takes only a code — a typed region is words, and words go to `regionOtherText`. */
  regionCode: string | null;
  /** The applicant's typed words when they chose "Other" for the region; null otherwise. */
  regionOtherText: string | null;
  /** The area name — a picked area or the applicant's typed "Other" words. Null when not asked. One
   *  column either way, exactly as `preferred_area_name` holds it for a WhatsApp applicant. */
  areaName: string | null;
  /** questionKey -> the chosen option's TITLE (or the typed text for a free-text question) — the same
   *  shape screening_extra_answers holds for a WhatsApp applicant. */
  extraAnswers: Record<string, string>;
};

export type WebsiteApplyValidation =
  | { ok: true; classification: WebsiteApplyClassification }
  | { ok: false; errors: string[] };

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Validate a submission against the role's live form, and produce the classification to write.
 *
 * PURE and total — it never reads a database (the form is passed in) and never throws. Every
 * rejection is a sentence the caller can return to the browser. The one guarantee it enforces beyond
 * "required fields present" is that a tappable answer's value really is one the question offers, so
 * the TITLE written to the candidate can only ever be one the owner defined — a stale or forged value
 * is rejected, never stored.
 */
export function validateWebsiteApplication(
  role: WebsiteApplyRole,
  form: WebsiteApplyForm,
  raw: WebsiteApplyRawAnswers,
): WebsiteApplyValidation {
  const errors: string[] = [];

  const fullName = cleanTypedAnswer(raw.fullName, WEBSITE_APPLY_NAME_MAX);
  if (!fullName) errors.push("Please enter your full name.");

  const email = cleanTypedAnswer(raw.email, WEBSITE_APPLY_EMAIL_MAX);
  if (!email || !EMAIL_SHAPE.test(email)) errors.push("Please enter a valid email address.");

  const phone = cleanTypedAnswer(raw.phone, WEBSITE_APPLY_PHONE_MAX);
  if (!phone) errors.push("Please enter your mobile number.");

  // Experience — a required tappable band, for every role the bot asks it of. That is every role but
  // the HR Section Head, whose pharma-experience questions replace it, so it is read from the form's
  // own fields rather than assumed: a missing or unrecognised value is a real error only where asked.
  let experienceLabel: string | null = null;
  if (form.fields.some((field) => field.key === "experience")) {
    const experienceRaw = String(raw.answers.experience ?? "").trim();
    if (!experienceRaw) {
      errors.push("Please choose how many years of experience you have.");
    } else if (!isOfferedExperience(experienceRaw)) {
      errors.push("Please choose a valid experience option.");
    } else {
      experienceLabel = candidateExperienceLabels[experienceRaw];
    }
  }

  // Salary — required free text, stored verbatim (never coerced), where the role is asked it. Same rule
  // as the bot: a number, a range and "negotiable" are all truthful answers a recruiter reads.
  let expectedSalary: string | null = null;
  if (form.fields.some((field) => field.key === "salary")) {
    expectedSalary = cleanTypedAnswer(raw.answers.salary, EXPECTED_SALARY_MAX);
    if (!expectedSalary) errors.push("Please enter your expected monthly net salary.");
  }

  // Background — present only when the role's family is in the background audience. A tapped answer
  // must be an offered code; "Other" requires its typed text. Stored as one read-back label.
  let declaredBackground: string | null = null;
  if (form.fields.some((field) => field.key === "background")) {
    const value = String(raw.answers.background ?? "").trim();
    if (!value) {
      errors.push("Please choose what you graduated in.");
    } else if (value === OTHER_ROW_VALUE) {
      const typed = cleanTypedAnswer(raw.answers.background_other, BACKGROUND_OTHER_MAX);
      if (!typed) errors.push("Please type what you graduated in.");
      else declaredBackground = typed;
    } else if (!isOfferedBackground(value)) {
      errors.push("Please choose a valid background option.");
    } else {
      declaredBackground = candidateBackgroundLabels[value];
    }
  }

  // Region — present only for field-force families. A tapped answer must be an offered code (stored as
  // the code); "Other" requires its typed text (stored as words, never in the code column).
  let regionCode: string | null = null;
  let regionOtherText: string | null = null;
  if (form.fields.some((field) => field.key === "region")) {
    const value = String(raw.answers.region ?? "").trim();
    if (!value) {
      errors.push("Please choose the region you would like to work in.");
    } else if (value === OTHER_ROW_VALUE) {
      const typed = cleanTypedAnswer(raw.answers.region_other, REGION_OTHER_MAX);
      if (!typed) errors.push("Please type the region you would like to work in.");
      else regionOtherText = typed;
    } else if (!isOfferedRegion(value)) {
      errors.push("Please choose a valid region option.");
    } else {
      regionCode = value;
    }
  }

  // Area — depends on the region above. A picked area name must belong to the chosen region's list,
  // which the form embeds, so this stays pure (validated against the schema, never the database). A
  // typed-Other region has no list, so only the typed area escape is accepted there.
  let areaName: string | null = null;
  const areaFieldSchema = form.fields.find((field) => field.key === "area");
  if (areaFieldSchema) {
    const value = String(raw.answers.area ?? "").trim();
    if (!value) {
      errors.push("Please choose the area you would like to work in.");
    } else if (value === OTHER_ROW_VALUE) {
      const typed = cleanTypedAnswer(raw.answers.area_other, AREA_OTHER_MAX);
      if (!typed) errors.push("Please type the area you would like to work in.");
      else areaName = typed;
    } else {
      const allowed = regionCode ? (areaFieldSchema.optionsByRegion?.[regionCode] ?? []) : [];
      const match = allowed.find((option) => option.value === value && option.value !== OTHER_ROW_VALUE);
      if (!match) errors.push("Please choose a valid area for your region.");
      else areaName = match.title;
    }
  }

  // Extras — optional, but any answer given must match an option the question defines. Read in the
  // form's own order, because that order is what makes the conditional rules mean anything:
  //   - a question with `showIf` is read only when the field it depends on was itself shown AND holds
  //     one of the listed answers, so a forged answer to a hidden follow-up is dropped, never stored;
  //   - a question with `endOn` whose answer is one of the listed ones ENDS the application there: the
  //     rest is not read, and the owner's message goes back to the applicant — exactly the WhatsApp
  //     rule. The ending question itself is required, since it gates everything after it.
  const extraAnswers: Record<string, string> = {};
  const shownValues: Record<string, string> = {};
  let endedMessage: string | null = null;
  for (const field of form.fields) {
    if (!field.key.startsWith("extra:")) continue;
    if (field.showIf && !field.showIf.values.includes(shownValues[field.showIf.fieldKey] ?? "")) continue;
    const value = String(raw.answers[field.key] ?? "").trim();
    if (!value) {
      if (field.required) errors.push(`Please answer: ${field.label}`);
      continue; // optional — no answer, no column, exactly like an abandoned WhatsApp extra.
    }
    const questionKey = field.key.slice("extra:".length);
    if (field.kind === "select") {
      const option = (field.options ?? []).find((candidate) => candidate.value === value);
      if (!option) {
        errors.push(`Please choose a valid answer for "${field.label}".`);
        continue;
      }
      extraAnswers[questionKey] = option.title; // the TITLE is what screening_extra_answers holds.
      shownValues[field.key] = option.value;
      if (field.endOn?.values.includes(option.value)) {
        endedMessage = field.endOn.message;
        break;
      }
    } else {
      const cleaned = cleanExtraAnswerText(value);
      if (cleaned) extraAnswers[questionKey] = cleaned;
    }
  }

  if (errors.length > 0) return { errors, ok: false };

  return {
    classification: {
      areaName,
      declaredBackground,
      endedMessage,
      expectedSalary,
      expectedSalaryFigure: expectedSalary ? parseDeclaredSalaryFigure(expectedSalary) : null,
      experienceLabel,
      extraAnswers,
      jobTitle: role.jobTitle,
      regionCode,
      regionOtherText,
    },
    ok: true,
  };
}

// ── Submitting: ingest the CV, then write the same classification the bot writes ───────────────────

export type WebsiteApplySubmission = {
  role: WebsiteApplyRole;
  fullName: string;
  email: string;
  phone: string;
  classification: WebsiteApplyClassification;
  attachment: InboundCvAttachment;
};

export type WebsiteApplyOutcome =
  /** `endedMessage` is set when an answer ended the application early: the CV and answers are
   *  recorded, no confirmation letter is sent, and the message is what the applicant is shown. */
  | { ok: true; candidateId: string; endedMessage: string | null }
  | { ok: false; reason: "unreadable_cv" | "duplicate" | "error"; message: string };

/**
 * Write the six-plus-extras answers onto a candidate the intake has just created or matched. Mirrors
 * whatsapp-classify-session.ts's writeClassification + whatsapp-screening-questions-session.ts's
 * finishExtraQuestionLoop, field for field — an optional column is written only when it has a value,
 * because writing an optional field unconditionally is a silent erase.
 */
async function applyWebsiteClassification(
  candidateId: string,
  classification: WebsiteApplyClassification,
  roleFamily: CandidateRoleFamily,
): Promise<void> {
  const supabase = recruitmentDb();
  const nowIso = new Date().toISOString();

  const payload: Record<string, unknown> = {
    applied_for_job_title: classification.jobTitle,
    preferences_declared_at: nowIso,
  };
  // Only where the role was asked them — the HR Section Head is asked neither, and writing a blank
  // would erase an answer a matched candidate already holds.
  if (classification.experienceLabel) payload.declared_experience = classification.experienceLabel;
  if (classification.expectedSalary) payload.declared_expected_salary = classification.expectedSalary;
  // The numeric column is filled ONLY when the answer really is a figure — everything that reads it
  // (the workspace salary cell, the merge borrow list) expects a real number, so "negotiable" or a
  // range leaves it untouched and keeps its words in declared_expected_salary. See
  // parseDeclaredSalaryFigure for why this split exists.
  if (classification.expectedSalaryFigure !== null) {
    payload.expected_salary = classification.expectedSalaryFigure;
  }
  // Background / region / area — written only when the role was asked them AND the applicant answered,
  // field for field the same as whatsapp-classify-session's writeClassification. An unanswered column
  // is left untouched rather than blanked, because writing an optional field unconditionally erases.
  if (classification.declaredBackground) payload.declared_background = classification.declaredBackground;
  // The code column takes ONLY a real code; a typed region is words and goes to its own name column.
  if (classification.regionCode) payload.preferred_region_code = classification.regionCode;
  if (classification.regionOtherText) payload.preferred_region_name = classification.regionOtherText;
  if (classification.areaName) payload.preferred_area_name = classification.areaName;
  // The role family they picked, raw — what the workspace files them by, the same column the WhatsApp
  // bot writes (owner, 2026-10-20: filed from the applicant's own answers, never the CV).
  payload.declared_role_family = roleFamily;

  const { error } = await supabase.from("ats_candidates").update(payload).eq("id", candidateId);
  if (error) throw error;

  // The extra answers key by key, as the bot merges them — never the whole map, which would erase an
  // answer HR had added for a matched candidate. These are new answers, so they win over HR's marks.
  if (Object.keys(classification.extraAnswers).length > 0) {
    await mergeExtraAnswers(candidateId, classification.extraAnswers);
  }

  // Filed where the answers say (placed by `website`), then the stored completeness. Never throws.
  await placeFromAnswers({
    areaName: classification.areaName,
    candidateId,
    placedBy: "website",
    regionCode: classification.regionCode,
    roleFamily,
  });
  await recomputeCompleteness([candidateId]);
}

/**
 * The full submit: one ingestInboundCv call (channel "website", identity from the applicant's own
 * details), then the classification write. Returns a browser-safe outcome — the CV is captured and
 * the candidate exists the moment ingest returns a candidate id, and a failure to write the
 * classification afterwards never loses the applicant (it is logged, and the candidate stands).
 */
export async function submitWebsiteApplication(input: WebsiteApplySubmission): Promise<WebsiteApplyOutcome> {
  let result: InboundCvIntakeResult;
  try {
    result = await ingestInboundCv({
      attachment: input.attachment,
      candidate: { email: input.email, fullName: input.fullName, phone: input.phone },
      channel: "website",
      // The paid model read is capped per day for this public channel (P5-02); past the cap the CV is
      // still captured and read the free way.
      aiBudget: consumePublicApplyAiRead,
      // What the applicant applied for is known here, not guessed from the CV — but the covering
      // message still helps extraction answer the other fields, exactly as an email subject does.
      coverMessage: `Applied via the Sato Pharma careers website for: ${input.role.jobTitle}`,
      // A real applicant's own email is their contact detail — the default "sender" identity, never
      // the "cv" path (that is only for bulk forward-imports off a shared handset/mailbox).
      providerMessageId: `website:${randomUUID()}`,
      senderDisplayName: input.fullName,
      senderIdentifier: input.email,
      subject: `Careers website application — ${input.role.jobTitle}`,
    });
  } catch (error) {
    logError("Website application intake failed", {
      error,
      labels: { event: "website_apply_intake_failed", role: input.role.key },
    });
    return { message: "Something went wrong. Please try again.", ok: false, reason: "error" };
  }

  if (result.outcome === "candidate_created" || result.outcome === "candidate_matched") {
    const candidateId = result.candidateId;
    if (!candidateId) {
      // Shape guarantees this never happens, but a candidate without an id cannot carry answers.
      return { message: "Something went wrong. Please try again.", ok: false, reason: "error" };
    }
    try {
      await applyWebsiteClassification(candidateId, input.classification, input.role.roleFamily);
    } catch (error) {
      // The candidate and CV are already safely captured; the screening answers are best-effort on
      // top of that — never fail the application for them. Logged so a systematic failure is visible.
      logError("Website application classification write failed", {
        error,
        labels: { candidate_id: candidateId, event: "website_apply_classification_failed", role: input.role.key },
      });
    }
    // An application an answer ended gets the owner's message on screen and NO letter: a confirmation
    // saying "we received your application" would contradict the message the applicant was just shown.
    // The e-mail is not the vehicle for that message — only the WhatsApp Cairo thank-you was approved
    // to go out on its own.
    if (input.classification.endedMessage) {
      return { candidateId, endedMessage: input.classification.endedMessage, ok: true };
    }
    // The applicant's confirmation letter — the SATO house template, sent to their own address. Best
    // effort on top of an already-captured application: an e-mail that cannot be sent (provider down,
    // notifications off, held by the confidence gate) must NEVER fail the submission or lose the CV.
    try {
      await sendWebsiteApplyConfirmation({
        email: input.email,
        fullName: input.fullName,
        roleTitle: input.role.title,
      });
    } catch (error) {
      logError("Website application confirmation e-mail failed", {
        error,
        labels: { candidate_id: candidateId, event: "website_apply_confirmation_failed", role: input.role.key },
      });
    }
    return { candidateId, endedMessage: null, ok: true };
  }

  if (result.outcome === "ignored_duplicate") {
    // A brand-new random providerMessageId cannot duplicate; this only arises if the same submission
    // reached ingest twice. It is already recorded — treat it as a success with no second write.
    return { message: "This application has already been received.", ok: false, reason: "duplicate" };
  }

  // ignored_no_attachment / ignored_unsupported_attachment: the file could not be read as a CV.
  return {
    message: "We could not read that file as a CV. Please upload a PDF or Word document.",
    ok: false,
    reason: "unreadable_cv",
  };
}

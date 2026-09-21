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
  | "regulatory_affairs_specialist"
  | "quality_control_analyst";

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
  talent_acquisition_specialist: {
    jobTitle: "Talent Acquisition Specialist",
    key: "talent_acquisition_specialist",
    roleFamily: "human_resources",
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

function extraField(question: ScreeningQuestion): WebsiteApplyField {
  if (question.kind === "free_text") {
    return {
      helpText: null,
      key: websiteExtraFieldKey(question.questionKey),
      kind: "text",
      label: question.bodyText,
      // Extras are optional on WhatsApp (the loop can be abandoned), so they are optional here too —
      // a missing answer must never block an application.
      maxLength: 200,
      required: false,
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
    required: false,
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
  experienceLabel: string;
  expectedSalary: string;
  expectedSalaryFigure: number | null;
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

  // Experience — a required tappable band. Its field is present for every role (universal built-in),
  // so a missing or unrecognised value is a real error, not a skipped optional.
  const experienceRaw = String(raw.answers.experience ?? "").trim();
  let experienceLabel = "";
  if (!experienceRaw) {
    errors.push("Please choose how many years of experience you have.");
  } else if (!isOfferedExperience(experienceRaw)) {
    errors.push("Please choose a valid experience option.");
  } else {
    experienceLabel = candidateExperienceLabels[experienceRaw];
  }

  // Salary — required free text, stored verbatim (never coerced). Same rule as the bot: a number, a
  // range and "negotiable" are all truthful answers a recruiter reads.
  const expectedSalary = cleanTypedAnswer(raw.answers.salary, EXPECTED_SALARY_MAX);
  if (!expectedSalary) errors.push("Please enter your expected monthly net salary.");

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

  // Extras — optional, but any answer given must match an option the question defines.
  const extraAnswers: Record<string, string> = {};
  for (const field of form.fields) {
    if (!field.key.startsWith("extra:")) continue;
    const value = String(raw.answers[field.key] ?? "").trim();
    if (!value) continue; // optional — no answer, no column, exactly like an abandoned WhatsApp extra.
    const questionKey = field.key.slice("extra:".length);
    if (field.kind === "select") {
      const option = (field.options ?? []).find((candidate) => candidate.value === value);
      if (!option) {
        errors.push(`Please choose a valid answer for "${field.label}".`);
        continue;
      }
      extraAnswers[questionKey] = option.title; // the TITLE is what screening_extra_answers holds.
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
      expectedSalary: expectedSalary as string,
      expectedSalaryFigure: parseDeclaredSalaryFigure(expectedSalary),
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
  | { ok: true; candidateId: string }
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
): Promise<void> {
  const supabase = recruitmentDb();
  const nowIso = new Date().toISOString();

  const payload: Record<string, unknown> = {
    applied_for_job_title: classification.jobTitle,
    declared_experience: classification.experienceLabel,
    declared_expected_salary: classification.expectedSalary,
    preferences_declared_at: nowIso,
  };
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
  if (Object.keys(classification.extraAnswers).length > 0) {
    payload.screening_extra_answers = classification.extraAnswers;
  }

  const { error } = await supabase.from("ats_candidates").update(payload).eq("id", candidateId);
  if (error) throw error;
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
      await applyWebsiteClassification(candidateId, input.classification);
    } catch (error) {
      // The candidate and CV are already safely captured; the screening answers are best-effort on
      // top of that — never fail the application for them. Logged so a systematic failure is visible.
      logError("Website application classification write failed", {
        error,
        labels: { candidate_id: candidateId, event: "website_apply_classification_failed", role: input.role.key },
      });
    }
    return { candidateId, ok: true };
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

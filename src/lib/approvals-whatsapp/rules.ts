// Approvals WhatsApp — the pure rules of the owner's WhatsApp screen on the approvals line (+20 10 40631155).
//
// Owner, 19 Nov 2026, four answers: "Keep them, my screen only" (replies on this number are kept and shown on his
// screen alone), "Super Admin only", "Phoenix people + pasted" (recipients come from the employee master or are pasted),
// "Submit from the screen" (new wordings go to Meta from the screen). Nothing in this file reads the database or the
// network, so every rule here is tested directly (tests/approvals-whatsapp.test.ts).

import type { AccessContext } from "@/lib/auth/permissions";


// ── Who may open it ──

/**
 * The Super Admin, acting as himself. Checked by ROLE in every route and on the page — never by a permission-matrix
 * grant, so no future widening of a resource can open these conversations to another role.
 */
export function canUseApprovalsWhatsApp(access: Pick<AccessContext, "role" | "source"> | null | undefined): boolean {
  if (!access || access.source === "guest") return false;
  return access.role === "Super Admin";
}

// ── Phone numbers ──

/**
 * One number in Meta's digits-only form, or null when it cannot be a WhatsApp number. An Egyptian mobile in any common
 * spelling (01xxxxxxxxx, 1xxxxxxxxx, +20 1xx…, 0020 1xx…) becomes 201xxxxxxxxx; any other number must already carry its
 * country code. A local landline (02…, 03…) is refused: it cannot hold WhatsApp.
 */
export function normaliseApprovalsPhone(value: string | null | undefined): string | null {
  let digits = String(value ?? "").replace(/\D+/g, "");
  if (!digits) return null;
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (/^01[0125]\d{8}$/.test(digits)) return `2${digits}`;
  if (/^1[0125]\d{8}$/.test(digits)) return `20${digits}`;
  if (/^201[0125]\d{8}$/.test(digits)) return digits;
  if (digits.startsWith("20")) return null; // an Egyptian number that is not a mobile
  if (digits.startsWith("0")) return null; // a local number with no country code
  return /^\d{10,15}$/.test(digits) ? digits : null;
}

export type PastedNumbers = {
  /** Valid and new, in the order pasted. */
  valid: string[];
  /** As pasted, with why each was skipped. */
  invalid: Array<{ text: string; reason: string }>;
  /** Valid but already in the paste, or already chosen elsewhere. */
  duplicates: string[];
};

/** Splits pasted text into numbers — one per line, or separated by commas or semicolons. */
export function parsePastedNumbers(text: string, alreadyChosen: Iterable<string> = []): PastedNumbers {
  const seen = new Set(alreadyChosen);
  const result: PastedNumbers = { duplicates: [], invalid: [], valid: [] };
  for (const raw of String(text ?? "").split(/[\n\r,;]+/)) {
    const piece = raw.trim();
    if (!piece) continue;
    const waId = normaliseApprovalsPhone(piece);
    if (!waId) {
      result.invalid.push({ reason: "Not a mobile number with a country code, or an Egyptian mobile (01…).", text: piece });
      continue;
    }
    if (seen.has(waId)) {
      result.duplicates.push(waId);
      continue;
    }
    seen.add(waId);
    result.valid.push(waId);
  }
  return result;
}

export type ApprovalsRecipient = {
  waId: string;
  employeeHrId: string | null;
  displayName: string | null;
};

/** One row per number, the FIRST kept — an employee row chosen before a pasted copy keeps its name. */
export function dedupeRecipients<T extends ApprovalsRecipient>(recipients: readonly T[]): { recipients: T[]; duplicates: T[] } {
  const seen = new Set<string>();
  const kept: T[] = [];
  const duplicates: T[] = [];
  for (const recipient of recipients) {
    if (seen.has(recipient.waId)) {
      duplicates.push(recipient);
      continue;
    }
    seen.add(recipient.waId);
    kept.push(recipient);
  }
  return { duplicates, recipients: kept };
}

/** `+20 10 4063 1155` for reading; other numbers as `+<digits>`. */
export function formatApprovalsPhone(waId: string | null | undefined): string | null {
  const digits = String(waId ?? "").replace(/\D+/g, "");
  if (!digits) return null;
  if (/^20\d{10}$/.test(digits)) return `+20 ${digits.slice(2, 4)} ${digits.slice(4, 8)} ${digits.slice(8)}`;
  return `+${digits}`;
}

// ── The 24-hour window ──

export const APPROVALS_REPLY_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Free text, emoji and attachments may go only while the contact's own last message is under 24 hours old; after that
 * WhatsApp accepts an approved template only (Meta answers 131047). The window runs from THEIR last live message.
 */
export function approvalsReplyWindow(lastInboundAt: string | null | undefined, now = Date.now()): { open: boolean; closesAt: string | null } {
  const at = lastInboundAt ? Date.parse(lastInboundAt) : NaN;
  if (!Number.isFinite(at)) return { closesAt: null, open: false };
  const closes = at + APPROVALS_REPLY_WINDOW_MS;
  return { closesAt: new Date(closes).toISOString(), open: now < closes };
}

// ── Meta's daily limit ──

/** The line is on Meta's TIER_250: 250 unique contacts may receive a business-started message in any 24 hours. */
export const APPROVALS_TIER_LIMIT = 250;

export type TierCheck = {
  limit: number;
  /** Unique contacts already sent a template in the last 24 hours. */
  usedToday: number;
  /** In this batch and not yet counted today. */
  newContacts: number;
  /** In this batch and already counted today — they cost nothing more. */
  alreadyCounted: number;
  remaining: number;
  allowed: boolean;
  /** How many contacts over the limit the batch is; 0 when allowed. */
  overBy: number;
};

/**
 * Whether a batch fits inside today's limit. A number already messaged today is not counted twice; a batch that would
 * take the day past the limit is REFUSED WHOLE — never half sent, because a half-sent bulk message is the one the owner
 * cannot reason about afterwards.
 */
export function tier250Check(input: { contactedToday: Iterable<string>; batch: Iterable<string>; limit?: number }): TierCheck {
  const limit = input.limit ?? APPROVALS_TIER_LIMIT;
  const today = new Set(input.contactedToday);
  const batch = new Set(input.batch);
  let alreadyCounted = 0;
  for (const waId of batch) if (today.has(waId)) alreadyCounted += 1;
  const newContacts = batch.size - alreadyCounted;
  const remaining = Math.max(0, limit - today.size);
  const overBy = Math.max(0, newContacts - remaining);
  return { allowed: overBy === 0, alreadyCounted, limit, newContacts, overBy, remaining, usedToday: today.size };
}

// ── Template parameters filled per recipient ──

export const EMPLOYEE_PARAMETER_FIELDS = [
  { key: "name_with_title", label: "Name with Arabic title (د. / أ.)" },
  { key: "first_name", label: "First name" },
  { key: "full_name", label: "Full name" },
  { key: "job_title", label: "Job title" },
  { key: "area", label: "Area" },
  { key: "region", label: "Region" },
  { key: "department", label: "Department" },
] as const;

type EmployeeParameterField = (typeof EMPLOYEE_PARAMETER_FIELDS)[number]["key"];

export type ParameterSource =
  | { source: "fixed"; text: string }
  | { source: "employee"; field: EmployeeParameterField; fallback?: string | null };

/** Template field key (`body:name`) → how it is filled. */
export type ParameterMapping = Record<string, ParameterSource>;

export type RecipientProfile = {
  displayName: string | null;
  nameAr: string | null;
  qualification: string | null;
  jobTitle: string | null;
  areaName: string | null;
  regionName: string | null;
  departmentName: string | null;
  gender: string | null;
};

// A pharmacist or a physician is addressed as doctor. Read off the qualification first, then the job title.
const MEDICAL = /pharm|medic|mbbch|m\.?b\.?b|doctor|dentist|dental|veterin|b\.?sc\.?\s*pharm|صيدل|طب|دكتور/i;

/** "د." for a medical or pharmacy qualification, else "أ." — the FAB send of 18 Nov 2026 addressed people this way. */
function arabicTitleFor(profile: Pick<RecipientProfile, "qualification" | "jobTitle">): "د." | "أ." {
  return MEDICAL.test(profile.qualification ?? "") || /^dr\.?\s/i.test(profile.jobTitle ?? "") ? "د." : "أ.";
}

function firstWord(value: string | null | undefined): string | null {
  const word = String(value ?? "").trim().split(/\s+/)[0];
  return word ? word : null;
}

/** One employee field's value for one recipient, or null when the record does not hold it. */
function employeeFieldValue(field: EmployeeParameterField, profile: RecipientProfile): string | null {
  switch (field) {
    case "name_with_title": {
      const first = firstWord(profile.nameAr) ?? firstWord(profile.displayName);
      return first ? `${arabicTitleFor(profile)} ${first}` : null;
    }
    case "first_name":
      return firstWord(profile.displayName);
    case "full_name":
      return profile.displayName?.trim() || null;
    case "job_title":
      return profile.jobTitle?.trim() || null;
    case "area":
      return profile.areaName?.trim() || null;
    case "region":
      return profile.regionName?.trim() || null;
    case "department":
      return profile.departmentName?.trim() || null;
    default:
      return null;
  }
}

/**
 * Every template field filled for one recipient. A pasted number has no employee record, so an employee field falls
 * back to its fallback text; a field still empty is named in `missing`, and that recipient is not sent (Meta refuses an
 * empty parameter).
 */
export function fillParameterValues(
  fieldKeys: readonly string[],
  mapping: ParameterMapping,
  profile: RecipientProfile | null,
): { values: Record<string, string>; missing: string[] } {
  const values: Record<string, string> = {};
  const missing: string[] = [];
  for (const key of fieldKeys) {
    const source = mapping[key];
    let value: string | null = null;
    if (source?.source === "fixed") value = source.text.trim() || null;
    else if (source?.source === "employee") value = (profile ? employeeFieldValue(source.field, profile) : null) ?? (source.fallback?.trim() || null);
    // WhatsApp refuses a parameter carrying a new line, a tab or more than four spaces in a row.
    if (value) values[key] = value.replace(/[\r\n\t]+/g, " ").replace(/ {5,}/g, "    ").trim();
    else missing.push(key);
  }
  return { missing, values };
}

export function parseParameterMapping(raw: unknown): ParameterMapping {
  const mapping: ParameterMapping = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return mapping;
  const fields = new Set<string>(EMPLOYEE_PARAMETER_FIELDS.map((field) => field.key));
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const entry = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
    if (!entry || !/^(header|body):[A-Za-z0-9_]+$/.test(key)) continue;
    if (entry.source === "fixed" && typeof entry.text === "string") mapping[key] = { source: "fixed", text: entry.text.slice(0, 1000) };
    else if (entry.source === "employee" && typeof entry.field === "string" && fields.has(entry.field)) {
      mapping[key] = {
        fallback: typeof entry.fallback === "string" ? entry.fallback.slice(0, 200) : null,
        field: entry.field as EmployeeParameterField,
        source: "employee",
      };
    }
  }
  return mapping;
}

// ── New wordings ──

export type TemplateSubmission = {
  name: string;
  language: "ar" | "en";
  category: "UTILITY" | "MARKETING";
  body: string;
  examples: Record<string, string>;
};

const NAMED_PARAM = /\{\{\s*([^{}]*?)\s*\}\}/g;

/**
 * Checks a new wording before Meta sees it, and builds the request in the shape
 * scripts/approvals/submit-urgent-reminder-template.ts already proved (named parameters, one example each).
 */
export function buildTemplateSubmission(input: {
  name: unknown;
  language: unknown;
  category: unknown;
  body: unknown;
  examples: unknown;
}): { ok: true; submission: TemplateSubmission; request: Record<string, unknown> } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!/^[a-z0-9_]{1,512}$/.test(name)) problems.push("The name may use only small English letters, numbers and _ (for example phx_finance_notice).");
  const language = input.language === "ar" || input.language === "en" ? input.language : null;
  if (!language) problems.push("Choose Arabic or English.");
  const category = input.category === "UTILITY" || input.category === "MARKETING" ? input.category : null;
  if (!category) problems.push("Choose Utility or Marketing.");
  const body = typeof input.body === "string" ? input.body.trim() : "";
  if (!body) problems.push("Write the message.");
  if (body.length > 1024) problems.push("A WhatsApp message can be at most 1,024 characters.");

  const params: string[] = [];
  for (const match of body.matchAll(NAMED_PARAM)) {
    const param = match[1] ?? "";
    if (!/^[a-z][a-z0-9_]*$/.test(param)) {
      problems.push(`{{${param}}}: a field name uses small English letters, numbers and _, starting with a letter.`);
      continue;
    }
    if (!params.includes(param)) params.push(param);
  }
  if (/^\s*\{\{|\}\}\s*$/.test(body)) problems.push("The message may not start or end with a field.");

  const rawExamples = input.examples && typeof input.examples === "object" && !Array.isArray(input.examples) ? (input.examples as Record<string, unknown>) : {};
  const examples: Record<string, string> = {};
  for (const param of params) {
    const example = typeof rawExamples[param] === "string" ? (rawExamples[param] as string).trim() : "";
    if (!example) problems.push(`Give an example for {{${param}}} — Meta reviews the message with it.`);
    else examples[param] = example;
  }
  if (problems.length > 0 || !language || !category) return { ok: false, problems };

  const component: Record<string, unknown> = { text: body, type: "BODY" };
  if (params.length > 0) {
    component.example = { body_text_named_params: params.map((param) => ({ example: examples[param], param_name: param })) };
  }
  return {
    ok: true,
    request: { category, components: [component], language, name, parameter_format: "NAMED" },
    submission: { body, category, examples, language, name },
  };
}

// Recruitment / ATS — AI CV field extraction (schema-driven, per position).
//
// Reads an already-uploaded CV. Text-based PDF/DOCX get their raw text extracted locally
// first; scanned/photographed CVs are read directly by OpenAI's vision-capable model instead (no
// separate OCR library/vendor — reuses the same OPENAI_API_KEY and model already configured for
// text extraction). A scan is recognised two ways: by file type when it arrives as .jpg/.png, and
// by an implausibly thin text layer when the same photograph arrives wrapped in a PDF — the second
// of those is cv-text-layer.ts, added after a real applicant was dropped for it. Either way, the
// same schema-driven structured-output call proposes that position's candidate fields
// (src/lib/recruitment/cv-field-schemas.ts) with a per-field confidence rating, following the
// same structured-output pattern as src/lib/email/ai-assist.ts. This module never writes to
// ats_candidates itself — the caller reviews/corrects the proposal and saves it via
// updateCandidate(); recordAppliedExtractionFields() only updates this module's own
// audit-trail row (a correction log for future prompt tuning, not a training pipeline).
//
// Because applying is deliberately human, a stored proposal has to be reachable — otherwise the
// automated intake path (which has no human in it) writes an extraction nobody can ever see.
// getLatestCvExtraction below, with the pure helpers in cv-extraction-fields.ts, hands a saved
// proposal back to the review board without spending a second AI call on a CV already read.

import "@/lib/recruitment/pdf-dommatrix-polyfill";

import { PDFParse } from "pdf-parse";
import * as mammoth from "mammoth";
import WordExtractor from "word-extractor";

import type { AccessContext } from "@/lib/auth/permissions";
import {
  createOpenAiResponseText,
  hasAiApiKey,
  OPENAI_COPILOT_DEFAULT_MODEL,
  OPENAI_NANO_MODEL,
  OPENAI_ROUTE_BUDGET_MS,
  PhoenixOpenAiError,
  type PhoenixOpenAiErrorCode,
} from "@/lib/ai/openai-client";
import { tryParseAiJson } from "@/lib/ai/parse-ai-json";
import { logError } from "@/lib/observability/log";
import { getCandidate, updateCandidate } from "@/lib/recruitment/candidates";
import { selectAutoApplyFields } from "@/lib/recruitment/cv-auto-apply";
import { resolveCandidateFullNameFromCv } from "@/lib/recruitment/candidate-name-from-cv";
import {
  normalizeStoredExtractionFields,
  withoutNulBytes,
  type ExtractedCandidateFields,
  type ExtractedField,
  type StoredCvExtraction,
} from "@/lib/recruitment/cv-extraction-fields";
import {
  defaultCvPositionKey,
  getCvPositionSchema,
  type CvFieldDefinition,
  type CvFieldType,
  type CvPositionSchema,
} from "@/lib/recruitment/cv-field-schemas";
import { detectCvFileKind, isLegacyDocBytes } from "@/lib/recruitment/cv-file-kind";
import { isThinCvRead, mergeCvExtractions, scoreCvExtraction } from "@/lib/recruitment/cv-extraction-quality";
import {
  aiFieldsWorthAsking,
  mergeRuleAndAiExtractions,
  shouldEscalateToAi,
} from "@/lib/recruitment/cv-extraction-merge";
import { extractTextByOcr } from "@/lib/recruitment/cv-ocr";
import { runRuleCvExtraction, type CvRuleContext, type RuleExtractionResult } from "@/lib/recruitment/rule-extraction";
import { chooseCvExtractionRoute, MAX_PDF_VISION_BYTES, type CvExtractionRoute } from "@/lib/recruitment/cv-text-layer";
import { recruitmentDb } from "@/lib/recruitment/db";
import { getFileForDownload, listCandidateFiles } from "@/lib/recruitment/files";
import type { RecruitmentFile } from "@/lib/recruitment/types";

export class CvExtractionError extends Error {
  code: "ai_failed" | "ai_not_configured" | "ai_rate_limited" | "unsupported_file" | "no_cv_file";
  /**
   * The OpenAI-level cause, when there was one.
   *
   * `code` cannot carry it and should not try: THREE different PhoenixOpenAiError codes — timeout,
   * auth_failed, and a generic failure — all collapse into "ai_failed" in
   * cvExtractionErrorFromOpenAi. That is the right answer for the sentence a human reads, and the
   * wrong one for the spend decision in shouldEscalateAfterFailure, which needs to know whether the
   * model actually answered. Keeping both means neither has to be compromised for the other.
   *
   * Undefined for "unsupported_file" and "no_cv_file", which are decided before OpenAI is involved.
   */
  openAiCode?: PhoenixOpenAiErrorCode;

  constructor(code: CvExtractionError["code"], message: string, openAiCode?: PhoenixOpenAiErrorCode) {
    super(message);
    this.name = "CvExtractionError";
    this.code = code;
    this.openAiCode = openAiCode;
  }
}

/**
 * Is this failure worth spending a SECOND read on?
 *
 * Only when it says something about the DOCUMENT. A transport or account failure hits the
 * escalation identically — same key, same account, same socket — so a second attempt cannot succeed
 * where the first did not, and for a rate limit or an exhausted quota it actively makes things
 * worse by firing another request into the wall that just stopped us.
 *
 * This matters more than a retry guard normally would, because the escalation is not like-for-like.
 * For a PDF it is the VISION route, which cvModelForRoute puts on the premium tier at 12x nano. So
 * before this existed, a slow socket bought a 12x read of a document nothing was wrong with.
 *
 * That was survivable at the timeout rate actually measured on production 2026-08-27 — 1 in 50,
 * and that one self-healed on the SDK's own retry (OPENAI_MAX_RETRIES = 1) without ever reaching
 * here. The reason to fix it anyway is that timeouts do not arrive independently: they cluster
 * during a provider slowdown, when every CV in the queue fails both attempts at once and every one
 * of them escalates together. The bill is then a multiple of the BATCH, not of one CV — the same
 * shape as the reasoning-effort drain of #2162, which is what exhausted the credits in the first
 * place. A per-call multiplier is invisible until it is correlated.
 *
 * "failed" stays escalatable on purpose. It is the one code that can mean the model answered and
 * the answer was unusable — a 400 on this document's content, or a parse failure below — which is
 * exactly the case a different route or a stronger model can fix.
 */
export function shouldEscalateAfterFailure(error: unknown): boolean {
  const code = error instanceof CvExtractionError ? error.openAiCode : undefined;
  if (!code) return true; // no OpenAI cause recorded: a parse failure, or a caller-side error
  switch (code) {
    case "timeout":
    case "rate_limited":
    case "quota_exceeded":
    case "auth_failed":
    case "not_configured":
      return false;
    case "failed":
      return true;
  }
}

// Declared in cv-extraction-fields.ts (isomorphic, so client components can use the logic around
// them) and re-exported here so every existing importer keeps its import path.
export type {
  ExtractedCandidateFields,
  ExtractedCvValue,
  ExtractedField,
  ExtractedFieldConfidence,
  StoredCvExtraction,
} from "@/lib/recruitment/cv-extraction-fields";

export type CvExtractionResult = {
  extractionId: string;
  model: string;
  positionKey: string;
  fields: ExtractedCandidateFields;
};

// The AI half of an extraction, before it is tied to a candidate/file row. Split out so a
// CV can be read while no candidate exists yet — see extractCvFieldsFromBytes.
export type CvFieldExtraction = {
  model: string;
  positionKey: string;
  fields: ExtractedCandidateFields;
  // Whether the document actually IS a CV/resume — returned by the same call that extracts the
  // fields (see is_cv in the schema), so inbound intake gets the "is this a CV" gate for free
  // instead of a second, separate classification call. Fails OPEN (true) if the model omits it.
  isCv: boolean;
};

// Bounds AI token cost/abuse regardless of the source file's size — a CV is a couple of
// pages; this comfortably covers even a verbose one.
const MAX_CV_TEXT_CHARS = 20_000;

// Raised from 2,000 on 2026-08-14 with the move to the universal schema. 2,000 was sized for 12
// scalar fields; the schema now carries ~30 scalars PLUS repeating blocks, and a CV listing five
// separate roles with their responsibilities will not fit in 2,000 output tokens. A truncated
// structured-output response fails to parse and the applicant is dropped, so the cap has to clear
// the worst realistic CV rather than the typical one.
const MAX_CV_EXTRACTION_OUTPUT_TOKENS = 8_000;

/**
 * How hard the model is allowed to think, chosen per ROUTE rather than once for everything.
 *
 * Hidden reasoning tokens are the part of the bill nobody sees: raising this medium -> high on
 * 2026-08-16 (#2162) was the single change that exhausted the credits, and dropping it back on
 * 2026-08-18 is what stopped the bleeding. A flat setting is the wrong shape for it, because the
 * two routes are not the same job:
 *
 *   • "text"   — the rules already read this document and won every deterministic field (email,
 *                phone, summary, governorate: 93-98% accurate). The model is here only to fill
 *                judgement gaps out of clean, already-extracted text. That is not hard thinking,
 *                and it is by far the COMMON case, so it is where a lower setting pays.
 *   • vision   — the model is reading pixels or rendering a PDF itself: two-column layouts,
 *                handwriting, a photograph taken at an angle. This is the work that actually needs
 *                reasoning, and it is rare — 24 of 555 candidates arrived as an image.
 *
 * Spending the effort where the difficulty is, rather than everywhere, is the whole idea.
 */
export function cvReasoningEffortForRoute(route: CvExtractionRoute): "low" | "medium" {
  return route === "text" ? "low" : "medium";
}

/**
 * WHICH model reads the document, chosen per route for the same reason the effort above is.
 *
 * gpt-5.4 costs $2.50 / $15.00 per million input / output tokens; the nano tier costs $0.20 /
 * $1.25 — 12.5x the input and 12x the output. Until 2026-08-27 every CV paid the premium tier,
 * and that single call site was the entire OpenAI bill: 514 of the account's billed calls between
 * 24 July and 26 August came from here, every other consumer in the codebase being nano or
 * gpt-4o-mini. It is also the wrong tier for the common case, on this module's own evidence —
 * the rules engine has ALREADY won the deterministic fields (email, phone, summary, governorate:
 * 93-98%) before the model is asked anything, and what is left is gap-filling out of clean text.
 *
 * The vision routes keep gpt-5.4. Reading pixels, a two-column layout, or a photograph taken at an
 * angle is the case the reasoning tier exists for, and it is rare: 24 of 555 candidates arrived as
 * an image. So the ladder now runs cheap-then-premium — the expensive model is spent on the
 * documents that actually defeated the cheap one rather than on all of them in advance, which is
 * what the escalation in runAiExtraction was already shaped to do.
 */
export function cvModelForRoute(route: CvExtractionRoute): string {
  return route === "text" ? OPENAI_NANO_MODEL : OPENAI_COPILOT_DEFAULT_MODEL;
}

/**
 * The second chance for a text read that has no better ROUTE to escalate to.
 *
 * A PDF read from its text layer always has one — hand the file over and let the model render the
 * pages. A .docx does not: there is no image form of it, so a thin read there was simply accepted.
 * That was survivable while the text route ran on gpt-5.4. It stopped being survivable the moment
 * that route moved to nano (see cvModelForRoute), because the read now accepted with no second
 * opinion is the CHEAP one — and `is_cv` follows the MODEL, not the rules, by deliberate design
 * further down. A wrong "this isn't a CV" therefore suppresses a real applicant with nothing left
 * to overturn it. 40 of 636 stored CV files are Word, measured on production 2026-08-27.
 *
 * So when there is no better route, escalate to a better MODEL: the same text, read again by the
 * reasoning tier. Null the moment that would be pointless — a route that already has a vision
 * escalation, a route that already IS vision, and, deliberately, a text route that is itself
 * already premium. That last clause makes this self-disabling: put the text route back on gpt-5.4
 * and this stops firing on its own instead of quietly paying twice for the same answer.
 */
export function cvTextRetryModel(route: CvExtractionRoute, hasRouteEscalation: boolean): string | null {
  if (hasRouteEscalation || route !== "text") return null;
  return cvModelForRoute(route) === OPENAI_COPILOT_DEFAULT_MODEL ? null : OPENAI_COPILOT_DEFAULT_MODEL;
}

// What gets written to ats_candidate_cv_extractions.ai_model when no model was involved at all.
// Recorded rather than left null so the audit trail can answer "how was this candidate read?", and
// so the share of CVs costing nothing is countable from the table itself:
//
//   select ai_model, count(*) from ats_candidate_cv_extractions group by 1;
export const RULE_ONLY_EXTRACTION_MODEL = "phoenix-rules";
// Written when the document was a SCAN and the model could not be reached, so the text came from
// free OCR. Distinct from the value above because the accuracy is materially different and a
// reviewer looking at a doubtful record deserves to know which of the two produced it.
export const OCR_EXTRACTION_MODEL = "phoenix-rules+ocr";
// Written when both engines contributed — the rules read the CV and the model was asked to fill
// what they could not. The model's own name is prefixed so cost can still be attributed to it.
const ruleAssistedModel = (model: string) => `${model}+rules`;

// True when the row's model means NO model was ever asked. Only the two constants above qualify:
// the `<model>+rules` form written by ruleAssistedModel means the model DID answer, it just had the
// rules' fields handed to it. Exported because persistCvExtraction is not the only place that has
// to tell a free read from a paid one, and a third rules-only engine must not be addable without
// this predicate in view.
export function isRuleOnlyExtractionModel(model: string): boolean {
  return model === RULE_ONLY_EXTRACTION_MODEL || model === OCR_EXTRACTION_MODEL;
}

// ---------------------------------------------------------------------------
// Structured-output schema, built dynamically from a CvPositionSchema (same
// "text: json_schema, strict: true" shape as src/lib/email/ai-assist.ts's
// emailDraftTextFormat — only the property list now comes from the schema registry
// instead of being hand-written per field).
// ---------------------------------------------------------------------------

// A scalar field's JSON type. "date" and "number" are carried as strings/numbers respectively;
// dates stay strings because the prompt pins the YYYY-MM-DD format and a JSON-schema "format"
// keyword is advisory anyway — validating the shape here would reject a CV that wrote "2019" and
// lose the year entirely, which is worse than storing it loosely and flagging low confidence.
function scalarValueType(type: Exclude<CvFieldType, "array">) {
  if (type === "boolean") return ["boolean", "null"] as const;
  if (type === "number") return ["number", "null"] as const;
  return ["string", "null"] as const;
}

function scalarFieldSchemaProperty(field: { aiDescription: string; type: Exclude<CvFieldType, "array"> }) {
  return {
    additionalProperties: false,
    properties: {
      confidence: { enum: ["high", "low"], type: "string" },
      value: { description: field.aiDescription, type: scalarValueType(field.type) },
    },
    required: ["value", "confidence"],
    type: "object",
  } as const;
}

// A repeating block (work history, education history, certifications, skills, languages). Unlike a
// scalar it carries no per-field confidence — an entry either came off the CV or it did not, and a
// half-trusted employer row is not useful. The array itself is required and may be empty, never
// null: "this CV lists no certifications" and "the model forgot to answer" must be distinguishable.
function arrayFieldSchemaProperty(field: CvFieldDefinition) {
  const itemFields = field.itemFields ?? [];
  const properties: Record<string, { description: string; type: readonly string[] }> = {};
  for (const item of itemFields) {
    properties[item.key] = { description: item.aiDescription, type: scalarValueType(item.type) };
  }
  return {
    description: field.aiDescription,
    items: {
      additionalProperties: false,
      properties,
      required: itemFields.map((item) => item.key),
      type: "object" as const,
    },
    type: "array" as const,
  };
}

function fieldSchemaProperty(field: CvFieldDefinition) {
  if (field.type === "array") return arrayFieldSchemaProperty(field);
  return scalarFieldSchemaProperty({ aiDescription: field.aiDescription, type: field.type });
}

// The is_cv gate rides on the SAME structured-output call as the field extraction, so inbound
// intake no longer needs a separate classification round-trip (halved latency per CV). Its type
// is a plain boolean (not the {value,confidence} field shape) — it's a screening decision, not an
// extracted candidate field, and must never appear in the applied-fields audit.
type ExtractionSchemaProperty = ReturnType<typeof fieldSchemaProperty> | { type: "boolean" };

// OpenAI requires the structured-output schema name to match ^[a-zA-Z0-9_-]+$. positionKey is
// currently always a safe slug, but it is plain `text` in the database with no CHECK constraint,
// so a stray value would otherwise fail the API call rather than the write that produced it.
function slugForSchemaName(value: string): string {
  const slug = value.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  return slug.length > 0 ? slug : "cv";
}

// `onlyKeys` narrows the request to the fields whose answer can still change the stored record —
// see aiFieldsWorthAsking. Omit it and the whole schema is asked for, which is the right thing
// whenever there is no rule read to have won anything (every vision route, and every caller that
// is not the escalation path). is_cv is never narrowed away: it is the screening gate, not a field.
export function buildExtractionTextFormat(schema: CvPositionSchema, onlyKeys?: readonly string[]) {
  const asked = onlyKeys ? schema.fields.filter((field) => onlyKeys.includes(field.key)) : schema.fields;
  const properties: Record<string, ExtractionSchemaProperty> = { is_cv: { type: "boolean" as const } };
  for (const field of asked) {
    properties[field.key] = fieldSchemaProperty(field);
  }
  return {
    format: {
      name: `phoenix_${slugForSchemaName(schema.positionKey)}_cv_extraction`,
      schema: {
        additionalProperties: false,
        properties,
        // strict structured output requires every declared property to be required, so this list
        // tracks `asked` rather than the full schema.
        required: ["is_cv", ...asked.map((field) => field.key)],
        type: "object" as const,
      },
      strict: true as const,
      type: "json_schema" as const,
    },
  };
}

// Prepended to the per-position extraction instructions so the single call also screens out
// non-CVs (invoices, vendor offers, brochures, contracts) that arrive at a recruitment inbox.
const CV_EXTRACTION_CLASSIFICATION_PREAMBLE =
  "First decide whether this document is a CV/resume from a person applying for a job (any " +
  "language/layout). Set is_cv=false for anything else — invoices, vendor/supplier offers or " +
  "registration letters, brochures, contracts, or other business correspondence — and in that " +
  "case the extracted fields may be left null. If it IS a CV, set is_cv=true and extract the " +
  "fields as described below.\n\n";

// ---------------------------------------------------------------------------
// Raw text extraction (local — PDF via pdf-parse, modern .docx via mammoth, legacy .doc via
// word-extractor; which of the two Word readers runs is decided by the bytes, not the label).
// ---------------------------------------------------------------------------

export async function extractRawTextFromFile(bytes: Buffer, mimeType: string, fileName: string): Promise<string> {
  const kind = detectCvFileKind(mimeType, fileName);

  if (kind === "pdf") {
    const parser = new PDFParse({ data: bytes });
    try {
      // parseHyperlinks is the whole reason linkedinUrl came back 0 out of 28 on the universal
      // schema in production. pdf-parse defaults it to FALSE, and getText() was called with no
      // arguments at all — so a PDF's /Annots link dictionaries were dropped on the floor. On a
      // modern CV the LinkedIn address is almost never typed out as text: it is an icon, or the
      // word "LinkedIn", carrying the URL as an annotation. The text layer holds the icon; the URL
      // lives only in the annotation. With this on, pdf-parse rewrites the anchor inline as
      // [LinkedIn](https://www.linkedin.com/in/...) and the model can finally see it — same for a
      // mailto: behind a mail icon, and for a portfolio or GitHub link.
      const result = await parser.getText({ parseHyperlinks: true });
      return result.text ?? "";
    } finally {
      await parser.destroy();
    }
  }
  if (kind === "docx") {
    // "docx" here means "a Word file", not "the modern format" — detectCvFileKind decides from a
    // MIME type and a file name, and this corpus proves that label wrong in both directions (see
    // isLegacyDocBytes). Trust the bytes: mammoth reads only the OOXML ZIP, so a Word 97-2003
    // binary handed to it dies with "Could not find the body element: are you sure this is a docx
    // file?" — which is what left four candidates permanently unreadable until 2026-08-27.
    if (isLegacyDocBytes(bytes)) {
      const document = await new WordExtractor().extract(bytes);
      return document.getBody() ?? "";
    }
    const result = await mammoth.extractRawText({ buffer: bytes });
    return result.value ?? "";
  }
  throw new CvExtractionError(
    "unsupported_file",
    "This CV file type isn't supported for text extraction — only PDF and Word (.docx) files are (scanned/photographed CVs are read via a separate vision path, not this function).",
  );
}

// ---------------------------------------------------------------------------
// Vision input (scanned/photographed CVs) — no local text extraction; the image is sent
// directly to the same OpenAI model used for text extraction. "high" detail since a CV is a
// text-dense document, not a casual photo — worth the extra tokens to avoid downsampling
// artifacts that would cost accuracy on small print.
// ---------------------------------------------------------------------------

export function buildVisionInput(bytes: Buffer, mimeType: string, coverMessage?: string | null) {
  return [
    {
      content: [
        { text: "Extract the candidate fields from this CV image.", type: "input_text" as const },
        { detail: "high" as const, image_url: `data:${mimeType};base64,${bytes.toString("base64")}`, type: "input_image" as const },
        // After the document, never before it: the CV is the subject and the covering note is
        // context about it. A photographed CV needs the covering message just as much as a text
        // one — arguably more, since a phone snapshot rarely includes a career objective.
        ...(coverMessage ? [{ text: coverMessage, type: "input_text" as const }] : []),
      ],
      role: "user" as const,
    },
  ];
}

// ---------------------------------------------------------------------------
// The same treatment for a scan that arrived wrapped in a PDF (cv-text-layer.ts explains how one
// is recognised). `input_file` hands the PDF to the model whole and lets IT render the pages —
// deliberately not pdfjs-dist + a canvas, because the native @napi-rs/canvas addon is dropped by
// Next's production file-tracing (see pdf-dommatrix-polyfill.ts, which exists to work around
// exactly that), so a rasterizing fallback would work locally and fail in production.
// "high" detail for the same reason as the image path above: small print on a scanned CV.
// ---------------------------------------------------------------------------

export function buildPdfFileInput(bytes: Buffer, fileName: string, coverMessage?: string | null) {
  return [
    {
      content: [
        { text: "Extract the candidate fields from this scanned CV.", type: "input_text" as const },
        ...(coverMessage ? [{ text: coverMessage, type: "input_text" as const }] : []),
        {
          detail: "high" as const,
          // A filename is required alongside inline file_data, and the model uses the extension to
          // pick its reader — so never pass the empty string a mime-only attachment can carry.
          filename: fileName?.trim() || "cv.pdf",
          file_data: `data:application/pdf;base64,${bytes.toString("base64")}`,
          type: "input_file" as const,
        },
      ],
      role: "user" as const,
    },
  ];
}

// ---------------------------------------------------------------------------
// AI response parsing (mirrors ai-assist.ts's parseAiJson — never trust the
// model's text blindly, even under "strict" schema mode).
// ---------------------------------------------------------------------------

export function parseAiJson(text: string): Record<string, unknown> {
  const parsed = tryParseAiJson(text);
  if (parsed) return parsed;
  throw new CvExtractionError("ai_failed", "The reply was not in the expected format. Try again.");
}

export function readStringField(parsed: Record<string, unknown>, key: string): ExtractedField<string | null> {
  const raw = parsed[key];
  const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const trimmed = typeof obj.value === "string" ? obj.value.trim() : "";
  return { confidence: obj.confidence === "high" ? "high" : "low", value: trimmed.length > 0 ? trimmed : null };
}

export function readBoolField(parsed: Record<string, unknown>, key: string): ExtractedField<boolean | null> {
  const raw = parsed[key];
  const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    confidence: obj.confidence === "high" ? "high" : "low",
    value: typeof obj.value === "boolean" ? obj.value : null,
  };
}

// Accepts a number or a numeric string — the schema asks for a number, but a model that writes
// "18" for years of experience should not cost us the value. A non-finite result reads as null
// rather than NaN, which would otherwise reach the database as a failed insert.
export function readNumberField(parsed: Record<string, unknown>, key: string): ExtractedField<number | null> {
  const raw = parsed[key];
  const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const candidate = typeof obj.value === "number" ? obj.value : typeof obj.value === "string" ? Number(obj.value.trim()) : Number.NaN;
  return {
    confidence: obj.confidence === "high" ? "high" : "low",
    value: Number.isFinite(candidate) ? candidate : null,
  };
}

// A repeating block. Carries no per-entry confidence (see arrayFieldSchemaProperty) so the wrapper
// is stamped "high" when the model answered with an array at all and "low" when it did not — the
// latter is the shape a truncated or garbled reply takes, and it must stay distinguishable from a
// CV that genuinely lists nothing. Entries are filtered to objects with at least one non-empty
// value so a row of all-nulls never reaches the review board as a phantom job.
export function readArrayField(
  parsed: Record<string, unknown>,
  key: string,
): ExtractedField<Array<Record<string, unknown>> | null> {
  const raw = parsed[key];
  if (!Array.isArray(raw)) return { confidence: "low", value: null };

  const entries: Array<Record<string, unknown>> = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const entry = item as Record<string, unknown>;
    const hasValue = Object.values(entry).some(
      (value) => value !== null && value !== undefined && String(value).trim().length > 0,
    );
    if (hasValue) entries.push(entry);
  }
  return { confidence: "high", value: entries };
}

// Dispatches one schema field to the reader matching its declared type. Keeping this beside the
// readers means a new CvFieldType is a compile error here rather than a value silently read as a
// string somewhere downstream.
export function readSchemaField(parsed: Record<string, unknown>, field: { key: string; type: CvFieldType }) {
  switch (field.type) {
    case "array":
      return readArrayField(parsed, field.key);
    case "boolean":
      return readBoolField(parsed, field.key);
    case "number":
      return readNumberField(parsed, field.key);
    // "date" is carried as a YYYY-MM-DD string; see scalarValueType.
    default:
      return readStringField(parsed, field.key);
  }
}

// Pure — reads the identity a CV states about ITSELF (the three shared fields every position
// schema declares) so a candidate can be created from the document rather than from whoever
// transmitted it. Used by bulk forward-imports, where the sending number belongs to the person
// doing the forwarding and is identical across every message.
//
// A missing/failed extraction deliberately yields null email AND null phone rather than falling
// back to the sender's details: with no match keys at all, candidate matching cannot merge this
// CV into an unrelated profile, so the worst case is a correctly-separate record that Talent
// Acquisition completes by hand — never a silent collapse of many applicants into one.
/**
 * The identity a CV's own contents give, for a candidate about to be created.
 *
 * `email` and `phone` are read straight off the extraction as before. The NAME goes through
 * resolveCandidateFullNameFromCv, because this is the one write in the module that had no
 * confidence gate: full_name is NOT NULL, is set once at intake, and a name the model itself
 * flagged as unsure went into it unchallenged — see candidate-name-from-cv.ts for the row that
 * exposed it. `fileName` is the CV's own filename, used as the fallback in preference to the
 * sender; omitting it simply skips that step.
 */
export function candidateIdentityFromCvFields(
  extraction: { fields: ExtractedCandidateFields } | null,
  fallbackFullName: string,
  fileName?: string | null,
): { fullName: string; email: string | null; phone: string | null } {
  const read = (key: string): string | null => {
    const value = extraction?.fields?.[key]?.value;
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
  };
  return {
    email: read("email"),
    fullName: resolveCandidateFullNameFromCv({
      extractedConfidence: extraction?.fields?.fullName?.confidence ?? null,
      extractedName: read("fullName"),
      fileName,
      senderFullName: fallbackFullName,
    }),
    phone: read("phone"),
  };
}

// Every branch passes error.code through as the third argument. It is not decoration: three of
// these codes produce the same user-facing "ai_failed", and shouldEscalateAfterFailure has to tell
// them apart to decide whether a second, more expensive read is worth buying. Drop it from a branch
// and that branch silently becomes escalatable again — which is the defect this whole change fixes.
function cvExtractionErrorFromOpenAi(error: PhoenixOpenAiError): CvExtractionError {
  switch (error.code) {
    case "not_configured":
      return new CvExtractionError(
        "ai_not_configured",
        "This isn't configured yet. Add the OpenAI key as OPENAI_API_KEY.",
        error.code,
      );
    case "quota_exceeded":
      return new CvExtractionError(
        "ai_rate_limited",
        "The OpenAI account is out of credit. Add billing/credit on platform.openai.com and try again.",
        error.code,
      );
    case "rate_limited":
      return new CvExtractionError(
        "ai_rate_limited",
        "The OpenAI rate limit was reached for now. Wait a minute and try again.",
        error.code,
      );
    case "auth_failed":
      return new CvExtractionError(
        "ai_failed",
        "OpenAI rejected the API key. Check OPENAI_API_KEY on the server.",
        error.code,
      );
    case "timeout":
      return new CvExtractionError(
        "ai_failed",
        "Could not reach the extraction service: request timed out.",
        error.code,
      );
    case "failed":
      return new CvExtractionError(
        "ai_failed",
        error.status
          ? `The extraction service returned ${error.status}. Try again.`
          : `Could not reach the extraction service: ${error.message}`,
        error.code,
      );
  }
}

// Pure: picks which of a candidate's files to run extraction against. With no fileId, the
// first cv-kind file (the existing single-CV-per-candidate assumption most callers rely on).
// With a fileId (used by inbound CV intake, where a matched candidate may already have an
// older CV on record and extraction must target the just-uploaded one, not the first), only
// that specific cv-kind file counts — a fileId that doesn't match anything yields null rather
// than silently falling back to the first file.
export function selectCvFile(files: readonly RecruitmentFile[], fileId?: string): RecruitmentFile | null {
  if (fileId) {
    return files.find((file) => file.id === fileId && file.kind === "cv") ?? null;
  }
  return files.find((file) => file.kind === "cv") ?? null;
}

// ---------------------------------------------------------------------------
// Public API.
// ---------------------------------------------------------------------------

// Runs the schema-driven extraction against raw CV bytes, with no candidate or uploaded-file
// row required. Split out of extractCandidateFieldsFromCv so inbound intake can read a
// forwarded CV's OWN identity (name/email/phone) before deciding which candidate it belongs
// to — see cv-intake-service.ts's "cv" identity source. The caller persists the very same
// result afterwards via persistCvExtraction, so a bulk import still costs one AI call per CV.
export async function extractCvFieldsFromBytes(input: {
  bytes: Buffer;
  mimeType: string;
  fileName: string;
  positionKey?: string;
  // What the sender WROTE when they submitted this CV — email subject and body, or WhatsApp
  // messages — already formatted by formatCoveringMessage. Optional: a CV uploaded by a recruiter
  // has no covering message and simply omits it.
  //
  // This is the only way the extraction can answer "what job is this person applying FOR", because
  // a CV states what someone has done, not what they want. See appliedForJobTitle in
  // cv-field-schemas.ts, and rules 5a/5b there for the two limits on how it may be used.
  coverMessage?: string | null;
  // Who sent it and what they titled it. Used by the RULE pass only, and worth passing wherever it
  // is known: the email subject is the vacancy name 87% of the time in this inbox, which makes it
  // the cheapest reliable source of appliedForJobTitle there is, and the sender's own address
  // corroborates an email found in the CV body. All optional — a recruiter-uploaded CV has none of
  // it and simply reads the document.
  senderName?: string | null;
  senderEmail?: string | null;
  subject?: string | null;
  // OPERATOR ESCAPE HATCH — bypasses shouldEscalateToAi, and nothing else.
  //
  // The gate below is a spend decision: when the rules have already answered everything worth
  // asking, it returns their read without calling a model. That is correct for intake and it is
  // why CV extraction is cheap. It is wrong for one narrow case — an operator deliberately
  // re-reading a backlog, who wants the model's own reading of documents the rules were merely
  // *adequate* on. Measured on production 2026-08-27: of the 59 candidates who have never had a
  // model read, 39 are refused by the gate, 35 of them for "rules answered every field worth
  // asking about". No number of re-runs will ever reach them, which is why the same candidates
  // carry two, three and four identical free rows.
  //
  // Deliberately NOT a config value, an env var, or anything intake can reach: it is passed by
  // hand, per run, from a script the owner invokes (--force-model). Default false everywhere.
  // It does NOT widen what is asked for — narrowedTextKeys still applies, so a forced call still
  // skips the fields the merge would discard. Forcing all 59 costs about $0.25 at the nano tier.
  forceModel?: boolean;
}): Promise<CvFieldExtraction> {
  const declaredSchema = getCvPositionSchema(input.positionKey ?? defaultCvPositionKey);
  if (!declaredSchema) {
    throw new CvExtractionError("ai_failed", `Unknown CV extraction position "${input.positionKey}".`);
  }
  // The declared schema IS the schema. There used to be a per-field include/exclude switch read
  // from ats_cv_field_settings on every extraction; the page that set it was removed 2026-08-15
  // with zero rows ever written, so the read could only ever return "everything on" while costing
  // a round trip to Frankfurt per CV. The owner's rule was always "capture everything" anyway.
  const schema = declaredSchema;

  const fileKind = detectCvFileKind(input.mimeType, input.fileName);
  // An unsupported kind still throws from inside extractRawTextFromFile, exactly as before — the
  // routing decision below only ever sees a kind we can actually open.
  const rawText = fileKind === "image" ? "" : await extractRawTextFromFile(input.bytes, input.mimeType, input.fileName);
  const cleanedText = rawText.trim().slice(0, MAX_CV_TEXT_CHARS);

  const route = chooseCvExtractionRoute({ byteLength: input.bytes.length, extractedText: cleanedText, fileKind });
  if (route === "text" && !cleanedText) {
    throw new CvExtractionError("unsupported_file", "No readable text was found in this CV file.");
  }

  // -------------------------------------------------------------------------
  // THE RULE PASS RUNS FIRST, ALWAYS, AND COSTS NOTHING.
  //
  // Owner instruction, 2026-08-19: make the deterministic engine the primary path and use the model
  // to enhance its result, rather than paying a model to do all of the work on every CV. On the 126
  // readable CVs in the careers inbox the rules alone answer everything worth asking on 62% of them,
  // so on roughly three CVs in five the code below returns without a network call at all.
  //
  // It runs before the API-key check on purpose. A CV that the rules can read is read whether or not
  // OpenAI is configured, in credit, or up — which is not hypothetical: the credits ran dry on
  // 2026-08-16 and every inbound CV that day failed to extract.
  // -------------------------------------------------------------------------
  const ruleContext: CvRuleContext = {
    coverMessage: input.coverMessage ?? null,
    senderEmail: input.senderEmail ?? null,
    senderName: input.senderName ?? null,
    subject: input.subject ?? null,
  };
  // Only over a real text layer. A scan routed to vision has no text for the rules to read, and
  // running them over the empty string would produce a confident-looking empty record.
  //
  // WRAPPED SO IT CANNOT FAIL THE EXTRACTION. This module's whole disposition is to fail open —
  // is_cv only suppresses on an explicit false, a dead first pass gets a second route, a dead
  // escalation keeps the first read. The rule engine is new code running over text produced by a
  // third-party PDF parser, and it is now the FIRST thing every inbound CV touches; a crash on some
  // pathological document must cost that document its free read, not its extraction. On this path a
  // throw would be strictly worse than the behaviour it replaced, which is the one outcome a
  // cost-saving change is not allowed to have.
  let rule: RuleExtractionResult | null = null;
  if (cleanedText) {
    try {
      rule = runRuleCvExtraction(cleanedText, ruleContext);
    } catch (error) {
      logError("Rule-based CV extraction threw; falling back to the AI path", {
        error,
        labels: { event: "cv_rule_extraction_failed", file_name: input.fileName },
      });
    }
  }
  const ruleOnly = (): CvFieldExtraction => ({
    fields: rule!.fields,
    isCv: rule!.isCv,
    model: RULE_ONLY_EXTRACTION_MODEL,
    positionKey: schema.positionKey,
  });

  if (!input.forceModel && rule && rule.isCv) {
    const decision = shouldEscalateToAi(rule);
    // Gated on isCv as well as on the decision. shouldEscalateToAi also answers "false" for a
    // document it judges NOT to be a CV, and that answer must never short-circuit to a result: the
    // rules' is_cv is a cheap six-signal heuristic, and dropping a real applicant on it is the exact
    // incident that put cv-text-layer.ts in this codebase. A "not a CV" therefore still costs a
    // model call, and the model gets the final say.
    if (!decision.escalate) return ruleOnly();
  }

  // We are escalating. Decide what is worth ASKING for, which is not the same as what the schema
  // declares: the rules have already won a share of the fields outright, and the merge policy will
  // discard the model's answer on every one of them. Generating those answers is billed output.
  //
  // Only for the TEXT route, and only off a rule read that judged the document a CV. A vision route
  // means the text layer was absent or too thin to trust, so whatever the rules "won" from it was
  // won from scraps — narrowing the vision retry on that basis would suppress the very fields the
  // vision read exists to recover. Same shape as cvReasoningEffortForRoute: the common, easy path
  // gets the saving, the rare hard one is left alone.
  const narrowedTextKeys =
    rule && rule.isCv ? aiFieldsWorthAsking(rule.fields, schema.fields.map((field) => field.key)) : null;

  // -------------------------------------------------------------------------
  // FREE OCR — the last resort for a scanned CV, never the first choice.
  //
  // ~5% of the inbox is a photograph of a printed CV. There is no text layer, so the rule pass above
  // had nothing to read and these documents belong to the vision model. This reads the pixels with
  // Tesseract instead, for free — but ONLY once the model has already failed or is unavailable, and
  // that ordering is a measured decision rather than caution.
  //
  // Free OCR is not accurate enough to REPLACE the model on this material. On the six real scans it
  // read four (it refuses the two Arabic ones on confidence, correctly), but among those four it
  // turned "nermeenadel177@example.org" into "77@example.org" and read a man's name as "in Egypt.".
  // A plausible-looking wrong e-mail is worse than an empty one: nobody ever questions it and the
  // candidate is simply never reachable. So OCR does not get to short-circuit a working model, and
  // it does not get to overrule one. What it does get to do is stop an applicant being lost entirely
  // when the model is down, rate-limited or out of credit — which is the same failure the rule pass
  // above now covers for text CVs, and the reason both exist.
  //
  // Every value it produces is marked LOW confidence regardless of what the rules thought, because
  // cv-auto-apply only ever writes HIGH ones. An OCR read reaches a human, never the record.
  // -------------------------------------------------------------------------
  const ruleFromOcr = async (): Promise<CvFieldExtraction | null> => {
    if (fileKind !== "pdf" && fileKind !== "image") return null;
    const ocr = await extractTextByOcr({ bytes: input.bytes, fileKind, fileName: input.fileName });
    if (!ocr) return null;
    let read: RuleExtractionResult;
    try {
      read = runRuleCvExtraction(ocr.text, ruleContext);
    } catch {
      return null;
    }
    if (!read.isCv) return null;
    const fields: ExtractedCandidateFields = {};
    for (const [key, field] of Object.entries(read.fields)) {
      fields[key] = { ...field, confidence: "low" };
    }
    return { fields, isCv: true, model: OCR_EXTRACTION_MODEL, positionKey: schema.positionKey };
  };

  if (!hasAiApiKey()) {
    // Unchanged for every caller that has no usable rule result; what is new is that a CV the rules
    // DID read is no longer thrown away just because the model is unavailable.
    if (rule && rule.isCv) return ruleOnly();
    const scanned = await ruleFromOcr();
    if (scanned) return scanned;
    throw new CvExtractionError(
      "ai_not_configured",
      "This isn't configured yet. Add the OpenAI key as OPENAI_API_KEY.",
    );
  }

  const buildInput = (
    forRoute: CvExtractionRoute,
  ): string | ReturnType<typeof buildVisionInput> | ReturnType<typeof buildPdfFileInput> => {
    if (forRoute === "vision_image") return buildVisionInput(input.bytes, input.mimeType, input.coverMessage);
    // A PDF whose text layer is too thin to be a CV: send the file itself rather than asking the
    // model to judge a page marker. Without this the call reliably answers is_cv:false and the
    // applicant is discarded — see cv-text-layer.ts.
    if (forRoute === "vision_pdf") return buildPdfFileInput(input.bytes, input.fileName, input.coverMessage);
    // The covering message goes AFTER the CV and under its own heading. Order matters: the CV is
    // what is being extracted, the covering note is context about it, and putting the note first
    // invites the model to describe the sender rather than the document.
    return input.coverMessage ? `CV text:\n\n${cleanedText}\n\n${input.coverMessage}` : `CV text:\n\n${cleanedText}`;
  };

  const runPass = async (forRoute: CvExtractionRoute, modelOverride?: string): Promise<CvFieldExtraction> => {
    const askKeys = forRoute === "text" ? narrowedTextKeys : null;
    const askedFields = askKeys ? schema.fields.filter((field) => askKeys.includes(field.key)) : schema.fields;
    let outputText: string;
    let model: string;
    try {
      const response = await createOpenAiResponseText({
        input: buildInput(forRoute),
        instructions: CV_EXTRACTION_CLASSIFICATION_PREAMBLE + schema.instructions,
        maxOutputTokens: MAX_CV_EXTRACTION_OUTPUT_TOKENS,
        // Per route, like the effort below and for the same reason — see cvModelForRoute. The
        // premium tier is 12x the nano tier per output token, and the text route is the ~95% case
        // the rules engine has already read. The override is the escalation ladder's other rung
        // (cvTextRetryModel): a route with nowhere better to GO is re-read by a stronger model.
        model: modelOverride ?? cvModelForRoute(forRoute),
        purpose: "recruitment-cv-extraction",
        // Per route, not one setting for everything — see cvReasoningEffortForRoute. "medium" was
        // set flat on 2026-08-18 after "high" (#2162) exhausted the credits; keeping "medium" only
        // for the vision routes, where the reading is genuinely hard, and dropping the common text
        // route to "low" cuts the hidden reasoning tokens again without touching the case that
        // needs them.
        reasoning: { effort: cvReasoningEffortForRoute(forRoute) },
        text: buildExtractionTextFormat(schema, askKeys ?? undefined),
        timeoutMs: OPENAI_ROUTE_BUDGET_MS,
      });
      outputText = response.outputText;
      model = response.model;
    } catch (error) {
      if (error instanceof PhoenixOpenAiError) throw cvExtractionErrorFromOpenAi(error);
      throw new CvExtractionError(
        "ai_failed",
        `Could not reach the extraction service: ${error instanceof Error ? error.message : "network error"}`,
      );
    }

    const parsed = parseAiJson(outputText);
    const fields: ExtractedCandidateFields = {};
    // The fields ASKED for, not the fields declared. Reading a key that was never in the request
    // would manufacture an empty high-confidence value and hand it to the merge as an answer.
    for (const field of askedFields) {
      fields[field.key] = readSchemaField(parsed, field);
    }
    // Fail OPEN: only an explicit is_cv:false suppresses a candidate; a missing/garbled value is
    // treated as "yes, it's a CV" so an AI quirk never drops a real applicant.
    return { fields, isCv: parsed.is_cv !== false, model, positionKey: schema.positionKey };
  };

  // The paid half, unchanged in every internal detail — the text pass, the vision escalation for a
  // PDF, and the best-of merge between those two READS OF THE SAME DOCUMENT. It is now wrapped in a
  // function so its result can be merged with the rule result, and so its total failure can fall
  // back to one instead of losing the applicant.
  const runAiExtraction = async (): Promise<CvFieldExtraction> => {
    // A PDF read from its text layer always has a second, INDEPENDENT way to be read: hand the file
    // to the model and let it render the pages. That is the only ROUTE escalation available — a .docx
    // has no image form, and a route that already IS vision has nothing better to fall back to.
    const escalation: CvExtractionRoute | null =
      route === "text" && fileKind === "pdf" && input.bytes.length <= MAX_PDF_VISION_BYTES ? "vision_pdf" : null;

    // The ladder has two rungs, and a document takes whichever one it can reach. A different ROUTE
    // is strictly better and comes first — the text layer is what failed, so re-reading it proves
    // little. A stronger MODEL on the same route is the only rung a .docx can reach at all; see
    // cvTextRetryModel for why that stopped being optional when the text route moved to nano.
    const retryModel = cvTextRetryModel(route, escalation !== null);
    const runEscalation = escalation
      ? () => runPass(escalation)
      : retryModel
        ? () => runPass(route, retryModel)
        : null;

    let primary: CvFieldExtraction;
    try {
      primary = await runPass(route);
    } catch (error) {
      // The first pass DIED. Before this, that ended the CV: cv-intake-service.ts catches and fails
      // open, so the applicant was created with a name and nothing else and nothing ever went back
      // for them — 49 of 226 production candidates are in exactly that state. A document gets one
      // more attempt down whichever rung it can reach before we accept losing it.
      //
      // But only when the failure was about the DOCUMENT. This catch used to be untyped, so a
      // timeout took the identical branch to an unreadable file and bought a 12x premium vision
      // read of a PDF that was never the problem — see shouldEscalateAfterFailure for why that is
      // dangerous in aggregate rather than per CV.
      if (!runEscalation || !shouldEscalateAfterFailure(error)) throw error;
      return await runEscalation();
    }

    if (!runEscalation) return primary;

    // A credible read stops here — the escalation costs a second call and must not fire on the
    // common path. It fires on the two shapes a FAILED text-layer read takes: a near-empty result,
    // and a confident "this isn't a CV" reached from scrambled text. The second is the incident that
    // put cv-text-layer.ts in this codebase; that guard catches a text layer thin enough to measure,
    // and this one catches the layer that is long enough to pass it but still unreadable.
    // Scored over the WHOLE record, rules included, whenever the request was narrowed.
    //
    // This gate asks "did this document get read?", and once the ask is narrowed, the model's reply
    // on its own is no longer an answer to that question: five of the nine core signals (email,
    // phone, professionalSummary, degree, university) are exactly the ones the rules win and the
    // narrowing drops. Scoring the reply alone would count every deliberately-unasked field as a
    // failure to answer and fire a second, FULL-PRICE vision call on the CVs the rules read best —
    // a cost-saving change that costs more, which is the one outcome it may not have.
    const narrowedPrimary = route === "text" ? narrowedTextKeys : null;
    const scored = narrowedPrimary && rule ? mergeRuleAndAiExtractions(rule.fields, primary.fields).fields : primary.fields;
    const score = scoreCvExtraction(scored);
    if (!isThinCvRead(score) && primary.isCv) return primary;

    let retry: CvFieldExtraction;
    try {
      retry = await runEscalation();
    } catch {
      return primary; // the escalation is a bonus attempt; its failure must never cost the first read
    }

    // Best-of, field by field — the retry reads layout better but must never delete what the text
    // layer already got right (see mergeCvExtractions). is_cv follows whichever pass actually read
    // the document: a retry that came back with a real CV overrules a text-layer "not a CV".
    const retryScore = scoreCvExtraction(retry.fields);
    return {
      fields: mergeCvExtractions(primary.fields, retry.fields),
      isCv: isThinCvRead(retryScore) ? primary.isCv : retry.isCv,
      model: retry.model,
      positionKey: schema.positionKey,
    };
  };

  let ai: CvFieldExtraction;
  try {
    ai = await runAiExtraction();
  } catch (error) {
    // Every AI route is exhausted. If the rules read this document, that result is a great deal
    // better than nothing — which is what the caller got before, and what 49 of 226 production
    // candidates permanently have. A model that is down, rate-limited or out of credit no longer
    // costs an applicant their profile.
    if (rule && rule.isCv) return ruleOnly();
    // No text layer either, so this is a scan: read the pixels rather than lose the applicant.
    const scanned = await ruleFromOcr();
    if (scanned) return scanned;
    throw error;
  }

  if (!rule) return ai;

  // Both engines read it. mergeRuleAndAiExtractions arbitrates per field: contact details and the
  // verbatim summary stay with the rules even against a confident model, judgement fields go to the
  // model when it is confident. NOT the same merge as mergeCvExtractions above — that one picks the
  // richer of two reads by the SAME engine; this one applies a fixed policy between two different
  // engines whose strengths are known in advance.
  //
  // is_cv follows the MODEL, exactly as before this change. The rules' is_cv is a six-signal
  // heuristic that an invoice with a phone number and an email address would also satisfy, so it
  // must not be allowed to overrule the deliberate "this is a vendor pitch, not a CV" gate.
  return {
    fields: mergeRuleAndAiExtractions(rule.fields, ai.fields).fields,
    isCv: ai.isCv,
    model: ruleAssistedModel(ai.model),
    positionKey: schema.positionKey,
  };
}

// ---------------------------------------------------------------------------
// Reading a stored extraction back.
//
// Inbound intake (email/WhatsApp) persists a full extraction per CV but has no human in the loop
// to review it — see cv-intake-service.ts. Until this read existed the proposal was written and
// never looked at again: every review surface re-ran a fresh AI call to obtain fields that were
// already on record, so an inbound candidate's university/faculty/governorate stayed null unless
// someone paid OpenAI a second time for the same document. The pure half (normalizing, counting,
// seeding empty slots from the saved record) lives in cv-extraction-fields.ts so the browser can
// use it too.
// ---------------------------------------------------------------------------

// The candidate's most recent extraction, whether or not anyone has reviewed it yet. Returns null
// when the candidate has never had a CV read — the ordinary case for a manually typed record.
export async function getLatestCvExtraction(candidateId: string): Promise<StoredCvExtraction | null> {
  const supabase = recruitmentDb();
  const { data, error } = await supabase
    .from("ats_candidate_cv_extractions")
    .select("id,ai_model,position_key,extracted_fields,applied_fields,created_at,is_cv")
    .eq("candidate_id", candidateId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;

  const row = data as {
    id: unknown;
    ai_model?: unknown;
    position_key?: unknown;
    extracted_fields?: unknown;
    applied_fields?: unknown;
    created_at?: unknown;
    is_cv?: unknown;
  };
  return {
    createdAt: row.created_at ? String(row.created_at) : null,
    extractionId: String(row.id),
    fields: normalizeStoredExtractionFields(row.extracted_fields),
    // Anything that is not literally a boolean stays null — a row written before the column
    // existed, or one whose value was hand-edited, must read as "unknown", not as a verdict.
    isCv: typeof row.is_cv === "boolean" ? row.is_cv : null,
    model: row.ai_model ? String(row.ai_model) : null,
    positionKey: typeof row.position_key === "string" && row.position_key ? row.position_key : defaultCvPositionKey,
    reviewed: row.applied_fields !== null && row.applied_fields !== undefined,
  };
}

// Writes an already-computed extraction to the audit table against a candidate + file.
//
// is_cv is written here and nowhere else. The model answers it on the SAME call that extracts the
// fields, so it costs nothing extra — but until 2026-08-21 this function dropped it, and the
// judgement died with the request. That is how a doctor's prescription became a candidate: a later
// ops script, reading this table, had no way to ask whether the page was a CV and fell back to
// re-asserting the extracted name, which a clinic letterhead satisfies. Everything downstream of an
// extraction sees only what this row records, so an answer that is not stored is an answer nobody
// downstream can ever have.
export async function persistCvExtraction(input: {
  candidateId: string;
  fileId: string;
  extraction: CvFieldExtraction;
  access: AccessContext;
}): Promise<string> {
  const supabase = recruitmentDb();
  const { data, error } = await supabase
    .from("ats_candidate_cv_extractions")
    .insert({
      ai_model: input.extraction.model,
      candidate_id: input.candidateId,
      created_by: input.access.hrId ?? input.access.loginId ?? null,
      // Scrubbed here as well as at the call site below, because cv-intake-service.ts reaches this
      // function directly. This is the statement that actually raises 22P05, so the guard belongs on it.
      extracted_fields: withoutNulBytes(input.extraction.fields),
      file_id: input.fileId,
      // NULL — not the boolean — when no model judged this document. A rules-only read arrives here
      // with isCv already true (the rule engine's own six-signal heuristic; ruleOnly() is reached
      // only on its `true` branch) and the OCR path hard-codes true, so storing either would
      // publish a verdict nobody gave. Measured on production 2026-08-21: of 173 rows written in
      // one re-read, 104 were rules-only and every one asserted is_cv=true having never cost a
      // call, which made the split script's `is_cv === false` guard unfirable on 60% of the table.
      // NULL is the honest answer and is safe by construction — every reader gates on an explicit
      // false, so an unjudged row blocks nobody.
      is_cv: isRuleOnlyExtractionModel(input.extraction.model) ? null : input.extraction.isCv,
      position_key: input.extraction.positionKey,
    })
    .select("id")
    .single();
  if (error) throw error;
  return String((data as { id: unknown }).id);
}

export async function extractCandidateFieldsFromCv(
  candidateId: string,
  access: AccessContext,
  positionKey: string = defaultCvPositionKey,
  // forceModel is the operator escape hatch documented on extractCvFieldsFromBytes. This function is
  // the RE-READ path — the per-candidate button and every bulk re-read — which is the only place it
  // makes sense. Inbound intake goes through cv-intake-service.ts and never passes it.
  options?: { fileId?: string; forceModel?: boolean },
): Promise<CvExtractionResult> {
  // The schema is validated up front. The API KEY IS DELIBERATELY NOT.
  //
  // It used to be, and that quietly cancelled the whole point of the rules-first engine. The owner
  // deleted the OpenAI key on 2026-08-21 to stop the spend; extractCvFieldsFromBytes is built to
  // cope with exactly that — it runs the free deterministic pass BEFORE any key check, then free
  // OCR, and only raises "ai_not_configured" when neither could read the document. Throwing here
  // meant that path was never reached: the call died before it had even looked up the candidate,
  // so a CV with a perfectly readable text layer got nothing instead of its free read. Measured
  // 2026-08-21: 5 of 5 attempted CVs failed in 0s, having downloaded nothing.
  //
  // A caller with no key still sees "ai_not_configured" for anything genuinely unreadable — the
  // error simply now comes from the engine that tried, rather than from a guard that did not.
  const schema = getCvPositionSchema(positionKey);
  if (!schema) {
    throw new CvExtractionError("ai_failed", `Unknown CV extraction position "${positionKey}".`);
  }
  const candidate = await getCandidate(candidateId);
  if (!candidate) throw new Error("Candidate not found.");

  const files = await listCandidateFiles(candidateId);
  const cvFile = selectCvFile(files, options?.fileId);
  if (!cvFile) {
    throw new CvExtractionError(
      "no_cv_file",
      options?.fileId
        ? "The specified CV file was not found for this candidate."
        : "Upload a CV file for this candidate before running extraction.",
    );
  }

  const downloaded = await getFileForDownload(cvFile.id);
  if (!downloaded || downloaded.kind !== "binary") {
    throw new CvExtractionError(
      "no_cv_file",
      "This candidate's CV is a link, not an uploaded file — extraction needs the actual file.",
    );
  }

  const rawExtraction = await extractCvFieldsFromBytes({
    bytes: downloaded.bytes,
    fileName: downloaded.fileName,
    forceModel: options?.forceModel === true,
    mimeType: downloaded.mimeType,
    positionKey: schema.positionKey,
  });
  // One scrub for the whole path. Three separate things read these values and every one of them
  // lands in a Postgres text or jsonb column: the extraction row below, the auto-apply write to
  // ats_candidates after it, and the proposal this function returns to its caller. Scrubbing here
  // rather than only at the insert means the candidate write cannot fail for the same reason.
  const extraction = { ...rawExtraction, fields: withoutNulBytes(rawExtraction.fields) };
  const extractionId = await persistCvExtraction({ access, candidateId, extraction, fileId: cvFile.id });

  // Fill the candidate's still-empty columns from this read, by the same conservative rule inbound
  // intake uses (selectAutoApplyFields: high confidence, column storage, blank column only).
  //
  // Why this is here and not only in cv-intake-service: this function is the RE-READ path — the
  // per-candidate "re-run extraction" button and every bulk re-read — and until now it persisted
  // what it found and returned, applying nothing. That was correct while a review queue existed to
  // pick the proposals up; that queue was removed on 2026-08-15, having been opened for 5 of 194
  // CVs. From then on a re-read wrote to extracted_fields and stopped there permanently, with no
  // screen anywhere that would surface it.
  //
  // Measured on production 2026-08-23, on the 189 candidates whose governorate was still blank:
  // every one of the 169 read by a rules-involving model had been extracted 65-80 HOURS after the
  // candidate was created — i.e. by a bulk re-read, never by intake — and not one field had
  // reached the row, against ~130 high-confidence universities sitting in extracted_fields. The
  // 37 read at intake by the model had their university applied 33 times out of 33. The gap was
  // never the extractor and never the confidence gate; it was that this path had no writer.
  //
  // candidateWasCreatedByThisIntake is FALSE here by construction — this candidate already
  // existed — so phone stays excluded, which is the documented behaviour for a record whose
  // identity was resolved by some other CV. Gap-fill only, so a human edit always wins.
  //
  // Best-effort: the extraction is persisted and returned either way. Enrichment must never turn a
  // successful read into a failed one, which is the same contract cv-intake-service holds.
  try {
    const autoApply = selectAutoApplyFields({
      candidate,
      candidateWasCreatedByThisIntake: false,
      extractedFields: extraction.fields,
      positionKey: extraction.positionKey,
    });
    if (Object.keys(autoApply).length > 0) {
      await updateCandidate(candidateId, autoApply);
    }
  } catch (autoApplyError) {
    logError("CV re-read could not auto-apply its high-confidence fields", {
      error: autoApplyError,
      labels: { candidateId, event: "cv_reread_auto_apply_failed" },
    });
  }

  return { extractionId, fields: extraction.fields, model: extraction.model, positionKey: extraction.positionKey };
}

// Called once Talent Acquisition saves the reviewed/corrected fields onto the candidate,
// so the audit row records the AI's proposal alongside what was actually kept.
export async function recordAppliedExtractionFields(
  extractionId: string,
  appliedFields: Record<string, unknown>,
): Promise<void> {
  const supabase = recruitmentDb();
  const { error } = await supabase
    .from("ats_candidate_cv_extractions")
    .update({ applied_fields: appliedFields })
    .eq("id", extractionId);
  if (error) throw error;
}

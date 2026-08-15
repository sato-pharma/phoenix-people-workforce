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

import type { AccessContext } from "@/lib/auth/permissions";
import {
  createOpenAiResponseText,
  hasOpenAiApiKey,
  OPENAI_COPILOT_DEFAULT_MODEL,
  OPENAI_ROUTE_BUDGET_MS,
  PhoenixOpenAiError,
} from "@/lib/ai/openai-client";
import { getCandidate } from "@/lib/recruitment/candidates";
import {
  normalizeStoredExtractionFields,
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
import { detectCvFileKind } from "@/lib/recruitment/cv-file-kind";
import { isThinCvRead, mergeCvExtractions, scoreCvExtraction } from "@/lib/recruitment/cv-extraction-quality";
import { chooseCvExtractionRoute, MAX_PDF_VISION_BYTES, type CvExtractionRoute } from "@/lib/recruitment/cv-text-layer";
import { recruitmentDb } from "@/lib/recruitment/db";
import { getFileForDownload, listCandidateFiles } from "@/lib/recruitment/files";
import type { RecruitmentFile } from "@/lib/recruitment/types";

export class CvExtractionError extends Error {
  code: "ai_failed" | "ai_not_configured" | "ai_rate_limited" | "unsupported_file" | "no_cv_file";

  constructor(code: CvExtractionError["code"], message: string) {
    super(message);
    this.name = "CvExtractionError";
    this.code = code;
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

export function buildExtractionTextFormat(schema: CvPositionSchema) {
  const properties: Record<string, ExtractionSchemaProperty> = { is_cv: { type: "boolean" as const } };
  for (const field of schema.fields) {
    properties[field.key] = fieldSchemaProperty(field);
  }
  return {
    format: {
      name: `phoenix_${slugForSchemaName(schema.positionKey)}_cv_extraction`,
      schema: {
        additionalProperties: false,
        properties,
        required: ["is_cv", ...schema.fields.map((field) => field.key)],
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
// Raw text extraction (local — PDF via pdf-parse, DOCX via mammoth).
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
  const cleaned = text.replace(/```(?:json)?/gi, "").trim();
  try {
    return JSON.parse(cleaned) as Record<string, unknown>;
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
      } catch {
        /* fall through to the error below */
      }
    }
  }
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
export function candidateIdentityFromCvFields(
  extraction: { fields: ExtractedCandidateFields } | null,
  fallbackFullName: string,
): { fullName: string; email: string | null; phone: string | null } {
  const read = (key: string): string | null => {
    const value = extraction?.fields?.[key]?.value;
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
  };
  return { email: read("email"), fullName: read("fullName") ?? fallbackFullName, phone: read("phone") };
}

function cvExtractionErrorFromOpenAi(error: PhoenixOpenAiError): CvExtractionError {
  switch (error.code) {
    case "not_configured":
      return new CvExtractionError(
        "ai_not_configured",
        "This isn't configured yet. Add the OpenAI key as OPENAI_API_KEY.",
      );
    case "quota_exceeded":
      return new CvExtractionError(
        "ai_rate_limited",
        "The OpenAI account is out of credit. Add billing/credit on platform.openai.com and try again.",
      );
    case "rate_limited":
      return new CvExtractionError("ai_rate_limited", "The OpenAI rate limit was reached for now. Wait a minute and try again.");
    case "auth_failed":
      return new CvExtractionError("ai_failed", "OpenAI rejected the API key. Check OPENAI_API_KEY on the server.");
    case "timeout":
      return new CvExtractionError("ai_failed", "Could not reach the extraction service: request timed out.");
    case "failed":
      return new CvExtractionError(
        "ai_failed",
        error.status
          ? `The extraction service returned ${error.status}. Try again.`
          : `Could not reach the extraction service: ${error.message}`,
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
  if (!hasOpenAiApiKey()) {
    throw new CvExtractionError(
      "ai_not_configured",
      "This isn't configured yet. Add the OpenAI key as OPENAI_API_KEY.",
    );
  }

  const fileKind = detectCvFileKind(input.mimeType, input.fileName);
  // An unsupported kind still throws from inside extractRawTextFromFile, exactly as before — the
  // routing decision below only ever sees a kind we can actually open.
  const rawText = fileKind === "image" ? "" : await extractRawTextFromFile(input.bytes, input.mimeType, input.fileName);
  const cleanedText = rawText.trim().slice(0, MAX_CV_TEXT_CHARS);

  const route = chooseCvExtractionRoute({ byteLength: input.bytes.length, extractedText: cleanedText, fileKind });
  if (route === "text" && !cleanedText) {
    throw new CvExtractionError("unsupported_file", "No readable text was found in this CV file.");
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

  const runPass = async (forRoute: CvExtractionRoute): Promise<CvFieldExtraction> => {
    let outputText: string;
    let model: string;
    try {
      const response = await createOpenAiResponseText({
        input: buildInput(forRoute),
        instructions: CV_EXTRACTION_CLASSIFICATION_PREAMBLE + schema.instructions,
        maxOutputTokens: MAX_CV_EXTRACTION_OUTPUT_TOKENS,
        model: OPENAI_COPILOT_DEFAULT_MODEL,
        purpose: "recruitment-cv-extraction",
        // Raised from "medium" 2026-08-15. This is the single most accuracy-sensitive call in the
        // module — it runs a few hundred times a month, once per applicant, and every field the
        // module will ever hold comes out of it. Reading a two-column CV, pairing employers to
        // date ranges and telling a current title from an applied-for one is reasoning work, and
        // it was being done at the middle setting to save tokens on the cheapest thing here.
        reasoning: { effort: "high" },
        text: buildExtractionTextFormat(schema),
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
    for (const field of schema.fields) {
      fields[field.key] = readSchemaField(parsed, field);
    }
    // Fail OPEN: only an explicit is_cv:false suppresses a candidate; a missing/garbled value is
    // treated as "yes, it's a CV" so an AI quirk never drops a real applicant.
    return { fields, isCv: parsed.is_cv !== false, model, positionKey: schema.positionKey };
  };

  // A PDF read from its text layer always has a second, INDEPENDENT way to be read: hand the file
  // to the model and let it render the pages. That is the only escalation available — a .docx has
  // no image form, and a route that already IS vision has nothing better to fall back to.
  const escalation: CvExtractionRoute | null =
    route === "text" && fileKind === "pdf" && input.bytes.length <= MAX_PDF_VISION_BYTES ? "vision_pdf" : null;

  let primary: CvFieldExtraction;
  try {
    primary = await runPass(route);
  } catch (error) {
    // The first pass DIED. Before this, that ended the CV: cv-intake-service.ts catches and fails
    // open, so the applicant was created with a name and nothing else and nothing ever went back
    // for them — 49 of 226 production candidates are in exactly that state. A PDF gets one more
    // attempt down a genuinely different path before we accept losing it.
    if (!escalation) throw error;
    return await runPass(escalation);
  }

  if (!escalation) return primary;

  // A credible read stops here — the escalation costs a second call and must not fire on the
  // common path. It fires on the two shapes a FAILED text-layer read takes: a near-empty result,
  // and a confident "this isn't a CV" reached from scrambled text. The second is the incident that
  // put cv-text-layer.ts in this codebase; that guard catches a text layer thin enough to measure,
  // and this one catches the layer that is long enough to pass it but still unreadable.
  const score = scoreCvExtraction(primary.fields);
  if (!isThinCvRead(score) && primary.isCv) return primary;

  let retry: CvFieldExtraction;
  try {
    retry = await runPass(escalation);
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
    .select("id,ai_model,position_key,extracted_fields,applied_fields,created_at")
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
  };
  return {
    createdAt: row.created_at ? String(row.created_at) : null,
    extractionId: String(row.id),
    fields: normalizeStoredExtractionFields(row.extracted_fields),
    model: row.ai_model ? String(row.ai_model) : null,
    positionKey: typeof row.position_key === "string" && row.position_key ? row.position_key : defaultCvPositionKey,
    reviewed: row.applied_fields !== null && row.applied_fields !== undefined,
  };
}

// Writes an already-computed extraction to the audit table against a candidate + file.
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
      extracted_fields: input.extraction.fields,
      file_id: input.fileId,
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
  options?: { fileId?: string },
): Promise<CvExtractionResult> {
  // Schema/key are validated up front (before the candidate and file lookups below) so the
  // error a caller sees for a misconfigured server stays the same as it has always been.
  const schema = getCvPositionSchema(positionKey);
  if (!schema) {
    throw new CvExtractionError("ai_failed", `Unknown CV extraction position "${positionKey}".`);
  }
  if (!hasOpenAiApiKey()) {
    throw new CvExtractionError(
      "ai_not_configured",
      "This isn't configured yet. Add the OpenAI key as OPENAI_API_KEY.",
    );
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

  const extraction = await extractCvFieldsFromBytes({
    bytes: downloaded.bytes,
    fileName: downloaded.fileName,
    mimeType: downloaded.mimeType,
    positionKey: schema.positionKey,
  });
  const extractionId = await persistCvExtraction({ access, candidateId, extraction, fileId: cvFile.id });

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

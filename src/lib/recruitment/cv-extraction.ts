// Recruitment / ATS — AI CV field extraction (schema-driven, per position).
//
// Reads an already-uploaded CV. Text-based PDF/DOCX get their raw text extracted locally
// first; scanned/photographed CVs (image kind) skip local extraction entirely and are read
// directly by OpenAI's vision-capable model instead (no separate OCR library/vendor — reuses
// the same OPENAI_API_KEY and model already configured for text extraction). Either way, the
// same schema-driven structured-output call proposes that position's candidate fields
// (src/lib/recruitment/cv-field-schemas.ts) with a per-field confidence rating, following the
// same structured-output pattern as src/lib/email/ai-assist.ts. This module never writes to
// ats_candidates itself — the caller reviews/corrects the proposal and saves it via
// updateCandidate(); recordAppliedExtractionFields() only updates this module's own
// audit-trail row (a correction log for future prompt tuning, not a training pipeline).

import "@/lib/recruitment/pdf-dommatrix-polyfill";

import { PDFParse } from "pdf-parse";
import * as mammoth from "mammoth";

import type { AccessContext } from "@/lib/auth/permissions";
import {
  createOpenAiResponseText,
  hasOpenAiApiKey,
  OPENAI_COPILOT_DEFAULT_MODEL,
  OPENAI_EMAIL_TIMEOUT_MS,
  OPENAI_ROUTE_BUDGET_MS,
  PhoenixOpenAiError,
} from "@/lib/ai/openai-client";
import { getCandidate } from "@/lib/recruitment/candidates";
import { defaultCvPositionKey, getCvPositionSchema, type CvFieldDefinition, type CvPositionSchema } from "@/lib/recruitment/cv-field-schemas";
import { detectCvFileKind } from "@/lib/recruitment/cv-file-kind";
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

export type ExtractedFieldConfidence = "high" | "low";
export type ExtractedField<T> = { value: T; confidence: ExtractedFieldConfidence };

// Generic (keyed by whatever the position's schema declares) rather than a fixed 12-key
// type — a value is a string field's text or a boolean field's judgment; readStringField/
// readBoolField below are the only code that needs to know which is which per key.
export type ExtractedCandidateFields = Record<string, ExtractedField<string | boolean | null>>;

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
};

// Bounds AI token cost/abuse regardless of the source file's size — a CV is a couple of
// pages; this comfortably covers even a verbose one.
const MAX_CV_TEXT_CHARS = 20_000;

// ---------------------------------------------------------------------------
// Structured-output schema, built dynamically from a CvPositionSchema (same
// "text: json_schema, strict: true" shape as src/lib/email/ai-assist.ts's
// emailDraftTextFormat — only the property list now comes from the schema registry
// instead of being hand-written per field).
// ---------------------------------------------------------------------------

function fieldSchemaProperty(field: CvFieldDefinition) {
  return {
    additionalProperties: false,
    properties: {
      confidence: { enum: ["high", "low"], type: "string" },
      value: {
        description: field.aiDescription,
        type: field.type === "boolean" ? (["boolean", "null"] as const) : (["string", "null"] as const),
      },
    },
    required: ["value", "confidence"],
    type: "object",
  } as const;
}

export function buildExtractionTextFormat(schema: CvPositionSchema) {
  const properties: Record<string, ReturnType<typeof fieldSchemaProperty>> = {};
  for (const field of schema.fields) {
    properties[field.key] = fieldSchemaProperty(field);
  }
  return {
    format: {
      name: `phoenix_${schema.positionKey}_cv_extraction`,
      schema: {
        additionalProperties: false,
        properties,
        required: schema.fields.map((field) => field.key),
        type: "object" as const,
      },
      strict: true as const,
      type: "json_schema" as const,
    },
  };
}

// ---------------------------------------------------------------------------
// Raw text extraction (local — PDF via pdf-parse, DOCX via mammoth).
// ---------------------------------------------------------------------------

export async function extractRawTextFromFile(bytes: Buffer, mimeType: string, fileName: string): Promise<string> {
  const kind = detectCvFileKind(mimeType, fileName);

  if (kind === "pdf") {
    const parser = new PDFParse({ data: bytes });
    try {
      const result = await parser.getText();
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

export function buildVisionInput(bytes: Buffer, mimeType: string) {
  return [
    {
      content: [
        { text: "Extract the candidate fields from this CV image.", type: "input_text" as const },
        { detail: "high" as const, image_url: `data:${mimeType};base64,${bytes.toString("base64")}`, type: "input_image" as const },
      ],
      role: "user" as const,
    },
  ];
}

// ---------------------------------------------------------------------------
// Lightweight "is this actually a CV" classification — runs BEFORE a candidate record
// exists (inbound email/WhatsApp intake sees plenty of non-CV business correspondence with
// a PDF/DOCX/image attached: vendor pitches, supplier registration letters, invoices).
// Deliberately a separate, cheap/fast yes-no call rather than reusing the full structured
// extraction above, which needs a real candidate + uploaded file to attach its audit row to.
// ---------------------------------------------------------------------------

const CV_CLASSIFICATION_INSTRUCTIONS =
  "You are screening an email/WhatsApp attachment arriving at a recruitment inbox. Decide whether " +
  "the document is a CV/resume from a person applying for a job (any language, any format/layout). " +
  'Answer "no" for anything else — invoices, vendor/supplier offers or registration letters, ' +
  "brochures, contracts, or other business correspondence that is not a personal CV/resume.";

const CV_CLASSIFICATION_TEXT_FORMAT = {
  format: {
    name: "phoenix_cv_classification",
    schema: {
      additionalProperties: false,
      properties: { is_cv: { type: "boolean" as const } },
      required: ["is_cv"],
      type: "object" as const,
    },
    strict: true as const,
    type: "json_schema" as const,
  },
};

// Fails open (returns true) whenever it can't reach a confident answer — an AI hiccup, a
// missing key, or an unreadable/empty attachment must never block a real candidate. Only a
// clear "no" from the model suppresses candidate creation.
export async function looksLikeCv(bytes: Buffer, mimeType: string, fileName: string): Promise<boolean> {
  if (!hasOpenAiApiKey()) return true;

  const kind = detectCvFileKind(mimeType, fileName);
  let input: string | ReturnType<typeof buildVisionInput>;
  if (kind === "image") {
    input = buildVisionInput(bytes, mimeType);
  } else if (kind === "pdf" || kind === "docx") {
    const rawText = await extractRawTextFromFile(bytes, mimeType, fileName);
    const cleanedText = rawText.trim().slice(0, MAX_CV_TEXT_CHARS);
    if (!cleanedText) return true;
    input = `Attachment text:\n\n${cleanedText}`;
  } else {
    return true;
  }

  const response = await createOpenAiResponseText({
    input,
    instructions: CV_CLASSIFICATION_INSTRUCTIONS,
    maxOutputTokens: 200,
    purpose: "recruitment-cv-classification",
    reasoning: { effort: "low" },
    text: CV_CLASSIFICATION_TEXT_FORMAT,
    timeoutMs: OPENAI_EMAIL_TIMEOUT_MS,
  });

  const parsed = parseAiJson(response.outputText);
  return parsed.is_cv !== false;
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
}): Promise<CvFieldExtraction> {
  const schema = getCvPositionSchema(input.positionKey ?? defaultCvPositionKey);
  if (!schema) {
    throw new CvExtractionError("ai_failed", `Unknown CV extraction position "${input.positionKey}".`);
  }
  if (!hasOpenAiApiKey()) {
    throw new CvExtractionError(
      "ai_not_configured",
      "This isn't configured yet. Add the OpenAI key as OPENAI_API_KEY.",
    );
  }

  const fileKind = detectCvFileKind(input.mimeType, input.fileName);
  let aiInput: string | ReturnType<typeof buildVisionInput>;
  if (fileKind === "image") {
    aiInput = buildVisionInput(input.bytes, input.mimeType);
  } else {
    const rawText = await extractRawTextFromFile(input.bytes, input.mimeType, input.fileName);
    const cleanedText = rawText.trim().slice(0, MAX_CV_TEXT_CHARS);
    if (!cleanedText) {
      throw new CvExtractionError(
        "unsupported_file",
        "No readable text was found in this CV file.",
      );
    }
    aiInput = `CV text:\n\n${cleanedText}`;
  }

  let outputText: string;
  let model: string;
  try {
    const response = await createOpenAiResponseText({
      input: aiInput,
      instructions: schema.instructions,
      maxOutputTokens: 2_000,
      model: OPENAI_COPILOT_DEFAULT_MODEL,
      purpose: "recruitment-cv-extraction",
      reasoning: { effort: "medium" },
      text: buildExtractionTextFormat(schema),
      timeoutMs: OPENAI_ROUTE_BUDGET_MS,
    });
    outputText = response.outputText;
    model = response.model;
  } catch (error) {
    if (error instanceof PhoenixOpenAiError) {
      throw cvExtractionErrorFromOpenAi(error);
    }
    throw new CvExtractionError(
      "ai_failed",
      `Could not reach the extraction service: ${error instanceof Error ? error.message : "network error"}`,
    );
  }

  const parsed = parseAiJson(outputText);
  const fields: ExtractedCandidateFields = {};
  for (const field of schema.fields) {
    fields[field.key] = field.type === "boolean" ? readBoolField(parsed, field.key) : readStringField(parsed, field.key);
  }
  return { fields, model, positionKey: schema.positionKey };
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

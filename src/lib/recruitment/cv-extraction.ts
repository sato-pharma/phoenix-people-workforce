// Recruitment / ATS — AI CV field extraction (schema-driven, per position).
//
// Reads an already-uploaded CV (PDF/DOCX, text-based only — no OCR in this phase),
// extracts its raw text locally, then asks OpenAI to propose that position's candidate
// fields (src/lib/recruitment/cv-field-schemas.ts) with a per-field confidence rating,
// following the same structured-output pattern as src/lib/email/ai-assist.ts. This module
// never writes to recruitment_candidates itself — the caller reviews/corrects the proposal
// and saves it via updateCandidate(); recordAppliedExtractionFields() only updates this
// module's own audit-trail row (a correction log for future prompt tuning, not a training
// pipeline). Medical Rep is the only position with a real field set today; a second
// position is a new entry in cv-field-schemas.ts, not a change here.

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
    "This CV file type isn't supported for AI extraction yet — only PDF and Word (.docx) files are, since scanned/image CVs aren't handled in this phase.",
  );
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
  throw new CvExtractionError("ai_failed", "The AI reply was not in the expected format. Try again.");
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

function cvExtractionErrorFromOpenAi(error: PhoenixOpenAiError): CvExtractionError {
  switch (error.code) {
    case "not_configured":
      return new CvExtractionError(
        "ai_not_configured",
        "The AI assistant is not configured yet. Add the OpenAI key as OPENAI_API_KEY.",
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
      return new CvExtractionError("ai_failed", "Could not reach the AI service: request timed out.");
    case "failed":
      return new CvExtractionError(
        "ai_failed",
        error.status ? `The AI service returned ${error.status}. Try again.` : `Could not reach the AI service: ${error.message}`,
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

export async function extractCandidateFieldsFromCv(
  candidateId: string,
  access: AccessContext,
  positionKey: string = defaultCvPositionKey,
  options?: { fileId?: string },
): Promise<CvExtractionResult> {
  const schema = getCvPositionSchema(positionKey);
  if (!schema) {
    throw new CvExtractionError("ai_failed", `Unknown CV extraction position "${positionKey}".`);
  }
  if (!hasOpenAiApiKey()) {
    throw new CvExtractionError(
      "ai_not_configured",
      "The AI assistant is not configured yet. Add the OpenAI key as OPENAI_API_KEY.",
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
        : "Upload a CV file for this candidate before running AI extraction.",
    );
  }

  const downloaded = await getFileForDownload(cvFile.id);
  if (!downloaded || downloaded.kind !== "binary") {
    throw new CvExtractionError(
      "no_cv_file",
      "This candidate's CV is a link, not an uploaded file — AI extraction needs the actual file.",
    );
  }

  const rawText = await extractRawTextFromFile(downloaded.bytes, downloaded.mimeType, downloaded.fileName);
  const cleanedText = rawText.trim().slice(0, MAX_CV_TEXT_CHARS);
  if (!cleanedText) {
    throw new CvExtractionError(
      "unsupported_file",
      "No readable text was found in this CV file — it may be a scanned image, which isn't supported in this phase.",
    );
  }

  let outputText: string;
  let model: string;
  try {
    const response = await createOpenAiResponseText({
      input: `CV text:\n\n${cleanedText}`,
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
      `Could not reach the AI service: ${error instanceof Error ? error.message : "network error"}`,
    );
  }

  const parsed = parseAiJson(outputText);
  const fields: ExtractedCandidateFields = {};
  for (const field of schema.fields) {
    fields[field.key] = field.type === "boolean" ? readBoolField(parsed, field.key) : readStringField(parsed, field.key);
  }

  const supabase = recruitmentDb();
  const { data, error } = await supabase
    .from("recruitment_candidate_cv_extractions")
    .insert({
      ai_model: model,
      candidate_id: candidateId,
      created_by: access.hrId ?? access.loginId ?? null,
      extracted_fields: fields,
      file_id: cvFile.id,
      position_key: schema.positionKey,
    })
    .select("id")
    .single();
  if (error) throw error;

  return { extractionId: String((data as { id: unknown }).id), fields, model, positionKey: schema.positionKey };
}

// Called once Talent Acquisition saves the reviewed/corrected fields onto the candidate,
// so the audit row records the AI's proposal alongside what was actually kept.
export async function recordAppliedExtractionFields(
  extractionId: string,
  appliedFields: Record<string, unknown>,
): Promise<void> {
  const supabase = recruitmentDb();
  const { error } = await supabase
    .from("recruitment_candidate_cv_extractions")
    .update({ applied_fields: appliedFields })
    .eq("id", extractionId);
  if (error) throw error;
}

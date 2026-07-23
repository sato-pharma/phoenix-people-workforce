// Recruitment / ATS — AI CV field extraction (Medical Rep field set, phase 1).
//
// Reads an already-uploaded CV (PDF/DOCX, text-based only — no OCR in this phase),
// extracts its raw text locally, then asks OpenAI to propose the Medical Rep candidate
// fields with a per-field confidence rating, following the same structured-output
// pattern as src/lib/email/ai-assist.ts. This module never writes to
// recruitment_candidates itself — the caller reviews/corrects the proposal and saves it
// via updateCandidate(); recordAppliedExtractionFields() only updates this module's own
// audit-trail row (a correction log for future prompt tuning, not a training pipeline).

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
import { recruitmentDb } from "@/lib/recruitment/db";
import { getFileForDownload, listCandidateFiles } from "@/lib/recruitment/files";
import { cvExtractableCandidateFields } from "@/lib/recruitment/types";

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

export type ExtractedCandidateFields = {
  fullName: ExtractedField<string | null>;
  email: ExtractedField<string | null>;
  phone: ExtractedField<string | null>;
  address: ExtractedField<string | null>;
  governorate: ExtractedField<string | null>;
  hasPriorWorkExperience: ExtractedField<boolean | null>;
  hasMedicalRepExperience: ExtractedField<boolean | null>;
  medicalRepEmployer: ExtractedField<string | null>;
  medicalRepExperienceFrom: ExtractedField<string | null>;
  medicalRepExperienceTo: ExtractedField<string | null>;
  faculty: ExtractedField<string | null>;
  university: ExtractedField<string | null>;
};

export type CvExtractionResult = {
  extractionId: string;
  model: string;
  fields: ExtractedCandidateFields;
};

// Bounds AI token cost/abuse regardless of the source file's size — a CV is a couple of
// pages; this comfortably covers even a verbose one.
const MAX_CV_TEXT_CHARS = 20_000;

// ---------------------------------------------------------------------------
// Structured-output schema (same "text: json_schema, strict: true" shape as
// src/lib/email/ai-assist.ts's emailDraftTextFormat).
// ---------------------------------------------------------------------------

const stringField = (description: string) =>
  ({
    additionalProperties: false,
    properties: {
      confidence: { enum: ["high", "low"], type: "string" },
      value: { description, type: ["string", "null"] },
    },
    required: ["value", "confidence"],
    type: "object",
  }) as const;

const boolField = (description: string) =>
  ({
    additionalProperties: false,
    properties: {
      confidence: { enum: ["high", "low"], type: "string" },
      value: { description, type: ["boolean", "null"] },
    },
    required: ["value", "confidence"],
    type: "object",
  }) as const;

const cvExtractionTextFormat = {
  format: {
    name: "phoenix_medical_rep_cv_extraction",
    schema: {
      additionalProperties: false,
      properties: {
        address: stringField("Candidate's street/detailed address, distinct from governorate."),
        email: stringField("Candidate's email address."),
        faculty: stringField("Faculty/college within the candidate's university, e.g. Faculty of Pharmacy."),
        fullName: stringField("Candidate's full name."),
        governorate: stringField("The single Egyptian governorate the candidate lives in (e.g. Cairo, Giza, Alexandria) — not a full street address."),
        hasMedicalRepExperience: boolField(
          "Whether the candidate has previously worked specifically as a Medical Rep / in medical sales promotion or detailing.",
        ),
        hasPriorWorkExperience: boolField("Whether the candidate has any prior work experience at all, in any field."),
        medicalRepEmployer: stringField(
          "Company where the candidate worked as a Medical Rep, only when hasMedicalRepExperience is true.",
        ),
        medicalRepExperienceFrom: stringField(
          "Start date (YYYY-MM-DD) of the candidate's Medical Rep tenure, only when hasMedicalRepExperience is true.",
        ),
        medicalRepExperienceTo: stringField(
          "End date (YYYY-MM-DD) of the candidate's Medical Rep tenure, only when hasMedicalRepExperience is true.",
        ),
        phone: stringField("Candidate's phone number, digits as written on the CV."),
        university: stringField("Name of the university the candidate graduated from."),
      },
      required: Array.from(cvExtractableCandidateFields),
      type: "object",
    },
    strict: true,
    type: "json_schema",
  },
} as const;

const cvExtractionInstructions = [
  "You extract structured candidate fields from a Medical Rep job applicant's CV for an Egyptian pharma company's HR system.",
  "Read the raw CV text given to you and fill every field in the schema.",
  "STRICT RULES:",
  "1. Only extract information that is actually present or clearly inferable in the CV text — never invent a value.",
  '2. If a field is not present in the CV, set value to null and confidence to "low".',
  '3. confidence is "high" only when you are confident the value is correct and unambiguous; use "low" whenever the CV text is unclear, abbreviated, contradictory, or you had to infer/guess.',
  "4. hasMedicalRepExperience means specifically prior experience as a Medical Rep or in medical sales promotion/detailing — general sales experience in an unrelated field does not count as true (it still counts toward hasPriorWorkExperience).",
  "5. Only fill medicalRepEmployer/medicalRepExperienceFrom/medicalRepExperienceTo when hasMedicalRepExperience is true; otherwise set them to null.",
  "6. Dates must be formatted YYYY-MM-DD. If only a month/year is given, use day 01.",
].join("\n\n");

// ---------------------------------------------------------------------------
// Raw text extraction (local — PDF via pdf-parse, DOCX via mammoth).
// ---------------------------------------------------------------------------

// Pure (no I/O) so it can be unit-tested without a real file — the parsing itself is
// exercised via extractRawTextFromFile / the manual browser verification pass instead.
export function detectCvFileKind(mimeType: string, fileName: string): "pdf" | "docx" | "unsupported" {
  const normalizedMime = (mimeType || "").toLowerCase();
  const lowerName = (fileName || "").toLowerCase();
  if (normalizedMime.includes("pdf") || lowerName.endsWith(".pdf")) return "pdf";
  if (normalizedMime.includes("wordprocessingml") || normalizedMime.includes("msword") || lowerName.endsWith(".docx")) {
    return "docx";
  }
  return "unsupported";
}

async function extractRawTextFromFile(bytes: Buffer, mimeType: string, fileName: string): Promise<string> {
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

// ---------------------------------------------------------------------------
// Public API.
// ---------------------------------------------------------------------------

export async function extractCandidateFieldsFromCv(
  candidateId: string,
  access: AccessContext,
): Promise<CvExtractionResult> {
  if (!hasOpenAiApiKey()) {
    throw new CvExtractionError(
      "ai_not_configured",
      "The AI assistant is not configured yet. Add the OpenAI key as OPENAI_API_KEY.",
    );
  }

  const candidate = await getCandidate(candidateId);
  if (!candidate) throw new Error("Candidate not found.");

  const files = await listCandidateFiles(candidateId);
  const cvFile = files.find((file) => file.kind === "cv");
  if (!cvFile) {
    throw new CvExtractionError("no_cv_file", "Upload a CV file for this candidate before running AI extraction.");
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
      instructions: cvExtractionInstructions,
      maxOutputTokens: 2_000,
      model: OPENAI_COPILOT_DEFAULT_MODEL,
      purpose: "recruitment-cv-extraction",
      reasoning: { effort: "medium" },
      text: cvExtractionTextFormat,
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
  const fields: ExtractedCandidateFields = {
    address: readStringField(parsed, "address"),
    email: readStringField(parsed, "email"),
    faculty: readStringField(parsed, "faculty"),
    fullName: readStringField(parsed, "fullName"),
    governorate: readStringField(parsed, "governorate"),
    hasMedicalRepExperience: readBoolField(parsed, "hasMedicalRepExperience"),
    hasPriorWorkExperience: readBoolField(parsed, "hasPriorWorkExperience"),
    medicalRepEmployer: readStringField(parsed, "medicalRepEmployer"),
    medicalRepExperienceFrom: readStringField(parsed, "medicalRepExperienceFrom"),
    medicalRepExperienceTo: readStringField(parsed, "medicalRepExperienceTo"),
    phone: readStringField(parsed, "phone"),
    university: readStringField(parsed, "university"),
  };

  const supabase = recruitmentDb();
  const { data, error } = await supabase
    .from("recruitment_candidate_cv_extractions")
    .insert({
      ai_model: model,
      candidate_id: candidateId,
      created_by: access.hrId ?? access.loginId ?? null,
      extracted_fields: fields,
      file_id: cvFile.id,
    })
    .select("id")
    .single();
  if (error) throw error;

  return { extractionId: String((data as { id: unknown }).id), fields, model };
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

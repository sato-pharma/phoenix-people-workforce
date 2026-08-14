import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  buildExtractionTextFormat,
  buildPdfFileInput,
  buildVisionInput,
  parseAiJson,
  readBoolField,
  readStringField,
} from "../src/lib/recruitment/cv-extraction.ts";
import { cvPositionSchemas, getCvPositionSchema, listCvPositionSchemas } from "../src/lib/recruitment/cv-field-schemas.ts";
import { detectCvFileKind } from "../src/lib/recruitment/cv-file-kind.ts";
import {
  chooseCvExtractionRoute,
  countReadableCharacters,
  MAX_PDF_VISION_BYTES,
  MIN_PDF_TEXT_LAYER_CHARS,
} from "../src/lib/recruitment/cv-text-layer.ts";
import { permissionMatrix } from "../src/lib/auth/permissions.ts";
import { findAccessRegistryEntry } from "../src/lib/security/access-registry.ts";

function read(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

export function runRecruitmentCvExtractionTests() {
  // --- detectCvFileKind ---------------------------------------------------
  assert.equal(detectCvFileKind("application/pdf", "cv.pdf"), "pdf");
  assert.equal(detectCvFileKind("", "resume.PDF"), "pdf", "extension fallback is case-insensitive");
  assert.equal(
    detectCvFileKind("application/vnd.openxmlformats-officedocument.wordprocessingml.document", "cv.docx"),
    "docx",
  );
  assert.equal(detectCvFileKind("application/msword", ""), "docx");
  assert.equal(detectCvFileKind("image/png", "scanned-cv.png"), "image", "scanned/photographed CVs are read via OpenAI vision");
  assert.equal(detectCvFileKind("image/jpeg", "photo.jpg"), "image");
  assert.equal(detectCvFileKind("", "photo.JPEG"), "image", "extension fallback is case-insensitive for images too");
  assert.equal(detectCvFileKind("application/zip", "cv.zip"), "unsupported", "a genuinely unsupported type stays unsupported");
  assert.equal(detectCvFileKind("", ""), "unsupported");

  // --- buildVisionInput (scanned/photographed CV -> OpenAI content-parts input) --------------
  const visionInput = buildVisionInput(Buffer.from("fake-image-bytes"), "image/png");
  assert.equal(visionInput.length, 1);
  assert.equal(visionInput[0].role, "user");
  assert.equal(visionInput[0].content.length, 2);
  assert.equal(visionInput[0].content[0].type, "input_text");
  assert.equal(visionInput[0].content[1].type, "input_image");
  assert.equal(visionInput[0].content[1].detail, "high");
  assert.equal(
    visionInput[0].content[1].image_url,
    `data:image/png;base64,${Buffer.from("fake-image-bytes").toString("base64")}`,
    "the image is embedded as a base64 data URL carrying its real mime type",
  );

  // --- A scan that arrived wrapped in a PDF (cv-text-layer.ts) --------------------------------
  // The headline case is the real one. careers inbox, 2026-08-11, `Osama Mohamed-1.pdf`,
  // 493,190 bytes, subject "Osama mohammed cv District manager upper Egypt". pdf-parse recovered
  // its ENTIRE text layer as the page marker below — sixteen characters — so the merged
  // classify+extract call answered is_cv:false and a District Manager applicant was discarded with
  // no dead letter and no retry. That input must now reach the model as a file.
  assert.equal(
    chooseCvExtractionRoute({ byteLength: 493_190, extractedText: "-- 1 of 1 --", fileKind: "pdf" }),
    "vision_pdf",
    "a PDF whose whole text layer is a page marker is a SCAN — routing it as text discards a real applicant",
  );
  assert.equal(
    chooseCvExtractionRoute({ byteLength: 400_000, extractedText: "", fileKind: "pdf" }),
    "vision_pdf",
    "an empty text layer used to throw and fail open into a candidate with no fields ever read",
  );

  // A PDF that really is text keeps the cheap path — in both scripts. Most CVs arriving here are
  // Arabic, and a \w-based character count would score every one of them as zero and send the
  // whole inbox down the expensive route.
  assert.equal(
    chooseCvExtractionRoute({ byteLength: 90_000, extractedText: "Experience ".repeat(30), fileKind: "pdf" }),
    "text",
  );
  assert.equal(
    chooseCvExtractionRoute({ byteLength: 90_000, extractedText: "محمد أحمد مندوب طبي ".repeat(20), fileKind: "pdf" }),
    "text",
    "an Arabic text CV must count as readable text, not as a scan",
  );

  // Threshold boundary — "fewer than" the minimum, not "at most".
  assert.equal(
    chooseCvExtractionRoute({ byteLength: 1, extractedText: "a".repeat(MIN_PDF_TEXT_LAYER_CHARS), fileKind: "pdf" }),
    "text",
  );
  assert.equal(
    chooseCvExtractionRoute({ byteLength: 1, extractedText: "a".repeat(MIN_PDF_TEXT_LAYER_CHARS - 1), fileKind: "pdf" }),
    "vision_pdf",
  );

  // The other kinds are deliberately untouched: an image was already going to vision, a DOCX has
  // no file-render path to fall back to, and a PDF too big to base64 into a request stays on the
  // text path so it fails open rather than failing the call.
  assert.equal(
    chooseCvExtractionRoute({ byteLength: 10, extractedText: "", fileKind: "image" }),
    "vision_image",
  );
  assert.equal(
    chooseCvExtractionRoute({ byteLength: 10, extractedText: "-- 1 of 1 --", fileKind: "docx" }),
    "text",
  );
  assert.equal(
    chooseCvExtractionRoute({ byteLength: MAX_PDF_VISION_BYTES + 1, extractedText: "", fileKind: "pdf" }),
    "text",
    "a PDF past the request budget must not be base64'd into a call the model would reject",
  );

  assert.equal(countReadableCharacters("-- 1 of 1 --"), 4, "punctuation and spacing are not readable content");
  assert.equal(countReadableCharacters("\n\f  \t "), 0);
  assert.equal(countReadableCharacters("مندوب"), 5, "Arabic letters count");

  // --- buildPdfFileInput (scan-in-a-PDF -> OpenAI content-parts input) ------------------------
  const pdfBytes = Buffer.from("fake-pdf-bytes");
  const pdfInput = buildPdfFileInput(pdfBytes, "Osama Mohamed-1.pdf");
  assert.equal(pdfInput.length, 1);
  assert.equal(pdfInput[0].role, "user");
  assert.equal(pdfInput[0].content.length, 2);
  assert.equal(pdfInput[0].content[0].type, "input_text");
  assert.equal(pdfInput[0].content[1].type, "input_file");
  assert.equal(pdfInput[0].content[1].detail, "high");
  assert.equal(pdfInput[0].content[1].filename, "Osama Mohamed-1.pdf");
  assert.equal(
    pdfInput[0].content[1].file_data,
    `data:application/pdf;base64,${pdfBytes.toString("base64")}`,
    "the PDF is embedded whole as a base64 data URL — the model renders the pages itself",
  );
  assert.equal(
    buildPdfFileInput(pdfBytes, "   ")[0].content[1].filename,
    "cv.pdf",
    "a blank filename must not reach the API — inline file_data requires a real one",
  );

  // The decision above is only worth anything if extraction actually asks it. Nothing in the type
  // system connects the two: extractCvFieldsFromBytes would still compile with its original
  // `fileKind === "image"` check, and every assertion above this line would stay green while the
  // applicant was dropped exactly as before. So pin the wiring at the source.
  const extractionSource = read("src/lib/recruitment/cv-extraction.ts");
  assert.match(
    extractionSource,
    /chooseCvExtractionRoute\(\{[^}]*fileKind[^}]*\}\)/,
    "extractCvFieldsFromBytes must route through chooseCvExtractionRoute rather than deciding inline",
  );
  assert.match(
    extractionSource,
    /case "vision_pdf":\s*aiInput = buildPdfFileInput\(/,
    "the vision_pdf route must actually send the PDF as a file — a route nothing acts on is not a fix",
  );

  // --- parseAiJson ---------------------------------------------------------
  assert.deepEqual(parseAiJson('{"a":1}'), { a: 1 });
  assert.deepEqual(parseAiJson('```json\n{"a":1}\n```'), { a: 1 }, "strips markdown code fences");
  assert.deepEqual(parseAiJson('noise before {"a":1} noise after'), { a: 1 }, "extracts embedded JSON object");
  assert.throws(() => parseAiJson("not json at all"), /expected format/i);

  // --- readStringField / readBoolField (defense-in-depth against a malformed
  //     or missing AI reply — must never throw, always default to low confidence) --
  assert.deepEqual(readStringField({ email: { value: " a@b.com ", confidence: "high" } }, "email"), {
    confidence: "high",
    value: "a@b.com",
  });
  assert.deepEqual(readStringField({ email: { value: "", confidence: "high" } }, "email"), {
    confidence: "high",
    value: null,
  }, "blank string collapses to null even when the model claims high confidence");
  assert.deepEqual(readStringField({}, "missing"), { confidence: "low", value: null });
  assert.deepEqual(readStringField({ x: { value: 123, confidence: "high" } }, "x"), {
    confidence: "high",
    value: null,
  }, "non-string value is ignored, not coerced");
  assert.deepEqual(readStringField({ x: "not-an-object" }, "x"), { confidence: "low", value: null });

  assert.deepEqual(readBoolField({ flag: { value: true, confidence: "high" } }, "flag"), {
    confidence: "high",
    value: true,
  });
  assert.deepEqual(readBoolField({ flag: { value: false, confidence: "low" } }, "flag"), {
    confidence: "low",
    value: false,
  });
  assert.deepEqual(readBoolField({}, "missing"), { confidence: "low", value: null });
  assert.deepEqual(readBoolField({ flag: { value: "true", confidence: "high" } }, "flag"), {
    confidence: "high",
    value: null,
  }, "a string 'true' is not coerced to boolean — only a real boolean is trusted");

  // --- Medical Rep field set (schema registry; see cv-field-schemas.ts) -----------
  assert.deepEqual(
    cvPositionSchemas.medical_rep.fields.map((field) => field.key).sort(),
    [
      "address",
      "email",
      "faculty",
      "fullName",
      "governorate",
      "hasMedicalRepExperience",
      "hasPriorWorkExperience",
      "medicalRepEmployer",
      "medicalRepExperienceFrom",
      "medicalRepExperienceTo",
      "phone",
      "university",
    ].sort(),
  );
  assert.equal(getCvPositionSchema("medical_rep")?.label, "Medical Rep");
  assert.equal(getCvPositionSchema("unknown_position"), null);
  for (const field of cvPositionSchemas.medical_rep.fields) {
    assert.equal(field.storage, "column", `${field.key} should use dedicated columns, not the generic jsonb field`);
  }

  // --- District Manager field set — same fields as Medical Rep by design (District
  //     Managers here are typically promoted from Medical Rep), reusing the same dedicated
  //     columns rather than jsonb since those columns already exist ------------------------
  assert.equal(getCvPositionSchema("district_manager")?.label, "District Manager");
  assert.deepEqual(
    cvPositionSchemas.district_manager.fields.map((field) => field.key).sort(),
    cvPositionSchemas.medical_rep.fields.map((field) => field.key).sort(),
    "District Manager's field set must be identical to Medical Rep's",
  );
  assert.equal(
    cvPositionSchemas.district_manager.fields,
    cvPositionSchemas.medical_rep.fields,
    "District Manager reuses the exact same field array (not a duplicated copy) to guarantee zero drift",
  );
  for (const field of cvPositionSchemas.district_manager.fields) {
    assert.equal(field.storage, "column", `${field.key} should use dedicated columns, not the generic jsonb field`);
  }
  assert.notEqual(
    cvPositionSchemas.district_manager.instructions,
    cvPositionSchemas.medical_rep.instructions,
    "instructions should be reworded for District Manager hiring context, not byte-identical",
  );
  assert.match(cvPositionSchemas.district_manager.instructions, /District Manager/);

  // --- listCvPositionSchemas / getCvPositionSchema now surface both positions ------------
  assert.deepEqual(
    listCvPositionSchemas()
      .map((schema) => schema.positionKey)
      .sort(),
    ["district_manager", "medical_rep"],
  );

  // --- Dynamically-built OpenAI JSON schema (buildExtractionTextFormat) must match the
  //     previously-hardcoded medical_rep schema exactly — schema-driven refactor must not
  //     silently change what's asked of the AI model ---------------------------------------
  const textFormat = buildExtractionTextFormat(cvPositionSchemas.medical_rep);
  assert.equal(textFormat.format.name, "phoenix_medical_rep_cv_extraction");
  assert.equal(textFormat.format.strict, true);
  assert.equal(textFormat.format.type, "json_schema");
  const jsonSchema = textFormat.format.schema as unknown as {
    additionalProperties: boolean;
    properties: Record<string, { properties: { confidence: { enum: string[] }; value: { description: string; type: string[] } }; required: string[] }>;
    required: string[];
    type: string;
  };
  assert.equal(jsonSchema.type, "object");
  assert.equal(jsonSchema.additionalProperties, false);
  assert.deepEqual(
    [...jsonSchema.required].sort(),
    ["is_cv", ...cvPositionSchemas.medical_rep.fields.map((field) => field.key)].sort(),
    "every field plus the merged is_cv gate must be required in the AI response — no optional fields",
  );
  // is_cv rides on the same call (S3: classify + extract in one round-trip) as a plain boolean,
  // NOT the {value,confidence} field shape — it's a screening flag, never an extracted field.
  assert.deepEqual(
    (jsonSchema.properties as unknown as Record<string, { type: string }>).is_cv,
    { type: "boolean" },
    "is_cv must be a plain boolean, not a {value,confidence} field",
  );
  for (const field of cvPositionSchemas.medical_rep.fields) {
    const property = jsonSchema.properties[field.key];
    assert.ok(property, `missing JSON schema property for ${field.key}`);
    assert.deepEqual(property.required, ["value", "confidence"]);
    assert.deepEqual(property.properties.confidence.enum, ["high", "low"]);
    assert.equal(property.properties.value.description, field.aiDescription);
    assert.deepEqual(
      property.properties.value.type,
      field.type === "boolean" ? ["boolean", "null"] : ["string", "null"],
      `${field.key} (${field.type}) has the wrong AI response value type`,
    );
  }

  // --- Migration (Phase 1 re-platform onto ats_ tables folded the original
  //     recruitment_candidate_cv_extraction + recruitment_position_schema_framework
  //     migrations in, since neither had reached production yet) --------------------
  const migration = read("supabase/migrations/20260724130000_ats_replatform_phase1.sql");
  for (const column of [
    "address",
    "faculty",
    "university",
    "has_prior_work_experience",
    "has_medical_rep_experience",
    "medical_rep_employer",
    "medical_rep_experience_from",
    "medical_rep_experience_to",
  ]) {
    assert.match(migration, new RegExp(`add column if not exists ${column}\\b`), `missing column ${column}`);
  }
  assert.match(migration, /create table public\.ats_candidate_cv_extractions/);
  assert.match(migration, /alter table public\.ats_candidate_cv_extractions enable row level security/);
  assert.match(migration, /phx_ats_candidate_cv_extractions_service_role/);
  assert.match(migration, /grant all on table public\.ats_candidate_cv_extractions to service_role/);
  assert.match(migration, /notify pgrst, 'reload schema'/);
  // Duration is derived, never stored (see plan rationale — avoids drift vs from/to dates).
  assert.doesNotMatch(migration, /medical_rep_experience_duration/);
  assert.match(migration, /add column if not exists position_specific_fields jsonb/);
  assert.match(
    migration,
    /alter table public\.ats_candidate_cv_extractions\s+add column if not exists position_key text not null default 'medical_rep'/,
  );

  // --- Permission model: `hiring_interviews` is narrow and NOT hard-boundary-capped,
  //     while `recruitment`/`candidates` stay locked to HR authority roles ---------
  const hiringManagerRoles = [
    "District Manager",
    "Regional Manager",
    "National Sales Manager",
    "Manager",
    "Product Manager",
    "Group Product Manager",
    "Marketing Manager",
  ] as const;
  for (const role of hiringManagerRoles) {
    assert.deepEqual(
      permissionMatrix[role].hiring_interviews,
      ["read", "update"],
      `${role} must have scoped hiring_interviews access`,
    );
    assert.equal(permissionMatrix[role].recruitment, undefined, `${role} must still have no general recruitment access`);
    assert.equal(permissionMatrix[role].candidates, undefined, `${role} must still have no candidate PII access`);
  }
  // Talent Acquisition's broad access is untouched by this feature.
  assert.ok(permissionMatrix["Talent Acquisition"].candidates?.includes("update"));
  assert.ok(permissionMatrix["Talent Acquisition"].recruitment?.includes("create"));

  // --- Access registry: the new hiring-manager surface is registered, session-guarded,
  //     and gated on `hiring_interviews` — never the broad `recruitment`/`candidates` ---
  const filesEntry = findAccessRegistryEntry("/api/recruitment/hiring-manager/candidates/c1/files", "GET");
  assert.deepEqual(filesEntry?.permission, { action: "read", resource: "hiring_interviews" });
  assert.ok(filesEntry?.audit.required, "candidate file access must be audit-classified");

  const applicationsEntry = findAccessRegistryEntry("/api/recruitment/hiring-manager/applications", "GET");
  assert.deepEqual(applicationsEntry?.permission, { action: "read", resource: "hiring_interviews" });

  const interviewsEntry = findAccessRegistryEntry("/api/recruitment/hiring-manager/applications/a1/interviews", "POST");
  assert.deepEqual(interviewsEntry?.permission, { action: "read", resource: "hiring_interviews" });
  assert.ok(interviewsEntry?.csrf.required, "interview scheduling must require CSRF");

  const outcomeEntry = findAccessRegistryEntry("/api/recruitment/hiring-manager/interviews/i1", "PATCH");
  assert.deepEqual(outcomeEntry?.permission, { action: "update", resource: "hiring_interviews" });

  const workflowEntry = findAccessRegistryEntry("/api/recruitment/hiring-manager/applications/a1/workflow", "POST");
  assert.deepEqual(workflowEntry?.permission, { action: "read", resource: "hiring_interviews" });
}

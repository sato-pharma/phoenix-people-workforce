import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  detectCvFileKind,
  parseAiJson,
  readBoolField,
  readStringField,
} from "../src/lib/recruitment/cv-extraction.ts";
import { cvExtractableCandidateFields } from "../src/lib/recruitment/types.ts";
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
  assert.equal(detectCvFileKind("image/png", "scanned-cv.png"), "unsupported", "scanned images are not supported this phase");
  assert.equal(detectCvFileKind("", ""), "unsupported");

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

  // --- Medical Rep field set (phase 1 hard-codes this list; see cv-extraction.ts) --
  assert.deepEqual(
    [...cvExtractableCandidateFields].sort(),
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

  // --- Migration ------------------------------------------------------------
  const migration = read("supabase/migrations/20260723160000_recruitment_candidate_cv_extraction.sql");
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
  assert.match(migration, /create table if not exists public\.recruitment_candidate_cv_extractions/);
  assert.match(migration, /alter table public\.recruitment_candidate_cv_extractions enable row level security/);
  assert.match(migration, /phx_recruitment_candidate_cv_extractions_service_role/);
  assert.match(migration, /grant all on table public\.recruitment_candidate_cv_extractions to service_role/);
  assert.match(migration, /notify pgrst, 'reload schema'/);
  // Duration is derived, never stored (see plan rationale — avoids drift vs from/to dates).
  assert.doesNotMatch(migration, /medical_rep_experience_duration/);

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

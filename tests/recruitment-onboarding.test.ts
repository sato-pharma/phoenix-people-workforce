import assert from "node:assert/strict";

import {
  documentsComplete,
  onboardingDocumentItems,
  onboardingItemStatuses,
  onboardingJoiningItems,
} from "../src/lib/recruitment/onboarding.ts";

export function runRecruitmentOnboardingTests() {
  // documentsComplete: every document approved/waived, and non-empty.
  assert.equal(documentsComplete([]), false, "empty checklist is not complete");
  assert.equal(documentsComplete(["approved", "approved", "waived"]), true);
  assert.equal(documentsComplete(["approved", "pending"]), false);
  assert.equal(documentsComplete(["rejected"]), false);
  assert.equal(documentsComplete(["submitted", "approved"]), false);

  // Standard checklists cover the spec's documents + joining tasks.
  for (const key of ["national_id", "military_certificate", "graduation_certificate", "personal_photo", "insurance_documents"]) {
    assert.ok(onboardingDocumentItems.some((doc) => doc.key === key), `missing document ${key}`);
  }
  for (const key of ["employee_id", "email_creation", "system_access", "payroll_setup", "manager_notification"]) {
    assert.ok(onboardingJoiningItems.some((task) => task.key === key), `missing joining task ${key}`);
  }

  // Status vocabulary.
  for (const status of ["pending", "submitted", "approved", "rejected", "waived", "completed"]) {
    assert.ok((onboardingItemStatuses as readonly string[]).includes(status), `status ${status}`);
  }
}

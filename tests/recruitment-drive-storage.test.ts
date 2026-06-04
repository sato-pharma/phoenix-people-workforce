import assert from "node:assert/strict";

import { buildDriveJwtClaim, isDriveConfigured } from "../src/lib/recruitment/drive-storage.ts";
import { getRecruitmentFileStorage, referenceOnlyFileStorage } from "../src/lib/recruitment/file-storage.ts";

export function runRecruitmentDriveStorageTests() {
  // JWT claim shape (pure).
  const claim = buildDriveJwtClaim("svc@project.iam.gserviceaccount.com", 1000);
  assert.equal(claim.iss, "svc@project.iam.gserviceaccount.com");
  assert.equal(claim.aud, "https://oauth2.googleapis.com/token");
  assert.match(claim.scope, /drive/);
  assert.equal(claim.iat, 1000);
  assert.equal(claim.exp, 4600);

  // Without the Drive env vars, the adapter is dormant and storage falls back to
  // reference-only (rejecting binary uploads). Tests run without GOOGLE_DRIVE_*.
  if (!process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_KEY || !process.env.GOOGLE_DRIVE_RECRUITMENT_FOLDER_ID) {
    assert.equal(isDriveConfigured(), false);
    const storage = getRecruitmentFileStorage();
    assert.equal(storage.id, referenceOnlyFileStorage.id);
    assert.equal(storage.supportsUpload, false);
  }
}

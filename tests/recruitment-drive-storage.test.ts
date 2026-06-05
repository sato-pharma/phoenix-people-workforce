import assert from "node:assert/strict";

import { buildDriveJwtClaim, isDriveConfigured } from "../src/lib/recruitment/drive-storage.ts";
import {
  getRecruitmentFileStorage,
  isSupabaseStorageConfigured,
  referenceOnlyFileStorage,
} from "../src/lib/recruitment/file-storage.ts";

export function runRecruitmentDriveStorageTests() {
  // Drive JWT claim shape (pure) — kept for the Drive fallback adapter.
  const claim = buildDriveJwtClaim("svc@project.iam.gserviceaccount.com", 1000);
  assert.equal(claim.iss, "svc@project.iam.gserviceaccount.com");
  assert.equal(claim.aud, "https://oauth2.googleapis.com/token");
  assert.match(claim.scope, /drive/);
  assert.equal(claim.iat, 1000);
  assert.equal(claim.exp, 4600);

  // When neither Supabase nor Drive is configured, storage falls back to
  // reference-only (binary uploads rejected).
  if (
    !isSupabaseStorageConfigured() &&
    (!process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_KEY || !process.env.GOOGLE_DRIVE_RECRUITMENT_FOLDER_ID)
  ) {
    assert.equal(isDriveConfigured(), false);
    const storage = getRecruitmentFileStorage();
    assert.equal(storage.id, referenceOnlyFileStorage.id);
    assert.equal(storage.supportsUpload, false);
  }

  // Supabase Storage is the active (primary) backend whenever its env is present.
  const prevUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const prevKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  try {
    assert.equal(isSupabaseStorageConfigured(), true);
    const storage = getRecruitmentFileStorage();
    assert.equal(storage.id, "supabase-storage");
    assert.equal(storage.supportsUpload, true);
  } finally {
    if (prevUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    else process.env.NEXT_PUBLIC_SUPABASE_URL = prevUrl;
    if (prevKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = prevKey;
  }
}

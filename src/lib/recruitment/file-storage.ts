// Recruitment / ATS — candidate file storage abstraction.
//
// Backend (LOCKED) = Google Drive via a service account. The adapter is built
// dependency-free (see drive-storage.ts) and stays DORMANT until the env vars
// are present; until then getRecruitmentFileStorage() returns a reference-only
// adapter that rejects binary uploads (candidates keep a CV link instead).

export type UploadFileInput = {
  fileName: string;
  mimeType: string;
  bytes: ArrayBuffer | Buffer;
};

export type StoredFile = {
  driveFileId: string | null;
  externalUrl: string | null;
};

export type DownloadedFile = {
  bytes: Buffer;
  mimeType: string;
  fileName: string;
};

export interface RecruitmentFileStorageAdapter {
  readonly id: string;
  readonly supportsUpload: boolean;
  uploadFile(input: UploadFileInput): Promise<StoredFile>;
  downloadFile(driveFileId: string): Promise<DownloadedFile>;
}

const uploadsDisabledMessage =
  "File uploads are not configured. Add the Google Drive service-account credentials to enable uploads.";

export const referenceOnlyFileStorage: RecruitmentFileStorageAdapter = {
  id: "reference-only",
  supportsUpload: false,
  async uploadFile() {
    throw new Error(uploadsDisabledMessage);
  },
  async downloadFile() {
    throw new Error(uploadsDisabledMessage);
  },
};

// Imported for their values; the adapters only import our types (erased), so
// there is no runtime import cycle.
import { googleDriveFileStorage, isDriveConfigured } from "@/lib/recruitment/drive-storage";
import { isSupabaseStorageConfigured, supabaseFileStorage } from "@/lib/recruitment/supabase-storage";

export { isDriveConfigured, isSupabaseStorageConfigured };

export function isFileUploadEnabled(): boolean {
  return isSupabaseStorageConfigured() || isDriveConfigured();
}

// Supabase Storage is the primary backend; Google Drive is a fallback if it is
// ever configured; otherwise uploads are disabled (CV-as-link only).
export function getRecruitmentFileStorage(): RecruitmentFileStorageAdapter {
  if (isSupabaseStorageConfigured()) return supabaseFileStorage;
  if (isDriveConfigured()) return googleDriveFileStorage;
  return referenceOnlyFileStorage;
}

// Recruitment / ATS — candidate/application file storage abstraction.
//
// Storage backend (LOCKED) = Google Drive via a service account. Because that is
// net-new infrastructure (a `googleapis` dependency + a service-account key env
// var + a root folder id), the real Drive adapter is the first task of Phase 2.
//
// Phase 1 ships a reference-only adapter: a CV/document is captured as a filename
// plus an optional external URL and persisted as metadata in `recruitment_files`.
// The Phase-2 Drive adapter will implement this same interface and serve files
// only through permission-gated routes (never "anyone with the link" sharing).

import type { RecruitmentFile } from "@/lib/recruitment/types";

export type RecruitmentFileReference = {
  kind: string;
  fileName: string;
  mimeType?: string | null;
  sizeBytes?: number | null;
  externalUrl?: string | null;
};

export type StoredRecruitmentFile = {
  driveFileId: string | null;
  externalUrl: string | null;
};

export interface RecruitmentFileStorageAdapter {
  readonly id: string;
  // Persists the binary and returns the backend handle. Phase 1 stores nothing
  // and just echoes the reference.
  persist(reference: RecruitmentFileReference): Promise<StoredRecruitmentFile>;
  // Returns a short-lived download URL for a stored file, or null if the file is
  // reference-only (Phase 1).
  resolveDownloadUrl(file: Pick<RecruitmentFile, "driveFileId" | "externalUrl">): Promise<string | null>;
}

// Phase 1 adapter: no binary upload, metadata-only.
export const referenceOnlyFileStorage: RecruitmentFileStorageAdapter = {
  id: "reference-only",
  async persist(reference) {
    return { driveFileId: null, externalUrl: reference.externalUrl ?? null };
  },
  async resolveDownloadUrl(file) {
    return file.externalUrl ?? null;
  },
};

// Single accessor so the rest of the module never imports a concrete adapter.
// Phase 2 swaps this to the Drive adapter behind an env flag.
export function getRecruitmentFileStorage(): RecruitmentFileStorageAdapter {
  return referenceOnlyFileStorage;
}

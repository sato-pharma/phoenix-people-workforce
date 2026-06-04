// Recruitment / ATS — candidate files service (Drive-backed, dormant fallback).
// Gated on the `candidates` resource at the route layer (PII). Binary uploads
// require Google Drive credentials; otherwise candidates keep a CV link.

import type { AccessContext } from "@/lib/auth/permissions";
import {
  mapRecruitmentFile,
  recruitmentDb,
  textOrNull,
  type RecruitmentFileDbRow,
} from "@/lib/recruitment/db";
import { getRecruitmentFileStorage } from "@/lib/recruitment/file-storage";
import type { RecruitmentFile } from "@/lib/recruitment/types";

export async function listCandidateFiles(candidateId: string): Promise<RecruitmentFile[]> {
  const supabase = recruitmentDb();
  const { data, error } = await supabase
    .from("recruitment_files")
    .select("*")
    .eq("candidate_id", candidateId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return ((data ?? []) as RecruitmentFileDbRow[]).map(mapRecruitmentFile);
}

export type UploadCandidateFileInput = {
  candidateId: string;
  applicationId?: string | null;
  kind?: string | null;
  fileName: string;
  mimeType: string;
  bytes: ArrayBuffer | Buffer;
  sizeBytes?: number | null;
};

export async function uploadCandidateFile(
  access: AccessContext,
  input: UploadCandidateFileInput,
): Promise<RecruitmentFile> {
  const storage = getRecruitmentFileStorage();
  if (!storage.supportsUpload) {
    throw new Error("File uploads are not configured. Add the Google Drive service-account credentials to enable uploads.");
  }
  if (!input.fileName.trim()) throw new Error("A file name is required.");

  const stored = await storage.uploadFile({
    fileName: input.fileName,
    mimeType: input.mimeType,
    bytes: input.bytes,
  });

  const supabase = recruitmentDb();
  const { data, error } = await supabase
    .from("recruitment_files")
    .insert({
      candidate_id: input.candidateId,
      application_id: textOrNull(input.applicationId),
      kind: textOrNull(input.kind) ?? "cv",
      file_name: input.fileName,
      mime_type: input.mimeType,
      size_bytes: input.sizeBytes ?? null,
      drive_file_id: stored.driveFileId,
      external_url: stored.externalUrl,
      uploaded_by_hr_id: access.hrId ?? access.loginId ?? null,
    })
    .select("*")
    .single();
  if (error) throw error;
  return mapRecruitmentFile(data as RecruitmentFileDbRow);
}

export type FileDownload =
  | { kind: "binary"; bytes: Buffer; mimeType: string; fileName: string }
  | { kind: "external"; url: string };

export async function getFileForDownload(fileId: string): Promise<FileDownload | null> {
  const supabase = recruitmentDb();
  const { data, error } = await supabase
    .from("recruitment_files")
    .select("*")
    .eq("id", fileId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;

  const file = mapRecruitmentFile(data as RecruitmentFileDbRow);
  if (file.driveFileId) {
    const downloaded = await getRecruitmentFileStorage().downloadFile(file.driveFileId);
    return {
      kind: "binary",
      bytes: downloaded.bytes,
      mimeType: downloaded.mimeType,
      fileName: downloaded.fileName || file.fileName,
    };
  }
  if (file.externalUrl) return { kind: "external", url: file.externalUrl };
  return null;
}

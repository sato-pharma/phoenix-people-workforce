// Recruitment / ATS — Supabase Storage adapter (the primary backend).
//
// Stores candidate files in a private Supabase bucket via the service-role
// client (mirrors the outstation/leave file pattern). No external credentials,
// no Google org-policy issues. The stored object path is carried in StoredFile's
// driveFileId field (the generic "storage key" the download path reads back).

import crypto from "node:crypto";

import { getSupabaseAdmin } from "@/lib/supabase/server";
import type {
  DownloadedFile,
  RecruitmentFileStorageAdapter,
  StoredFile,
  UploadFileInput,
} from "@/lib/recruitment/file-storage";

export const RECRUITMENT_FILES_BUCKET = "recruitment-files";

export function isSupabaseStorageConfigured(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

function sanitizeFileName(name: string): string {
  const cleaned = String(name ?? "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || "file";
}

export const supabaseFileStorage: RecruitmentFileStorageAdapter = {
  id: "supabase-storage",
  supportsUpload: true,
  async uploadFile(input: UploadFileInput): Promise<StoredFile> {
    const bytes = Buffer.isBuffer(input.bytes) ? input.bytes : Buffer.from(input.bytes);
    const path = `cv/${crypto.randomUUID()}/${sanitizeFileName(input.fileName)}`;
    const supabase = getSupabaseAdmin();
    const { error } = await supabase.storage.from(RECRUITMENT_FILES_BUCKET).upload(path, bytes, {
      cacheControl: "31536000",
      contentType: input.mimeType || "application/octet-stream",
      upsert: false,
    });
    if (error) throw new Error(`Unable to store file: ${error.message}`);
    return { driveFileId: path, externalUrl: null };
  },
  async downloadFile(path: string): Promise<DownloadedFile> {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase.storage.from(RECRUITMENT_FILES_BUCKET).download(path);
    if (error || !data) {
      throw new Error(`Unable to download file: ${error?.message ?? "not found"}`);
    }
    const bytes = Buffer.from(await data.arrayBuffer());
    const fileName = path.split("/").pop() ?? "download";
    return { bytes, mimeType: data.type || "application/octet-stream", fileName };
  },
};

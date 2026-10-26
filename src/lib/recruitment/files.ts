// Recruitment / ATS — candidate files service (Drive-backed, dormant fallback).
// Gated on the `candidates` resource at the route layer (PII). Binary uploads
// require Google Drive credentials; otherwise candidates keep a CV link.

import { createHash } from "node:crypto";

import type { AccessContext } from "@/lib/auth/permissions";
import {
  mapRecruitmentFile,
  recruitmentDb,
  textOrNull,
  type RecruitmentFileDbRow,
} from "@/lib/recruitment/db";
import { getRecruitmentFileStorage } from "@/lib/recruitment/file-storage";
import type { RecruitmentFile, TeamCandidateFile } from "@/lib/recruitment/types";
import { hrIdForStorage } from "@/lib/hr-id";

export async function listCandidateFiles(candidateId: string): Promise<RecruitmentFile[]> {
  const supabase = recruitmentDb();
  const { data, error } = await supabase
    .from("ats_files")
    .select("*")
    .eq("candidate_id", candidateId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return ((data ?? []) as RecruitmentFileDbRow[]).map(mapRecruitmentFile);
}

/**
 * The files for many candidates at once, keyed by candidate.
 *
 * Exists because a LIST screen must not ask per card. The manager's team view renders one card per
 * CV and each card's View/Download control needs to know whether there is a file: asking per card
 * meant seven parallel requests, each of which re-authorised by walking the whole org chart, and the
 * buttons took about fifteen seconds to appear on a cold server. A control that arrives that late is
 * not a control — the owner reported it as missing, and he was right to.
 *
 * Chunked at 50: a PostgREST `.in()` carrying several hundred ids returns zero rows and no error,
 * which here would render "No CV file on record." over a candidate whose CV is sitting right there.
 */
export async function listCandidateFilesByCandidate(
  candidateIds: readonly string[],
): Promise<Map<string, RecruitmentFile[]>> {
  const byCandidate = new Map<string, RecruitmentFile[]>();
  const ids = Array.from(new Set(candidateIds.filter((id) => id.length > 0)));
  if (ids.length === 0) return byCandidate;

  const supabase = recruitmentDb();
  for (let index = 0; index < ids.length; index += 50) {
    const { data, error } = await supabase
      .from("ats_files")
      .select("*")
      .in("candidate_id", ids.slice(index, index + 50))
      .order("created_at", { ascending: false });
    if (error) throw error;
    for (const row of (data ?? []) as RecruitmentFileDbRow[]) {
      const file = mapRecruitmentFile(row);
      const key = String(row.candidate_id ?? "");
      if (!key) continue;
      const existing = byCandidate.get(key);
      if (existing) existing.push(file);
      else byCandidate.set(key, [file]);
    }
  }
  return byCandidate;
}

/**
 * The same thing, in the four fields a CARD may render — the shape that crosses to the browser.
 *
 * Every list screen that shows View CV / Download needs exactly this and nothing more, so it lives
 * here once rather than being remapped at each caller. `RecruitmentFile` must NOT cross that line:
 * it carries the storage path and the provider's own id, neither of which a card has any use for
 * and both of which would then sit in the page's serialized props.
 *
 * Every requested candidate gets a key, empty array included. The absence of a key would mean
 * "nobody asked", which the card would then treat as "go and ask yourself" — the exact per-card
 * request this function exists to remove.
 */
export async function listCandidateCardFiles(
  candidateIds: readonly string[],
): Promise<Record<string, TeamCandidateFile[]>> {
  const byCandidate = await listCandidateFilesByCandidate(candidateIds);
  const files: Record<string, TeamCandidateFile[]> = {};
  for (const candidateId of candidateIds) {
    if (!candidateId) continue;
    files[candidateId] = (byCandidate.get(candidateId) ?? []).map((file) => ({
      fileName: file.fileName,
      id: file.id,
      kind: file.kind ?? "",
      mimeType: file.mimeType ?? null,
    }));
  }
  return files;
}

/**
 * Which in-app path uploaded a file.
 *
 * A CV that arrives through inbound intake carries its channel on `ats_cv_intake_events`, and the
 * cabinet files it by that. A CV uploaded INSIDE Phoenix has no intake record at all, so before this
 * existed the cabinet could only call it "Source unknown" — measured on production 2026-09-21, all 5
 * such CVs sat under `Red flags/Source unknown`, 4 of them attached by the owner himself while
 * booking an interview. The channel was never unknown; nothing on the file said what it was.
 *
 * Deliberately NOT a third `ats_cv_intake_events.channel` value: that column is typed
 * `"email" | "whatsapp" | null` across intake analytics, the 6h digest and WhatsApp health, and a new
 * value there would move the intake counts the owner reads.
 */
export type CandidateFileUploadOrigin = "interview_calendar" | "ats_upload" | "whatsapp_inbox";

export type UploadCandidateFileInput = {
  candidateId: string;
  applicationId?: string | null;
  kind?: string | null;
  fileName: string;
  mimeType: string;
  bytes: ArrayBuffer | Buffer;
  sizeBytes?: number | null;
  /** Omitted only by inbound intake, whose channel lives on its intake record instead. */
  origin?: CandidateFileUploadOrigin | null;
};

/**
 * The file's own fingerprint — MD5 of the exact bytes, hex.
 *
 * MD5 and not SHA-256 on purpose: Supabase storage already stores the MD5 of every object as its
 * eTag, so the 986 rows uploaded before this column existed can be backfilled from what storage
 * itself recorded, and old rows then compare against new ones. Nothing here is a security decision —
 * this hash answers "are these the same document", never "is this document trusted".
 */
export function cvContentFingerprint(bytes: ArrayBuffer | Buffer): string {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  return createHash("md5").update(buffer).digest("hex");
}

/**
 * The candidate who already owns a byte-identical file, or null.
 *
 * Ordered oldest-first so the ORIGINAL record wins: a duplicate should attach to the person already
 * in the pipeline, never the other way round. Reads the oldest matching row rather than counting,
 * because the answer needed is which candidate, not how many.
 */
export async function findCandidateIdByContentFingerprint(
  contentMd5: string,
  options: { excludeCandidateId?: string | null } = {},
): Promise<string | null> {
  return (await findContentFingerprintOwner(contentMd5, options))?.candidateId ?? null;
}

/** Who owns a byte-identical file, and what that file was filed as ("cv" when it was filed as nothing). */
export type ContentFingerprintOwner = { candidateId: string; kind: string };

/**
 * The same lookup as findCandidateIdByContentFingerprint, plus the KIND of the matching file.
 *
 * Inbound intake needs the kind to decide whether it may skip the paid CV read: identical bytes
 * already filed as a CV were already accepted as one, so reading them again buys nothing. Identical
 * bytes filed as something else (an ID scan, a certificate) were never judged as a CV, and still are.
 */
export async function findContentFingerprintOwner(
  contentMd5: string,
  options: { excludeCandidateId?: string | null } = {},
): Promise<ContentFingerprintOwner | null> {
  const fingerprint = String(contentMd5 ?? "").trim();
  if (!fingerprint) return null;

  const supabase = recruitmentDb();
  let query = supabase
    .from("ats_files")
    .select("candidate_id, kind, created_at")
    .eq("content_md5", fingerprint)
    .not("candidate_id", "is", null)
    .order("created_at", { ascending: true })
    .limit(1);
  if (options.excludeCandidateId) query = query.neq("candidate_id", options.excludeCandidateId);

  const { data, error } = await query;
  if (error) throw error;
  const row = data?.[0] as { candidate_id?: unknown; kind?: unknown } | undefined;
  if (!row?.candidate_id) return null;
  // uploadCandidateFile files a blank kind as "cv", so a blank one read back means the same.
  const kind = typeof row.kind === "string" && row.kind.trim() ? row.kind.trim().toLowerCase() : "cv";
  return { candidateId: String(row.candidate_id), kind };
}

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
    .from("ats_files")
    .insert({
      candidate_id: input.candidateId,
      application_id: textOrNull(input.applicationId),
      kind: textOrNull(input.kind) ?? "cv",
      file_name: input.fileName,
      mime_type: input.mimeType,
      size_bytes: input.sizeBytes ?? null,
      content_md5: cvContentFingerprint(input.bytes),
      drive_file_id: stored.driveFileId,
      external_url: stored.externalUrl,
      upload_origin: input.origin ?? null,
      uploaded_by_hr_id: hrIdForStorage(access.hrId) ?? access.loginId ?? null,
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
    .from("ats_files")
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

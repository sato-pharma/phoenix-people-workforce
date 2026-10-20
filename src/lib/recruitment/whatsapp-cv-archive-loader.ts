// Recruitment / ATS — the WhatsApp CV Archive: the database half. What the page says is decided in
// whatsapp-cv-archive.ts; why the Archive is kept apart from the candidates is written there too.

import type { AccessContext } from "@/lib/auth/permissions";
import { recruitmentDb } from "@/lib/recruitment/db";
import { fenceApplies, isHrArchivedApplicant } from "@/lib/recruitment/workspace/fence";
import {
  buildWhatsAppCvArchiveView,
  type WhatsAppCvArchiveFileRow,
  type WhatsAppCvArchiveRow,
  type WhatsAppCvArchiveView,
} from "@/lib/recruitment/whatsapp-cv-archive";

export const WHATSAPP_CV_ARCHIVE_TABLE = "ats_whatsapp_cv_archive";
export const WHATSAPP_CV_ARCHIVE_FILES_TABLE = "ats_whatsapp_cv_archive_files";
/** A bucket of its own, so nothing that lists or cleans `recruitment-files` can reach the Archive. */
export const WHATSAPP_CV_ARCHIVE_BUCKET = "recruitment-cv-archive";

const ARCHIVE_COLUMNS =
  "id,full_name,phone,whatsapp,email,job_title,region,area,background,experience,expected_salary,extra_answers,received_at,folder_path";
const FILE_COLUMNS = "id,archive_id,file_name,mime_type,size_bytes";

/** Supabase serves at most 1000 rows a request, whatever `.limit()` asks for. */
const PAGE_SIZE = 1000;
/** 20,000 rows: far past the 390 archived. A list with people silently missing is worse than an error. */
const PAGE_LIMIT = 20;

async function readEveryPage<TRow>(
  what: string,
  readPage: (from: number, to: number) => PromiseLike<{ data: unknown; error: unknown }>,
): Promise<TRow[]> {
  const rows: TRow[] = [];
  for (let page = 0; page < PAGE_LIMIT; page += 1) {
    const from = page * PAGE_SIZE;
    const { data, error } = await readPage(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    const batch = (data ?? []) as TRow[];
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) return rows;
  }
  throw new Error(`${what} paging stopped at ${PAGE_LIMIT * PAGE_SIZE} rows. Refusing to show an Archive with people missing.`);
}

/** Who is reading the Archive. The Talent Acquisition seat never sees an HR applicant (owner, 2026-10-20). */
export type WhatsAppCvArchiveViewer = { access?: Pick<AccessContext, "role" | "scope"> | null };

function archiveFenced(viewer: WhatsAppCvArchiveViewer | undefined): boolean {
  return Boolean(viewer?.access && fenceApplies(viewer.access));
}

/** Everyone in the Archive this viewer may see, with their CV files, grouped by cabinet folder. */
export async function loadWhatsAppCvArchiveView(viewer?: WhatsAppCvArchiveViewer): Promise<WhatsAppCvArchiveView> {
  const supabase = recruitmentDb();
  const [rows, files] = await Promise.all([
    readEveryPage<WhatsAppCvArchiveRow>("WhatsApp CV Archive", (from, to) =>
      supabase.from(WHATSAPP_CV_ARCHIVE_TABLE).select(ARCHIVE_COLUMNS).order("id", { ascending: true }).range(from, to),
    ),
    readEveryPage<WhatsAppCvArchiveFileRow>("WhatsApp CV Archive file", (from, to) =>
      supabase.from(WHATSAPP_CV_ARCHIVE_FILES_TABLE).select(FILE_COLUMNS).order("id", { ascending: true }).range(from, to),
    ),
  ]);
  // The fence drops the person before the view is built, so no folder, count or file total includes them.
  return buildWhatsAppCvArchiveView(archiveFenced(viewer) ? rows.filter((row) => !isHrArchivedApplicant(row)) : rows, files);
}

/** One archived CV's bytes, or null when no Archive file has this id — or this viewer may not see its owner. */
export async function getWhatsAppCvArchiveFile(
  fileId: string,
  viewer?: WhatsAppCvArchiveViewer,
): Promise<{ bytes: Buffer; fileName: string; mimeType: string } | null> {
  const supabase = recruitmentDb();
  const { data, error } = await supabase
    .from(WHATSAPP_CV_ARCHIVE_FILES_TABLE)
    .select("archive_id,file_name,mime_type,storage_path")
    .eq("id", fileId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const row = data as { archive_id: string; file_name: string | null; mime_type: string | null; storage_path: string };
  if (archiveFenced(viewer)) {
    const { data: owner, error: ownerError } = await supabase
      .from(WHATSAPP_CV_ARCHIVE_TABLE)
      .select("job_title,folder_path")
      .eq("id", row.archive_id)
      .maybeSingle();
    if (ownerError) throw ownerError;
    // Hidden reads exactly like a file that is not there.
    if (!owner || isHrArchivedApplicant(owner as { job_title: string | null; folder_path: string[] | null })) return null;
  }
  const downloaded = await supabase.storage.from(WHATSAPP_CV_ARCHIVE_BUCKET).download(row.storage_path);
  if (downloaded.error || !downloaded.data) {
    throw new Error(`Unable to download the archived CV: ${downloaded.error?.message ?? "not found"}`);
  }
  return {
    bytes: Buffer.from(await downloaded.data.arrayBuffer()),
    fileName: row.file_name || row.storage_path.split("/").pop() || "CV",
    mimeType: row.mime_type || downloaded.data.type || "application/octet-stream",
  };
}

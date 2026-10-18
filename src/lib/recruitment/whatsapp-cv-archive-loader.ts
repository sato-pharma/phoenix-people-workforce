// Recruitment / ATS — the WhatsApp CV Archive: the database half. What the page says is decided in
// whatsapp-cv-archive.ts; why the Archive is kept apart from the candidates is written there too.

import { recruitmentDb } from "@/lib/recruitment/db";
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

/** Everyone in the Archive, with their CV files, grouped by cabinet folder. */
export async function loadWhatsAppCvArchiveView(): Promise<WhatsAppCvArchiveView> {
  const supabase = recruitmentDb();
  const [rows, files] = await Promise.all([
    readEveryPage<WhatsAppCvArchiveRow>("WhatsApp CV Archive", (from, to) =>
      supabase.from(WHATSAPP_CV_ARCHIVE_TABLE).select(ARCHIVE_COLUMNS).order("id", { ascending: true }).range(from, to),
    ),
    readEveryPage<WhatsAppCvArchiveFileRow>("WhatsApp CV Archive file", (from, to) =>
      supabase.from(WHATSAPP_CV_ARCHIVE_FILES_TABLE).select(FILE_COLUMNS).order("id", { ascending: true }).range(from, to),
    ),
  ]);
  return buildWhatsAppCvArchiveView(rows, files);
}

/** One archived CV's bytes, or null when no Archive file has this id. */
export async function getWhatsAppCvArchiveFile(
  fileId: string,
): Promise<{ bytes: Buffer; fileName: string; mimeType: string } | null> {
  const supabase = recruitmentDb();
  const { data, error } = await supabase
    .from(WHATSAPP_CV_ARCHIVE_FILES_TABLE)
    .select("file_name,mime_type,storage_path")
    .eq("id", fileId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const row = data as { file_name: string | null; mime_type: string | null; storage_path: string };
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

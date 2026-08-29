// Sales mailbox intake — the arrivals register (storage + database).
//
// One row per distributor workbook that arrived by email. The file itself is parked in the
// `sales-imports` bucket, which is exactly where the Monthly Sales wizard's preview and commit
// already read from (`resolveSalesUploadRequest` accepts a `storagePath`), so an arrival needs no
// new import transport at all — it is the same object the browser would have uploaded, put there
// by the poller instead of by a person.
//
// NOTHING HERE IMPORTS ANYTHING. Recording an arrival is the end of the machine's work.

import crypto from "node:crypto";

import { logWarning } from "@/lib/observability/log";
import { detectDistributorFromBuffer } from "@/lib/sales/distributor-detection";
import { SALES_IMPORT_BUCKET } from "@/lib/sales/monthly-import-request";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import { sanitizeArrivalFileName } from "./attachments";

/** Arrivals live under their own prefix so they are never confused with `incoming/`, which the
 *  upload screen creates and deletes within a single import. An arrival outlives its import. */
const ARRIVAL_PREFIX = "arrived";

export type ArrivalStatus = "arrived" | "claimed" | "dismissed";

export type SalesInboxArrival = {
  id: string;
  mailboxLabel: string;
  folderPath: string;
  fromAddress: string | null;
  fromName: string | null;
  subject: string | null;
  receivedAt: string | null;
  fileName: string;
  fileSizeBytes: number;
  storagePath: string;
  detectedDistributorCode: string | null;
  detectedDistributorName: string | null;
  detectionConfidence: "high" | "low" | "none";
  detectionAmbiguous: boolean;
  status: ArrivalStatus;
  claimedPeriod: string | null;
  claimedBatchId: string | null;
  claimedAt: string | null;
};

type ArrivalRow = Record<string, unknown>;

function mapArrival(row: ArrivalRow): SalesInboxArrival {
  const confidence = String(row.detection_confidence ?? "none");
  return {
    claimedAt: (row.claimed_at as string | null) ?? null,
    claimedBatchId: (row.claimed_batch_id as string | null) ?? null,
    claimedPeriod: (row.claimed_period as string | null) ?? null,
    detectedDistributorCode: (row.detected_distributor_code as string | null) ?? null,
    detectedDistributorName: (row.detected_distributor_name as string | null) ?? null,
    detectionAmbiguous: Boolean(row.detection_ambiguous),
    detectionConfidence: confidence === "high" || confidence === "low" ? confidence : "none",
    fileName: String(row.file_name ?? ""),
    fileSizeBytes: Number(row.file_size_bytes ?? 0),
    folderPath: String(row.folder_path ?? ""),
    fromAddress: (row.from_address as string | null) ?? null,
    fromName: (row.from_name as string | null) ?? null,
    id: String(row.id ?? ""),
    mailboxLabel: String(row.mailbox_label ?? ""),
    receivedAt: (row.received_at as string | null) ?? null,
    status: (String(row.status ?? "arrived") as ArrivalStatus),
    storagePath: String(row.storage_path ?? ""),
    subject: (row.subject as string | null) ?? null,
  };
}

export type RecordArrivalInput = {
  mailboxLabel: string;
  folderPath: string;
  uidValidity: bigint | number;
  uid: number;
  attachmentIndex: number;
  messageId: string | null;
  fromAddress: string | null;
  fromName: string | null;
  subject: string | null;
  receivedAt: Date | null;
  fileName: string;
  bytes: Buffer;
};

export type RecordArrivalResult =
  | { outcome: "recorded"; arrivalId: string; distributorCode: string | null }
  | { outcome: "duplicate" }
  | { outcome: "failed"; reason: string };

/**
 * Whether this exact attachment has already been recorded.
 *
 * Checked BEFORE the bytes are uploaded, not merely relied on afterwards through the unique index.
 * A re-poll after a UIDVALIDITY reset re-offers a whole backfill window, and without this check
 * every one of those attachments would be copied into the bucket again and then orphaned when the
 * insert lost the race with the index.
 */
async function alreadyRecorded(input: RecordArrivalInput): Promise<boolean> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("sales_inbox_arrivals")
    .select("id")
    .eq("mailbox_label", input.mailboxLabel)
    .eq("imap_uidvalidity", String(input.uidValidity))
    .eq("uid", input.uid)
    .eq("attachment_index", input.attachmentIndex)
    .maybeSingle();
  if (error) throw error;
  return Boolean(data);
}

/**
 * Park one workbook attachment and record it.
 *
 * Detection failure is NOT an error here. A workbook whose headers match no profile is recorded
 * with a null distributor — it is the most interesting thing this poller can find (a distributor
 * changed their export, or a new one started sending) and dropping it would turn a discovery into
 * a file nobody was ever told about.
 */
export async function recordArrival(input: RecordArrivalInput): Promise<RecordArrivalResult> {
  try {
    if (await alreadyRecorded(input)) return { outcome: "duplicate" };
  } catch (error) {
    return { outcome: "failed", reason: error instanceof Error ? error.message : "Duplicate check failed." };
  }

  // Detection reads only the header rows, and must never be able to fail the whole arrival: an
  // unreadable or password-protected workbook still deserves to be visible to a person.
  let detection: Awaited<ReturnType<typeof detectDistributorFromBuffer>> | null = null;
  try {
    const arrayBuffer = input.bytes.buffer.slice(
      input.bytes.byteOffset,
      input.bytes.byteOffset + input.bytes.byteLength,
    ) as ArrayBuffer;
    detection = await detectDistributorFromBuffer(arrayBuffer);
  } catch (error) {
    logWarning("Sales inbox arrival could not be parsed for distributor detection", {
      labels: { event: "sales_inbox_detect_failed", job: "sales-inbox-intake" },
      context: { fileName: input.fileName, mailboxLabel: input.mailboxLabel, uid: input.uid },
      error,
    });
  }

  const supabase = getSupabaseAdmin();
  const safeName = sanitizeArrivalFileName(input.fileName);
  const storagePath = `${ARRIVAL_PREFIX}/${crypto.randomUUID()}/${safeName}`;

  const upload = await supabase.storage
    .from(SALES_IMPORT_BUCKET)
    .upload(storagePath, input.bytes, { contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", upsert: false });
  if (upload.error) {
    return { outcome: "failed", reason: upload.error.message };
  }

  const { data, error } = await supabase
    .from("sales_inbox_arrivals")
    .insert({
      attachment_index: input.attachmentIndex,
      detected_distributor_code: detection?.best?.distributorCode ?? null,
      detected_distributor_name: detection?.best?.distributorName ?? null,
      detection_ambiguous: detection?.ambiguous ?? false,
      detection_confidence: detection?.confidence ?? "none",
      detection_matches: detection ? detection.matches.slice(0, 5) : null,
      file_name: input.fileName,
      file_size_bytes: input.bytes.length,
      folder_path: input.folderPath,
      from_address: input.fromAddress,
      from_name: input.fromName,
      imap_uidvalidity: String(input.uidValidity),
      mailbox_label: input.mailboxLabel,
      message_id: input.messageId,
      received_at: input.receivedAt ? input.receivedAt.toISOString() : null,
      storage_bucket: SALES_IMPORT_BUCKET,
      storage_path: storagePath,
      subject: input.subject,
      uid: input.uid,
    })
    .select("id")
    .maybeSingle();

  if (error) {
    // The unique index is the authority, so a lost race is a duplicate, not a failure — but the
    // object we just uploaded is then unreferenced and has to go, or every re-poll leaks one.
    await supabase.storage.from(SALES_IMPORT_BUCKET).remove([storagePath]).catch(() => {});
    if (String(error.code) === "23505") return { outcome: "duplicate" };
    return { outcome: "failed", reason: error.message };
  }

  return {
    arrivalId: String((data as { id?: unknown } | null)?.id ?? ""),
    distributorCode: detection?.best?.distributorCode ?? null,
    outcome: "recorded",
  };
}

/** Arrivals still waiting for a person, newest first. `distributorCode` narrows to one step. */
export async function listArrivals(
  options: { status?: ArrivalStatus; distributorCode?: string | null; limit?: number } = {},
): Promise<SalesInboxArrival[]> {
  const supabase = getSupabaseAdmin();
  let query = supabase
    .from("sales_inbox_arrivals")
    .select(
      "id,mailbox_label,folder_path,from_address,from_name,subject,received_at,file_name,file_size_bytes,storage_path,detected_distributor_code,detected_distributor_name,detection_confidence,detection_ambiguous,status,claimed_period,claimed_batch_id,claimed_at",
    )
    .eq("status", options.status ?? "arrived")
    .order("received_at", { ascending: false, nullsFirst: false })
    .limit(options.limit ?? 100);

  if (options.distributorCode) {
    query = query.eq("detected_distributor_code", options.distributorCode);
  }

  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []).map((row) => mapArrival(row as ArrivalRow));
}

/**
 * Mark an arrival as imported.
 *
 * Called after the wizard's commit succeeds. Commit deletes the storage object it read, so an
 * arrival that is not marked here would keep being offered while pointing at a file that no longer
 * exists — the one way this feature could waste more of a person's time than it saves.
 */
export async function claimArrival(
  id: string,
  input: { period: string | null; batchId: string | null; by: string },
): Promise<void> {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from("sales_inbox_arrivals")
    .update({
      claimed_at: new Date().toISOString(),
      claimed_batch_id: input.batchId,
      claimed_by: input.by,
      claimed_period: input.period,
      status: "claimed",
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("status", "arrived");
  if (error) throw error;
}

/** A person said this is not a sales file worth importing. The stored object goes with it. */
export async function dismissArrival(id: string, input: { reason: string | null; by: string }): Promise<void> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("sales_inbox_arrivals")
    .update({
      dismissed_by: input.by,
      dismissed_reason: input.reason,
      status: "dismissed",
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("status", "arrived")
    .select("storage_path")
    .maybeSingle();
  if (error) throw error;

  const path = (data as { storage_path?: string } | null)?.storage_path;
  if (path) {
    await getSupabaseAdmin().storage.from(SALES_IMPORT_BUCKET).remove([path]).catch(() => {});
  }
}

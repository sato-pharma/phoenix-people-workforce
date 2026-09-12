import { randomBytes } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import { systemDeployment } from "@/config/system-settings";
import type { SendPhoenixEmailAttachment } from "@/lib/email/send-phoenix-email";
import {
  SATO_EMAIL_MEDIA_MAX_FILES,
  SATO_EMAIL_MEDIA_MAX_TOTAL_BYTES,
  formatBytes,
  isSatoEmailInlineContentType,
  safeAttachmentFileName,
  validateSatoEmailUpload,
  type SatoEmailMediaKind,
  type SatoEmailMediaRecord,
  type SatoEmailUploadRefusal,
} from "@/lib/sato-email/media-limits";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/**
 * Files the Sato Email Composer carries — a picture in the body, or a file clipped to the mail.
 *
 * Owner 2026-09-12: "make an option to attach pic or file and to put pic in message body".
 *
 * 🔴 THE TWO ARE NOT THE SAME FEATURE, AND THE DIFFERENCE IS WHERE THE BYTES GO.
 *
 * An ATTACHMENT travels inside the message. It is read once, at send time, by the service-role
 * client, base64'd into the provider call, and never asked for again. Nothing outside this system
 * can reach it, so its row carries no address at all.
 *
 * A BODY PICTURE does not travel. The recipient's mail app fetches it over plain HTTP when the mail
 * is opened — possibly days later, from a machine with no Phoenix session — so it needs an address
 * that is still valid then. A signed URL is exactly the wrong instrument: it expires, and the
 * picture becomes a broken box inside an email the company has already sent. So a body picture gets
 * one permanent, unguessable token, and `/api/sato-email/media/:token` is the only door to it.
 *
 * 🔴 SAY THIS TO THE SENDER, DO NOT HIDE IT: anybody holding that link can see that picture, for as
 * long as the email exists. It is not a new shape of exposure on this screen — the Sato masthead and
 * band in every one of these emails are already fetched from this app unauthenticated — but it is a
 * real one, and it is why a company document belongs in the attachments, not in the body.
 *
 * The bucket itself stays private. The caller never names a storage path: the token route resolves
 * bucket and path from the row and serves nothing that is not an inline picture, which is the rule
 * `app/api/share/marketing-requests/[token]/file/route.ts` states in its own header — accepting a
 * path, even a signed one, turns a file route into a read primitive over a whole bucket.
 */
export const SATO_EMAIL_MEDIA_BUCKET = "sato-email-media";
const MEDIA_TABLE = "sato_email_media";

/**
 * A missing table answers PostgREST's `PGRST205`, not Postgres's `42P01`. Same local shape as the
 * guard in `service.ts` and in the automated-payroll modules; the deploy can land before the
 * migration and that window must read as "not here yet", never as a 500.
 */
function isMissingTable(error: unknown): boolean {
  const code = String((error as { code?: string } | null)?.code ?? "");
  const message = String((error as { message?: string } | null)?.message ?? "").toLowerCase();
  return code === "42P01" || code === "PGRST205" || (message.includes("relation") && message.includes("does not exist"));
}

export const SATO_EMAIL_MEDIA_MISSING_TABLE =
  "File attachments are not available in this environment yet — the migration has not been applied here.";

function mediaBaseUrl(): string {
  const configured = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || systemDeployment.productionUrl;
  const withScheme = /^https?:\/\//i.test(configured) ? configured : `https://${configured}`;
  return withScheme.replace(/\/+$/, "");
}

/**
 * The address a body picture is fetched from.
 *
 * https only, and never protocol-relative: `sanitizeEmailTemplateHtml` allows `img` on the `https`
 * scheme alone, so an http address would be stripped out of the saved body and the sender would
 * watch his picture disappear with nothing explaining why.
 */
export function satoEmailMediaUrl(token: string): string {
  return `${mediaBaseUrl()}/api/sato-email/media/${encodeURIComponent(token)}`;
}

/**
 * Store the bytes and index them in one call.
 *
 * The row and the object must not drift: an object with no row is unreachable (the token route
 * reads the row, never the bucket listing), and a row with no object is a filename pretending to be
 * a file — the exact lie the marketing-evidence module was written to end. If the index write
 * fails, the object just uploaded is removed before the error propagates.
 */
export async function storeSatoEmailMedia(input: {
  bytes: Buffer;
  contentType: string;
  filename: string;
  kind: SatoEmailMediaKind;
  supabase?: SupabaseClient;
  uploadedByHrId?: string | null;
  uploadedByLoginId?: string | null;
}): Promise<SatoEmailMediaRecord | SatoEmailUploadRefusal> {
  const validated = validateSatoEmailUpload({
    byteSize: input.bytes.length,
    contentType: input.contentType,
    kind: input.kind,
  });
  if ("message" in validated) return validated;

  const contentType = input.contentType.trim().toLowerCase().split(";")[0];
  const filename = safeAttachmentFileName(input.filename, validated.extension);
  // 24 random bytes, not a uuid: a uuid is 122 bits of which some are structural, and this one
  // string is the entire access control on a body picture.
  const token = input.kind === "inline" ? randomBytes(24).toString("base64url") : null;
  const objectId = randomBytes(16).toString("hex");
  const path = `${input.kind}/${new Date().toISOString().slice(0, 7)}/${objectId}.${validated.extension}`;
  const supabase = input.supabase ?? getSupabaseAdmin();

  const upload = await supabase.storage.from(SATO_EMAIL_MEDIA_BUCKET).upload(path, input.bytes, {
    // A body picture is fetched by every recipient's mail client, often through a caching proxy.
    // The path holds a random object id and is never reused, so a long cache is safe.
    cacheControl: "31536000",
    contentType,
    upsert: false,
  });
  if (upload.error) {
    return { message: `The file could not be stored: ${upload.error.message}` };
  }

  const { data, error } = await supabase
    .from(MEDIA_TABLE)
    .insert({
      byte_size: input.bytes.length,
      content_type: contentType,
      kind: input.kind,
      original_file_name: filename,
      public_token: token,
      storage_bucket: SATO_EMAIL_MEDIA_BUCKET,
      storage_path: path,
      uploaded_by_hr_id: input.uploadedByHrId ?? null,
      uploaded_by_login_id: input.uploadedByLoginId ?? null,
    })
    .select("id")
    .single();

  if (error || !data) {
    await supabase.storage.from(SATO_EMAIL_MEDIA_BUCKET).remove([path]).then(undefined, () => undefined);
    if (isMissingTable(error)) return { message: SATO_EMAIL_MEDIA_MISSING_TABLE };
    return { message: `The file could not be recorded: ${error?.message ?? "unknown error"}` };
  }

  return {
    byteSize: input.bytes.length,
    contentType,
    filename,
    id: String((data as { id: string }).id),
    kind: input.kind,
    url: token ? satoEmailMediaUrl(token) : null,
  };
}

export type SatoEmailAttachmentSummary = { byteSize: number; filename: string; id: string };

/**
 * The metadata of every file clipped to one draft, plus the one reason it may not be sendable.
 *
 * Preview calls this so the sender learns the total is over budget while he is still looking at the
 * draft, not after he has pressed the confirm button. Send calls it again, because the preview is a
 * courtesy and the server is the boundary.
 */
export async function resolveSatoEmailAttachments(
  ids: readonly string[],
  supabaseClient?: SupabaseClient,
): Promise<{ files: SatoEmailAttachmentSummary[]; problem: string | null }> {
  const wanted = Array.from(new Set(ids.map((id) => String(id ?? "").trim()).filter(Boolean)));
  if (wanted.length === 0) return { files: [], problem: null };
  if (wanted.length > SATO_EMAIL_MEDIA_MAX_FILES) {
    return { files: [], problem: `An email may carry at most ${SATO_EMAIL_MEDIA_MAX_FILES} attachments.` };
  }

  const supabase = supabaseClient ?? getSupabaseAdmin();
  const { data, error } = await supabase
    .from(MEDIA_TABLE)
    .select("id, byte_size, original_file_name")
    .in("id", wanted)
    .eq("kind", "attachment");

  if (error) {
    return {
      files: [],
      problem: isMissingTable(error) ? SATO_EMAIL_MEDIA_MISSING_TABLE : "The attachments could not be read.",
    };
  }

  const rows = (data ?? []) as { byte_size: number; id: string; original_file_name: string }[];
  // Ordered by the sender's own list rather than by whatever the database returned, so the chips on
  // screen and the files on the mail are in the same order.
  const byId = new Map(rows.map((row) => [String(row.id), row]));
  const files: SatoEmailAttachmentSummary[] = [];
  for (const id of wanted) {
    const row = byId.get(id);
    // A missing id is a refusal, never a quiet skip: it means the sender is looking at a chip for a
    // file the send would not carry.
    if (!row) {
      return { files: [], problem: "One of the attached files is no longer available. Remove it and attach it again." };
    }
    files.push({ byteSize: Number(row.byte_size ?? 0), filename: String(row.original_file_name ?? "attachment"), id });
  }

  const total = files.reduce((sum, file) => sum + file.byteSize, 0);
  if (total > SATO_EMAIL_MEDIA_MAX_TOTAL_BYTES) {
    return {
      files,
      problem:
        `The attachments come to ${formatBytes(total)}, and one email may carry ${formatBytes(SATO_EMAIL_MEDIA_MAX_TOTAL_BYTES)}. `
        + "Remove a file, or put it somewhere the email can link to.",
    };
  }

  return { files, problem: null };
}

/** Read the bytes of every attachment on a draft, ready for the provider call. */
export async function loadSatoEmailAttachments(
  ids: readonly string[],
  supabaseClient?: SupabaseClient,
): Promise<{ attachments: SendPhoenixEmailAttachment[] } | { problem: string }> {
  const supabase = supabaseClient ?? getSupabaseAdmin();
  const resolved = await resolveSatoEmailAttachments(ids, supabase);
  if (resolved.problem) return { problem: resolved.problem };
  if (resolved.files.length === 0) return { attachments: [] };

  const { data, error } = await supabase
    .from(MEDIA_TABLE)
    .select("id, content_type, original_file_name, storage_bucket, storage_path")
    .in("id", resolved.files.map((file) => file.id))
    .eq("kind", "attachment");
  if (error) return { problem: "The attachments could not be read." };

  const rows = new Map(
    (
      (data ?? []) as {
        content_type: string;
        id: string;
        original_file_name: string;
        storage_bucket: string;
        storage_path: string;
      }[]
    ).map((row) => [String(row.id), row]),
  );

  const attachments: SendPhoenixEmailAttachment[] = [];
  for (const file of resolved.files) {
    const row = rows.get(file.id);
    if (!row) return { problem: "One of the attached files is no longer available. Remove it and attach it again." };
    const blob = await supabase.storage.from(row.storage_bucket || SATO_EMAIL_MEDIA_BUCKET).download(row.storage_path);
    if (blob.error || !blob.data) {
      return { problem: `"${row.original_file_name}" could not be read from storage. Attach it again.` };
    }
    attachments.push({
      content: Buffer.from(await blob.data.arrayBuffer()).toString("base64"),
      contentType: row.content_type,
      filename: row.original_file_name,
    });
  }

  return { attachments };
}

export type SatoEmailInlineMedia = { bytes: ArrayBuffer; contentType: string; filename: string };

/**
 * Resolve one body picture from its token, for the public route.
 *
 * 🔴 `kind = 'inline'` IS PART OF THE LOOKUP, NOT A CHECK AFTERWARDS. An attachment row has no token
 * at all, so it cannot be named here — but stating the kind in the query as well means a future
 * column that accidentally minted one still could not open an attached contract to the world.
 */
export async function readSatoEmailInlineMedia(
  token: string,
  supabaseClient?: SupabaseClient,
): Promise<SatoEmailInlineMedia | null> {
  const clean = String(token ?? "").trim();
  if (!clean || !/^[A-Za-z0-9_-]{16,64}$/.test(clean)) return null;

  const supabase = supabaseClient ?? getSupabaseAdmin();
  const { data, error } = await supabase
    .from(MEDIA_TABLE)
    .select("content_type, original_file_name, storage_bucket, storage_path")
    .eq("public_token", clean)
    .eq("kind", "inline")
    .maybeSingle();
  if (error || !data) return null;

  const row = data as {
    content_type: string;
    original_file_name: string;
    storage_bucket: string;
    storage_path: string;
  };
  const blob = await supabase.storage.from(row.storage_bucket || SATO_EMAIL_MEDIA_BUCKET).download(row.storage_path);
  if (blob.error || !blob.data) return null;

  return {
    bytes: await blob.data.arrayBuffer(),
    // Echoing a stored content type back unchecked is how an unexpected row becomes an unexpected
    // document type on this origin. Only the four picture types are ever named here.
    contentType: isSatoEmailInlineContentType(row.content_type) ? row.content_type : "application/octet-stream",
    filename: row.original_file_name,
  };
}

/**
 * Download a file the ChatGPT connector built (src/lib/chatgpt-connector/files.ts).
 *
 * The link ChatGPT shows is only an address: opening it needs the SAME person's own Phoenix session
 * in the browser (the account that asked ChatGPT for it), and it works for 7 days. Signed out, the
 * browser goes to /login and comes back here. Anyone else — including the other connector seat —
 * gets a plain 404, so the link proves nothing about whether a file exists.
 */
import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { JOB_EXPORTS_BUCKET } from "@/lib/background-jobs/service";
import { CONNECTOR_FILE_CONTENT_TYPES, type ConnectorFileKind } from "@/lib/chatgpt-connector/files";
import { logError } from "@/lib/observability/log";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Above this a file (a long film) is handed over by a signed storage address, never through this server. */
export const CONNECTOR_STREAM_DIRECT_BYTES = 24 * 1024 * 1024;
const CONNECTOR_SIGNED_URL_SECONDS = 600;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function notFound() {
  return NextResponse.json({ error: "This file does not exist or has expired. Ask ChatGPT to build it again." }, { status: 404, headers: { "Cache-Control": "no-store" } });
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!UUID.test(id)) return notFound();

  const access = await resolveAccessContext(request);
  if (!access.loginId) {
    // A relative Location: never this request's own origin, which behind a proxy can be the bound address.
    const location = `/login?returnUrl=${encodeURIComponent(`/api/connector/files/${id}`)}`;
    return new Response(null, { status: 303, headers: { Location: location, "Cache-Control": "no-store" } });
  }

  const db = getSupabaseAdmin();
  const { data: row, error } = await db
    .from("connector_files")
    .select("id, login_id, kind, file_name, storage_path, expires_at, size_bytes")
    .eq("id", id)
    .maybeSingle();
  if (error) {
    logError("ChatGPT connector file lookup failed", { labels: { event: "chatgpt_connector_file_lookup_failed" }, error });
    return NextResponse.json({ error: "Phoenix could not open this file just now. Try again." }, { status: 503 });
  }
  if (!row || String(row.login_id).toLowerCase() !== String(access.loginId).toLowerCase()) return notFound();
  if (Date.parse(String(row.expires_at)) <= Date.now()) return notFound();

  // A film can run to hundreds of megabytes: rather than pass it through this server's memory, hand the
  // browser a ten-minute signed address to the stored file, after the same owner and expiry checks.
  if (Number(row.size_bytes ?? 0) > CONNECTOR_STREAM_DIRECT_BYTES) {
    const { data: signed, error: signError } = await db.storage
      .from(JOB_EXPORTS_BUCKET)
      .createSignedUrl(String(row.storage_path), CONNECTOR_SIGNED_URL_SECONDS);
    if (signError || !signed?.signedUrl) {
      logError("ChatGPT connector file signing failed", { labels: { event: "chatgpt_connector_file_sign_failed" }, error: signError });
      return notFound();
    }
    await db.from("connector_files").update({ downloaded_at: new Date().toISOString() }).eq("id", id);
    return new Response(null, { status: 303, headers: { Location: signed.signedUrl, "Cache-Control": "no-store" } });
  }

  const { data: blob, error: downloadError } = await db.storage.from(JOB_EXPORTS_BUCKET).download(String(row.storage_path));
  if (downloadError || !blob) {
    logError("ChatGPT connector file download failed", { labels: { event: "chatgpt_connector_file_download_failed" }, error: downloadError });
    return notFound();
  }
  await db.from("connector_files").update({ downloaded_at: new Date().toISOString() }).eq("id", id);

  const fileName = String(row.file_name);
  const asciiName = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "'");
  const kind = String(row.kind) as ConnectorFileKind;
  // A screenshot or a video opens in the browser tab to be looked at; a sheet or a PDF downloads.
  const media = kind === "png" || kind === "mp4" || kind === "webm";
  return new Response(blob, {
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Type": CONNECTOR_FILE_CONTENT_TYPES[kind] ?? "application/octet-stream",
      "Content-Disposition": `${media ? "inline" : "attachment"}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      "X-Content-Type-Options": "nosniff",
    },
  });
}

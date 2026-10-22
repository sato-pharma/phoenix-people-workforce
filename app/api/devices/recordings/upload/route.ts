import { NextResponse } from "next/server";

import { ingestRecording } from "@/lib/devices/headwind/recordings";
import { logError } from "@/lib/observability/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const JOB = "devices/recordings/upload";

/**
 * The tablet's door for a finished screen recording. Server to device, never a browser.
 *
 * 🔴 NO SESSION AND NO SHARED SECRET. A tablet's Headwind configuration is world-readable, so no
 * long-lived credential may reach it. This endpoint is authenticated solely by the per-recording token
 * minted when the Super Admin pressed Record and sent to that one tablet in the push payload. The token
 * is matched against the row's stored hash inside `ingestRecording`, once, inside a short window — so a
 * leaked token buys at most one capture slot, for minutes, and CSRF has no meaning here (there is no
 * cookie to ride). Multipart body: `recordingId`, `token`, `capturedSeconds`, and the `file`.
 */
export async function POST(request: Request) {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "invalid_form" }, { status: 400 });
  }

  const recordingId = String(form.get("recordingId") ?? "").trim();
  const token = String(form.get("token") ?? "");
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "missing_file" }, { status: 400 });
  }
  const capturedRaw = form.get("capturedSeconds");
  const capturedSeconds = capturedRaw === null ? null : Number(capturedRaw);

  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const result = await ingestRecording({
      bytes,
      capturedSeconds: Number.isFinite(capturedSeconds) ? (capturedSeconds as number) : null,
      contentType: file.type || null,
      recordingId,
      token,
    });
    return NextResponse.json(result.body, { status: result.status });
  } catch (error) {
    logError("Could not ingest a tablet screen recording", {
      error,
      labels: { event: "tablet_recording_ingest_failed", job: JOB },
    });
    return NextResponse.json({ error: "ingest_failed" }, { status: 500 });
  }
}

import { NextResponse } from "next/server";

import {
  RECORDING_UPLOAD_ID_PARAM,
  RECORDING_UPLOAD_RATE_LIMIT,
  RECORDING_UPLOAD_RATE_WINDOW_MS,
  checkRecordingSlotOpen,
  ingestRecording,
  recordingUploadLengthDecision,
} from "@/lib/devices/headwind/recordings";
import { logError, logWarning } from "@/lib/observability/log";
import { ApiRateLimitError, assertApiRateLimit, rateLimitIdentity } from "@/lib/security/api-rate-limit";

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
 * cookie to ride). The address names the slot (`?recordingId=`, as the record push gives it);
 * multipart body: `token`, `capturedSeconds`, the `file`, and optionally `recordingId` again,
 * which must then be the same id.
 *
 * NOTHING IS READ BEFORE THREE CHECKS (audit, 2026-10-26, point 24). The body is a video of up to
 * 256 MB and `formData()` holds all of it in memory, so the door first refuses a request whose
 * Content-Length is missing or over the cap, then counts the address (RECORDING_UPLOAD_RATE_LIMIT a
 * minute), then reads the one slot the address names and refuses it unless it is still waiting for
 * its file. Before this, anyone could stream 256 MB bodies at it as fast as they liked, each one
 * buffered whole before the token was even looked at. This route is also left OUT of the proxy matcher (proxy.ts), whose
 * 10 MB body copy cut every real recording short.
 */
export async function POST(request: Request) {
  const length = recordingUploadLengthDecision(request.headers.get("content-length"));
  if (!length.ok) return NextResponse.json({ error: length.reason }, { status: length.status });

  try {
    // No onStoreError: a limit that cannot be checked refuses the upload; the tablet retries.
    await assertApiRateLimit({
      identifier: rateLimitIdentity({ request }),
      limit: RECORDING_UPLOAD_RATE_LIMIT,
      scope: "device_recording_upload",
      windowMs: RECORDING_UPLOAD_RATE_WINDOW_MS,
    });
  } catch (error) {
    if (error instanceof ApiRateLimitError) {
      return NextResponse.json(
        { error: "rate_limited" },
        { headers: { "Retry-After": String(error.retryAfterSeconds) }, status: 429 },
      );
    }
    logWarning("Tablet recording upload refused: the rate limit could not be checked", {
      error,
      labels: { event: "tablet_recording_rate_limit_unavailable", job: JOB },
    });
    return NextResponse.json({ error: "rate_limit_unavailable" }, { status: 503 });
  }

  const recordingId = (new URL(request.url).searchParams.get(RECORDING_UPLOAD_ID_PARAM) ?? "").trim();
  try {
    const slot = await checkRecordingSlotOpen(recordingId);
    if (!slot.ok) return NextResponse.json({ error: slot.reason }, { status: slot.status });
  } catch (error) {
    logWarning("Tablet recording upload refused: its slot could not be read", {
      error,
      labels: { event: "tablet_recording_slot_unavailable", job: JOB },
    });
    return NextResponse.json({ error: "slot_unavailable" }, { status: 503 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "invalid_form" }, { status: 400 });
  }

  const formRecordingId = String(form.get("recordingId") ?? "").trim();
  if (formRecordingId && formRecordingId !== recordingId) {
    return NextResponse.json({ error: "recording_id_mismatch" }, { status: 400 });
  }
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

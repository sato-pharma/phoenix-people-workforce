import { NextResponse } from "next/server";

import {
  ERROR_SCREENSHOT_BUCKET,
  ERROR_SCREENSHOT_CONTENT_TYPE,
  ERROR_SCREENSHOT_MAX_BYTES,
  ERROR_SCREENSHOT_RATE_LIMIT,
  ERROR_SCREENSHOT_RATE_WINDOW_MS,
  errorScreenshotObjectPath,
  isWebpImage,
  screenshotBodyTooLarge,
} from "@/lib/error-monitor/screenshot-intake";
import { readErrorScreenshotTicket } from "@/lib/error-monitor/screenshot-ticket";
import { ApiRateLimitError, assertApiRateLimit, rateLimitIdentity } from "@/lib/security/api-rate-limit";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The picture of what the employee was looking at when it broke.
 *
 * Unauthenticated, exactly like its sibling `/api/errors/client` and for the same reason — the
 * person it happened to is often not signed in — but it accepts BYTES, so it is bounded harder:
 *
 *   - a signed ticket is required, and only the report response mints one, for the row it wrote;
 *   - the ticket expires in two minutes and names ONE row, so bytes cannot be aimed anywhere else;
 *   - 2 MB hard ceiling, checked on the header AND on the read;
 *   - WebP only, sniffed from the container's own magic bytes rather than the caller's header;
 *   - 10 uploads a minute per address, a third of what the text report allows.
 *
 * The answer is always bare `{ ok }` — never why something was refused. A failed upload must stay
 * invisible to the person whose page just crashed; the error itself is already filed either way.
 */
export async function POST(request: Request) {
  if (screenshotBodyTooLarge(request.headers.get("content-length"))) {
    return NextResponse.json({ ok: false }, { status: 413 });
  }

  const eventId = readErrorScreenshotTicket(request.headers.get("x-phoenix-screenshot-ticket"));
  if (!eventId) {
    return NextResponse.json({ ok: false }, { status: 403 });
  }

  try {
    try {
      await assertApiRateLimit({
        identifier: rateLimitIdentity({ request }),
        limit: ERROR_SCREENSHOT_RATE_LIMIT,
        scope: "client_error_screenshot",
        windowMs: ERROR_SCREENSHOT_RATE_WINDOW_MS,
      });
    } catch (error) {
      if (error instanceof ApiRateLimitError) {
        return NextResponse.json(
          { ok: false },
          { headers: { "Retry-After": String(error.retryAfterSeconds) }, status: 429 },
        );
      }
      // The limiter could not be read. The ticket already bounds this far harder than the limiter
      // does, so let the picture through rather than lose it to an outage of the limiter's table.
      console.error("Error-screenshot rate limit unavailable:", error);
    }

    const bytes = new Uint8Array(await request.arrayBuffer());
    // A body with no (or a false) Content-Length is capped on the read as well.
    if (bytes.length === 0 || bytes.length > ERROR_SCREENSHOT_MAX_BYTES) {
      return NextResponse.json({ ok: false }, { status: 413 });
    }
    if (!isWebpImage(bytes)) {
      return NextResponse.json({ ok: false }, { status: 415 });
    }

    const supabase = getSupabaseAdmin();
    const objectPath = errorScreenshotObjectPath(eventId);

    const upload = await supabase.storage
      .from(ERROR_SCREENSHOT_BUCKET)
      // `upsert` so a retry against the same error row replaces its picture rather than orphaning
      // one — the path is keyed by that row's id, so there is only ever one per error.
      .upload(objectPath, bytes, { contentType: ERROR_SCREENSHOT_CONTENT_TYPE, upsert: true });

    if (upload.error) {
      console.error("Failed to store error screenshot:", upload.error);
      return NextResponse.json({ ok: false }, { status: 500 });
    }

    // Written only after the bytes are safely in the bucket, so a path on a row always resolves.
    const { error: updateError } = await supabase
      .from("app_error_events")
      .update({ screenshot_path: objectPath })
      .eq("id", eventId);

    if (updateError) {
      console.error("Failed to attach error screenshot to its row:", updateError);
      return NextResponse.json({ ok: false }, { status: 500 });
    }
  } catch (error) {
    console.error("Failed to ingest error screenshot:", error);
    return NextResponse.json({ ok: false }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}

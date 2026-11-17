import { NextResponse } from "next/server";

import {
  ERROR_SCREENSHOT_MAX_BYTES,
  ERROR_SCREENSHOT_RATE_LIMIT,
  ERROR_SCREENSHOT_RATE_WINDOW_MS,
  errorScreenshotImageType,
  screenshotBodyTooLarge,
} from "@/lib/error-monitor/screenshot-intake";
import { readErrorScreenshotTicket } from "@/lib/error-monitor/screenshot-ticket";
import { attachErrorScreenshot } from "@/lib/error-monitor/user-error-screens";
import { ApiRateLimitError, assertApiRateLimit, rateLimitIdentity } from "@/lib/security/api-rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The picture of what the employee was looking at when it broke.
 *
 * It reads no cookie: the ticket is the whole authorisation. It accepts BYTES, so it is bounded hard:
 *
 *   - a signed ticket is required, and only the report response mints one, for the row it wrote —
 *     and since 23 Oct 2026 only for a SIGNED-IN reporter (owner's decision, after a review found a
 *     guest ticket let anyone on the internet store images in the Super Admin's error drawer);
 *   - the ticket expires in two minutes and names ONE row, so bytes cannot be aimed anywhere else;
 *   - 2 MB hard ceiling, checked on the header AND on the read;
 *   - WebP or JPEG only, each sniffed from its own magic bytes rather than the caller's header, and
 *     stored under the type the bytes proved (`.webp` or `.jpg`) — JPEG because Safari on an iPhone,
 *     an iPad or a Mac cannot encode WebP, and no crash picture from those devices had ever landed
 *     until 17 Nov 2026 (screenshot-intake.ts);
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
      // The limiter could not be read: refuse. This is the one public door that stores BYTES, and the
      // picture is a nicety on top of a report already filed — losing it in a limiter outage costs
      // nothing, letting uploads through unmetered does (review of #6358, 23 Oct 2026).
      console.error("Error-screenshot rate limit unavailable:", error);
      return NextResponse.json({ ok: false }, { status: 503 });
    }

    const bytes = new Uint8Array(await request.arrayBuffer());
    // A body with no (or a false) Content-Length is capped on the read as well.
    if (bytes.length === 0 || bytes.length > ERROR_SCREENSHOT_MAX_BYTES) {
      return NextResponse.json({ ok: false }, { status: 413 });
    }
    // The bytes decide the format, and so the stored type and extension; the header decides nothing.
    const contentType = errorScreenshotImageType(bytes);
    if (!contentType) {
      return NextResponse.json({ ok: false }, { status: 415 });
    }

    // Bytes into the bucket first, then the path onto the row, so a path on a row always resolves; a
    // row that cannot be written takes the file back out (user-error-screens.ts, attachErrorScreenshot).
    const stored = await attachErrorScreenshot({ eventId, bytes, contentType });
    if (!stored.ok) {
      console.error(
        stored.stage === "upload" ? "Failed to store error screenshot:" : "Failed to attach error screenshot to its row:",
        stored.cause,
      );
      return NextResponse.json({ ok: false }, { status: 500 });
    }
  } catch (error) {
    console.error("Failed to ingest error screenshot:", error);
    return NextResponse.json({ ok: false }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}

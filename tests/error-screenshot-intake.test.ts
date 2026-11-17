import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { CAPTURE_QUALITY, encodeCapture, sendErrorScreenshot } from "../src/lib/error-monitor/capture-screenshot.ts";
import {
  ERROR_SCREENSHOT_CONTENT_TYPES,
  ERROR_SCREENSHOT_MAX_BYTES,
  ERROR_SCREENSHOT_RATE_LIMIT,
  errorScreenshotImageType,
  errorScreenshotObjectPath,
  isJpegImage,
  isWebpImage,
  screenshotBodyTooLarge,
} from "../src/lib/error-monitor/screenshot-intake.ts";
import { issueErrorScreenshotTicket, readErrorScreenshotTicket } from "../src/lib/error-monitor/screenshot-ticket.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * THE SCREENSHOT DOOR IS BOUNDED, AND IT IS THE ONLY PUBLIC ONE THAT TAKES BYTES (23 Oct 2026).
 *
 * `/api/errors/client/screenshot` reads no cookie; the ticket is the whole authorisation. It is
 * minted only by a report that really wrote a row, only for a SIGNED-IN reporter (owner, 23 Oct
 * 2026 — a guest ticket let anyone on the internet store images in the Super Admin's error drawer),
 * it names that one row, and it dies in two minutes. These are the pieces that decide it, all pure
 * — no request, no bucket, no database — plus source pins on the two routes.
 */
export async function runErrorScreenshotIntakeTests() {
  const savedSecret = process.env.PHOENIX_AUTH_SECRET;
  try {
    // ── the byte ceiling ──────────────────────────────────────────────────────────────────────────
    assert.equal(screenshotBodyTooLarge(String(ERROR_SCREENSHOT_MAX_BYTES)), false, "exactly the cap is allowed");
    assert.equal(screenshotBodyTooLarge(String(ERROR_SCREENSHOT_MAX_BYTES + 1)), true, "one byte over is refused");
    assert.equal(screenshotBodyTooLarge(null), false, "a missing Content-Length is not a refusal — the read is capped too");
    assert.equal(screenshotBodyTooLarge("not-a-number"), false, "and neither is an unreadable one");
    assert.ok(
      ERROR_SCREENSHOT_RATE_LIMIT < 30,
      "the picture door is tighter than the 30/min text report beside it, never looser",
    );

    // ── WebP is sniffed from the bytes, never believed from the header ────────────────────────────
    const webp = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20,
    ]);
    assert.equal(isWebpImage(webp), true, "RIFF....WEBP is a WebP");

    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
    assert.equal(isWebpImage(png), false, "a PNG is not a WebP — the PNG Safari hands back when asked for WebP never passes as one");

    const html = new TextEncoder().encode("<!DOCTYPE html><html><body>not an image at all</body></html>");
    assert.equal(isWebpImage(html), false, "an HTML page named .webp is refused before it reaches the bucket");

    const riffButNotWebp = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x41, 0x56, 0x49, 0x20, 0x00, 0x00, 0x00, 0x00,
    ]);
    assert.equal(isWebpImage(riffButNotWebp), false, "a RIFF container that is not WEBP is refused — both markers are read");
    assert.equal(isWebpImage(new Uint8Array([0x52, 0x49, 0x46, 0x46])), false, "a body too short to carry both markers is refused");

    // ── JPEG too: Safari cannot encode WebP (17 Nov 2026) ─────────────────────────────────────────
    // Production, 24 Oct – 17 Nov 2026: 593 iPhone/iPad and 228 Mac Safari signed-in crash reports and
    // not one picture, because WebKit hands back a PNG when asked for WebP and this door took WebP only.
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
    assert.deepEqual([...ERROR_SCREENSHOT_CONTENT_TYPES], ["image/webp", "image/jpeg"], "exactly two formats are accepted");
    assert.equal(isJpegImage(jpeg), true, "FF D8 FF is a JPEG");
    assert.equal(errorScreenshotImageType(jpeg), "image/jpeg", "a real JPEG is accepted — the Safari fallback lands");
    assert.equal(errorScreenshotImageType(webp), "image/webp", "a real WebP is accepted as before");
    assert.equal(errorScreenshotImageType(png), null, "a PNG is still refused, whatever header it came under");
    assert.equal(errorScreenshotImageType(html), null, "and so is an HTML page");
    assert.equal(errorScreenshotImageType(new Uint8Array([0xff, 0xd8])), null, "two bytes are not a JPEG");

    // ── the object path is keyed by the row, so a retry replaces rather than multiplies ───────────
    const eventId = "11111111-2222-3333-4444-555555555555";
    const path = errorScreenshotObjectPath(eventId, "image/webp", new Date("2026-10-23T09:00:00Z"));
    assert.equal(path, `2026/10/23/${eventId}.webp`, "partitioned by Cairo day, named for the error row");
    assert.equal(
      errorScreenshotObjectPath(eventId, "image/jpeg", new Date("2026-10-23T09:00:00Z")),
      `2026/10/23/${eventId}.jpg`,
      "a JPEG is stored as .jpg, never under a .webp name",
    );
    assert.equal(
      errorScreenshotObjectPath(eventId, "image/webp", new Date("2026-10-23T09:00:00Z")),
      errorScreenshotObjectPath(eventId, "image/webp", new Date("2026-10-23T09:01:00Z")),
      "two captures for one error are one object, not two",
    );
    // 21:30 UTC is already the 24th in Cairo — Egypt is on UTC+3 until the last Thursday of October,
    // so this also pins that the formatter reads the real offset rather than a hard-coded +2.
    assert.equal(
      errorScreenshotObjectPath(eventId, "image/webp", new Date("2026-10-23T21:30:00Z")).startsWith("2026/10/24/"),
      true,
      "the day boundary is Cairo's, never UTC's",
    );

    // ── the ticket ────────────────────────────────────────────────────────────────────────────────
    process.env.PHOENIX_AUTH_SECRET = "test-signing-secret-for-the-screenshot-ticket";
    const now = 1_800_000_000;

    const ticket = issueErrorScreenshotTicket(eventId, now);
    assert.ok(ticket, "a ticket is minted when there is a secret to sign it with");
    assert.equal(readErrorScreenshotTicket(ticket, now), eventId, "and it reads back as the row it names");

    assert.equal(
      readErrorScreenshotTicket(ticket, now + 121),
      null,
      "two minutes later it is dead — a ticket bounds replay, it is not a standing permission",
    );

    const [encoded] = ticket!.split(".");
    assert.equal(readErrorScreenshotTicket(`${encoded}.deadbeef`, now), null, "a forged signature is refused");
    assert.equal(readErrorScreenshotTicket(encoded, now), null, "an unsigned payload is refused");
    assert.equal(readErrorScreenshotTicket(null, now), null, "and so is nothing at all");

    // Aiming a ticket at a different row means re-signing it, which an uploader cannot do.
    const otherEncoded = Buffer.from(
      JSON.stringify({ v: 1, id: "99999999-8888-7777-6666-555555555555", exp: now + 60 }),
      "utf8",
    ).toString("base64url");
    const [, signature] = ticket!.split(".");
    assert.equal(
      readErrorScreenshotTicket(`${otherEncoded}.${signature}`, now),
      null,
      "one row's signature does not carry another row's payload",
    );

    delete process.env.PHOENIX_AUTH_SECRET;
    assert.equal(issueErrorScreenshotTicket(eventId, now), null, "with no secret nothing is minted");
    assert.equal(readErrorScreenshotTicket(ticket, now), null, "and nothing verifies — the upload fails closed");
  } finally {
    if (savedSecret === undefined) delete process.env.PHOENIX_AUTH_SECRET;
    else process.env.PHOENIX_AUTH_SECRET = savedSecret;
  }

  // ── the three faults the 23 Oct 2026 review of #6358 found, pinned at their source ──────────────
  const root = join(import.meta.dirname ?? ".", "..");
  const read = (...parts: string[]) => stripComments(readFileSync(join(root, ...parts), "utf8"));

  // 1. A ticket only for a SIGNED-IN reporter: a guest ticket let anyone store images in the drawer.
  const report = read("app", "api", "errors", "client", "route.ts");
  assert.match(
    report,
    /if \(eventId && report\.source === "client" && \(access\.hrId \|\| access\.loginId\)\) \{\s*screenshotTicket = issueErrorScreenshotTicket\(eventId\);/,
    "/api/errors/client mints a screenshot ticket only for a signed-in reporter",
  );
  //    …and an unreadable limiter refuses the upload rather than waving it through unmetered.
  const upload = read("app", "api", "errors", "client", "screenshot", "route.ts");
  assert.match(
    upload,
    /console\.error\("Error-screenshot rate limit unavailable:", error\);\s*return NextResponse\.json\(\{ ok: false \}, \{ status: 503 \}\);/,
    "the screenshot upload fails closed when its rate limiter cannot be read",
  );

  // 2. Retention: a crash picture is removed before its row, and a row with a picture is deleted
  //    only by id once that picture is gone — never by the age filter alone.
  const service = read("src", "lib", "error-monitor", "service.ts");
  const prune = service.slice(service.indexOf("export async function pruneOldAppErrorEvents"));
  const removal = prune.indexOf(".storage");
  const ageDelete = prune.indexOf('.lt("created_at", cutoff)\n      .is("screenshot_path", null)');
  assert.ok(removal > 0, "pruneOldAppErrorEvents removes the pictures through the Storage API");
  assert.ok(ageDelete > removal, "and the age-based row delete runs after it, on rows with NO picture only");
  assert.ok(prune.includes('.in("id", removedIds.slice('), "rows with a picture go by id, once it is removed");

  // 3. The freeze guards the refusal picture already had: an element cap and an off-screen filter.
  const capture = read("src", "lib", "error-monitor", "capture-screenshot.ts");
  assert.ok(
    capture.includes('if (document.getElementsByTagName("*").length > SCREEN_MAX_ELEMENTS) return null;'),
    "a page over the element cap is not drawn at all",
  );
  assert.ok(capture.includes("filter: pictureFilter(),"), "off-screen boxes are copied empty before html-to-image copies what is inside them");

  // 4. The crash picture is drawn under the ONE capture lock the refusal picture shares (17 Nov 2026):
  //    without it html-to-image's own image downloads through the wrapped fetch filed refusal pictures.
  assert.match(
    capture,
    /await withCaptureLock\(\(\) => rasteriseViewport\(\), \{/,
    "the crash picture is drawn under the shared capture lock, which gives itself back in a finally",
  );
  assert.ok(!capture.includes("withTimeout("), "no second, unlocked timeout path around the draw");

  // 5. The route stores what the bytes ARE, and leaves no picture without a row.
  assert.ok(upload.includes("errorScreenshotImageType(bytes)"), "the route sniffs WebP or JPEG from the bytes");
  assert.ok(upload.includes("attachErrorScreenshot({ eventId, bytes, contentType })"), "and stores through the helper that cleans up after a failed row write");
  assert.ok(!/\.upload\(|\.update\(/.test(upload), "no second store path in the route that would skip that clean-up");

  // 6. The bucket's allow-list takes the JPEG too — the route's sniff is the first gate, this the second.
  const migration = readFileSync(join(root, "supabase", "migrations", "20261117044749_error_screenshots_accept_jpeg.sql"), "utf8");
  assert.match(
    migration,
    /update storage\.buckets\s+set allowed_mime_types = array\['image\/webp', 'image\/jpeg'\]\s+where id = 'error-screenshots';/,
    "the error-screenshots bucket accepts image/jpeg beside image/webp",
  );

  await crashPictureEncodingTests();
}

/** A canvas that encodes like a given browser: Safari answers a WebP request with a PNG. */
function fakeCanvas(encodes: Record<string, string | null>) {
  const asked: Array<{ type: string | undefined; quality: number | undefined }> = [];
  return {
    asked,
    toBlob(callback: (blob: Blob | null) => void, type?: string, quality?: number) {
      asked.push({ type, quality });
      const produced = encodes[type ?? ""];
      callback(produced === null || produced === undefined ? null : new Blob([new Uint8Array([1, 2, 3])], { type: produced }));
    },
  };
}

async function crashPictureEncodingTests() {
  // Chrome, Edge, Firefox: WebP, as before.
  const chromium = fakeCanvas({ "image/webp": "image/webp", "image/jpeg": "image/jpeg" });
  assert.equal((await encodeCapture(chromium))?.type, "image/webp", "a browser that encodes WebP sends WebP");
  assert.deepEqual(chromium.asked, [{ type: "image/webp", quality: CAPTURE_QUALITY }], "and is never asked for a second encoding");

  // Safari on an iPhone, an iPad or a Mac: asked for WebP, it silently hands back a PNG.
  const safari = fakeCanvas({ "image/webp": "image/png", "image/jpeg": "image/jpeg" });
  const fromSafari = await encodeCapture(safari);
  assert.equal(fromSafari?.type, "image/jpeg", "a browser that cannot encode WebP falls back to JPEG — never the PNG it handed back");
  assert.deepEqual(safari.asked[1], { type: "image/jpeg", quality: CAPTURE_QUALITY }, "at the capture's own quality");

  const noWebp = fakeCanvas({ "image/webp": null, "image/jpeg": "image/jpeg" });
  assert.equal((await encodeCapture(noWebp))?.type, "image/jpeg", "a null WebP blob falls back to JPEG too");
  assert.equal(await encodeCapture(fakeCanvas({ "image/webp": "image/png", "image/jpeg": "image/png" })), null, "a browser that encodes neither sends nothing");

  // The upload says what the picture really is.
  const sent: Array<{ url: string; headers: Record<string, string> }> = [];
  const send = (async (url: string, init: RequestInit) => {
    sent.push({ url, headers: init.headers as Record<string, string> });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as unknown as typeof fetch;
  await sendErrorScreenshot(send, fromSafari!, "the-ticket");
  assert.equal(sent[0]?.url, "/api/errors/client/screenshot");
  assert.equal(sent[0]?.headers["Content-Type"], "image/jpeg", "a JPEG goes up labelled image/jpeg, never image/webp");
  assert.equal(sent[0]?.headers["x-phoenix-screenshot-ticket"], "the-ticket", "with the ticket that admits it");
  const failing = (() => Promise.reject(new TypeError("Load failed"))) as unknown as typeof fetch;
  await assert.doesNotReject(sendErrorScreenshot(failing, fromSafari!, "t"), "a failed upload never becomes a second error");
}

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  ERROR_SCREENSHOT_MAX_BYTES,
  ERROR_SCREENSHOT_RATE_LIMIT,
  errorScreenshotObjectPath,
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
    assert.equal(isWebpImage(png), false, "a PNG is refused — the bucket takes one format");

    const html = new TextEncoder().encode("<!DOCTYPE html><html><body>not an image at all</body></html>");
    assert.equal(isWebpImage(html), false, "an HTML page named .webp is refused before it reaches the bucket");

    const riffButNotWebp = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x41, 0x56, 0x49, 0x20, 0x00, 0x00, 0x00, 0x00,
    ]);
    assert.equal(isWebpImage(riffButNotWebp), false, "a RIFF container that is not WEBP is refused — both markers are read");
    assert.equal(isWebpImage(new Uint8Array([0x52, 0x49, 0x46, 0x46])), false, "a body too short to carry both markers is refused");

    // ── the object path is keyed by the row, so a retry replaces rather than multiplies ───────────
    const eventId = "11111111-2222-3333-4444-555555555555";
    const path = errorScreenshotObjectPath(eventId, new Date("2026-10-23T09:00:00Z"));
    assert.equal(path, `2026/10/23/${eventId}.webp`, "partitioned by Cairo day, named for the error row");
    assert.equal(
      errorScreenshotObjectPath(eventId, new Date("2026-10-23T09:00:00Z")),
      errorScreenshotObjectPath(eventId, new Date("2026-10-23T09:01:00Z")),
      "two captures for one error are one object, not two",
    );
    // 21:30 UTC is already the 24th in Cairo — Egypt is on UTC+3 until the last Thursday of October,
    // so this also pins that the formatter reads the real offset rather than a hard-coded +2.
    assert.equal(
      errorScreenshotObjectPath(eventId, new Date("2026-10-23T21:30:00Z")).startsWith("2026/10/24/"),
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
}

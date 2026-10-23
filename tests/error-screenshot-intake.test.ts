import assert from "node:assert/strict";

import {
  ERROR_SCREENSHOT_MAX_BYTES,
  ERROR_SCREENSHOT_RATE_LIMIT,
  errorScreenshotObjectPath,
  isWebpImage,
  screenshotBodyTooLarge,
} from "../src/lib/error-monitor/screenshot-intake.ts";
import { issueErrorScreenshotTicket, readErrorScreenshotTicket } from "../src/lib/error-monitor/screenshot-ticket.ts";

/**
 * THE SCREENSHOT DOOR IS BOUNDED, AND IT IS THE ONLY PUBLIC ONE THAT TAKES BYTES (23 Oct 2026).
 *
 * `/api/errors/client/screenshot` has to accept guests, exactly like the text report beside it — the
 * employee whose page broke is often on the login screen. What stops that being an open image
 * upload on the production domain is the ticket: it is minted only by a report that really wrote a
 * row, it names that one row, and it dies in two minutes. These are the pieces that decide it, all
 * pure — no request, no bucket, no database.
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
}

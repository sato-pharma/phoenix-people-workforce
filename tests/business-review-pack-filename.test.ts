import assert from "node:assert/strict";

import { packContentDisposition, packFileName } from "@/lib/business-review/pack/filename";

/**
 * The pack's download header — a production 500 that no other test could see.
 *
 * 🔴 THE INCIDENT (2026-09-27): every Sales Review pack export — PDF, Excel AND PowerPoint —
 * returned "Failed to build the pack" on production, while the pack itself built perfectly. The
 * stack was `TypeError: Cannot convert argument to a ByteString because the character at index 35
 * has a value of 8212` at `new Response()`. 8212 is "—" (em dash): the filename "Sales Review — …"
 * and the window "Jul – Aug 2026" carry an em and an en dash, and an HTTP header value is a
 * ByteString where every character must be ≤ 255. It reached production because the build/render
 * tests never construct the HTTP Response, so the throw only happened on a live request.
 *
 * This suite constructs a real `Response` with the header — exactly what threw — so the regression
 * cannot come back unseen.
 */

export function runBusinessReviewPackFilenameTests() {
  // The real-world value: an em dash in the prefix, an en dash in the window.
  const name = packFileName("Cairo district", "Jul – Aug 2026", "pdf");
  assert.match(name, /—/, "the human filename keeps its em dash");

  // ---- 1. the throw that hit production: a bare filename header ----
  assert.throws(
    () => new Response("x", { headers: { "Content-Disposition": `attachment; filename="${name}"` } }),
    /ByteString|character/i,
    "the bare filename must still be shown to throw — this is the bug the fix exists for",
  );

  // ---- 2. the fix: the real header must be accepted by a real Response ----
  const header = packContentDisposition(name);
  assert.doesNotThrow(
    () => new Response("x", { headers: { "Content-Disposition": header } }),
    "the Content-Disposition value must be a valid header — every character ≤ 255",
  );
  for (let i = 0; i < header.length; i += 1) {
    assert.ok(header.charCodeAt(i) <= 255, `header character ${i} (${header.charCodeAt(i)}) is not Latin1`);
  }

  // ---- 3. both names present, and the real name recoverable ----
  const ascii = /filename="([^"]+)"/.exec(header)?.[1];
  assert.ok(ascii && !/[—–]/.test(ascii), "the ascii fallback replaces the em/en dashes");
  assert.ok(/[\x20-\x7E]/.test(ascii ?? "") && [...(ascii ?? "")].every((c) => c.charCodeAt(0) <= 127), "the fallback is pure ASCII");
  const star = /filename\*=UTF-8''([^;]+)/.exec(header)?.[1];
  assert.ok(star, "a filename* must be present for clients that read it");
  assert.equal(decodeURIComponent(star as string), name, "and it round-trips back to the real filename, dashes intact");

  // ---- 4. all three formats produce a valid header (the incident hit all three) ----
  for (const ext of ["pdf", "pptx", "xlsx"]) {
    const h = packContentDisposition(packFileName("Anti-Infective line", "Jul – Aug 2026", ext));
    assert.doesNotThrow(
      () => new Response("x", { headers: { "Content-Disposition": h } }),
      `the ${ext} pack's header must be valid`,
    );
  }
}

// The Sales Review pack's download name, and the Content-Disposition header that carries it.
//
// 🔴 WHY THIS IS ITS OWN MODULE, WITH A TEST. An HTTP header value is a ByteString: every character
// must be ≤ 255. The pack's filename carries an em dash ("Sales Review —") and an en dash in the
// window label ("Jul – Aug 2026"), both > 255. Passing that straight into `filename="…"` makes
// `new Response()` throw a TypeError, and the whole export 500s — AFTER the pack was built
// perfectly. It reached production because every unit test builds the pack or renders it, and NONE
// of them constructs the HTTP Response, so the throw only ever happened on a live request. It broke
// PDF, Excel and PowerPoint alike. Pulling the header build here lets a test construct a real
// Response and prove it no longer throws.

export type PackFileFormat = "pdf" | "pptx" | "xlsx";

/** A filename a human can find again in a downloads folder, with no characters Windows refuses. */
export function packFileName(subject: string, windowLabel: string, extension: string): string {
  const safe = `${subject} ${windowLabel}`.replace(/[\\/:*?"<>|]/g, " ").replace(/\s+/g, " ").trim();
  return `Sales Review — ${safe}.${extension}`;
}

/**
 * A Content-Disposition value Node will accept as a header, carrying TWO names per RFC 6266/5987:
 *   - `filename="…"`  an ASCII-folded fallback every client accepts (em/en dash → "-", quotes → ');
 *   - `filename*=UTF-8''…`  the real name, percent-encoded, which modern clients prefer.
 *
 * The ASCII fold is what stops `new Response()` throwing; the `filename*` is what keeps the real
 * dashes for anyone whose browser reads it.
 */
export function packContentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7E]/g, "-").replace(/"/g, "'");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/**
 * Read the download name back out of `packContentDisposition`'s header — the page fetches the pack itself
 * (so it can say "Preparing…" and refuse a second click), which means the page, not the browser, names the
 * saved file. Prefers the real UTF-8 name, falls back to the ASCII one, and answers null for anything else.
 */
export function packFileNameFromDisposition(header: string | null): string | null {
  if (!header) return null;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(header)?.[1];
  if (star) {
    try {
      return decodeURIComponent(star.trim());
    } catch {
      // A malformed escape falls through to the plain name.
    }
  }
  const plain = /filename="([^"]+)"/i.exec(header)?.[1];
  return plain ? plain : null;
}

/**
 * Extract a JSON object from an AI text reply. Strips a ```json fence if present, then falls back
 * to slicing between the first `{` and last `}` before giving up — models occasionally wrap a
 * clean object in prose despite being told not to.
 *
 * Deliberately dependency-free and living outside recruitment/cv-extraction.ts, which used to be
 * the only place this logic lived: that file top-level-imports mammoth/pdf-parse/tesseract.js/
 * word-extractor for its CV pipeline, so every unrelated route that only wanted this one function
 * (direct-orders' evidence-check.ts and invoice-extraction.ts) dragged all of that into its
 * Turbopack trace too — the build tracer has no way to know the rest of that file is unreachable
 * from here.
 */
export function tryParseAiJson(text: string): Record<string, unknown> | null {
  const cleaned = text.replace(/```(?:json)?/gi, "").trim();
  try {
    return JSON.parse(cleaned) as Record<string, unknown>;
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
      } catch {
        /* fall through to null below */
      }
    }
  }
  return null;
}

export class AiJsonParseError extends Error {
  constructor(message = "The AI reply was not in the expected format. Try again.") {
    super(message);
    this.name = "AiJsonParseError";
  }
}

/** Same as {@link tryParseAiJson}, but throws {@link AiJsonParseError} instead of returning null. */
export function parseAiJson(text: string): Record<string, unknown> {
  const parsed = tryParseAiJson(text);
  if (parsed) return parsed;
  throw new AiJsonParseError();
}

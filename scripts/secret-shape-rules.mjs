// Shape rules for Railway secret VALUES, kept in their own module so that both the validator and
// its test can import them: validate-railway-production-secrets.mjs exits at import time when
// RAILWAY_TOKEN is unset, so a test can never import the validator itself.
//
// Added 2026-09-02, after OPENAI_API_KEY sat in Railway production holding a MASKED paste —
// "sk-..." glued onto the front of the real key and "..." onto the end, 173 chars where a real
// key is 164. Every existing check passed it: it was present, non-empty, comfortably long, and
// carried no embedded KEY=VALUE pair. OpenAI answered 401 ("Incorrect API key provided:
// sk-...sk****") and every AI feature in the app — CV extraction, payroll copilot, email assist,
// CRM campaign notes, direct-order invoice extraction, error-monitor triage — degraded in
// SILENCE, because those call sites catch the failure and return "no suggestions" rather than
// surfacing it. The telemetry that would otherwise have caught it (recordAiCall) writes to GCP
// Cloud Monitoring, whose billing is closed, so those writes are discarded.
//
// Both rules below are deterministic rather than heuristic, so they FAIL rather than warn —
// unlike EMBEDDED_KEY_VALUE in the validator, which is a guess about what a value contains.

/**
 * Vendor-fixed key formats. The charset is the real point: these vendors issue keys from
 * [A-Za-z0-9_-] only, so this same rule also rejects a value carrying a BOM, a stray newline, or
 * surrounding whitespace — the exact corruption `railway variable set --stdin` is known to
 * introduce. Test the RAW value against these, never a trimmed copy, or that catch is lost.
 */
export const KEY_SHAPES = [
  {
    name: "OPENAI_API_KEY",
    // Relax this if the OpenAI-compatible provider is ever swapped: AI_BASE_URL points this same
    // variable at Groq / OpenRouter / any compatible host, and those vendors prefix their keys
    // differently (gsk_…, sk-or-…). See src/lib/sales/ai/provider.ts.
    pattern: /^sk-[A-Za-z0-9_-]{20,}$/,
    describe: 'must look like sk-… — letters, digits, "_" and "-" only, with no spaces, dots or line breaks',
  },
];

/**
 * What a value copied off a screen that had already masked it looks like. None of these is ever
 * part of a real credential, so this applies to every checked variable rather than a named list.
 */
export const REDACTION_MARKER = /\.{3}|…|\*{3}|•{3}/;

/**
 * Returns human-readable failures for one variable, or [] when it looks sound.
 *
 * NEVER includes the value itself — an offset and a length are enough to identify the problem and
 * are safe to print in a CI log, which the value is not.
 */
export function checkSecretShape(name, rawValue) {
  const failures = [];
  if (rawValue === undefined || rawValue === null) return failures;
  const value = String(rawValue);

  const shape = KEY_SHAPES.find((entry) => entry.name === name);
  if (shape && !shape.pattern.test(value)) {
    failures.push(`${name} is not shaped like a real key — it ${shape.describe} (got ${value.length} chars)`);
  }

  const marker = REDACTION_MARKER.exec(value);
  if (marker) {
    failures.push(
      `${name} contains a redaction marker ("${marker[0]}" at offset ${marker.index} of ${value.length} chars) — that is what a value copied from an already-masked display looks like, not the credential itself`,
    );
  }

  return failures;
}

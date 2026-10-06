/**
 * Production Planner — reading a published dollar rate, as a decimal STRING.
 *
 * Its own file, with ZERO imports, for the same reason `rules.ts` has none: the sweep that uses it
 * pulls in the Supabase admin client, and a unit test must be able to check this without that. The
 * rate is the number every derived price in the module hangs off, so what it refuses matters as much
 * as what it accepts.
 *
 * A JSON number has already lost the question of how many decimals arrived, and `numeric(14,6)` is
 * what stores it, so the value is read as text and validated as a plain positive decimal. Anything
 * else — a null, a string that is not a number, a zero, a negative, an exponent — is NOT a rate, and
 * answering `null` makes the sweep record a failure and keep the last good rate rather than letting
 * `NaN` through as today's dollar.
 */
export function readUsdToEgpRate(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const rates = (body as { rates?: unknown }).rates;
  if (!rates || typeof rates !== "object") return null;
  const egp = (rates as Record<string, unknown>).EGP;
  if (typeof egp !== "number" && typeof egp !== "string") return null;
  const text = String(egp).trim();
  if (!/^\d+(\.\d+)?$/.test(text)) return null;
  if (Number(text) <= 0) return null;
  return text;
}

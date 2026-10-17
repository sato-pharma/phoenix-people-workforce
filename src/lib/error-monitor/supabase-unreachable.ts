/**
 * A Supabase outage, named once.
 *
 * When the hosted database stops answering, Cloudflare — which sits in front of it — serves its OWN HTML
 * page instead: 521 "Web server is down", 520 "Unknown error", 525 "SSL handshake failed". postgrest-js
 * wraps that page in a plain `{ message: "<!DOCTYPE html>…" }`, this codebase rethrows it as-is, and every
 * downstream sink then titled its issue with the page itself. One restart (2026-10-17, 12:30 Cairo) filed
 * four unrelated-looking Sentry issues, two of them whole Cloudflare pages, and the same HTML filled the
 * `app_error_events` message column.
 *
 * This recognises that page and gives it ONE stable name — "Supabase unreachable" — plus the code, so the
 * sinks can group every one of them together and print a line a person can read.
 *
 * It REWRITES, it never drops: a filter that hides a genuine fault is worse than the noise it removes
 * (`browser-noise.ts`). Only the exact Cloudflare title `supabase.co | 5NN: <words>` matches. A bare
 * "Failed to fetch", "Connection closed." or the client's own "Supabase request timed out." are NOT this —
 * they do not say the database was unreachable, only that a request did not finish.
 *
 * ZERO IMPORTS, DELIBERATELY. `instrumentation.ts` and `sentry-policy.ts` are bundled for the Edge Runtime
 * as well as Node, and the browser bundle reaches this too. Do not add an import to this file.
 */

export const SUPABASE_UNREACHABLE_TITLE = "Supabase unreachable";

/** Sentry groups on this, so every outage page lands in the same issue whatever its code or route. */
export const SUPABASE_UNREACHABLE_FINGERPRINT: readonly string[] = ["supabase-unreachable"];

export type SupabaseUnreachable = {
  /** The Cloudflare status in the page title: 520, 521, 525… */
  status: number;
  /** The words after the code: "Web server is down". */
  label: string;
  /** "Cloudflare 521: Web server is down" — what an exception's value says. */
  summary: string;
  /** "Supabase unreachable: Cloudflare 521: Web server is down" — the one line a message column holds. */
  line: string;
};

// Cloudflare's page title is `<host> | <code>: <words>`, and the host here is always the project's
// `<ref>.supabase.co`. The words stop at the next tag, quote, backslash or line break, so the match is the
// same inside the raw page, inside a JSON-escaped copy of it, and inside a log line.
const EDGE_PAGE_TITLE = /supabase\.co\s*\|\s*(5\d\d)\s*:\s*([^<>"\\\r\n]{1,60})/i;

export function classifySupabaseUnreachable(text: unknown): SupabaseUnreachable | null {
  if (typeof text !== "string" || text.length === 0) return null;
  const found = EDGE_PAGE_TITLE.exec(text);
  if (!found) return null;
  const status = Number(found[1]);
  const label = found[2].trim().replace(/[.\s]+$/, "");
  if (!label) return null;
  const summary = `Cloudflare ${status}: ${label}`;
  return { status, label, summary, line: `${SUPABASE_UNREACHABLE_TITLE}: ${summary}` };
}

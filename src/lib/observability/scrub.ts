// What may leave Phoenix in a URL path or a line of free text: an outbound database call's label
// (src/lib/supabase/server.ts) and the new-error message to the Super Admin's Telegram
// (src/lib/error-monitor/new-error-alert.ts). Pure on purpose, with no imports: both callers are on hot or
// failing paths, and this must never pull in a client, a Node module or the Supabase stack.

// Path segments that name ONE thing: an HR id (B-10), a bare number, or a long token (a 36-character uuid is one). Phoenix puts
// all of them in URLs (/admin/employees/B-10, /payroll/2026-10/…).
// `bot<id>:<token>` is Telegram's bot API path segment — the credential itself, in the URL of every `sendMessage`. The colon keeps
// it out of the long-word branch, so it gets a branch of its own.
const TELEGRAM_BOT_SEGMENT = String.raw`bot\d{5,}:[A-Za-z0-9_-]{20,}`;
const IDENTIFYING_SEGMENT = new RegExp(String.raw`^(?:[A-Za-z]{1,3}-?\d{1,8}|\d+|[A-Za-z0-9_-]{24,}|${TELEGRAM_BOT_SEGMENT})$`, "i");
// The same token with no `bot` and no slash in front of it (a log line, an error message that quotes the URL's tail).
const TELEGRAM_TOKEN_IN_TEXT = /\b\d{5,}:[A-Za-z0-9_-]{30,}/g;
const HR_ID_IN_TEXT = /\b[A-Z]-\d{1,6}\b/g;
const EMAIL_IN_TEXT = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;

// A PostgREST call is `/rest/v1/<table>` or `/rest/v1/rpc/<function>`: the segments after `/rest/v1/` are SCHEMA names, never
// data (the values ride in the query string, which is dropped). They must survive, or every outbound database call reads as
// the same call: until 2026-10-17 `v1` and any table name of 24+ characters were masked as `:id`, so a day's calls read
// `/rest/:id/:id`.
const POSTGREST_PATH = /^(\/rest\/v1\/(?:rpc\/)?[A-Za-z_][A-Za-z0-9_]*)(?:\/.*)?$/;
// The API version after a Supabase service name (`/auth/v1/…`, `/storage/v1/…`) is the same kind of word: `v1` reads like an HR id.
const SUPABASE_SERVICE_SEGMENT = /^(?:rest|auth|storage|functions|graphql|realtime)$/;
const API_VERSION_SEGMENT = /^v\d{1,2}$/;

/** One URL path, query and fragment removed and every identifying segment replaced by `:id`. */
export function scrubPath(path: string): string {
  const withoutQuery = path.split(/[?#]/)[0] ?? "";
  const postgrest = POSTGREST_PATH.exec(withoutQuery);
  if (postgrest) return postgrest[1] as string;
  const segments = withoutQuery.split("/");
  return segments
    .map((segment, index) => {
      if (!segment) return segment;
      if (API_VERSION_SEGMENT.test(segment) && SUPABASE_SERVICE_SEGMENT.test(segments[index - 1] ?? "")) return segment;
      return IDENTIFYING_SEGMENT.test(segment) ? ":id" : segment;
    })
    .join("/");
}

/** Free text (an error message, a log line): paths lose their ids and queries, HR ids, e-mail addresses and bot tokens are masked. */
export function scrubText(text: string): string {
  return text
    .replace(/(?:https?:\/\/[^\s/]+)?(\/[^\s"'<>)]*)/g, (match, path: string) => {
      const host = match.slice(0, match.length - path.length);
      return `${host}${scrubPath(path)}`;
    })
    .replace(TELEGRAM_TOKEN_IN_TEXT, "[token]")
    .replace(EMAIL_IN_TEXT, "[email]")
    .replace(HR_ID_IN_TEXT, ":id");
}

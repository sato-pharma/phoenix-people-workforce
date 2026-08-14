/**
 * What was actually thrown, in words — the ONE implementation.
 *
 * NOT every throw is an Error. Supabase hands back a plain `{ message, details, hint, code }` and
 * this codebase rethrows it as-is, so `String(error)` yields the useless "[object Object]".
 * Production has 19 rows proving it: 12 on /api/admin/outstation/expenses (2026-08-12) and 7 on
 * /api/auth/heartbeat (2026-07-17..07-28). Every one of them recorded a shrug instead of an error.
 *
 * The expenses route grew a private copy of this on 2026-08-12 (#2062) and stopped writing those
 * rows. `instrumentation.ts` — the app-wide `onRequestError` catch-all that covers EVERY route
 * handler and server component — kept the `String(error)` version, which is where the heartbeat
 * rows came from and where the next batch would have come from. One route was fixed; the net under
 * all of them was not. Hence one shared function rather than a second private copy.
 *
 * ZERO IMPORTS, DELIBERATELY. `instrumentation.ts` is bundled for the Edge Runtime as well as Node
 * (see its own header), so anything reachable from here must be edge-safe. A pure function with no
 * imports cannot break that build. Do not add an import to this file.
 */

/**
 * Own properties are enumerated so a PostgrestError's `code`, `details` and `hint` survive —
 * those three are usually the entire diagnosis, and the 42501 that took
 * /api/admin/outstation/expenses down for three and a half hours carried its own fix in `hint`.
 *
 * `JSON.stringify` is guarded because a cyclic throw must not replace one unreadable log line
 * with a second failure, and the result is guaranteed non-empty because an empty message is
 * dropped downstream — `/api/errors/client` skips a falsy message entirely and `logAppError`
 * rewrites it to "Unknown error". Either way the row stops being evidence, which is the same
 * failure this function exists to end.
 */
export function describeThrown(error: unknown): string {
  if (error instanceof Error) {
    // `.message` IS the real message and is never "[object Object]". An Error with an empty
    // message still has to say something, or the row is dropped before it is written.
    return nonEmpty(error.message, error.name, "Error");
  }

  if (typeof error === "object" && error !== null) {
    const names = Object.getOwnPropertyNames(error);
    try {
      return nonEmpty(JSON.stringify(error, names), "Unserializable object throw");
    } catch {
      const joined = names
        .map((key) => `${key}=${String((error as Record<string, unknown>)[key])}`)
        .join(" ");
      return nonEmpty(joined, "Unserializable object throw");
    }
  }

  return nonEmpty(String(error), "Unknown throw");
}

/** First candidate that is a non-blank string. The last one must be a literal, so this always returns. */
function nonEmpty(...candidates: Array<string | undefined>): string {
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim() !== "") return candidate;
  }
  return "Unknown error";
}

/**
 * "Is this error the database telling us a specific COLUMN is not there?"
 *
 * 🔴 THE POINT IS WHAT IT REFUSES TO MATCH. The compensation read and write paths used to ask
 * `message.includes("payment_mode")`, which is true of every error that so much as NAMES the
 * column — a check-constraint violation, a bad enum value, a permission denial, a NOT NULL breach.
 * Each of those then took the "the column is missing" branch: the read silently returned rows with
 * no payment mode, the import silently wrote everyone's compensation WITHOUT their payment mode,
 * and the employee write silently returned having saved nothing. A real failure on salary data was
 * reported as success, and no log said otherwise.
 *
 * They also asked `message.includes("schema cache")`, which is true of a PostgREST schema-cache
 * message about ANY column of ANY table — so an unrelated missing column triggered the payment_mode
 * fallback.
 *
 * So this asks the database, not the prose:
 *
 *  - `42703`    — PostgreSQL undefined_column, what a SELECT or filter naming an absent column returns.
 *  - `PGRST204` — PostgREST's "Could not find the 'x' column of 'y' in the schema cache", on a write.
 *
 * and, either way, the message must NAME the column we asked about. A missing-column error about a
 * DIFFERENT column is not this one.
 *
 * Only when the error carries no machine code at all does it fall back to wording — and then to the
 * two exact sentences Postgres and PostgREST actually produce, never a bare substring.
 *
 * Both error shapes in this codebase are covered: `employee-directory.ts`'s `supabaseRest` decorates
 * its thrown Error with `pgrst_code`, and supabase-js hands back a PostgrestError carrying `code`
 * (a genuine Error subclass since v2 — see `src/lib/http/api-errors.ts`).
 */

/** Codes that mean "that column is not there", and nothing else. */
const MISSING_COLUMN_CODES = new Set(["42703", "PGRST204"]);

function codeOf(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const bag = error as { code?: unknown; pgrst_code?: unknown };
  const raw = bag.pgrst_code ?? bag.code;
  return typeof raw === "string" ? raw.trim().toUpperCase() : "";
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return String(error);
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The column must appear as a whole identifier. `includes()` would let `payment_mode` match
 * `payment_mode_id`, and `medical_insurance` match `medical_insurance_number` — the same
 * substring trap one column wider.
 */
function namesColumn(message: string, column: string): boolean {
  return new RegExp(`(^|[^a-z0-9_])${escapeForRegExp(column)}([^a-z0-9_]|$)`).test(message);
}

export function isMissingColumnError(error: unknown, column: string): boolean {
  const wanted = column.trim().toLowerCase();
  if (!wanted) return false;

  const message = messageOf(error).toLowerCase();
  if (!namesColumn(message, wanted)) return false;

  const code = codeOf(error);
  // A code is the database's own answer, so it decides on its own — including when it says NO.
  if (code) return MISSING_COLUMN_CODES.has(code);

  // No code: the exact wordings only.
  return (
    message.includes(`could not find the '${wanted}' column`) ||
    new RegExp(`column\\s+"?(?:[a-z0-9_]+\\.)?${escapeForRegExp(wanted)}"?\\s+does not exist`).test(message)
  );
}

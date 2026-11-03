// What a Supabase error means. A leaf module, so a reader on the shell's path or the process-health
// tick can ask without loading a whole domain's reads.

/**
 * True when an error means "this database has no such FUNCTION": the migration has not reached it yet
 * (a fresh clone, staging before it lands, a rollback). PostgREST answers PGRST202, Postgres 42883.
 */
export function isMissingRpcError(error: unknown): boolean {
  if (!error) return false;
  const shape = error as { code?: string | null; message?: string | null };
  const code = String(shape.code ?? "");
  if (code === "PGRST202" || code === "42883") return true;
  const message = String(shape.message ?? (error instanceof Error ? error.message : ""));
  return /could not find the function|function .*does not exist/i.test(message);
}

/** True when the client gave up on a request: its fetch throws "Supabase request timed out." (server.ts). */
export function isSupabaseTimeout(error: unknown): boolean {
  return (error instanceof Error ? error.message : String(error)).toLowerCase().includes("timed out");
}

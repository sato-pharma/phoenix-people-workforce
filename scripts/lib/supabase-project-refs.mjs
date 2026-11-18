// The two Supabase projects this app runs on, and the one check every script that writes to a
// database should make before it does: WHICH project is this URL for?
//
// Why it exists (Supabase audit, 18 Nov 2026): every `.env.local` on this laptop points at
// PRODUCTION, and several scripts take their URL from it with nothing asking which project it
// names. The fixture smoke runners create employees, payroll batches and sales batches; the SQL
// apply step printed `current_database()`, which answers "postgres" on BOTH projects. A ref read
// out of the URL itself is the only thing that tells the two apart before the first write.
//
// The refs are not secrets — they are in every Supabase URL — and AGENTS.md §3 lists them. They are
// taken from repo-doctor-supabase-link.mjs, whose two literals tests/supabase-project-refs.test.ts
// holds against that table, so this module can never keep a ref the doc has retired.

import { PRODUCTION_REF, STAGING_REF } from "../repo-doctor-supabase-link.mjs";

/** Production — Phoenix HR, real payroll data. */
export const PRODUCTION_PROJECT_REF = PRODUCTION_REF;
/** Staging — Phoenix-HR-Staging, a clone with real accounts; never demo-safe. */
export const STAGING_PROJECT_REF = STAGING_REF;

/**
 * The project ref a Supabase URL names, or null when it names none.
 *
 * Reads all three shapes this repo uses:
 *   https://<ref>.supabase.co                         (the API URL)
 *   postgres://postgres:…@db.<ref>.supabase.co:5432/… (the direct database URL)
 *   postgres://postgres.<ref>:…@aws-N-….pooler.supabase.com:5432/… (the pooler URL)
 *
 * @param {string | null | undefined} url
 * @returns {string | null}
 */
export function projectRefFromUrl(url) {
  const text = String(url ?? "").trim();
  if (!text) return null;
  const pooler = /^[a-z][a-z0-9+.-]*:\/\/postgres\.([a-z0-9]{20})(?::[^@]*)?@[^/]*pooler\.supabase\.com/i.exec(text);
  if (pooler) return pooler[1].toLowerCase();
  const direct = /@db\.([a-z0-9]{20})\.supabase\.co(?::\d+)?(?:\/|$)/i.exec(text);
  if (direct) return direct[1].toLowerCase();
  const api = /^https?:\/\/([a-z0-9]{20})\.supabase\.co(?:\/|$)/i.exec(text);
  if (api) return api[1].toLowerCase();
  return null;
}

/**
 * Stop a script that may only ever write to STAGING unless its Supabase URL names staging.
 *
 * Reads `NEXT_PUBLIC_SUPABASE_URL`, then `SUPABASE_URL` — the two names `getSupabaseAdmin()` reads.
 * A URL that names production, names nothing, or is missing all refuse, before any client exists.
 *
 * @param {string} scriptName - shown in the refusal, so the reader knows which run stopped
 * @param {Record<string, string | undefined>} [env]
 * @returns {string} the staging ref, once proven
 */
export function requireStagingSupabase(scriptName, env = process.env) {
  const url = env.NEXT_PUBLIC_SUPABASE_URL || env.SUPABASE_URL || "";
  const ref = projectRefFromUrl(url);
  if (ref === STAGING_PROJECT_REF) return ref;
  const named =
    ref === PRODUCTION_PROJECT_REF ? "PRODUCTION (Phoenix HR, real payroll data)" : ref ? `project ${ref}` : "no Supabase project";
  throw new Error(
    `${scriptName} writes disposable fixtures and runs on STAGING only, but its Supabase URL names ${named}. ` +
      "Nothing was written. Every .env.local on this machine points at production, so set " +
      `NEXT_PUBLIC_SUPABASE_URL=https://${STAGING_PROJECT_REF}.supabase.co and the staging service-role key ` +
      "in the environment for this one run.",
  );
}

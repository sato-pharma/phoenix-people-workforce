/**
 * Which test account mirrors which employee — the server-side half of `test-persona.ts`.
 *
 * `test-persona.ts` stays pure so every guard can import it anywhere; this file is the one that
 * touches the database, and it exists for a single job: when something happens inside Phoenix CRM's
 * test world, work out which `TEST-` login should be told, WITHOUT telling the real person.
 *
 * 🔴 THE MAPPING IS THE SAFETY BOUNDARY, NOT A CONVENIENCE. A test-world notice is addressed to the
 * employee it mirrors, because that is the id the notification bell queries by. What keeps it off
 * her bell is the marker travelling with it, and what decides the marker is this lookup. An HR id
 * with no active test account mirroring it therefore gets NO notice at all — never a fallback to
 * the real person, which is the one outcome test accounts exist to prevent.
 *
 * HR ids go through `src/lib/hr-id.ts` and nothing else. A hand-rolled `trim().toUpperCase()` here
 * would be a second copy of the id rule that does not fold the legacy `aaa`→`aa` alias, so a person
 * stored one way would silently fail to match a recipient named the other — and a failed match in
 * THIS function means a notice is dropped, which looks exactly like a quiet morning.
 */

import { getSupabaseAdmin } from "@/lib/supabase/server";
import { normalizeTestAccountLoginId } from "@/lib/auth/test-persona";
import { canonicalHrIdForDisplay, hrIdLookupKeys } from "@/lib/hr-id";

export type TestAccountMirror = {
  /** The employee this test account stands in for — the id the notice is addressed to. */
  hrId: string;
  /** The test account's own login, e.g. `TEST-AYA`. Upper-cased. */
  loginId: string;
};

/**
 * Every ACTIVE test account mirroring one of these employees.
 *
 * More than one test account may mirror the same person; each is returned, so each is told. An
 * inactive one is skipped — it cannot sign in, so a notice for it would sit unread for ever.
 */
export async function testAccountsMirroring(hrIds: ReadonlyArray<string | null | undefined>): Promise<TestAccountMirror[]> {
  const wanted = new Map<string, string>();
  for (const raw of hrIds) {
    const canonical = canonicalHrIdForDisplay(raw);
    if (canonical) wanted.set(canonical, canonical);
  }
  if (wanted.size === 0) return [];

  // Every spelling the column may hold, not just the canonical one: the query is an exact `in`, so
  // a row stored in another case would simply not come back and the notice would vanish.
  const lookupKeys = [...new Set([...wanted.keys()].flatMap((hrId) => hrIdLookupKeys(hrId)))];

  const { data, error } = await getSupabaseAdmin()
    .from("app_auth_users")
    .select("login_id, test_persona_of_hr_id")
    .eq("is_test_persona", true)
    .eq("is_active", true)
    .in("test_persona_of_hr_id", lookupKeys);
  if (error) throw error;

  const mirrors: TestAccountMirror[] = [];
  for (const row of (data ?? []) as Array<{ login_id?: unknown; test_persona_of_hr_id?: unknown }>) {
    const loginId = normalizeTestAccountLoginId(row.login_id);
    const hrId = canonicalHrIdForDisplay(typeof row.test_persona_of_hr_id === "string" ? row.test_persona_of_hr_id : null);
    // A row failing either check is not a usable test account, and guessing at one would be exactly
    // the fallback this module refuses to make.
    if (!loginId || !hrId) continue;
    mirrors.push({ hrId, loginId });
  }
  return mirrors.sort((left, right) => left.loginId.localeCompare(right.loginId));
}

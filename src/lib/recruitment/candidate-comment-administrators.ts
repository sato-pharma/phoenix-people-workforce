// Recruitment / ATS — who is told in the app about a comment on a CV, beyond the conversation.
//
// The owner, 2026-09-19, on a comment notice that had reached him only as a Telegram copy of an
// email: "I want the comments to come in in-app notifications." The thread's own notice goes to the
// manager the CV was pushed to and the people already in the conversation, so the Super Admin, who
// is in none of them, saw nothing in the app. Asked who else should get the in-app copy, his answer
// was the Super Admin — not HR Advisory.
//
// Pure on purpose: it imports the HR id helper and nothing else, so a test can hold the rule without
// a database. The read that feeds it is in candidate-comments.ts.

import { canonicalHrIdForDisplay } from "@/lib/hr-id";

/**
 * The HR ids of the accounts a comment is copied to, from `app_auth_users` rows, in display form and
 * deduplicated.
 *
 * A row with no HR id is dropped — `admin-HR`, the canary Super Admin account, has none by design and
 * cannot be notified. `is_active !== false` rather than `=== true`: a row that does not carry the
 * column is still an account, and only an explicit `false` is a deactivated one.
 */
export function activeAdministratorHrIds(rows: ReadonlyArray<{ hr_id?: unknown; is_active?: unknown }>): string[] {
  return Array.from(
    new Set(
      rows
        .filter((row) => row.is_active !== false)
        .map((row) => canonicalHrIdForDisplay(String(row.hr_id ?? "")))
        .filter((hrId): hrId is string => hrId !== null),
    ),
  );
}

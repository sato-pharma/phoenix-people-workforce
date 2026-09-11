import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * THE MONTHLY CLOSING'S FIXED Cc MOVED OUT OF CODE AND INTO A DISTRIBUTION LIST.
 *
 * Publishing a closing mails every sales and product manager, and a sent mail cannot be recalled —
 * so the whole point of this change is that it must be IMPOSSIBLE to tell from the outside. What
 * moved is WHERE the three Cc roles are stored. Who holds them is still resolved live by the same
 * app_auth_users query, and every downstream step — employee lookup, active check, the shared sales
 * exclusion filter, the To/Cc/Bcc split — is untouched.
 *
 * 🔴 THE THREE FAILURES THIS PINS ARE ALL SILENT, AND TWO OF THEM SEND MAIL.
 *
 * DRIFT BETWEEN THE TWO COPIES. The hardcoded array is now the FALLBACK used when the list is
 * unreadable or switched off. A fallback that has drifted from the seed is a second opinion nobody
 * knows exists: the closing would Cc one set of roles normally and a different set during an
 * outage, and only the outage would reveal it. The two are compared literally, here, so they cannot
 * part company.
 *
 * A LOST EXCLUSION. The owner asked that one person not be mailed sales announcements. That filter
 * is applied to every bucket including the fixed-Cc one; routing the roles through a new resolver
 * is exactly the kind of edit that quietly steps around it.
 *
 * THE PER-LINE HALF FOLLOWING IT OUT. A stored list cannot express "the District Managers on THIS
 * line". If the seat/NSM/PM resolution ever moves to a list too, every line's closing goes to every
 * line's managers — a cross-line leak that no error would report.
 */

const CLOSING_SOURCE = readFileSync(
  fileURLToPath(new URL("../src/lib/sales/closing-publish-recipients.ts", import.meta.url)),
  "utf8",
);

const MIGRATION_SOURCE = readFileSync(
  fileURLToPath(new URL("../supabase/migrations/20260911140000_closing_fixed_cc_list.sql", import.meta.url)),
  "utf8",
);

/** Source with comments stripped, so a rule quoted in prose cannot satisfy a check. */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

/** The role names inside a bracketed list, however they are quoted. */
function rolesIn(fragment: string): string[] {
  return [...fragment.matchAll(/['"]([^'"]+)['"]/g)].map((match) => match[1]).sort();
}

export function runClosingFixedCcListTests() {
  const closingCode = code(CLOSING_SOURCE);

  // ── The fallback array and the seeded list must name the SAME roles ──────────────────────────
  const fallbackMatch = closingCode.match(/const\s+FIXED_CC_ROLES\s*:?[^=]*=\s*\[([^\]]*)\]/);
  assert.ok(fallbackMatch, "FIXED_CC_ROLES must still exist as the fallback — without it an unreadable list silences the Cc");
  const fallbackRoles = rolesIn(fallbackMatch[1]);

  const seedMatch = MIGRATION_SOURCE.match(/array\[([^\]]*)\]::text\[\]/);
  assert.ok(seedMatch, "the migration must seed the list with a roles array");
  const seededRoles = rolesIn(seedMatch[1]);

  assert.deepEqual(
    fallbackRoles,
    seededRoles,
    "the hardcoded fallback and the seeded list must name the SAME roles — if they drift, the closing Cc's one set normally and another during an outage, and only the outage reveals it",
  );
  assert.deepEqual(
    seededRoles,
    ["CEO", "Marketing Manager", "SFE Manager"],
    "the seed must be byte-identical to the roles Cc'd before this change — this migration moves WHERE the answer lives, never what it is",
  );

  // ── Seeded ENABLED, or the list is not actually in charge ────────────────────────────────────
  assert.match(
    MIGRATION_SOURCE,
    /\]::text\[\]\s*,\s*true\s*\)/,
    "the list must be seeded ENABLED — a disabled row silently falls back to the hardcoded default while the screen shows a list that is not in charge",
  );

  // ── The closing reads the list, and passes the fallback ──────────────────────────────────────
  assert.match(
    closingCode,
    /resolveDistributionListRoles\(\s*CLOSING_FIXED_CC_LIST_KEY\s*,\s*FIXED_CC_ROLES\s*\)/,
    "the closing must read the list AND hand it the fallback — calling it without one turns an unreadable table into a silently missing Cc",
  );
  assert.match(
    closingCode,
    /CLOSING_FIXED_CC_LIST_KEY\s*=\s*["']closing_fixed_cc["']/,
    "the key the closing reads must be the key the migration seeds",
  );
  assert.match(
    MIGRATION_SOURCE,
    /'closing_fixed_cc'/,
    "the migration must seed exactly that key",
  );

  // ── The warnings reach the caller ────────────────────────────────────────────────────────────
  // A fallback that never says it fired is indistinguishable from the list working.
  assert.match(
    closingCode,
    /warnings\.push\(\s*\.\.\.\s*\w+\.warnings\s*\)/,
    "the list's warnings must be merged into the send's own — a silent fallback reads exactly like a working list",
  );

  // ── The shared sales exclusion still applies ─────────────────────────────────────────────────
  assert.match(
    closingCode,
    /isSalesNotificationExcluded\(/,
    "the closing must still filter through the shared sales exclusion helper",
  );

  // ── 🔴 The PER-LINE half must NOT follow the fixed roles out of the organogram ────────────────
  // These three are resolved per published line. Routing any of them through a stored list sends
  // every line's closing to every line's managers.
  for (const perLine of ["au_v_org_tree", "LINE_PRODUCT_MANAGER_ROLES", "DM_SEAT_TIERS"]) {
    assert.ok(
      closingCode.includes(perLine),
      `${perLine} must still drive the per-line recipients — a stored list cannot express "the DMs on THIS line", so replacing it leaks each line's closing to the others`,
    );
  }
  assert.equal(
    closingCode.split("resolveDistributionListRoles(").length - 1,
    1,
    "exactly ONE distribution list is read here — a second call is the per-line half being moved out, which is the cross-line leak",
  );

  // ── The named individuals stay named, not listed ─────────────────────────────────────────────
  // They are not tied to a role, so no list could ever resolve them.
  for (const named of ["NAMED_CC_HR_IDS", "NAMED_BCC_HR_IDS"]) {
    assert.ok(closingCode.includes(named), `${named} must stay in code — a role-based list can never resolve a person named individually`);
  }
}

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * THE COMPOSER'S HR AND FINANCE GROUPS MOVED ONTO DISTRIBUTION LISTS. "MANAGERS" DID NOT.
 *
 * The three groups were resolved by matching a SUBSTRING of the department and job-title text —
 * roleText(employee).includes("hr") — which is invisible, unauditable, and puts somebody in a
 * mailing group according to how their title happens to be typed.
 *
 * 🔴 THE THREE THINGS THIS PINS ARE EACH A SILENT AUDIENCE CHANGE.
 *
 * "MANAGERS" FOLLOWING THE OTHER TWO. Half its rule is "is somebody's manager" — a RELATIONSHIP.
 * A distribution list holds attributes (roles, lines, areas, departments, positions, regions) and
 * has no dimension for direct reports, so moving it can only drop that half. Measured against
 * production, 2 people are in the group ONLY because they have reports and 4 ONLY because of their
 * title: any migration of this group silently changes it. Owner decision 2026-09-11: leave it.
 *
 * THE FALLBACK BEING DELETED. groupEmployees is no longer the live rule for two of the groups, so
 * it reads like dead code. It is not: it is what runs when a list is switched off or unreadable,
 * and it is still the ONLY rule for managers. Deleting it turns an outage into an empty audience.
 *
 * THE PRESERVED MEMBERS BEING DROPPED. Switching hr_team and finance_team to roles would have
 * dropped exactly two people the substring rule includes — B-10 (title "HR Section Head", app role
 * Super Admin) and OF-0002 (title "Financial Advisor", app role Employee). The migration adds them
 * by name so the first send matches the last. Losing that line silently shrinks both groups.
 */

const COMPOSER_SOURCE = readFileSync(
  fileURLToPath(new URL("../src/lib/email/email-composer-service.ts", import.meta.url)),
  "utf8",
);

const MIGRATION_SOURCE = readFileSync(
  fileURLToPath(new URL("../supabase/migrations/20260911160000_composer_groups_preserve_membership.sql", import.meta.url)),
  "utf8",
);

/** Source with comments stripped, so a rule described in prose cannot satisfy a check. */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

export function runComposerGroupListsTests() {
  const composer = code(COMPOSER_SOURCE);

  // ── The two groups that moved read a list ────────────────────────────────────────────────────
  const mapMatch = composer.match(/GROUP_DISTRIBUTION_LISTS[^=]*=\s*\{([^}]*)\}/);
  assert.ok(mapMatch, "the composer must declare which group maps to which distribution list");
  const mapped = mapMatch[1];

  assert.match(mapped, /hr_team\s*:/, "hr_team must be answered by a list");
  assert.match(mapped, /finance_team\s*:/, "finance_team must be answered by a list");

  // ── 🔴 "managers" must NOT be ─────────────────────────────────────────────────────────────────
  assert.ok(
    !/\bmanagers\s*:/.test(mapped),
    'managers must NOT be mapped to a distribution list — half its rule is "is somebody\'s manager", a relationship no list dimension expresses, so mapping it can only drop that half and silently change the group',
  );

  // ── The substring rule survives as the fallback, and as the live rule for managers ───────────
  assert.match(
    composer,
    /function\s+groupEmployees\s*\(/,
    "groupEmployees must stay — it is the fallback when a list is off or unreadable, and still the ONLY rule for managers",
  );
  assert.match(
    composer,
    /:\s*groupEmployees\(\s*selection\.key\s*,\s*employees\s*\)/,
    "the fallback must actually be reachable from selection resolution, not merely defined",
  );

  // ── A failed or switched-off list falls back and SAYS SO ─────────────────────────────────────
  // Failing closed here would silently shrink a manually composed audience, and the sender could
  // not tell an empty group from a broken one.
  assert.match(
    composer,
    /refusedReason/,
    "the composer must notice a refused list rather than treating an empty result as a real audience",
  );
  assert.match(
    composer,
    /warnings\.push\(`\$\{key\}:/,
    "a fallback must be reported to the composer preview — an unannounced one reads exactly like the list working",
  );
  assert.match(
    composer,
    /const\s+warnings:\s*string\[\]\s*=\s*\[\s*\.\.\.\s*groupWarnings\s*\]/,
    "the group warnings must reach the returned warnings, or the preview never shows them",
  );

  // ── The migration preserves the two people the role rule would drop ──────────────────────────
  for (const [hrId, why] of [
    ["B-10", 'title "HR Section Head" but app role Super Admin'],
    ["OF-0002", 'title "Financial Advisor" but app role Employee'],
  ] as const) {
    assert.ok(
      MIGRATION_SOURCE.includes(`'${hrId}'`),
      `${hrId} must be preserved as a named member (${why}) — the role rule alone drops them and the group silently shrinks`,
    );
  }

  // ── The migration must not revert a decision already made on the screen ──────────────────────
  assert.equal(
    MIGRATION_SOURCE.match(/and\s+enabled\s*=\s*false/g)?.length,
    2,
    "both updates must be guarded on the untouched seeded state — an unguarded re-run would revert whatever was chosen at /admin/distribution-lists",
  );
  assert.match(
    MIGRATION_SOURCE,
    /enabled\s*=\s*true/,
    "the lists must be switched on, or the composer keeps falling back and nothing actually moved",
  );
}

// Which organization entities an employee import may WRITE, and which it must leave alone.
//
// The employee import is allowed to CREATE an organization row it has never seen (a new team, a new
// position). It is never allowed to rewrite one that already exists — those rows are curated by hand
// in the organogram admin, and a spreadsheet is not the authority on them.
//
// Departments, lines and positions get that guarantee upstream: collectOrganizationEntities() in
// employee-validator.ts drops any code already present in the loaded existing-state, so their
// upserts only ever receive codes that do not exist yet and their onConflict update branch is
// unreachable. (Read one of those upserts on its own and it looks like it overwrites curated data.
// It cannot — the caller already removed everything it could have overwritten.)
//
// Teams do NOT get it upstream, and that gap is what this helper closes. loadTeamState() omits
// is_active=false rows when it builds the "already exists" set, deliberately: a deactivated team
// must not win a name resolution and pull employees back onto a retired seat. Correct for resolving
// — but it also meant the importer treated a deactivated team as ABSENT, while a lookup by code
// still found the row. The write path then UPDATEd it and set is_active: true, so a single mention
// in a single spreadsheet silently resurrected a team somebody had deactivated on purpose, and
// overwrote its curated name and area on the way.
//
// Measured against production on 2026-08-28: exactly 2 of 120 teams sat in that gap, and both were
// deactivated — reactivating them was the update branch's only reachable effect. Reactivating a team
// is a deliberate act. It belongs in the organogram admin, never as a side effect of an upload.

export type OrgEntityWriteSplit<T> = {
  /** Entities with no row yet. Safe to INSERT. */
  toInsert: T[];
  /** Entities that already have a row. Left exactly as they are — including deactivated ones. */
  preserved: T[];
};

/**
 * Splits import entities into the ones to insert and the ones to leave untouched.
 *
 * `codeAlreadyExists` must answer for the ROW, not for the resolvable set — pass a lookup that sees
 * deactivated rows too. Answering "no" for a row that exists is precisely the bug this guards: it
 * sends an existing row down the write path.
 */
export function splitInsertOnly<T extends { code: string }>(
  entities: readonly T[],
  codeAlreadyExists: (code: string) => boolean,
): OrgEntityWriteSplit<T> {
  const toInsert: T[] = [];
  const preserved: T[] = [];

  for (const entity of entities) {
    if (codeAlreadyExists(entity.code)) {
      preserved.push(entity);
      continue;
    }

    toInsert.push(entity);
  }

  return { preserved, toInsert };
}

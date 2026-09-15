// ─────────────────────────────────────────────────────────────────────────────────────────────
// Which Manager HR_ID links an employee import may write.
//
// The confirm step links each row to its manager with a separate UPDATE after the employees are
// upserted, and skips a link whose manager has no employee row — employees.manager_hr_id is a
// foreign key, so writing one would fail the import. It used to decide "has an employee row" by
// looking up only the HR_IDs that are ROWS IN THE FILE, so a manager who was not also a row counted
// as missing and the link was skipped without a word. A full master upload hides that, because every
// manager is a row in it; a partial upload (a batch of new hires, one region's sheet) left every one
// of its manager links unwritten.
//
// Pure: the database lookup stays in the route, which asks about every HR_ID listed here.
// ─────────────────────────────────────────────────────────────────────────────────────────────

type ManagerLinkSource = {
  hrId: string | null;
  managerHrId: string | null;
};

/** Every HR_ID the manager-link existence lookup must cover: each row's own, and the manager it names. */
export function hrIdsForManagerLinks(records: readonly ManagerLinkSource[]): string[] {
  const hrIds = new Set<string>();

  for (const record of records) {
    if (record.hrId) hrIds.add(record.hrId);
    if (record.managerHrId) hrIds.add(record.managerHrId);
  }

  return Array.from(hrIds);
}

/** The links to write, in file order: each row naming a manager whose employee row exists. */
export function managerLinksToWrite(
  records: readonly ManagerLinkSource[],
  existingHrIds: ReadonlySet<string>,
): Array<{ hrId: string; managerHrId: string }> {
  return records.flatMap((record) =>
    record.hrId && record.managerHrId && existingHrIds.has(record.managerHrId)
      ? [{ hrId: record.hrId, managerHrId: record.managerHrId }]
      : [],
  );
}

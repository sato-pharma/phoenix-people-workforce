import { tidyAllCapitalsName } from "@/lib/employees/display-name";
import { namesByHrId, type EmployeeNameLookupClient } from "@/lib/employees/names-by-hr-id";

/**
 * HR id → the name a manager's board prints, for EVERY person on it — including people who have left.
 *
 * WHY. The sales services return the name the Source of Sales file spelled, in capitals
 * ("YEHYA MOHAMED KAMAL ELDEEN SAAD MOHAMED"). The boards used to swap it for the directory's
 * nickname-aware name, but the directory holds ACTIVE staff only, so a manager who had resigned kept
 * the raw capitals: the National Sales Manager's Top Reps board printed a departed district manager
 * that way beside every active one in proper case (audit, 2026-10-26).
 *
 * Order: the directory row (active staff) → the `employees` row by HR id, whatever its status
 * (`namesByHrId`, one chunked read for only the ids the directory did not answer) → the caller's own
 * fallback. Whatever wins goes through `tidyAllCapitalsName`, so a name stored in capitals still
 * reads in proper case. A failed read costs the departed names and nothing else.
 */
export type DirectoryNameRow = { hrId: string; displayName: string };

export type PersonNameLookup = (hrId: string | null | undefined, fallback: string) => string;

/** Hyphen- and case-insensitive: canonical "B100" and stored "B-100" are one key. */
function nameKey(value?: string | null) {
  return (value ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export async function personNameLookup(
  directoryRows: readonly DirectoryNameRow[],
  wantedHrIds: Iterable<string | null | undefined>,
  client?: EmployeeNameLookupClient,
): Promise<PersonNameLookup> {
  const byKey = new Map<string, string>();
  for (const row of directoryRows) {
    const key = nameKey(row.hrId);
    if (key && row.displayName) byKey.set(key, row.displayName);
  }

  const missing = [...new Set([...wantedHrIds].filter((hrId): hrId is string => Boolean(hrId && nameKey(hrId))))].filter(
    (hrId) => !byKey.has(nameKey(hrId)),
  );
  // A sales file can spell "B23" for the stored "B-23"; ask the hyphenated spelling too, and key the answer
  // the directory's way so any spelling finds it.
  const asked = missing.flatMap((hrId) => {
    const parts = /^([A-Za-z]+)-?(\d+)$/.exec(hrId.trim());
    return parts ? [hrId, `${parts[1]}-${parts[2]}`] : [hrId];
  });
  const departed = asked.length > 0 ? await namesByHrId(asked, client).catch(() => null) : null;
  if (departed) {
    for (const hrId of asked) {
      const name = departed.get(hrId);
      const key = nameKey(hrId);
      if (name && key && !byKey.has(key)) byKey.set(key, name);
    }
  }

  return (hrId, fallback) => {
    const key = nameKey(hrId);
    return tidyAllCapitalsName((key ? byKey.get(key) : undefined) ?? fallback);
  };
}

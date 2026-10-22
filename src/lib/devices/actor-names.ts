/**
 * Who did something to a company device, as a person's name — never the HR id it was stored under.
 *
 * WHY THIS EXISTS. The tablet console's history and the enrollment card's "saved by" both printed the
 * raw actor column, so a screen read "· B-10" where it owed a name (AGENTS.md §4: names, never codes).
 * The device routes write that column as `hrIdForStorage(access.hrId) ?? identity id ?? loginId ??
 * role`, so it is an HR id in every case a person pressed something; the shared `namesByHrId` turns it
 * into the name the company uses on every other screen.
 *
 * 🔴 AN ACTOR WITH NO NAME ON FILE IS "a colleague", NEVER THE ID. A role string or a login with no
 * employee row is still somebody who did it; printing the code would be the very fault this fixes, and
 * printing nothing would read as "nobody did it". A failed lookup costs the names and nothing else —
 * it never takes the history down with it.
 */

import { namesByHrId, type EmployeeNameLookupClient } from "@/lib/employees/names-by-hr-id";

/** What an actor reads as when no employee name can be found for them. */
export const UNNAMED_DEVICE_ACTOR = "a colleague";

export type DeviceActorNamer = (actor: string | null | undefined) => string | null;

export async function deviceActorNames(
  actors: Iterable<string | null | undefined>,
  client?: EmployeeNameLookupClient,
): Promise<DeviceActorNamer> {
  const ids = [...new Set([...actors].map((actor) => actor?.trim() ?? "").filter((actor) => actor.length > 0))];
  if (ids.length === 0) return () => null;
  const names = await namesByHrId(ids, client).catch(() => null);
  return (actor) => {
    const id = actor?.trim();
    if (!id) return null;
    if (id.startsWith("system:")) return "Phoenix itself";
    return names?.get(id) ?? UNNAMED_DEVICE_ACTOR;
  };
}

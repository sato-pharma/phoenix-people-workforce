import type { EmployeeNameLookupClient } from "@/lib/employees/names-by-hr-id";
import { personNameLookup } from "@/lib/employees/person-name-lookup";

import type { ReviewPersonRow } from "./sources/roles";

/**
 * The name a rep's own Business Review — his portal page and the pack he exports — is headed with.
 *
 * 🔴 THE SESSION CARRIES NO NAME, so the scope's `viewerName` falls back to the HR id
 * (`portal-scope.ts`), and a rep with no row among the review's people printed that id on the cover
 * of her pack: "ai-0029 · Pedia Line" (2026-10-29). The review's people rows answer first, as before;
 * a rep they do not hold is asked of `employees` by HR id (`personNameLookup`, any status, every
 * spelling); only then the caller's fallback. A failed read costs the name, never the page.
 */
export async function reviewRepName(
  input: { hrId: string; people: readonly Pick<ReviewPersonRow, "hrId" | "name">[]; fallback: string },
  client?: EmployeeNameLookupClient,
): Promise<string> {
  const lookup = await personNameLookup(
    input.people.map((person) => ({ hrId: person.hrId, displayName: person.name })),
    [input.hrId],
    client,
  ).catch(() => null);
  return lookup ? lookup(input.hrId, input.fallback) : input.fallback;
}

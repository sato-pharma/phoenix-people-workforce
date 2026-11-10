import { resolveEmployeeDisplayName } from "@/lib/employees/display-name";
import { canonicalHrIdKey, hrIdLookupKeys } from "@/lib/hr-id";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import type { OfferRecord } from "@/lib/offers/types";

/**
 * The names of the people who drafted, sent, asked approval for and approved the offers on screen
 * (owner, 2026-11-10: "add a column to show the job offer was sent by whom"). Names, never HR codes.
 *
 * Keyed by `canonicalHrIdKey` (lower case), which is what the screen asks with, because the stored ids
 * are mixed case: an actor written before 2026-09-02 is lower case, one written since is upper.
 * A read that fails answers an empty map: the column then says it does not know, and the Offers screen
 * still loads — a name is display only and nothing is decided from it.
 */
export async function loadOfferPeopleNames(
  offers: readonly OfferRecord[],
  extra: ReadonlyArray<string | null | undefined> = [],
): Promise<Record<string, string>> {
  const wanted = new Set<string>();
  const add = (value: string | null | undefined) => {
    const key = canonicalHrIdKey(value);
    if (key) wanted.add(key);
  };
  for (const offer of offers) {
    add(offer.createdBy);
    add(offer.sentBy);
    add(offer.approval?.requestedBy);
    add(offer.approval?.approvedBy);
    add(offer.approval?.returnedBy);
    add(offer.revisedBy);
  }
  extra.forEach(add);

  const names: Record<string, string> = {};
  if (wanted.size === 0) return names;
  const lookup = [...new Set([...wanted].flatMap((key) => hrIdLookupKeys(key)))];

  try {
    const { data, error } = await getSupabaseAdmin().from("employees").select("hr_id, full_name, nickname").in("hr_id", lookup);
    if (error) return names;
    for (const row of (data ?? []) as Array<{ full_name?: string | null; hr_id?: string | null; nickname?: string | null }>) {
      const key = canonicalHrIdKey(row.hr_id);
      const fullName = String(row.full_name ?? "").trim();
      if (!key || !wanted.has(key) || names[key] || !fullName) continue;
      names[key] = resolveEmployeeDisplayName(fullName, row.nickname ?? null, row.hr_id ?? null);
    }
  } catch {
    return names;
  }
  return names;
}

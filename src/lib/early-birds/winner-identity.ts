// Who a winner IS today, as opposed to what the row said the day it was written.
//
// THE DEFECT (owner audit of the Early Birds page, 2026-10-26). The Hall of Fame printed "—" in the
// area slot of 90 of 125 winners and showed the same rep under two spellings ("Mostafa Saied" and
// "Mostafa Saied Basiouny Hamd"). Both come from one fact: `early_birds_winners` is a FROZEN copy
// (the announcement is copied, never joined, so a later transfer cannot relabel a past crown), and
// the copy was thin. A fortnight confirmed automatically carried no area and no display name at all,
// and one confirmed by the manager took both from the ACTIVE-only directory, so a rep who had since
// left, or whose spelling the directory held differently, came out blank or differently spelled.
//
// THE RULE. The area the row stored wins when it has one — a frozen record stays frozen. Only an
// EMPTY area falls back to the employee's live area. The NAME is the opposite: a person reads the
// same on every screen, so the winner's name is the employee's current display name whatever the
// row stored on the day, and the row's own spelling is only the last resort.
//
// A lookup that fails costs the fallback and nothing else: the row still shows what it stored.
// Under-reporting beats a read that throws and takes the Hall of Fame down for a column.

import { resolvePersonDisplayName, tidyAllCapitalsName } from "@/lib/employees/display-name";
import { canonicalHrIdKey, hrIdLookupKeys } from "@/lib/hr-id";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { HR_ID_LOOKUP_CHUNK, type EmployeeNameLookupClient } from "@/lib/employees/names-by-hr-id";
import { loadReferenceAreas } from "@/lib/reference/reference-lists";

export type WinnerIdentity = { name: string | null; areaName: string | null };

/** The winner fields this module reads and may complete — structural so the pure half needs no row type. */
export type WinnerIdentityFields = { employeeHrId: string; employeeName: string; areaName: string | null };

export type WinnerIdentityIndex = ReadonlyMap<string, WinnerIdentity>;

/** Where the area names come from — the shared reference list by default; a test injects its own. */
export type WinnerAreaLoader = () => Promise<ReadonlyArray<{ id?: string | number | null; name?: string | null }>>;

type EmployeeRow = {
  hr_id?: string | null;
  full_name?: string | null;
  nickname?: string | null;
  area_id?: string | number | null;
};

function chunked<T>(values: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let start = 0; start < values.length; start += size) out.push(values.slice(start, start + size));
  return out;
}

/**
 * The live name and area of each employee, keyed by canonical hr id.
 *
 * The employees are read by hr id: the lists are chunked at 50 for the reason `namesByHrId` documents
 * (a long `in` returns zero rows and no error), and the `hr_id` spellings are expanded because
 * production stores them mixed-case and PostgREST matches case-sensitively. The area NAMES come from
 * the shared, cached reference list (`loadReferenceAreas`) — the repo allows no second direct read of
 * `areas`. A failed read is skipped — see the header.
 */
export async function loadWinnerIdentities(
  hrIds: Iterable<string | null | undefined>,
  client?: EmployeeNameLookupClient,
  loadAreas: WinnerAreaLoader = loadReferenceAreas,
): Promise<WinnerIdentityIndex> {
  const keys = [...new Set([...hrIds].flatMap((hrId) => hrIdLookupKeys(hrId)))];
  const index = new Map<string, WinnerIdentity>();
  if (keys.length === 0) return index;

  const db = client ?? (getSupabaseAdmin() as unknown as EmployeeNameLookupClient);
  const areaIdByKey = new Map<string, string>();

  for (const chunk of chunked(keys, HR_ID_LOOKUP_CHUNK)) {
    const { data, error } = await db.from("employees").select("hr_id,full_name,nickname,area_id").in("hr_id", chunk);
    if (error || !data) continue;
    for (const row of data as EmployeeRow[]) {
      const key = canonicalHrIdKey(row.hr_id);
      if (!key) continue;
      const fullName = String(row.full_name ?? "").trim();
      index.set(key, {
        name: fullName ? resolvePersonDisplayName(fullName, row.nickname ?? null, row.hr_id ?? null) : null,
        areaName: null,
      });
      if (row.area_id !== null && row.area_id !== undefined && String(row.area_id).trim() !== "") {
        areaIdByKey.set(key, String(row.area_id));
      }
    }
  }

  const areaNameById = new Map<string, string>();
  if (areaIdByKey.size > 0) {
    try {
      for (const row of await loadAreas()) {
        const name = String(row.name ?? "").trim();
        if (row.id !== null && row.id !== undefined && name) areaNameById.set(String(row.id), name);
      }
    } catch {
      // The area names are a fallback; without them the row keeps what it stored.
    }
  }

  for (const [key, areaId] of areaIdByKey) {
    const current = index.get(key);
    if (current) index.set(key, { ...current, areaName: areaNameById.get(areaId) ?? null });
  }
  return index;
}

/**
 * Complete a winner list from the live identities. Pure — this is the half the unit test drives.
 *
 * Generic over the record so the caller keeps every other field untouched.
 */
export function withLiveWinnerIdentity<T extends WinnerIdentityFields>(
  winners: readonly T[],
  identities: WinnerIdentityIndex,
): T[] {
  return winners.map((winner) => {
    const live = identities.get(canonicalHrIdKey(winner.employeeHrId) ?? "");
    const storedArea = winner.areaName?.trim() ? winner.areaName.trim() : null;
    return {
      ...winner,
      employeeName: live?.name ?? tidyAllCapitalsName(winner.employeeName),
      areaName: storedArea ?? live?.areaName ?? null,
    };
  });
}

/** Read the live identities for `winners` and complete them. Never throws; on a failure the rows come back as stored. */
export async function completeWinnerIdentities<T extends WinnerIdentityFields>(
  winners: readonly T[],
  client?: EmployeeNameLookupClient,
  loadAreas?: WinnerAreaLoader,
): Promise<T[]> {
  if (winners.length === 0) return [];
  try {
    const identities = await loadWinnerIdentities(
      winners.map((winner) => winner.employeeHrId),
      client,
      loadAreas,
    );
    return withLiveWinnerIdentity(winners, identities);
  } catch {
    return withLiveWinnerIdentity(winners, new Map());
  }
}

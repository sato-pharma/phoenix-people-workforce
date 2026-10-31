import { getSupabaseAdmin } from "@/lib/supabase/server";
import { normalizeHrId, type AccessContext } from "@/lib/auth/permissions";
import { loadReferenceEmployees } from "@/lib/reference/reference-lists";

/**
 * Area-scoped medical-rep options for the outstation submit wizard.
 *
 * A submitting manager (DM / Regional Manager / NSM / acting-DM) picks one of
 * the AREAS inside their own span of control; the medical rep occupying that
 * area is resolved automatically, so they never type or search a rep by name.
 *
 * Source of truth is the seat model (schema `au`, via the public.au_v_org_tree
 * wrapper) — the same authoritative tree the organogram uses. We find the
 * seat(s) the caller occupies and walk DOWN the tree to every REP seat beneath
 * them, so one implementation covers a DM (one hop to reps), a Regional Manager
 * (RSM -> DM -> rep) and an NSM (NSM -> RSM -> DM -> rep) identically.
 *
 * The wizard falls back to its existing free-text rep picker whenever this
 * returns an empty list (e.g. Product/Marketing managers who are not modelled
 * in the sales seat tree), so a manager is never worse off than before.
 */

export type ManagerAreaRepOption = {
  areaCode: string;
  areaName: string;
  lineName: string | null;
  regionName: string | null;
  /** Occupying rep's HR_ID, or null when the area is currently vacant. */
  repHrId: string | null;
  /** Occupying rep's display name, or null when the area is vacant. */
  repName: string | null;
  isVacant: boolean;
};

type AuTreeRow = {
  seat_id: string;
  parent_seat_id: string | null;
  seat_tier: "CEO" | "NSM" | "RSM" | "DM" | "ACTING_DM" | "REP";
  line_code: string | null;
  region_code: string | null;
  area_code: string | null;
  is_other_pseudo_dm: boolean;
  occupant_hr_id: string | null;
  is_vacant: boolean;
  area_name: string | null;
  region_name: string | null;
  line_name: string | null;
  line_id: number | null;
};

const AU_TREE_COLUMNS =
  "seat_id,parent_seat_id,seat_tier,line_code,region_code,area_code,is_other_pseudo_dm,occupant_hr_id,is_vacant,area_name,region_name,line_name,line_id";

/**
 * Resolve the distinct areas within the caller's span of control, each paired
 * with the medical rep currently occupying it. Best-effort: any failure (no
 * seat for the caller, view/permission error) yields an empty list so the
 * wizard degrades to its legacy rep picker rather than breaking the form.
 */
export async function getManagerAreaRepOptions(
  access: AccessContext,
): Promise<ManagerAreaRepOption[]> {
  const callerHrId = normalizeHrId(access.hrId);
  if (!callerHrId) return [];

  // The rep names start WITH the tree read, not after the walk (2026-10-31, "fix the slowest five
  // pages"): they come from the shared one-minute copy below and never reject, so a caller who turns
  // out to manage nobody has only warmed that copy.
  const empRead = loadReferenceEmployees().catch(() => []);

  const supabase = getSupabaseAdmin();
  const { data: treeData, error } = await supabase
    .from("au_v_org_tree")
    .select(AU_TREE_COLUMNS);
  if (error || !treeData) return [];
  const tree = treeData as AuTreeRow[];

  // Index children by parent so we can walk the subtree without recursion.
  const childrenByParent = new Map<string, AuTreeRow[]>();
  for (const seat of tree) {
    if (!seat.parent_seat_id) continue;
    const bucket = childrenByParent.get(seat.parent_seat_id) ?? [];
    bucket.push(seat);
    childrenByParent.set(seat.parent_seat_id, bucket);
  }

  // Seats the caller occupies as a MANAGER. A plain REP seat manages nobody, so
  // it is excluded; an ACTING_DM seat (a rep who also runs areas) is included.
  const managerSeatIds = tree
    .filter(
      (seat) =>
        seat.seat_tier !== "REP" &&
        seat.occupant_hr_id != null &&
        normalizeHrId(seat.occupant_hr_id) === callerHrId,
    )
    .map((seat) => seat.seat_id);
  if (managerSeatIds.length === 0) return [];

  // Walk down to every REP seat beneath the caller's manager seat(s).
  const repSeats: AuTreeRow[] = [];
  const visited = new Set<string>();
  const stack = [...managerSeatIds];
  while (stack.length > 0) {
    const seatId = stack.pop()!;
    for (const child of childrenByParent.get(seatId) ?? []) {
      if (visited.has(child.seat_id)) continue;
      visited.add(child.seat_id);
      if (child.is_other_pseudo_dm) continue; // the per-line "Others" bucket holds no real people
      if (child.seat_tier === "REP") {
        repSeats.push(child);
      } else {
        stack.push(child.seat_id); // descend through RSM / DM / ACTING_DM layers
      }
    }
  }
  if (repSeats.length === 0) return [];

  // Resolve rep display names from the employee master, through the shared one-minute copy
  // (src/lib/reference/reference-lists.ts) — best-effort as before: a failed read leaves the map
  // empty and each option falls back to the rep's HR id, never breaking the wizard.
  const empData = await empRead;
  const nameByHrId = new Map<string, string>();
  for (const emp of empData) {
    const key = normalizeHrId(emp.hr_id);
    if (key) nameByHrId.set(key, emp.full_name ?? emp.hr_id ?? key);
  }

  // Collapse to one option per area, preferring an occupied seat over a vacant one.
  const byAreaCode = new Map<string, ManagerAreaRepOption>();
  for (const seat of repSeats) {
    if (!seat.area_code) continue;
    const repHrId =
      seat.occupant_hr_id && !seat.is_vacant ? normalizeHrId(seat.occupant_hr_id) : null;
    const option: ManagerAreaRepOption = {
      areaCode: seat.area_code,
      areaName: seat.area_name?.trim() || seat.area_code,
      lineName: seat.line_name,
      regionName: seat.region_name,
      repHrId,
      repName: repHrId ? nameByHrId.get(repHrId) ?? repHrId : null,
      isVacant: repHrId == null,
    };
    const existing = byAreaCode.get(seat.area_code);
    if (!existing || (existing.isVacant && !option.isVacant)) {
      byAreaCode.set(seat.area_code, option);
    }
  }

  return [...byAreaCode.values()].sort((a, b) =>
    a.areaName.localeCompare(b.areaName, undefined, { sensitivity: "base" }),
  );
}

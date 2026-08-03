import { normalizeHrId } from "@/lib/auth/permissions";
import { logError } from "@/lib/observability/log";
import { getSupabaseAdmin } from "@/lib/supabase/server";

// ─────────────────────────────────────────────────────────────────────────────
// (line, area) → the medical rep who covers it, from the seat model.
//
// Sibling of ./region-resolver.ts, which answers (line, area) → region from the same `au_v_*`
// view family and is likewise split into a pure selector plus an async loader. That split is
// what makes the selection rule unit-testable without Supabase, so it is copied deliberately.
//
// Source is `au_v_org_tree` (the public wrapper over au.v_org_tree) — the same authoritative
// tree the organogram and the outstation area-rep picker read. `au_v_line_area_map` is NOT
// usable here: it exposes rep_seat_id but no occupant HR_ID.
//
// The map is keyed by (line, area), never area alone — the same area is covered by different
// reps on CNS vs Pedia vs Anti Infective.
// ─────────────────────────────────────────────────────────────────────────────

export type AreaRepAssignment = {
  /** The normalized line key the match was made on. */
  lineKey: string;
  /** Upper-cased area code. */
  areaCode: string;
  repHrId: string | null;
  /** All occupied rep names joined " / " — never truncated (owner rule). */
  repName: string | null;
  repNames: string[];
  /** A REP seat exists for this (line, area) but nobody occupies it. */
  isVacant: boolean;
};

/** One `au_v_org_tree` row, narrowed to what the selection rule reads. */
export type AreaRepSeatRow = {
  seat_id?: string | null;
  seat_tier?: string | null;
  line_code?: string | null;
  line_name?: string | null;
  area_code?: string | null;
  is_other_pseudo_dm?: boolean | null;
  occupant_hr_id?: string | null;
  is_vacant?: boolean | null;
};

const SEAT_COLUMNS = "seat_id,seat_tier,line_code,line_name,area_code,is_other_pseudo_dm,occupant_hr_id,is_vacant";

/**
 * Collapse every spelling of a line to one key.
 *
 * This is REQUIRED, not defensive. `au.lines` seeds the Anti Infective line as
 * 'Anti infective' (lower-case i) while the application's canonical name is "Anti Infective"
 * (src/lib/admin/access-control.ts) — a case-sensitive comparison silently drops that entire
 * line's reps. Punctuation is stripped too so 'anti_infective' and 'Anti-Infective' collapse
 * to the same key as both of the above.
 */
export function normalizeLineKey(value: string | null | undefined): string {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Lookup key for a (line, area) pair. Returns "" when either half is missing — never matches. */
export function areaRepKey(line: string | null | undefined, areaCode: string | null | undefined): string {
  const lineKey = normalizeLineKey(line);
  const area = String(areaCode ?? "").trim().toUpperCase();
  if (!lineKey || !area) return "";
  return `${lineKey}|${area}`;
}

/**
 * Pure: index REP seats by (line, area).
 *
 * Each seat is indexed under BOTH its line_name and its line_code key. When the reference data
 * is consistent those collapse to one entry; when it is not, either spelling still finds the rep.
 *
 * An absent key and a vacant seat are deliberately different outcomes — see DirectOrderAreaRep.
 */
export function selectAreaRepsFromSeats(
  seats: AreaRepSeatRow[],
  nameOf: (hrId: string | null) => string | null,
): Map<string, AreaRepAssignment> {
  const byKey = new Map<string, AreaRepAssignment>();

  const repSeats = seats
    .filter((seat) => String(seat.seat_tier ?? "").trim().toUpperCase() === "REP")
    .filter((seat) => !seat.is_other_pseudo_dm) // the per-line "Others" bucket holds no real people
    .filter((seat) => String(seat.area_code ?? "").trim())
    // Stable order so a multi-rep area always picks the same primary.
    .sort((a, b) => String(a.seat_id ?? "").localeCompare(String(b.seat_id ?? "")));

  for (const seat of repSeats) {
    const areaCode = String(seat.area_code ?? "").trim().toUpperCase();
    const occupantHrId = seat.is_vacant ? null : normalizeHrId(seat.occupant_hr_id) || null;

    const lineKeys = new Set(
      [normalizeLineKey(seat.line_name), normalizeLineKey(seat.line_code)].filter(Boolean),
    );
    for (const lineKey of lineKeys) {
      const key = `${lineKey}|${areaCode}`;
      const existing = byKey.get(key) ?? {
        lineKey,
        areaCode,
        repHrId: null,
        repName: null,
        repNames: [],
        isVacant: true,
      };
      if (occupantHrId) {
        const name = nameOf(occupantHrId) ?? occupantHrId;
        if (!existing.repNames.includes(name)) existing.repNames.push(name);
        existing.repHrId = existing.repHrId ?? occupantHrId;
        existing.repName = existing.repNames.join(" / ");
        existing.isVacant = false;
      }
      byKey.set(key, existing);
    }
  }

  return byKey;
}

/**
 * Batch loader — ONE `au_v_org_tree` read serves a whole list page.
 *
 * Fails soft to an empty map: the approval window is the only place a direct order can be
 * decided, so a seat-model outage must degrade the Medical rep field to "—", never 500 the page.
 */
export async function resolveAreaRepsForLineAreas(
  pairs: Array<{ line: string | null | undefined; areaCode: string | null | undefined }>,
  options?: { nameOf?: (hrId: string | null) => string | null },
): Promise<Map<string, AreaRepAssignment>> {
  const wanted = new Set(pairs.map((pair) => areaRepKey(pair.line, pair.areaCode)).filter(Boolean));
  if (wanted.size === 0) return new Map();

  try {
    const { data, error } = await getSupabaseAdmin().from("au_v_org_tree").select(SEAT_COLUMNS);
    if (error) throw error;
    const nameOf = options?.nameOf ?? (() => null);
    const all = selectAreaRepsFromSeats((data ?? []) as AreaRepSeatRow[], nameOf);
    // Return only what was asked for, so a caller cannot accidentally leak the whole org tree.
    const scoped = new Map<string, AreaRepAssignment>();
    for (const key of wanted) {
      const hit = all.get(key);
      if (hit) scoped.set(key, hit);
    }
    return scoped;
  } catch (error) {
    logError("Direct order area-rep resolution failed", {
      labels: { event: "direct_order_area_rep_resolve_failed" },
      error,
    });
    return new Map();
  }
}

/** Single-pair convenience. null = no REP seat for this (line, area) — "we cannot say". */
export async function resolveAreaRep(
  input: { line: string | null | undefined; areaCode: string | null | undefined },
  options?: { nameOf?: (hrId: string | null) => string | null },
): Promise<AreaRepAssignment | null> {
  const key = areaRepKey(input.line, input.areaCode);
  if (!key) return null;
  const map = await resolveAreaRepsForLineAreas([input], options);
  return map.get(key) ?? null;
}

import { canonicalPersonHrId } from "@/lib/auth/identity-aliases";
import { hasDepartedEmployment } from "@/lib/auth/session-lifecycle";
import { todayInCairo } from "@/lib/date-only";
import { resolveEmployeeDisplayName } from "@/lib/employees/display-name";
import { REMINDER_TEAM_ROLES } from "@/lib/hr-reminders/access";
import { canonicalHrIdKey, hrIdLookupKeys } from "@/lib/hr-id";
import {
  EMPTY_OFFER_COPY_DIRECTORY,
  buildOfferCopyDirectory,
  type OfferCopyDirectory,
  type OfferCopyPersonRecord,
  type OfferCopySeatRow,
} from "@/lib/offers/copy-directory";
import { loadReferenceLines } from "@/lib/reference/reference-lists";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/**
 * The database half. Never throws: a failed read is an empty directory, and the CC and BCC boxes still
 * take a typed address — the lists are a convenience, never a gate on sending an offer.
 */
export async function loadOfferCopyDirectory(): Promise<OfferCopyDirectory> {
  try {
    const db = getSupabaseAdmin();
    const today = todayInCairo();
    const [mapRes, seatRes, regionRes, lineRes, hrRes] = await Promise.all([
      db
        .from("au_v_line_area_map")
        .select("line_code, area_code, area_name, operational_region_code, dm_seat_id, effective_from, effective_to")
        .or(`effective_to.is.null,effective_to.gte.${today}`),
      // Manager seats only: the 111 rep seats are never copied on an offer.
      db
        .from("au_v_org_tree")
        .select("seat_id, parent_seat_id, seat_tier, occupant_hr_id, is_other_pseudo_dm")
        .in("seat_tier", ["DM", "ACTING_DM", "RSM", "NSM", "CEO"]),
      db.from("au_v_regions").select("region_code, region_name"),
      // Line names from the shared reference list, read once a minute per process.
      loadReferenceLines().catch(() => []),
      db.from("app_auth_users").select("hr_id, role, is_test_persona").in("role", [...REMINDER_TEAM_ROLES]).eq("is_active", true),
    ]);
    if (mapRes.error || seatRes.error || regionRes.error) return EMPTY_OFFER_COPY_DIRECTORY;

    type Row = Record<string, unknown>;
    const text = (value: unknown) => (typeof value === "string" ? value : null);
    const seats: OfferCopySeatRow[] = ((seatRes.data ?? []) as Row[])
      .filter((row) => text(row.seat_id))
      .map((row) => ({
        isOtherPseudoDm: row.is_other_pseudo_dm === true,
        occupantHrId: text(row.occupant_hr_id),
        parentSeatId: text(row.parent_seat_id),
        seatId: String(row.seat_id),
        seatTier: text(row.seat_tier),
      }));
    // An HR team read that fails leaves the HR list empty and the managers' lists intact.
    const hrTeam = hrRes.error
      ? []
      : ((hrRes.data ?? []) as Row[])
          .filter((row) => row.is_test_persona !== true)
          .map((row) => ({ hrId: canonicalPersonHrId(text(row.hr_id)) ?? "", role: String(row.role ?? "") }))
          .filter((member) => member.hrId);

    const wanted = new Set<string>();
    for (const seat of seats) if (seat.occupantHrId) wanted.add(seat.occupantHrId);
    for (const member of hrTeam) wanted.add(member.hrId);
    const people = new Map<string, OfferCopyPersonRecord>();
    const lookup = [...new Set([...wanted].flatMap((hrId) => hrIdLookupKeys(hrId)))];
    if (lookup.length > 0) {
      const { data, error } = await db
        .from("employees")
        .select("hr_id, full_name, nickname, work_email, employment_status")
        .in("hr_id", lookup);
      if (!error) {
        for (const row of (data ?? []) as Row[]) {
          const key = canonicalHrIdKey(text(row.hr_id));
          const fullName = text(row.full_name)?.trim();
          if (!key || !fullName || people.has(key)) continue;
          people.set(key, {
            // A leaver's seat reads as vacant: an offer is never copied to somebody who has gone.
            active: !hasDepartedEmployment(text(row.employment_status)),
            email: text(row.work_email)?.trim().toLowerCase() || null,
            name: resolveEmployeeDisplayName(fullName, text(row.nickname), text(row.hr_id)),
          });
        }
      }
    }

    const names = (rows: Row[], key: string, value: string) =>
      new Map(rows.map((row) => [String(row[key] ?? ""), String(row[value] ?? "").trim()] as const).filter(([k, v]) => k && v));

    return buildOfferCopyDirectory({
      hrTeam,
      // A line whose name could not be read shows its code rather than hiding the lists.
      lineNames: new Map(lineRes.flatMap((line) => (line.code && line.name?.trim() ? [[line.code, line.name.trim()] as const] : []))),
      mapRows: ((mapRes.data ?? []) as Row[]).map((row) => ({
        areaCode: text(row.area_code),
        areaName: text(row.area_name),
        dmSeatId: text(row.dm_seat_id),
        effectiveFrom: text(row.effective_from),
        effectiveTo: text(row.effective_to),
        lineCode: text(row.line_code),
        regionCode: text(row.operational_region_code),
      })),
      people,
      regionNames: names((regionRes.data ?? []) as Row[], "region_code", "region_name"),
      seats,
      today,
    });
  } catch {
    return EMPTY_OFFER_COPY_DIRECTORY;
  }
}

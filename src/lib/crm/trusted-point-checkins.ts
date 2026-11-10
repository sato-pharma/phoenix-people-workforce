/**
 * The old CRM's (iReports360) check-ins of one customer, for the Super Admin's trusted point (owner,
 * 2026-11-10 — "compare with the locations of checkins of this customer from the old crm";
 * src/lib/phoenix-crm/trusted-point-rules.ts).
 *
 * It lives here, beside the other old-CRM readers, because Phoenix CRM's own services read only Phoenix
 * CRM's tables (tests/phoenix-crm-boundary.test.ts); this is the one door they use to the old check-ins.
 *
 * 🔴 ONLY iREPORTS360 ROWS — `source <> 'phoenix'`. The unified view also holds a row MIRRORING every
 * Phoenix visit, at the visit's own coordinates (13,087 of them on 2026-11-10). Counting them would
 * count every Phoenix visit twice and make a thin cluster look trusted.
 */

import { CRM_CHECKINS_UNIFIED_VIEW } from "@/lib/crm/tables";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/** Ceiling on one customer's check-ins — a doctor seen weekly for six years is about 300. */
export const OLD_CRM_CHECKINS_MAX = 3000;

export type OldCrmCheckin = {
  checkinId: number | null;
  lat: number;
  lon: number;
  /** The check-in instant, ISO. */
  checkDate: string;
  agentHrId: string | null;
};

export async function loadOldCrmCheckinsForContacts(contactIds: ReadonlyArray<number | null | undefined>): Promise<OldCrmCheckin[]> {
  const ids = [...new Set(contactIds.filter((id): id is number => typeof id === "number" && Number.isFinite(id)))];
  if (ids.length === 0) return [];
  const { data, error } = await getSupabaseAdmin()
    .from(CRM_CHECKINS_UNIFIED_VIEW)
    .select("crm_checkin_id, contact_crm_id, agent_hr_id, lat, lon, check_date, source")
    .in("contact_crm_id", ids)
    .neq("source", "phoenix")
    .not("lat", "is", null)
    .not("lon", "is", null)
    .order("check_date", { ascending: true })
    .limit(OLD_CRM_CHECKINS_MAX);
  if (error) throw error;
  return ((data ?? []) as Record<string, unknown>[]).flatMap((row) => {
    const lat = Number(row.lat);
    const lon = Number(row.lon);
    const checkDate = typeof row.check_date === "string" ? row.check_date : null;
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !checkDate) return [];
    const checkinId = row.crm_checkin_id === null || row.crm_checkin_id === undefined ? null : Number(row.crm_checkin_id);
    return [
      {
        checkinId: Number.isFinite(checkinId) ? checkinId : null,
        lat,
        lon,
        checkDate,
        agentHrId: typeof row.agent_hr_id === "string" && row.agent_hr_id.trim() ? row.agent_hr_id.trim() : null,
      },
    ];
  });
}

import { haversineKm } from "@/lib/sales/normalizer/geo-validate";
import type {
  CrmIntegrityContactMatchState,
  CrmIntegritySaveLagFlag,
  CrmIntegritySpeedFeasibilityFlag,
} from "@/lib/crm-integrity/types";

// Matches the outstation module's own impossible-speed threshold (src/lib/outstation/service.ts)
// for vocabulary consistency across the codebase -- deliberately NOT imported/shared, so this
// module's blast radius stays independent of outstation's.
export const CRM_INTEGRITY_IMPOSSIBLE_SPEED_KMH = 180;

export type CrmIntegrityVisitInput = {
  agentCrmId: number;
  contactCrmId: number | null;
  crmSaveDate: string | null;
  crmVisitId: number;
  visitDate: string;
};

export type CrmIntegrityCheckinInput = {
  address: string | null;
  agentCrmId: number;
  checkDate: string;
  contactCrmId: number | null;
  contactName: string | null;
  crmCheckinId: number;
  lat: number | null;
  lon: number | null;
};

export type CrmIntegrityCorrelationResult = {
  checkinAddress: string | null;
  checkinContactCrmId: number | null;
  checkinContactName: string | null;
  checkinDate: string | null;
  checkinLat: number | null;
  checkinLon: number | null;
  contactMatchState: CrmIntegrityContactMatchState;
  crmVisitId: number;
  distanceFromPreviousCheckinKm: number | null;
  impliedSpeedKmh: number | null;
  saveLagFlag: CrmIntegritySaveLagFlag | null;
  saveLagHours: number | null;
  speedFeasibilityFlag: CrmIntegritySpeedFeasibilityFlag | null;
};

type SpeedMeta = {
  distanceFromPreviousCheckinKm: number | null;
  impliedSpeedKmh: number | null;
  speedFeasibilityFlag: CrmIntegritySpeedFeasibilityFlag;
};

function dayKey(iso: string): string {
  return iso.slice(0, 10);
}

function computeSpeedMeta(previous: CrmIntegrityCheckinInput | null, current: CrmIntegrityCheckinInput): SpeedMeta {
  if (!previous || previous.lat == null || previous.lon == null || current.lat == null || current.lon == null) {
    return { distanceFromPreviousCheckinKm: null, impliedSpeedKmh: null, speedFeasibilityFlag: "unknown" };
  }
  const hours = (new Date(current.checkDate).getTime() - new Date(previous.checkDate).getTime()) / 3600000;
  if (!Number.isFinite(hours) || hours <= 0) {
    return { distanceFromPreviousCheckinKm: null, impliedSpeedKmh: null, speedFeasibilityFlag: "unknown" };
  }
  const distanceKm = haversineKm(previous.lat, previous.lon, current.lat, current.lon);
  const speedKmh = distanceKm / hours;
  return {
    distanceFromPreviousCheckinKm: Math.round(distanceKm * 10) / 10,
    impliedSpeedKmh: Math.round(speedKmh * 10) / 10,
    speedFeasibilityFlag: speedKmh > CRM_INTEGRITY_IMPOSSIBLE_SPEED_KMH ? "impossible_speed" : "ok",
  };
}

/**
 * Per-agent chronological speed-feasibility for every in-window check-in, each compared against
 * its immediately preceding check-in (which may come from `lookbackCheckins` -- one extra day
 * fetched purely to give the window's very first check-in per agent a real predecessor to compare
 * against, rather than false-negatively treating it as having no history). Lookback check-ins are
 * only ever a comparison reference here -- they never get an entry of their own in the returned
 * map, and are never surfaced as their own row anywhere in this module.
 */
function buildSpeedMetadataByCheckinId(
  checkins: CrmIntegrityCheckinInput[],
  lookbackCheckins: CrmIntegrityCheckinInput[],
): Map<number, SpeedMeta> {
  const inWindowIds = new Set(checkins.map((checkin) => checkin.crmCheckinId));
  const byAgent = new Map<number, CrmIntegrityCheckinInput[]>();
  for (const checkin of [...lookbackCheckins, ...checkins]) {
    byAgent.set(checkin.agentCrmId, [...(byAgent.get(checkin.agentCrmId) ?? []), checkin]);
  }

  const result = new Map<number, SpeedMeta>();
  for (const agentCheckins of byAgent.values()) {
    const sorted = [...agentCheckins].sort((a, b) => new Date(a.checkDate).getTime() - new Date(b.checkDate).getTime());
    for (let index = 0; index < sorted.length; index += 1) {
      const current = sorted[index];
      if (!inWindowIds.has(current.crmCheckinId)) continue;
      const previous = index > 0 ? sorted[index - 1] : null;
      result.set(current.crmCheckinId, computeSpeedMeta(previous, current));
    }
  }
  return result;
}

function saveLag(checkDate: string, crmSaveDate: string | null): { saveLagFlag: CrmIntegritySaveLagFlag | null; saveLagHours: number | null } {
  if (!crmSaveDate) return { saveLagFlag: null, saveLagHours: null };
  const hours = (new Date(crmSaveDate).getTime() - new Date(checkDate).getTime()) / 3600000;
  if (!Number.isFinite(hours)) return { saveLagFlag: null, saveLagHours: null };
  const flag: CrmIntegritySaveLagFlag = dayKey(crmSaveDate) > dayKey(checkDate) ? "next_day_or_later" : "same_day";
  return { saveLagFlag: flag, saveLagHours: Math.round(hours * 10) / 10 };
}

/**
 * Same-agent, same-calendar-day candidates for a visit. Unlike the shared display matcher
 * (crm/checkin-match.ts, which keys by agent+contact+day and only ever returns a same-contact
 * check-in), this integrity view groups by agent+day so it can ALSO surface the "nearest check-in
 * at a DIFFERENT contact" — a data-quality signal the audit exists to flag. The exact-contact
 * match it returns uses the same rule as the shared matcher (same contact, tie broken by
 * crm_save_date proximity — never the visit_date_time midnight placeholder), so its primary answer
 * agrees with the Visits Report and CRM master surfaces; the different-contact fallback is an
 * explicit audit state, not a silent disagreement.
 */
function findBestCheckin(
  visit: CrmIntegrityVisitInput,
  candidatesByAgentDay: Map<string, CrmIntegrityCheckinInput[]>,
): { checkin: CrmIntegrityCheckinInput; state: CrmIntegrityContactMatchState } | null {
  const candidates = candidatesByAgentDay.get(`${visit.agentCrmId}:${visit.visitDate}`);
  if (!candidates || candidates.length === 0) return null;

  const anchor = visit.crmSaveDate ? new Date(visit.crmSaveDate).getTime() : null;
  const nearestOf = (pool: CrmIntegrityCheckinInput[]): CrmIntegrityCheckinInput => {
    if (anchor == null) return pool[0];
    let best = pool[0];
    let bestDiff = Infinity;
    for (const candidate of pool) {
      const diff = Math.abs(new Date(candidate.checkDate).getTime() - anchor);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = candidate;
      }
    }
    return best;
  };

  if (visit.contactCrmId != null) {
    const exactMatches = candidates.filter((candidate) => candidate.contactCrmId === visit.contactCrmId);
    if (exactMatches.length > 0) return { checkin: nearestOf(exactMatches), state: "exact_contact_match" };
  }
  return { checkin: nearestOf(candidates), state: "nearest_different_contact" };
}

/**
 * Correlates each visit with its best-matching check-in (exact contact_crm_id match first,
 * same-agent/same-day time-proximity fallback second, per the plan's 3-state design), and attaches
 * the save-lag and speed-feasibility flags. Pure function over plain data -- no Supabase calls --
 * so it's directly unit-testable with fixture objects.
 */
export function correlateVisitsWithCheckins(
  visits: CrmIntegrityVisitInput[],
  checkins: CrmIntegrityCheckinInput[],
  lookbackCheckins: CrmIntegrityCheckinInput[],
): CrmIntegrityCorrelationResult[] {
  const speedMetaByCheckinId = buildSpeedMetadataByCheckinId(checkins, lookbackCheckins);

  const candidatesByAgentDay = new Map<string, CrmIntegrityCheckinInput[]>();
  for (const checkin of checkins) {
    const key = `${checkin.agentCrmId}:${dayKey(checkin.checkDate)}`;
    candidatesByAgentDay.set(key, [...(candidatesByAgentDay.get(key) ?? []), checkin]);
  }

  return visits.map((visit) => {
    const match = findBestCheckin(visit, candidatesByAgentDay);
    if (!match) {
      return {
        checkinAddress: null,
        checkinContactCrmId: null,
        checkinContactName: null,
        checkinDate: null,
        checkinLat: null,
        checkinLon: null,
        contactMatchState: "no_checkin",
        crmVisitId: visit.crmVisitId,
        distanceFromPreviousCheckinKm: null,
        impliedSpeedKmh: null,
        saveLagFlag: null,
        saveLagHours: null,
        speedFeasibilityFlag: null,
      };
    }

    const { checkin, state } = match;
    const speedMeta = speedMetaByCheckinId.get(checkin.crmCheckinId) ?? {
      distanceFromPreviousCheckinKm: null,
      impliedSpeedKmh: null,
      speedFeasibilityFlag: "unknown" as const,
    };
    const lag = saveLag(checkin.checkDate, visit.crmSaveDate);

    return {
      checkinAddress: checkin.address,
      checkinContactCrmId: checkin.contactCrmId,
      checkinContactName: checkin.contactName,
      checkinDate: checkin.checkDate,
      checkinLat: checkin.lat,
      checkinLon: checkin.lon,
      contactMatchState: state,
      crmVisitId: visit.crmVisitId,
      distanceFromPreviousCheckinKm: speedMeta.distanceFromPreviousCheckinKm,
      impliedSpeedKmh: speedMeta.impliedSpeedKmh,
      saveLagFlag: lag.saveLagFlag,
      saveLagHours: lag.saveLagHours,
      speedFeasibilityFlag: speedMeta.speedFeasibilityFlag,
    };
  });
}

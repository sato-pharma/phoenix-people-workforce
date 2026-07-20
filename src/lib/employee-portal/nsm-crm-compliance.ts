import { indexCheckinsByAgentContactDay, pickCheckinForVisit } from "@/lib/crm/checkin-match";
import { queryCheckins, queryVisits, resolveVisitTime, type VisitTimeSource } from "@/lib/crm/reads";

// NSM "first CRM visit" compliance for the recurring iReports360 sync (3x/day plus a live
// 8:30 AM-12:01 PM morning window — see the ireports360-visits-* cron routes): who on the NSM's
// line has / hasn't submitted a real field visit today, plus the earliest few submitters
// ("early birds"). Read-only; the caller supplies the line-scoped rosters (already
// permission-scoped), so this never widens access.

export type CrmPerson = { hrId: string; name: string };

export type CrmEarlyBird = {
  hrId: string;
  name: string;
  role: "Med Rep" | "DSM";
  at: string;
  /** GPS check-in time vs. self-reported save time — see resolveVisitTime (crm/reads.ts). */
  source: VisitTimeSource;
};

export type NsmCrmComplianceData = {
  /** Africa/Cairo calendar day the check is computed for (YYYY-MM-DD). */
  date: string;
  /** Most recent CRM sync timestamp among today's mirrored rows (ISO), or null. */
  lastSyncAt: string | null;
  /** True once at least one visit for `date` has been mirrored (i.e. the sync has landed). */
  synced: boolean;
  reps: { total: number; submitted: number; missing: CrmPerson[] };
  dsms: { total: number; submitted: number; missing: CrmPerson[] };
  /** Earliest submitters across the line roster, soonest first (max 3). */
  earlyBirds: CrmEarlyBird[];
  /** True only when the underlying fetch itself failed (see nsmCrmComplianceUnavailable) — lets
   * the UI tell a real outage apart from the ordinary "nothing mirrored yet today" state, which
   * looks identical otherwise (synced: false in both). Absent/false in the normal paths below. */
  error?: boolean;
};

type VisitRow = {
  agent_hr_id: string | null;
  agent_crm_id: number | null;
  contact_crm_id: number | null;
  double_hr_id: string | null;
  crm_save_date: string | null;
  synced_at: string | null;
  visit_type: number | null;
};

type CheckinRow = { agent_crm_id: number | null; contact_crm_id: number | null; check_date: string | null };

// Collapse HR IDs to a hyphen-insensitive, case-insensitive key so canonical
// ("B100") and stored ("B-100") forms always match (guards the hr-id hyphen trap).
const matchKey = (value?: string | null): string => (value ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

// iReports360 counts Regular (0) and Campaign (-8) as real field visits; -4 is
// vacation and other negatives are administrative — never a submitted visit.
const isRealVisit = (visitType: number | null | undefined): boolean =>
  visitType != null && (visitType >= 0 || visitType === -8);

function cairoToday(): string {
  // ireports360_visits.visit_date is the local (Africa/Cairo) calendar day.
  return new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Cairo" });
}

async function fetchVisitsForDate(date: string): Promise<VisitRow[]> {
  // One day of company-wide visits via the CRM read layer — a full-coverage keyset scan, so a
  // busy day never silently drops rows and mislabels reps as non-submitters.
  return queryVisits<VisitRow>({
    dateFrom: date,
    dateTo: date,
    columns: "agent_hr_id, agent_crm_id, contact_crm_id, double_hr_id, crm_save_date, synced_at, visit_type",
  });
}

async function fetchCheckinsForDate(date: string): Promise<CheckinRow[]> {
  // Same single-day scope as fetchVisitsForDate, so GPS correlation below never reaches outside
  // the day being checked. Cheap: one day, not the Visits Report's multi-week window.
  return queryCheckins<CheckinRow>({
    dateFrom: date,
    dateTo: date,
    columns: "agent_crm_id, contact_crm_id, check_date",
  });
}

/** Built by the caller's catch handler when getNsmCrmCompliance itself throws (a real fetch
 * failure), so the UI can distinguish that from the ordinary "not synced yet" state instead of
 * both collapsing to the same silent-looking empty board. */
export function nsmCrmComplianceUnavailable(input: { reps: CrmPerson[]; dsms: CrmPerson[]; date?: string }): NsmCrmComplianceData {
  return {
    date: input.date ?? cairoToday(),
    lastSyncAt: null,
    synced: false,
    error: true,
    reps: { total: input.reps.length, submitted: 0, missing: [...input.reps] },
    dsms: { total: input.dsms.length, submitted: 0, missing: [...input.dsms] },
    earlyBirds: [],
  };
}

export async function getNsmCrmCompliance(input: {
  reps: CrmPerson[];
  dsms: CrmPerson[];
  date?: string;
}): Promise<NsmCrmComplianceData> {
  const date = input.date ?? cairoToday();
  const notSynced: NsmCrmComplianceData = {
    date,
    lastSyncAt: null,
    synced: false,
    reps: { total: input.reps.length, submitted: 0, missing: [...input.reps] },
    dsms: { total: input.dsms.length, submitted: 0, missing: [...input.dsms] },
    earlyBirds: [],
  };

  const [rows, checkins] = await Promise.all([fetchVisitsForDate(date), fetchCheckinsForDate(date)]);
  if (rows.length === 0) return notSynced;

  // Same GPS-first waterfall as the CRM master table / Visits Report (resolveVisitTime,
  // crm/reads.ts): GPS check-in time -> save time -> none. Ranking purely by crm_save_date (the
  // rep's own submission/paperwork time) previously let a rep who merely logged fast outrank one
  // who genuinely arrived earlier but saved later — the exact distortion #1192 fixed for the
  // Master table and Visits Report but had left this board still doing.
  const checkinIndex = indexCheckinsByAgentContactDay(checkins);

  type Best = { when: number; source: VisitTimeSource };
  const agentEarliest = new Map<string, Best>(); // match key -> earliest resolved visit (as visiting agent)
  const doubleEarliest = new Map<string, Best>(); // match key -> earliest resolved visit (as double-visit partner)
  let lastSync = 0;

  for (const row of rows) {
    if (row.synced_at) {
      const synced = Date.parse(row.synced_at);
      if (Number.isFinite(synced) && synced > lastSync) lastSync = synced;
    }
    if (!isRealVisit(row.visit_type)) continue;

    // Never anchored on visit_date_time (a fixed midnight placeholder) or synced_at (the sync
    // clock, not the rep's own visit) — see resolveVisitTime's own contract. A row that resolves
    // to no real time still counts as submitted below, but can never be an early bird.
    const match = pickCheckinForVisit(
      { agentCrmId: row.agent_crm_id, contactCrmId: row.contact_crm_id, visitDay: date, crmSaveDate: row.crm_save_date },
      checkinIndex,
    );
    const resolved = resolveVisitTime({ nearestCheckinTime: match?.check_date ?? null, crmSaveDate: row.crm_save_date });
    const parsed = resolved.time ? Date.parse(resolved.time) : NaN;
    const when = Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;

    const agent = matchKey(row.agent_hr_id);
    if (agent) {
      const cur = agentEarliest.get(agent);
      if (cur === undefined || when < cur.when) agentEarliest.set(agent, { when, source: resolved.source });
    }
    const dbl = matchKey(row.double_hr_id);
    if (dbl) {
      const cur = doubleEarliest.get(dbl);
      if (cur === undefined || when < cur.when) doubleEarliest.set(dbl, { when, source: resolved.source });
    }
  }

  const earlyBirds: CrmEarlyBird[] = [];

  const repMissing: CrmPerson[] = [];
  let repSubmitted = 0;
  for (const person of input.reps) {
    const best = agentEarliest.get(matchKey(person.hrId));
    if (best !== undefined) {
      repSubmitted += 1;
      if (best.when !== Number.MAX_SAFE_INTEGER) {
        earlyBirds.push({
          at: new Date(best.when).toISOString(),
          hrId: person.hrId,
          name: person.name,
          role: "Med Rep",
          source: best.source,
        });
      }
    } else {
      repMissing.push(person);
    }
  }

  const dsmMissing: CrmPerson[] = [];
  let dsmSubmitted = 0;
  for (const person of input.dsms) {
    const key = matchKey(person.hrId);
    // A DSM "submits" either by a solo visit (agent) or by accompanying a rep (double).
    const asAgent = agentEarliest.get(key);
    const asDouble = doubleEarliest.get(key);
    const best =
      asAgent === undefined ? asDouble : asDouble === undefined ? asAgent : asAgent.when <= asDouble.when ? asAgent : asDouble;
    if (best !== undefined) {
      dsmSubmitted += 1;
      if (best.when !== Number.MAX_SAFE_INTEGER) {
        earlyBirds.push({
          at: new Date(best.when).toISOString(),
          hrId: person.hrId,
          name: person.name,
          role: "DSM",
          source: best.source,
        });
      }
    } else {
      dsmMissing.push(person);
    }
  }

  earlyBirds.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

  return {
    date,
    lastSyncAt: lastSync ? new Date(lastSync).toISOString() : null,
    synced: true,
    reps: { total: input.reps.length, submitted: repSubmitted, missing: repMissing },
    dsms: { total: input.dsms.length, submitted: dsmSubmitted, missing: dsmMissing },
    earlyBirds: earlyBirds.slice(0, 3),
  };
}

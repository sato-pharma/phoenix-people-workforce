import { hasRealVendorTime, queryVisits } from "@/lib/crm/reads";

// NSM "first CRM visit" compliance for the noon (12 PM Cairo) iReports360 sync:
// who on the NSM's line has / hasn't submitted a real field visit today, plus the
// earliest few submitters ("early birds"). Read-only; the caller supplies the
// line-scoped rosters (already permission-scoped), so this never widens access.

export type CrmPerson = { hrId: string; name: string };

export type CrmEarlyBird = { hrId: string; name: string; role: "Med Rep" | "DSM"; at: string };

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
};

type VisitRow = {
  agent_hr_id: string | null;
  double_hr_id: string | null;
  crm_save_date: string | null;
  synced_at: string | null;
  visit_type: number | null;
};

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
    columns: "agent_hr_id, double_hr_id, crm_save_date, synced_at, visit_type",
  });
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

  const rows = await fetchVisitsForDate(date);
  if (rows.length === 0) return notSynced;

  const agentEarliest = new Map<string, number>(); // match key -> earliest submission ms (as visiting agent)
  const doubleEarliest = new Map<string, number>(); // match key -> earliest submission ms (as double-visit partner)
  let lastSync = 0;

  for (const row of rows) {
    if (row.synced_at) {
      const synced = Date.parse(row.synced_at);
      if (Number.isFinite(synced) && synced > lastSync) lastSync = synced;
    }
    if (!isRealVisit(row.visit_type)) continue;

    // Early-bird ranking is by SUBMISSION time (crm_save_date) only — never the visit_date_time
    // midnight placeholder (which would rank a rep as spuriously "earliest"), nor synced_at (the
    // sync clock, not the rep's own submission). A row without a real save time still counts as
    // submitted below, but can never be an early bird (when = MAX_SAFE_INTEGER).
    const stamp = hasRealVendorTime(row.crm_save_date) ? row.crm_save_date : null;
    const parsed = stamp ? Date.parse(stamp) : NaN;
    const when = Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;

    const agent = matchKey(row.agent_hr_id);
    if (agent) {
      const cur = agentEarliest.get(agent);
      if (cur === undefined || when < cur) agentEarliest.set(agent, when);
    }
    const dbl = matchKey(row.double_hr_id);
    if (dbl) {
      const cur = doubleEarliest.get(dbl);
      if (cur === undefined || when < cur) doubleEarliest.set(dbl, when);
    }
  }

  const earlyBirds: CrmEarlyBird[] = [];

  const repMissing: CrmPerson[] = [];
  let repSubmitted = 0;
  for (const person of input.reps) {
    const at = agentEarliest.get(matchKey(person.hrId));
    if (at !== undefined) {
      repSubmitted += 1;
      if (at !== Number.MAX_SAFE_INTEGER) {
        earlyBirds.push({ hrId: person.hrId, name: person.name, role: "Med Rep", at: new Date(at).toISOString() });
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
    const at = Math.min(
      agentEarliest.get(key) ?? Number.POSITIVE_INFINITY,
      doubleEarliest.get(key) ?? Number.POSITIVE_INFINITY,
    );
    if (Number.isFinite(at)) {
      dsmSubmitted += 1;
      if (at !== Number.MAX_SAFE_INTEGER) {
        earlyBirds.push({ hrId: person.hrId, name: person.name, role: "DSM", at: new Date(at).toISOString() });
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

// The only file on the Early Birds scoring path that touches the database.
//
// Everything it produces is a plain value handed to the pure scorer, so the award rule itself stays
// testable against fixed rows. Reads are roster-scoped by the CALLER supplying a manager — this
// module resolves that manager's own direct reports and nobody else's.

import { indexCheckinsByAgentContactDay, pickCheckinForVisit } from "@/lib/crm/checkin-match";
import { queryCheckins, queryVisits, resolveVisitTime, CRM_DOUBLE_VISIT_TYPE_CODES } from "@/lib/crm/reads";
import { crmMinutesPastMidnight, phoenixFirstVisitStarts } from "@/lib/crm/sfe-field-analytics";
import { cairoTodayIso } from "@/lib/crm/dates";
import { isPhoenixNativeVisitRow } from "@/lib/crm/phoenix-team-starts";
import { getEmployeeDirectoryRows, isActiveDirectoryEmployee } from "@/lib/employees/employee-directory";
import { isMedicalRepDirectoryEmployee } from "@/lib/employee-portal/service";
import { fieldWorkforceDeductionDayWeight } from "@/lib/field-workforce-compliance/weekend-policy";
import { normalizeHrIdForAccess } from "@/lib/hr-id";
import { buildEarlyBirdsDailyWinners } from "@/lib/early-birds/daily-board";
import { earlyBirdsPeriodDays, type EarlyBirdsPeriod } from "@/lib/early-birds/period";
import { EARLY_BIRDS_EARLIEST_PLAUSIBLE_START_MINUTES } from "@/lib/early-birds/scoring";
import type {
  EarlyBirdsRepContext,
  EarlyBirdsRepProfile,
  EarlyBirdsVisitFact,
} from "@/lib/early-birds/types";
import type { NsmCrmCheckinRow, NsmCrmVisitRow } from "@/lib/employee-portal/nsm-crm-compliance";

// `crm_visit_id` and `source` mark a Phoenix CRM row, whose capture time is its rep's clock (phoenix-start.ts).
// `double2_hr_id` is selected although nothing here reads it: `buildEarlyBirdsDailyWinners` replays the
// first-visit board off these rows, and that board credits BOTH partner slots. Selecting one and not the
// other leaves the second silently `undefined` in the replay while the live board counts it.
const VISIT_COLUMNS =
  "agent_hr_id, agent_crm_id, contact_crm_id, double_hr_id, double2_hr_id, crm_save_date, synced_at, " +
  "visit_type, visit_type_description, contact_name, customer_name, comment, visit_date, crm_visit_id, source";

type VisitRowWithDate = NsmCrmVisitRow & { visit_date: string | null; crm_visit_id?: number | null; source?: string | null };

export type EarlyBirdsInputs = {
  reps: EarlyBirdsRepContext[];
  facts: EarlyBirdsVisitFact[];
  dailyWinnerHrIdKeys: Map<string, string | null>;
  contestedDays: number;
  profiles: Map<string, EarlyBirdsRepProfile>;
  /**
   * `${hrIdKey}|${dateIso}` -> minutes past Cairo midnight of that rep's FIRST GPS check-in that
   * day — or, on a day in `phoenixClockRepDays`, of his first countable Phoenix CRM visit (owner,
   * 2026-10-02: "First Phoenix visit"). The only clock the ranking uses. A day absent from this map has
   * no verified start.
   */
  gpsStartByRepDay: Map<string, number>;
  /**
   * `${hrIdKey}|${dateIso}` of every rep-day on which the rep made a countable Phoenix CRM visit. On those
   * days his clock is his first Phoenix visit and his iReports360 check-ins are left out by the read door
   * (Phoenix wins the day) — so the scorer counts and names such a start as a first visit, never as GPS
   * (phoenix-start.ts). A day with no Phoenix visit is not in the set and is scored on iReports360.
   */
  phoenixClockRepDays: Set<string>;
  /** Last day actually scored — the period end, or today for a mid-period preview. */
  throughIso: string;
};

/** Every District Manager with at least one medical rep reporting to them. */
export async function listEarlyBirdsDistrictManagers(): Promise<
  Array<{ hrId: string; hrIdKey: string; name: string }>
> {
  const rows = await getEmployeeDirectoryRows().catch(() => []);
  const managerKeys = new Map<string, string>();
  for (const row of rows) {
    if (!isMedicalRepDirectoryEmployee(row)) continue;
    const managerKey = normalizeHrIdForAccess(row.managerHrId);
    if (managerKey) managerKeys.set(managerKey, row.managerHrId ?? "");
  }
  const managers: Array<{ hrId: string; hrIdKey: string; name: string }> = [];
  for (const row of rows) {
    const key = normalizeHrIdForAccess(row.hrId);
    if (!key || !managerKeys.has(key)) continue;
    managers.push({ hrId: row.hrId, hrIdKey: key, name: row.displayName });
  }
  return managers.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Everything the scorer needs for one district and one fortnight.
 *
 * `throughIso` clamps to today so a mid-period preview never counts days that have not happened as
 * days the rep failed to submit.
 */
export async function collectEarlyBirdsInputs(input: {
  period: EarlyBirdsPeriod;
  managerHrId: string;
  todayIso?: string;
}): Promise<EarlyBirdsInputs> {
  const todayIso = input.todayIso ?? cairoTodayIso();
  const throughIso = todayIso < input.period.endIso ? todayIso : input.period.endIso;
  const managerKey = normalizeHrIdForAccess(input.managerHrId);

  // Resigned people are OFF the board. Not greyed out, not listed last as ineligible — absent.
  //
  // This used to read `includeInactive: true` and rely on the eligibility rules to push leavers to
  // the bottom with a "Not active at period end" reason. That was wrong for a board a whole
  // district looks at: the owner's reaction to seeing resignations ranked among his reps was
  // immediate, and he is right. A leaderboard is a list of people you can still recognise.
  //
  // The trade-off, stated rather than hidden: a rep who resigns mid-fortnight drops out of the
  // LIVE preview for that fortnight. Snapshots already closed are unaffected — their candidates are
  // frozen rows in early_birds_candidates, not recomputed from the directory.
  const directory = await getEmployeeDirectoryRows().catch(() => []);
  const team = directory.filter(
    (row) =>
      isMedicalRepDirectoryEmployee(row) &&
      isActiveDirectoryEmployee(row) &&
      normalizeHrIdForAccess(row.managerHrId) === managerKey,
  );

  const periodDays = earlyBirdsPeriodDays(input.period, throughIso);

  const reps: EarlyBirdsRepContext[] = [];
  const profiles = new Map<string, EarlyBirdsRepProfile>();

  for (const row of team) {
    const hrIdKey = normalizeHrIdForAccess(row.hrId);
    if (!hrIdKey) continue;

    // A rep is only "expected" on a day they were actually employed. Without this a mid-period
    // hire scores a consistency of zero for days that pre-date their first one.
    let expectedWorkingDayWeight = 0;
    let expectedWorkingDays = 0;
    for (const dateIso of periodDays) {
      if (row.hireDate && dateIso < row.hireDate) continue;
      const weight = fieldWorkforceDeductionDayWeight({ dateIso, title: row.jobTitle });
      if (weight <= 0) continue;
      expectedWorkingDayWeight += weight;
      expectedWorkingDays += 1;
    }

    reps.push({
      hrIdKey,
      hrId: row.hrId,
      name: row.displayName,
      expectedWorkingDayWeight: Math.round(expectedWorkingDayWeight * 100) / 100,
      expectedWorkingDays,
      activeAtPeriodEnd: isActiveDirectoryEmployee(row),
    });

    profiles.set(hrIdKey, {
      hrIdKey,
      hrId: row.hrId,
      name: row.displayName,
      areaName: row.areaName ?? null,
      regionName: row.regionName ?? null,
      lineName: row.lineName ?? null,
      hireDate: row.hireDate ?? null,
      hasPhoto: Boolean(row.hasPhoto),
      managerHrId: row.managerHrId ?? null,
      managerName: row.managerName ?? null,
    });
  }

  if (reps.length === 0) {
    return {
      reps,
      facts: [],
      dailyWinnerHrIdKeys: new Map(),
      contestedDays: 0,
      profiles,
      gpsStartByRepDay: new Map(),
      phoenixClockRepDays: new Set(),
      throughIso,
    };
  }

  const [visits, checkins] = await Promise.all([
    queryVisits<VisitRowWithDate>({
      dateFrom: input.period.startIso,
      dateTo: throughIso,
      agentHrIds: reps.map((rep) => rep.hrId),
      columns: VISIT_COLUMNS,
    }),
    // Company-wide for the window: the check-in door has no roster filter that matches on hr id,
    // and correlation is by agent+contact+day anyway, so a wider read cannot leak into a rep's score.
    queryCheckins<NsmCrmCheckinRow & { agent_hr_id?: string | null }>({
      dateFrom: input.period.startIso,
      dateTo: throughIso,
      // agent_hr_id is read so a rep's OWN earliest check-in can be found without correlating it
      // to a particular visit — see gpsStartByRepDay below.
      columns: "agent_crm_id, agent_hr_id, contact_crm_id, check_date",
    }),
  ]);

  // PHOENIX WINS THE DAY (owner, 2026-10-16): a rep-day on which he made a countable Phoenix visit is on
  // Phoenix's clock — his first Phoenix visit — and a day on which he made none is on iReports360's.
  // The check-in door already leaves out his iReports360 check-ins of a day he has a Phoenix entry
  // (crm_checkins_unified), so the check-ins below are the days Phoenix has nothing for, and read as they
  // always did. The module still never mixes two clocks inside one rep-day.
  const phoenixStarts = phoenixFirstVisitStarts(visits);
  const phoenixClockRepDays = new Set<string>(phoenixStarts.keys());

  const checkinIndex = indexCheckinsByAgentContactDay(checkins);
  const realVisitTypes = new Set<number>(CRM_DOUBLE_VISIT_TYPE_CODES);

  const facts: EarlyBirdsVisitFact[] = [];
  const visitsByDate = new Map<string, VisitRowWithDate[]>();
  const checkinsByDate = new Map<string, NsmCrmCheckinRow[]>();

  // The rep's OWN earliest GPS check-in per day — the only clock this module ranks on.
  //
  // Deliberately NOT visit-correlated. Correlating a check-in to a particular visit needs a
  // contact both sides share, and measured on production 2026-08-09 that matches 94.8% of Regular
  // visits and exactly 0 of 546 Campaign rows. Ranking off the correlated time therefore erased
  // real Campaign work as "never showed up". "When did this rep first check in anywhere today"
  // is both the honest answer to the question the board asks and immune to that.
  const gpsStartByRepDay = new Map<string, number>();

  for (const checkin of checkins) {
    const dateIso = String(checkin.check_date ?? "").slice(0, 10);
    if (!dateIso) continue;
    const bucket = checkinsByDate.get(dateIso);
    if (bucket) bucket.push(checkin);
    else checkinsByDate.set(dateIso, [checkin]);

    const hrIdKey = normalizeHrIdForAccess(checkin.agent_hr_id ?? null);
    if (!hrIdKey) continue;
    const minutes = crmMinutesPastMidnight(checkin.check_date);
    // An after-midnight check-in is not an arrival; same rule the timeline applies.
    if (minutes === null || minutes < EARLY_BIRDS_EARLIEST_PLAUSIBLE_START_MINUTES) continue;
    const key = `${hrIdKey}|${dateIso}`;
    const current = gpsStartByRepDay.get(key);
    if (current === undefined || minutes < current) gpsStartByRepDay.set(key, minutes);
  }

  // On a rep-day with a countable Phoenix visit, his first one IS the day's start.
  for (const [key, minutes] of phoenixStarts) {
    gpsStartByRepDay.set(key, minutes);
  }

  for (const row of visits) {
    const dateIso = String(row.visit_date ?? "").slice(0, 10);
    if (!dateIso) continue;

    const dayBucket = visitsByDate.get(dateIso);
    if (dayBucket) dayBucket.push(row);
    else visitsByDate.set(dateIso, [row]);

    if (row.visit_type == null || !realVisitTypes.has(row.visit_type)) continue;
    const hrIdKey = normalizeHrIdForAccess(row.agent_hr_id);
    if (!hrIdKey) continue;

    const match = pickCheckinForVisit(
      {
        agentCrmId: row.agent_crm_id,
        agentHrId: row.agent_hr_id,
        contactCrmId: row.contact_crm_id,
        visitDay: dateIso,
        crmSaveDate: row.crm_save_date,
      },
      checkinIndex,
    );
    const resolved = resolveVisitTime({
      nearestCheckinTime: match?.check_date ?? null,
      crmSaveDate: row.crm_save_date,
    });

    // A Phoenix CRM visit is its own check-in (crm/call-rate.ts): captured at the customer's door, it
    // earns the Regular credit a GPS-checked visit earns. No GPS check-in can ever match one — his are
    // not read within a start — so it never sits in the GPS denominator either.
    const phoenixVisit = isPhoenixNativeVisitRow(row);
    facts.push({
      hrIdKey,
      // The visit's own date, never the day implied by its timestamp.
      dateIso,
      startMinutes: crmMinutesPastMidnight(resolved.time),
      timeSource: resolved.source,
      visitType: row.visit_type,
      // A GPS check-in can only ever match a visit that carries a real contact, so a Campaign row
      // is not in the denominator rather than being a zero in it.
      gpsEligible: !phoenixVisit && typeof row.contact_crm_id === "number" && row.contact_crm_id !== 0,
      ...(phoenixVisit ? { phoenixVisit: true } : {}),
    });
  }

  const daily = buildEarlyBirdsDailyWinners({
    period: input.period,
    reps: reps.map((rep) => ({ hrId: rep.hrId, name: rep.name })),
    visitsByDate,
    checkinsByDate,
    throughIso,
  });

  return {
    reps,
    facts,
    dailyWinnerHrIdKeys: daily.winnersByDate,
    contestedDays: daily.contestedDays,
    profiles,
    gpsStartByRepDay,
    phoenixClockRepDays,
    throughIso,
  };
}

import { hrIdsMatch } from "@/lib/hr-id";
import { addDaysIso, cairoTodayIso } from "@/lib/crm/dates";
import { getCrmIdentityResolutions } from "@/lib/crm/identity";
import { getUnstampedAgentAccounts, queryVisits } from "@/lib/crm/reads";

/**
 * CRM work a person did AFTER a last working day that is about to be recorded.
 *
 * WHY (owner, 2026-10-22). Two exits were recorded with a last working day before work the CRM
 * already held. Shimaa Ibrahim (Sharkia 1, Anti-Infective) worked seven days and then declined the
 * offer, but the declined-offer form was saved with her hire day as the last day and "Include in
 * payroll: no"; the CRM held 37 of her visits from 5 to 10 September, a district manager beside her
 * on the first day. Ahmed Nabil (Alex East) moved to Pedia on 1 October, and a resignation dated
 * 30 September then closed his Pedia seat the day it opened while the CRM held 35 of his visits from
 * 1 to 6 October, six with the Pedia district manager. Nothing in the exit forms looked. This is the
 * look: the three exit forms (Resign, Declined Offer, the Resignations date edit) show it beside the
 * date, before anything is saved. It never blocks and never changes a date or a payroll choice.
 *
 * WHOSE ROWS COUNT. A CRM account is reused for the replacement in the same area and line (memory
 * `crm-resigned-slot-reused-for-new-hire`), so a row on the person's account after the date may be the
 * successor's. A row counts when it is stamped to this person, when it is UNSTAMPED on one of this
 * person's CRM accounts (the sync stamps nobody once the record has ended — Shimaa's 37 visits carry
 * no HR number at all), or when this person is the manager beside the rep. A row stamped to anybody
 * else is that person's and never counts.
 */

/** The visit columns the summary reads. */
export const CRM_WORK_AFTER_DATE_COLUMNS = "visit_date, agent_hr_id, agent_crm_id, double_hr_id, double2_hr_id";

export type CrmWorkAfterDateRow = {
  agent_crm_id?: number | string | null;
  agent_hr_id?: string | null;
  double_hr_id?: string | null;
  /** A chain visit’s second manager (slot 2) — the reader below already fetches those rows. */
  double2_hr_id?: string | null;
  visit_date?: string | null;
};

export type CrmWorkAfterDate = {
  /** The date asked about: every counted visit is strictly after it. */
  afterDate: string;
  /** Distinct visit days after the date, ascending. */
  days: string[];
  /** The days on which a manager was beside this person on at least one of their own visits. */
  daysWithManager: string[];
  firstDay: string | null;
  lastDay: string | null;
  /** Visits counted after the date (one per CRM row). */
  visits: number;
};

function dayOf(value: string | null | undefined): string | null {
  const day = String(value ?? "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

function crmIdKey(value: number | string | null | undefined): string | null {
  const text = String(value ?? "").trim();
  return text && text !== "0" ? text : null;
}

/**
 * Pure: which of `rows` are this person's own work after `afterDate`, summarised by day. Exported for
 * its unit test; the reader below only fetches.
 */
export function summarizeCrmWorkAfterDate(
  rows: readonly CrmWorkAfterDateRow[],
  input: { afterDate: string; crmIds: readonly (number | string)[]; hrId: string },
): CrmWorkAfterDate {
  const ownCrmIds = new Set(input.crmIds.map((id) => crmIdKey(id)).filter((id): id is string => Boolean(id)));
  const days = new Set<string>();
  const daysWithManager = new Set<string>();
  let visits = 0;
  for (const row of rows) {
    const day = dayOf(row.visit_date);
    if (!day || day <= input.afterDate) continue;
    const stampedToHim = hrIdsMatch(row.agent_hr_id, input.hrId);
    const unstampedOnHisAccount =
      !String(row.agent_hr_id ?? "").trim() && ownCrmIds.has(crmIdKey(row.agent_crm_id) ?? "");
    // Either partner slot: the manager-side read asks for slot 2 as well (applyVisitFilter’s
    // doubleHrIds), and a chain visit’s second manager rode along exactly as the first did
    // (re-audit, 2026-10-22 — those rows were fetched and then dropped here).
    const asManager = hrIdsMatch(row.double_hr_id, input.hrId) || hrIdsMatch(row.double2_hr_id, input.hrId);
    if (!stampedToHim && !unstampedOnHisAccount && !asManager) continue;
    visits += 1;
    days.add(day);
    const partner = String(row.double_hr_id ?? "").trim();
    if (!asManager && partner && !hrIdsMatch(partner, input.hrId)) daysWithManager.add(day);
  }
  const ordered = [...days].sort();
  return {
    afterDate: input.afterDate,
    days: ordered,
    daysWithManager: [...daysWithManager].sort(),
    firstDay: ordered[0] ?? null,
    lastDay: ordered[ordered.length - 1] ?? null,
    visits,
  };
}

/** How far back the reader looks for the CRM accounts this person has logged on. */
const ACCOUNT_LOOKBACK_DAYS = 120;

/** The live letter a CRM account label carries for each line; `E` and `F` are retired codes for A and P. */
const LINE_LETTER_BY_NAME: Record<string, string> = { "anti infective": "A", cns: "C", pedia: "P" };
const RETIRED_LINE_LETTER: Record<string, string> = { E: "A", F: "P" };

function normalizeLabelText(value: string | null | undefined): string {
  return String(value ?? "").toLowerCase().replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * The area and line letter a CRM account label carries — `[Name ]( Area / Line )`, with the retired
 * codes read as their live ones. Null when the label has no such part. Pure, exported for its test.
 */
export function crmLabelAreaAndLine(label: string | null | undefined): { area: string; line: string } | null {
  const match = String(label ?? "").match(/\(([^()]*)\)\s*$/);
  if (!match) return null;
  const parts = match[1].split("/").map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  const letter = parts[parts.length - 1].toUpperCase();
  const area = normalizeLabelText(parts.slice(0, -1).join(" / "));
  if (!area || !/^[A-Z]$/.test(letter)) return null;
  return { area, line: RETIRED_LINE_LETTER[letter] ?? letter };
}

/** Whether a CRM label names this area and line. */
export function crmLabelMatchesSeat(
  label: string | null | undefined,
  seat: { areaName: string | null | undefined; lineName: string | null | undefined },
): boolean {
  const parsed = crmLabelAreaAndLine(label);
  const letter = LINE_LETTER_BY_NAME[normalizeLabelText(seat.lineName)];
  return Boolean(parsed && letter && parsed.line === letter && parsed.area === normalizeLabelText(seat.areaName));
}

/**
 * The CRM accounts with UNSTAMPED visits after the date whose label names this person's area and
 * line. Needed because a hire often inherits a predecessor's account and the sync then stamps
 * nobody on it once the record ends — Shimaa Ibrahim's record never carried a CRM id, and her 37
 * visits sit unstamped on the Sharkia 1 / Anti-Infective account. Only finds ACCOUNTS; the visits
 * themselves are then read through the door.
 */
async function unstampedAccountsForSeat(input: {
  areaName: string | null | undefined;
  dateFrom: string;
  dateTo: string;
  lineName: string | null | undefined;
}): Promise<string[]> {
  const area = String(input.areaName ?? "").trim();
  if (!area || !LINE_LETTER_BY_NAME[normalizeLabelText(input.lineName)]) return [];
  const rows = await getUnstampedAgentAccounts({
    dateFrom: input.dateFrom,
    dateTo: input.dateTo,
    labelContains: area,
  });
  const accounts = new Set<string>();
  for (const row of rows) {
    const id = crmIdKey(row.agentCrmId);
    if (id && crmLabelMatchesSeat(row.agentName, input)) accounts.add(id);
  }
  return [...accounts];
}

async function mappedCrmIds(hrId: string): Promise<string[]> {
  const resolutions = await getCrmIdentityResolutions();
  return resolutions
    .filter((row) => row.status === "mapped" && hrIdsMatch(row.mappedHrId, hrId))
    .map((row) => crmIdKey(row.crmId))
    .filter((id): id is string => Boolean(id));
}

/**
 * The person's CRM work after `afterDate`, through today (Cairo). Reads the visits door with the
 * departed-agent exclusion lifted, because the person being judged is exactly the one it would hide
 * once the exit is recorded; the summary above decides whose rows count.
 */
export async function readCrmWorkAfterDate(input: {
  afterDate: string;
  areaName?: string | null;
  employeeCrmId?: string | null;
  hrId: string;
  lineName?: string | null;
}): Promise<CrmWorkAfterDate> {
  const today = cairoTodayIso();
  const empty = summarizeCrmWorkAfterDate([], { afterDate: input.afterDate, crmIds: [], hrId: input.hrId });
  if (input.afterDate >= today) return empty;
  const dateFrom = addDaysIso(input.afterDate, 1);

  // The accounts this person logs on: the one on their record, the one an admin mapped to them, and
  // any account their visits were stamped from shortly before the date.
  const [mapped, seatAccounts, stampedBefore] = await Promise.all([
    mappedCrmIds(input.hrId),
    unstampedAccountsForSeat({ areaName: input.areaName, dateFrom, dateTo: today, lineName: input.lineName }),
    queryVisits<CrmWorkAfterDateRow>({
      agentHrIds: [input.hrId],
      columns: CRM_WORK_AFTER_DATE_COLUMNS,
      dateFrom: addDaysIso(input.afterDate, -ACCOUNT_LOOKBACK_DAYS),
      dateTo: input.afterDate,
      includeResignedAgents: true,
    }),
  ]);
  const crmIds = Array.from(
    new Set(
      [input.employeeCrmId, ...mapped, ...seatAccounts, ...stampedBefore.map((row) => row.agent_crm_id)]
        .map((id) => crmIdKey(id))
        .filter((id): id is string => Boolean(id)),
    ),
  );
  const numericCrmIds = crmIds.map(Number).filter((id) => Number.isFinite(id));

  const [asAgent, asManager] = await Promise.all([
    queryVisits<CrmWorkAfterDateRow>({
      agentCrmOrHrIds: { crmIds: numericCrmIds, hrIds: [input.hrId] },
      columns: CRM_WORK_AFTER_DATE_COLUMNS,
      dateFrom,
      dateTo: today,
      includeResignedAgents: true,
    }),
    queryVisits<CrmWorkAfterDateRow>({
      columns: CRM_WORK_AFTER_DATE_COLUMNS,
      dateFrom,
      dateTo: today,
      doubleHrIds: [input.hrId],
      includeResignedAgents: true,
    }),
  ]);
  // A row can answer both reads (this person's own account AND named as the manager), so keep it once.
  const seen = new Set<string>();
  const rows = [...asAgent, ...asManager].filter((row) => {
    const id = String((row as { id?: string | null }).id ?? "");
    if (!id) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  return summarizeCrmWorkAfterDate(rows, {
    afterDate: input.afterDate,
    crmIds,
    hrId: input.hrId,
  });
}

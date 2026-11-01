// The "Targets uploaded" email (owner request, 2026-10-14).
//
// When a targets workbook is COMMITTED, every rep who received a target is told it is on Phoenix —
// "your target for Oct, Nov, Dec 2026 is now on Phoenix", with NO figure in the email (owner,
// 2026-10-15). The rep's manager (District Manager), the Regional Sales Manager where the line has
// one, the line's National Sales Manager and Omar Anwar are copied.
//
// ONE EMAIL PER TEAM, NOT ONE PER REP AND NOT ONE PER LINE, and a file that sets a whole quarter is
// still ONE email per team, never three. The grouping and the recipients are decided in
// targets-uploaded-teams.ts, which is pure and tested; this file loads the organogram and sends.
//
// Nobody's address is written here. Everything resolves LIVE against the organogram
// (au_v_org_tree + au_v_line_area_map) and the HR record, so a seat change or a leaver updates the
// audience with no code change.
//
// The wording lives in /admin/email-templates under "Targets Uploaded"; only the line and the
// months are supplied here. Routing stays ours (replaceRecipients) — who is told about a targets
// file is decided by the organogram, not by recipient rules.

import { sendTemplatedEmail } from "@/lib/email-templates/service";
import { hrIdLookupKeys } from "@/lib/hr-id";
import { logError } from "@/lib/observability/log";
import { lineName, loadProductNameMap, type ResolvedTargetRow } from "@/lib/sales/monthly-targets";
import {
  buildTargetTeams,
  dateOnly,
  NAMED_CC_HR_IDS,
  periodsLabel,
  resolveTeamRecipients,
  teamFingerprint,
  type TargetAreaMapRow,
  type TargetDirectory,
  type TargetPerson,
  type TargetSeat,
  type TargetTeam,
} from "@/lib/sales/targets-uploaded-teams";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/** Same env-var convention the other sales notification modules use for their one CTA link. */
function appUrl(path: string) {
  const base = (process.env.NOTIFICATION_DASHBOARD_URL || process.env.NEXT_PUBLIC_APP_URL || "").replace(/\/+$/, "");
  if (!base) return path;
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

export async function loadTargetDirectory(lineCodes: string[]): Promise<TargetDirectory> {
  const supabase = getSupabaseAdmin();
  const [seatResult, mapResult, productNames] = await Promise.all([
    supabase.from("au_v_org_tree_sales").select("seat_id,parent_seat_id,seat_tier,line_code,occupant_hr_id"),
    supabase
      .from("au_v_line_area_map")
      .select("line_code,area_code,area_name,dm_seat_id,rep_seat_id,effective_from,effective_to")
      .in("line_code", lineCodes),
    loadProductNameMap(),
  ]);
  if (seatResult.error) throw seatResult.error;
  if (mapResult.error) throw mapResult.error;

  // The chain above a District Manager leaves the line (the CEO seat has no line), so seats are read
  // whole rather than filtered by line; the chain walk only ever follows parent links.
  const seats: TargetSeat[] = ((seatResult.data ?? []) as Array<Record<string, unknown>>).map((row) => ({
    seatId: String(row.seat_id ?? ""),
    parentSeatId: String(row.parent_seat_id ?? "").trim() || null,
    tier: String(row.seat_tier ?? "").trim().toUpperCase(),
    occupantHrId: String(row.occupant_hr_id ?? "").trim() || null,
  }));
  const areaMap: TargetAreaMapRow[] = ((mapResult.data ?? []) as Array<Record<string, unknown>>).map((row) => ({
    lineCode: String(row.line_code ?? ""),
    areaCode: String(row.area_code ?? ""),
    areaName: String(row.area_name ?? "").trim() || null,
    dmSeatId: String(row.dm_seat_id ?? "").trim() || null,
    repSeatId: String(row.rep_seat_id ?? "").trim() || null,
    effectiveFrom: dateOnly(String(row.effective_from ?? "")),
    effectiveTo: dateOnly(String(row.effective_to ?? "")),
  }));

  const hrIds = [
    ...new Set([
      ...seats.map((seat) => seat.occupantHrId).filter((value): value is string => Boolean(value)),
      ...NAMED_CC_HR_IDS,
    ]),
  ];
  const lookupKeys = [...new Set(hrIds.flatMap((hrId) => hrIdLookupKeys(hrId)))];
  const employeeResult = lookupKeys.length > 0
    ? await supabase.from("employees").select("hr_id,full_name,work_email,employment_status").in("hr_id", lookupKeys)
    : { data: [] as Array<Record<string, unknown>>, error: null };
  if (employeeResult.error) throw employeeResult.error;
  const people: TargetPerson[] = ((employeeResult.data ?? []) as Array<Record<string, unknown>>).map((row) => ({
    hrId: String(row.hr_id ?? ""),
    name: String(row.full_name ?? "").trim() || String(row.hr_id ?? ""),
    email: String(row.work_email ?? "").trim() || null,
    active: String(row.employment_status ?? "").trim().toLowerCase() === "active",
  }));

  return { seats, areaMap, people, productNames };
}

export type TargetTeamSend = {
  line: string;
  periods: string[];
  sent: boolean;
  reason?: string;
  toCount: number;
  ccCount: number;
  warnings: string[];
};

export type TargetsUploadedResult = {
  teams: TargetTeamSend[];
  /** Rows whose line and area no organogram row names — they reach nobody. */
  unplacedRows: number;
};

async function sendOneTeam(team: TargetTeam, people: TargetPerson[]): Promise<TargetTeamSend> {
  const line = lineName(team.lineCode);
  const { to, cc, warnings } = resolveTeamRecipients(team, people);
  const base = { line, periods: team.periods, toCount: to.length, ccCount: cc.length, warnings };
  if (to.length === 0) {
    return { ...base, sent: false, reason: "No active rep or manager with a work email resolved for this team." };
  }

  const label = periodsLabel(team.periods);
  const subject = `${line} — your target for ${label} is now on Phoenix`;
  const action = { href: appUrl("/employee-portals/targets"), label: "Open Targets" };

  const result = await sendTemplatedEmail({
    context: {
      ctaLabel: action.label,
      ctaUrl: action.href,
      line,
      periodLabel: label,
      subject,
    },
    fallbackTo: to.map((recipient) => recipient.email),
    idempotencyKey: `targets-uploaded:${team.lineCode}:${team.managerSeatId ?? "none"}:${team.periods.join("+")}:${teamFingerprint(team)}`,
    origin: { eventType: "targets_uploaded", module: "sales" },
    overrides: {
      cc: cc.map((recipient) => recipient.email),
      replaceRecipients: true,
      to: to.map((recipient) => recipient.email),
    },
    templateKey: "targets_uploaded",
  });

  return { ...base, sent: !result.skipped, reason: result.skipped ? result.reason : undefined };
}

/**
 * Tell each team its targets. Never throws a send failure: the rows are already stored by the time
 * this runs, so one team's failure is logged and the others are still told.
 */
export async function notifyTargetsUploaded(input: { rows: ResolvedTargetRow[] }): Promise<TargetsUploadedResult> {
  if (input.rows.length === 0) return { teams: [], unplacedRows: 0 };
  const lineCodes = [...new Set(input.rows.map((row) => row.line_code))];
  const directory = await loadTargetDirectory(lineCodes);
  const { teams, unplaced } = buildTargetTeams({ rows: input.rows, directory });

  const sends: TargetTeamSend[] = [];
  for (const team of teams) {
    try {
      sends.push(await sendOneTeam(team, directory.people));
    } catch (error) {
      logError("targets_uploaded_team_notification_failed", {
        error,
        labels: { event: "targets_uploaded_team_notification_failed" },
        context: { line: team.lineCode, managerSeatId: team.managerSeatId, periods: team.periods },
      });
      sends.push({
        line: lineName(team.lineCode),
        periods: team.periods,
        sent: false,
        reason: error instanceof Error ? error.message : "unknown error",
        toCount: 0,
        ccCount: 0,
        warnings: [],
      });
    }
  }
  return { teams: sends, unplacedRows: unplaced.length };
}

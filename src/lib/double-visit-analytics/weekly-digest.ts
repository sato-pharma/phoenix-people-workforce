// DV Planner weekly digest (Wave 2, F4). Rides the existing daily notifications cron — no new
// Cloud Scheduler job — self-gating to a single Cairo weekday, same convention as
// processProbationWeeklyDigest and runWeeklySystemHealthDigest.
//
// Framing (owner decision, 2026-07-18): a weekly REVIEW, not an escalation. Every applicable
// manager role gets a premium summary of their OWN DV week, sent to their own mailbox, CC'd to
// DV_DIGEST_CC_EMAILS on every send — including an all-covered week. No skip-if-clean.
//
// Perf (avoids the 2026-07-15/16 notifications-cron 504 outage pattern): ONE company-wide
// directory + ONE wide double-visit scan, then sliced per manager in memory via the exact same
// filterEmployeesForDoubleVisitAccess / filterRowsForAccess / buildDvPlannerRosterEntries /
// summarizeRosterCoverage the DV Planner page itself uses — never re-scan per recipient.

import { systemDeployment } from "@/config/system-settings";
import { normalizeHrIdForAccess, type AccessContext, type PhoenixRole } from "@/lib/auth/permissions";
import { isCrmVisitsSchemaReady } from "@/lib/crm/schema";
import {
  buildDvPlannerProbationEntries,
  buildDvPlannerRosterEntries,
  filterEmployeesForDoubleVisitAccess,
  filterRowsForAccess,
  getLiveDoubleVisitRows,
  isActiveEmployee,
  isMedicalRep,
} from "@/lib/double-visit-analytics/service";
import { summarizeRosterCoverage, type DvCoverageSummary } from "@/lib/double-visit-analytics/roster-summary";
import type { DoubleVisitFocusProbationEntry, DoubleVisitRosterEntry } from "@/lib/double-visit-analytics/types";
import { getEmployeeDirectoryRows } from "@/lib/employees/employee-directory";
import { canonicalHrIdKey } from "@/lib/hr-id";
import { createSystemNotification, logNotificationSendFailure } from "@/lib/notifications/system";
import { getSupabaseAdmin } from "@/lib/supabase/server";

const CAIRO_TZ = "Africa/Cairo";
// Sunday — matches the probation weekly digest and the weekly system-health digest.
const WEEKLY_DIGEST_WEEKDAY = 0;

function cairoWeekday(when: Date): number {
  const wd = new Intl.DateTimeFormat("en-US", { timeZone: CAIRO_TZ, weekday: "short" }).format(when);
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(wd);
}

function cairoDate(when: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: CAIRO_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(when);
}

function addDaysIso(dateIso: string, days: number): string {
  const date = new Date(`${dateIso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Pure — exported for direct unit testing. */
export function isDvDigestDay(nowIso: string): boolean {
  return cairoWeekday(new Date(nowIso)) === WEEKLY_DIGEST_WEEKDAY;
}

/** Pure — exported for direct unit testing. Inclusive 7-day window ending today (Cairo-local). */
export function dvDigestWeekWindow(nowIso: string): { today: string; weekStart: string; weekLabel: string } {
  const now = new Date(nowIso);
  const today = cairoDate(now);
  const weekStart = cairoDate(new Date(now.getTime() - 6 * 86_400_000));
  return { today, weekLabel: `${weekStart} to ${today}`, weekStart };
}

// Same lookback as the DV Planner page's includeCadence scan (service.ts CADENCE_LOOKBACK_DAYS) —
// kept as an independent literal rather than importing the private constant, matching this
// codebase's convention of each digest self-containing its own gate/window constants.
const CADENCE_LOOKBACK_DAYS = 180;

const DIGEST_RECIPIENT_ROLES: PhoenixRole[] = [
  "District Manager",
  "Regional Manager",
  "National Sales Manager",
  "Product Manager",
  "Group Product Manager",
  "Training Manager",
];

const DIGEST_SHORTLIST_LIMIT = 8;

// No default: omar.anwar@satopharma.com is already BCC'd on every automated email
// unconditionally (sendPhoenixEmail's standing BCC), so defaulting this to the same address
// would leave him visibly CC'd here on top of that. Env var still lets ops add other CCs.
function defaultDigestCcEmails(): string[] {
  return String(process.env.DV_DIGEST_CC_EMAILS ?? "")
    .split(",")
    .map((email) => email.trim())
    .filter(Boolean);
}

async function activeManagersByRole(roles: PhoenixRole[]): Promise<Array<{ hrId: string; role: PhoenixRole }>> {
  const { data } = await getSupabaseAdmin()
    .from("app_auth_users")
    .select("hr_id, role")
    .in("role", roles as unknown as string[])
    .eq("is_active", true);
  const seen = new Set<string>();
  const out: Array<{ hrId: string; role: PhoenixRole }> = [];
  for (const row of (data ?? []) as Array<{ hr_id?: string | null; role?: string | null }>) {
    // Keep the RAW hr_id here — do NOT run it through normalizeHrIdForAccess. A real browser
    // session's access.hrId is always the raw value; pre-canonicalizing it broke
    // getProbationRows' own internal viewer resolution, which compares access.hrId against
    // directory rows via canonicalHrIdKey (dash-preserving, e.g. "PD-0001" -> "pd-0001") — a
    // different convention than normalizeHrIdForAccess (dash-stripping, "PD-0001" -> "pd0001").
    // Feeding the dash-stripped form in made every probation lookup resolve viewer to null.
    const hrId = cleanHrId(row.hr_id);
    const role = (row.role ?? "") as PhoenixRole;
    const dedupeKey = normalizeHrIdForAccess(hrId);
    if (!hrId || !role || !dedupeKey || seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push({ hrId, role });
  }
  return out;
}

function cleanHrId(value: string | null | undefined): string | null {
  const trimmed = String(value ?? "").trim();
  return trimmed || null;
}

/**
 * Build the {{digestTable}} / {{digestTableText}} content: a compact stat summary plus (when
 * non-empty) a "needs attention" shortlist of the most cadence-overdue reps. Deliberately a
 * summary, not a per-rep row dump — keeps a company-wide TM/NSM digest a clean one-pager.
 */
export function buildDvDigestSummaryEmail(params: {
  summary: DvCoverageSummary;
  topOverdue: Array<{ name: string; daysSinceLastVisit: number | null }>;
}): { html: string; text: string } {
  const { summary, topOverdue } = params;
  const cell = "padding:10px 12px;font-family:Arial,Helvetica,sans-serif;font-size:13px;border-bottom:1px solid #e2e8f0";
  const label = `${cell};color:#475569`;
  const value = `${cell};color:#0f172a;font-weight:700;text-align:right`;

  const stats: Array<[string, string]> = [
    ["Coverage this week", `${summary.coveragePct}% (${summary.covered}/${summary.total})`],
    ["Never visited", String(summary.neverVisited)],
    ["Cadence overdue (30d+)", String(summary.overdue)],
    ["On probation, DV pending", String(summary.probationDvPending)],
  ];
  const statRows = stats
    .map(([statLabel, statValue], i) => {
      const bg = i % 2 === 1 ? "background:#f8fafc" : "background:#ffffff";
      return `<tr style="${bg}"><td style="${label};${bg}">${statLabel}</td><td style="${value};${bg}">${statValue}</td></tr>`;
    })
    .join("");

  const shortlistRows = topOverdue
    .map((entry, i) => {
      const bg = i % 2 === 1 ? "background:#f8fafc" : "background:#ffffff";
      const days = entry.daysSinceLastVisit == null ? "Never visited" : `${entry.daysSinceLastVisit}d ago`;
      return `<tr style="${bg}"><td style="${cell};${bg}">${entry.name}</td><td style="${cell};${bg};text-align:right">${days}</td></tr>`;
    })
    .join("");

  const html =
    `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:16px 0;width:100%;border-collapse:collapse;border-top:1px solid #e2e8f0">` +
    `<tbody>${statRows}</tbody></table>` +
    (topOverdue.length > 0
      ? `<p style="color:#0f172a;font-size:14px;line-height:1.4;font-weight:700;margin:16px 0 4px">Needs attention</p>` +
        `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;border-collapse:collapse;border-top:1px solid #e2e8f0">` +
        `<tbody>${shortlistRows}</tbody></table>`
      : "");

  const textLines = [
    `Coverage this week: ${summary.coveragePct}% (${summary.covered}/${summary.total})`,
    `Never visited: ${summary.neverVisited}`,
    `Cadence overdue (30d+): ${summary.overdue}`,
    `On probation, DV pending: ${summary.probationDvPending}`,
  ];
  if (topOverdue.length > 0) {
    textLines.push("", "Needs attention:");
    for (const entry of topOverdue) {
      const days = entry.daysSinceLastVisit == null ? "Never visited" : `${entry.daysSinceLastVisit}d ago`;
      textLines.push(`- ${entry.name}: ${days}`);
    }
  }
  return { html, text: textLines.join("\n") };
}

/**
 * Defensive retry for a genuine external-call failure (network/Supabase blip) — NOT a workaround
 * for a known bug: the actual root cause of an earlier bad reading here was traced to and fixed at
 * the source (activeManagersByRole below was pre-canonicalizing hrId with normalizeHrIdForAccess,
 * a dash-stripping form, which broke getProbationRows' own internal viewer resolution — it compares
 * access.hrId against directory rows via canonicalHrIdKey, a dash-PRESERVING form). Kept as cheap
 * insurance against real transient failures: an empty result is ambiguous (genuinely zero
 * probationers vs. a dropped fetch), so retry once and keep whichever attempt is non-empty. Still
 * fails soft to [] if both attempts are genuinely empty.
 */
async function buildProbationEntriesWithRetry(
  params: Parameters<typeof buildDvPlannerProbationEntries>[0],
): Promise<DoubleVisitFocusProbationEntry[]> {
  const first = await buildDvPlannerProbationEntries(params).catch(() => []);
  if (first.length > 0) return first;
  const retry = await buildDvPlannerProbationEntries(params).catch(() => []);
  return retry.length > 0 ? retry : first;
}

export type DvPlannerDigestManagerOutcome = {
  hrId: string;
  role: PhoenixRole;
  sent: boolean;
  summary: DvCoverageSummary;
};

export type DvPlannerDigestResult = {
  scanned: number;
  sent: number;
  skipped?: string;
  /** Only populated for dryRun — lets a verification run assert email math == page math. */
  managers?: DvPlannerDigestManagerOutcome[];
};

/**
 * Weekly sweep (call daily; self-gates to Cairo Sunday unless opts.force): one review digest per
 * active manager in DIGEST_RECIPIENT_ROLES, scoped exactly like their own DV Planner page view.
 */
export async function runDvPlannerWeeklyDigest(
  nowIso: string = new Date().toISOString(),
  opts: { force?: boolean; dryRun?: boolean } = {},
): Promise<DvPlannerDigestResult> {
  if (!opts.force && !isDvDigestDay(nowIso)) {
    return { scanned: 0, sent: 0, skipped: "not the weekly digest day" };
  }
  if (!(await isCrmVisitsSchemaReady())) {
    return { scanned: 0, sent: 0, skipped: "double-visit schema not ready" };
  }

  const { today, weekStart, weekLabel } = dvDigestWeekWindow(nowIso);
  const managers = await activeManagersByRole(DIGEST_RECIPIENT_ROLES);
  if (managers.length === 0) return { scanned: 0, sent: 0 };

  // ONE company-wide load — sliced per manager below. Do NOT call getDoubleVisitReportData per
  // manager: it would re-run this same directory + wide DV scan once per recipient.
  const employees = await getEmployeeDirectoryRows({ includeInactive: true });
  const cadenceFloor = addDaysIso(today, -CADENCE_LOOKBACK_DAYS);
  const rawRowsWide = await getLiveDoubleVisitRows(cadenceFloor, today, employees);
  const ccEmails = defaultDigestCcEmails();
  const ctaBase = `${systemDeployment.productionUrl}/employee-portals/dv-planner`;

  // Sequential, not Promise.all — a handful of managers/week comfortably fits the 300s cron budget
  // serially, and keeping this loop simple avoids re-introducing the kind of multi-viewer-at-once
  // code path that made the earlier hrId-normalization bug (see activeManagersByRole above) easy to
  // misdiagnose as a concurrency issue in the first place.
  const outcomes: Array<DvPlannerDigestManagerOutcome | null> = [];
  for (const { hrId, role } of managers) {
    try {
      // scope: "hierarchy" for every role — resolveDoubleVisitAccessScope keys the company-wide
      // {all:true} branch off role alone for Training Manager (and CEO/Super Admin/SFE/Marketing
      // Manager), never off scope. Never pass scope:"system" here — that would flip DM/RM/PM/GPM
      // to company-wide too, which is wrong for this digest.
      const access: AccessContext = { hrId, loginId: hrId, role, scope: "hierarchy", source: "system" };

      const scopedEmployees = filterEmployeesForDoubleVisitAccess(employees, access);
      const scopedRowsWide = filterRowsForAccess(rawRowsWide, access, employees);
      const scopedRows = scopedRowsWide.filter((row) => row.activity_date >= weekStart && row.activity_date <= today);

      const cadenceLastVisitByKey = new Map<string, string>();
      for (const row of scopedRowsWide) {
        const key = canonicalHrIdKey(row.visited_employee_hr_id);
        if (!key) continue;
        const existing = cadenceLastVisitByKey.get(key);
        if (!existing || row.activity_date > existing) cadenceLastVisitByKey.set(key, row.activity_date);
      }

      const probation = await buildProbationEntriesWithRetry({ access, employees, scopedRows });
      const activeMedicalReps = scopedEmployees.filter((employee) => isActiveEmployee(employee) && isMedicalRep(employee));
      const roster: DoubleVisitRosterEntry[] = buildDvPlannerRosterEntries({
        activeMedicalReps,
        cadenceLastVisitByKey,
        dateTo: today,
        inWindowRows: scopedRows
          .filter((row) => row.visited_employee_hr_id)
          .map((row) => ({ activityDate: row.activity_date, visitedHrId: row.visited_employee_hr_id })),
        probation,
        today,
      });

      const summary = summarizeRosterCoverage(roster);
      if (opts.dryRun) {
        outcomes.push({ hrId, role, sent: false, summary });
        continue;
      }

      const topOverdue = roster
        .filter((entry) => entry.cadenceOverdue)
        .sort((a, b) => (b.daysSinceLastVisit ?? Number.MAX_SAFE_INTEGER) - (a.daysSinceLastVisit ?? Number.MAX_SAFE_INTEGER))
        .slice(0, DIGEST_SHORTLIST_LIMIT)
        .map((entry) => ({ daysSinceLastVisit: entry.daysSinceLastVisit, name: entry.name }));
      const table = buildDvDigestSummaryEmail({ summary, topOverdue });
      const ctaUrl = `${ctaBase}?dateFrom=${weekStart}&dateTo=${today}`;
      const title = `Your Double-Visit week — ${weekLabel}`;
      const message = `Coverage this week: ${summary.coveragePct}% (${summary.covered}/${summary.total}). ${summary.overdue} rep(s) cadence-overdue.`;

      const result = await createSystemNotification({
        actionUrl: ctaUrl,
        actorId: "system",
        category: "double_visit_analytics",
        eventType: "weekly_digest",
        message,
        metadata: { idempotencyKey: `dv-planner-weekly:${hrId}:${weekStart}` },
        module: "double_visit_analytics",
        priority: "normal",
        recipientHrId: hrId,
        subjectHrId: hrId,
        title,
        channels: ["in_app", "email"],
        email: {
          cc: ccEmails,
          ctaHref: ctaUrl,
          ctaLabel: "Open DV Planner",
          notificationType: "general",
          subject: title,
          summary: message,
          templateContext: {
            digestTable: table.html,
            digestTableText: table.text,
            weekLabel,
          },
          templateKey: "dv_planner_weekly",
          title,
        },
      });
      const sent = result.deliveries.some((delivery) => delivery.status === "sent" || delivery.status === "pending");
      outcomes.push({ hrId, role, sent, summary });
    } catch (error) {
      logNotificationSendFailure("doubleVisitAnalytics.weeklyDigest", error);
      outcomes.push(null);
    }
  }

  const settled = outcomes.filter((entry): entry is DvPlannerDigestManagerOutcome => Boolean(entry));
  return {
    scanned: managers.length,
    sent: settled.filter((entry) => entry.sent).length,
    ...(opts.dryRun ? { managers: settled } : {}),
  };
}
